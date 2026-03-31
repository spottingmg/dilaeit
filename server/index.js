import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from 'db-hafas';
const dbClient = createClient('dilaeit-app'); // Ein Name für deine App

// Neue Route für DB-Echtzeit (speziell für Züge)
app.get('/api/db/departures/:stationId', async (req, res) => {
    try {
        const { stationId } = req.params;
        // Wir fragen die DB nach Abfahrten an dieser Station
        const departures = await dbClient.departures(stationId, {
            duration: 60, // Die nächsten 60 Minuten
            remarks: true
        });

        // Wir mappen die DB-Daten auf dein Format
        const formatted = departures.map(dep => ({
            tripId: dep.tripId,
            line: { name: dep.line.name },
            direction: dep.direction,
            plannedWhen: dep.plannedWhen,
            when: dep.when, // Hier steckt die echte DB-Sekunden-Präzision drin!
            delay: dep.delay, // Verspätung in Sekunden
            platform: dep.platform,
            plannedPlatform: dep.plannedPlatform,
            product: dep.line.product // ice, ic, re, rb, etc.
        }));

        res.json({ departures: formatted });
    } catch (error) {
        res.status(500).json({ error: 'DB API Fehler' });
    }
});
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const OPEN_SERVICE_BASE =
  process.env.OPEN_SERVICE_BASE || 'https://openservice-test.vrr.de/openservice';
const EFA_VERSION = process.env.EFA_VERSION || '10.4.18.18';

function toIsoStringOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function toYyyymmddUtc(iso) {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function toHmmUtc(iso) {
  const d = new Date(iso);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}${m}`;
}

function encodeTripId(payload) {
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8').toString('base64url');
}

function decodeTripId(tripId) {
  const json = Buffer.from(tripId, 'base64url').toString('utf8');
  return JSON.parse(json);
}

async function efaGet(endpoint, params) {
  const url = new URL(`${OPEN_SERVICE_BASE}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    url.searchParams.set(k, String(v));
  });
  const res = await fetch(url, {
    headers: {
      'user-agent': 'dilaeit-vrr-proxy/0.1 (+https://github.com/)'
    }
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`EFA HTTP ${res.status} ${endpoint}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error(`EFA invalid JSON from ${endpoint}`);
    err.body = text;
    throw err;
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    openServiceBase: OPEN_SERVICE_BASE,
    efaVersion: EFA_VERSION
  });
});

// Stop search -> returns EFA stopIDs (properties.stopId)
app.get('/api/locations', async (req, res) => {
  const query = (req.query.query || '').toString().trim();
  if (query.length < 2) return res.json({ locations: [] });

  const data = await efaGet('XML_STOPFINDER_REQUEST', {
    outputFormat: 'rapidJSON',
    version: EFA_VERSION,
    language: 'de',
    type_sf: 'any',
    name_sf: query,
    anyObjFilter_sf: 2,
    locationServerActive: 1
  });

  const locs = (data.locations || [])
    .filter((l) => l?.properties?.stopId && (l.type === 'stop' || l.type === 'platform'))
    .slice(0, 12)
    .map((l) => ({
      id: String(l.properties.stopId),
      name: l.name,
      type: l.type,
      rawId: l.id,
      source: 'VRR'
    }));

  res.json({ locations: locs });
});

// Departures for stopID
app.get('/api/stops/:stopId/departures', async (req, res) => {
  const stopId = String(req.params.stopId || '').trim();
  if (!stopId) return res.status(400).json({ error: 'missing stopId' });

  // `when` als ISO-String direkt zeichenweise parsen – NICHT über new Date(),
  // da der Server in UTC läuft und getHours() dann falsche Lokalzeit liefert.
  // Das Frontend schickt z.B. "2026-03-31T10:18:00.000+02:00" oder "...Z".
  // Wir schneiden Datum und Uhrzeit direkt aus dem String heraus.
  const whenRaw = req.query.when ? decodeURIComponent(req.query.when) : null;
  let itdDateDay, itdDateMonth, itdDateYear, itdTimeHour, itdTimeMinute;

  if (whenRaw) {
    // ISO-String aufsplitten: "2026-03-31T10:18:00..." → ["2026","03","31"], ["10","18",...]
    const [datePart, timePart] = whenRaw.split('T');
    const [y, mo, d] = datePart.split('-').map(Number);
    const [h, mi]    = (timePart || '00:00').split(':').map(Number);
    itdDateYear  = y;
    itdDateMonth = mo;
    itdDateDay   = d;
    itdTimeHour  = h;
    itdTimeMinute = mi;
  } else {
    const now = new Date();
    itdDateYear   = now.getFullYear();
    itdDateMonth  = now.getMonth() + 1;
    itdDateDay    = now.getDate();
    itdTimeHour   = now.getHours();
    itdTimeMinute = now.getMinutes();
  }

  const data = await efaGet('XML_DM_REQUEST', {
    outputFormat: 'rapidJSON',
    version: EFA_VERSION,
    mode: 'direct',
    type_dm: 'stopID',
    name_dm: stopId,
    useRealtime: 1,
    itdDateDay,
    itdDateMonth,
    itdDateYear,
    itdTimeHour,
    itdTimeMinute,
    itdTripDateTimeDepArr: 'dep',
  });

  const stopEvents = Array.isArray(data.stopEvents) ? data.stopEvents : [];

  const departures = stopEvents
    .map((ev) => {
      const planned = toIsoStringOrNull(ev.departureTimePlanned);
      if (!planned) return null;
      // estimated ist null wenn kein Echtzeitsignal vorhanden – dann delay=null,
      // nicht delay=0, damit das Frontend "kein Signal" korrekt darstellt.
      const estimated = toIsoStringOrNull(ev.departureTimeEstimated);

      const plannedDate = planned;
      // Verfrühung = negativer delaySec (estimated < planned)
      const delaySec = estimated !== null
        ? Math.round((Date.parse(estimated) - Date.parse(plannedDate)) / 1000)
        : null;

      const platform =
        ev.location?.properties?.platform ||
        ev.location?.properties?.platformName ||
        ev.location?.properties?.plannedPlatformName ||
        null;

      const lineName =
        ev.transportation?.number ||
        ev.transportation?.disassembledName ||
        ev.transportation?.name ||
        '???';

      const productName = (ev.transportation?.product?.name || '').toLowerCase();
      const operatorName = ev.transportation?.operator?.name || null;

      const tripPayload = {
        line: ev.transportation?.id || null,
        stopID: stopId,
        tripCode: ev.transportation?.properties?.tripCode ?? null,
        date: toYyyymmddUtc(planned),
        time: toHmmUtc(planned)
      };

      const tripId = tripPayload.line && tripPayload.tripCode != null ? encodeTripId(tripPayload) : null;

      const cancelled =
        Array.isArray(ev.realtimeStatus) && ev.realtimeStatus.some((s) => String(s).toUpperCase().includes('CANCEL'));

      return {
        plannedWhen: plannedDate,
        when: estimated ?? plannedDate,   // null-coalescing: wenn kein RT, Soll-Zeit
        delay: delaySec,                  // null = kein Signal, negativ = Verfrühung
        plannedPlatform: platform,
        platform,
        cancelled,
        direction: ev.transportation?.destination?.name || '',
        tripId,
        prognosis: {
          tripId,
          platform
        },
        line: {
          name: String(lineName).replace(/^.*?\s+/, '').trim() || String(lineName),
          product: productName || 'bus',
          operator: operatorName ? { name: operatorName } : undefined
        },
        _source: 'VRR OpenService'
      };
    })
    .filter(Boolean)
    .slice(0, 60);

  res.json({ departures });
});

// Trip stop sequence for a specific trip (TripStopTimes)
app.get('/api/trips/:tripId', async (req, res) => {
  const tripId = String(req.params.tripId || '').trim();
  if (!tripId) return res.status(400).json({ error: 'missing tripId' });

  let payload;
  try {
    payload = decodeTripId(tripId);
  } catch {
    return res.status(400).json({ error: 'invalid tripId' });
  }

  const { line, stopID, tripCode, date, time } = payload || {};
  if (!line || !stopID || tripCode == null || !date || !time) {
    return res.status(400).json({ error: 'tripId missing fields' });
  }

  const data = await efaGet('XML_TRIPSTOPTIMES_REQUEST', {
    outputFormat: 'rapidJSON',
    version: EFA_VERSION,
    mode: 'direct',
    line,
    stopID,
    tripCode,
    date,
    time,
    tStOTType: 'ALL',
    useRealtime: 1
  });

  const seq = data.transportation?.locationSequence || [];

  const stopovers = (Array.isArray(seq) ? seq : []).map((s) => ({
    stop: { name: s.name || s.parent?.name || '' },
    plannedArrival: toIsoStringOrNull(s.arrivalTimePlanned),
    arrival: toIsoStringOrNull(s.arrivalTimeEstimated),
    plannedDeparture: toIsoStringOrNull(s.departureTimePlanned),
    departure: toIsoStringOrNull(s.departureTimeEstimated),
    plannedPlatform: s.properties?.plannedPlatformName || s.properties?.platformName || s.properties?.platform || null,
    platform: s.properties?.platformName || s.properties?.platform || null,
    cancelled: false,
    additional: false
  }));

  res.json({
    stopovers,
    remarks: [],
    source: 'VRR OpenService'
  });
});

// Serve the static frontend
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`dilaeit server running on http://localhost:${port}`);
});
