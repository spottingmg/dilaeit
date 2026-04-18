import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── db-hafas (optional, dynamischer Import) ─────────────────────────────────
let hafas = null;
try {
  const mod = await import('db-hafas');
  const createFn = mod.default ?? mod.createDbHafas ?? mod.createHafas;
  if (typeof createFn === 'function') {
    hafas = createFn('dilaeit-app');
    console.log('✅ db-hafas initialisiert');
  }
} catch (e) {
  console.warn('⚠️  db-hafas nicht verfügbar:', e.message);
}

// ─── Frontend-Pfad ermitteln ─────────────────────────────────────────────────
const potentialPaths = [
  path.join(process.cwd(), 'public'),
  path.join(__dirname, '..', 'public'),
  path.join(__dirname, 'public')
];
let publicPath = potentialPaths[0];
for (const p of potentialPaths) {
  if (fs.existsSync(path.join(p, 'index.html'))) { publicPath = p; break; }
}
console.log('📂 Frontend:', publicPath);

// ─── EFA-Konfiguration ───────────────────────────────────────────────────────
const app               = express();
const OPEN_SERVICE_BASE = process.env.OPEN_SERVICE_BASE || 'https://openservice-test.vrr.de/openservice';
const EFA_VERSION       = process.env.EFA_VERSION       || '10.4.18.18';

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────
function toIsoStringOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toYyyymmddUtc(iso) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
}

function toHmmUtc(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2,'0')}${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

function encodeTripId(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeTripId(tripId) {
  return JSON.parse(Buffer.from(tripId, 'base64url').toString('utf8'));
}

async function efaGet(endpoint, params) {
  const url = new URL(`${OPEN_SERVICE_BASE}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });
  const res  = await fetch(url, { headers: { 'user-agent': 'dilaeit-vrr-proxy/0.1' } });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`EFA HTTP ${res.status} ${endpoint}`);
    err.status = res.status; err.body = text; throw err;
  }
  try { return JSON.parse(text); }
  catch { const err = new Error(`EFA invalid JSON from ${endpoint}`); err.body = text; throw err; }
}

// ─── Statische Dateien ───────────────────────────────────────────────────────
app.use(express.static(publicPath));
app.get('/', (_req, res) => res.sendFile(path.join(publicPath, 'index.html')));

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({
  ok: true, hafas: !!hafas, openServiceBase: OPEN_SERVICE_BASE
}));

// ─── Stationssuche (VRR) ─────────────────────────────────────────────────────
app.get('/api/locations', async (req, res) => {
  try {
    const query = (req.query.query || '').toString().trim();
    if (query.length < 2) return res.json({ locations: [] });

    const data = await efaGet('XML_STOPFINDER_REQUEST', {
      outputFormat: 'rapidJSON', version: EFA_VERSION, language: 'de',
      type_sf: 'any', name_sf: query, anyObjFilter_sf: 2, locationServerActive: 1
    });

    const locs = (data.locations || [])
      .filter(l => l?.properties?.stopId && (l.type === 'stop' || l.type === 'platform'))
      .slice(0, 12)
      .map(l => ({ id: String(l.properties.stopId), name: l.name, type: l.type, source: 'VRR' }));

    res.json({ locations: locs });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ─── Stationssuche (DB) ──────────────────────────────────────────────────────
app.get('/api/db/locations', async (req, res) => {
  try {
    const query = (req.query.query || '').toString().trim();
    if (query.length < 2) return res.json({ locations: [] });
    if (!hafas) return res.status(503).json({ error: 'DB-Hafas nicht initialisiert' });

    const result = await hafas.locations(query, { results: 12 });
    const locs = (result || [])
        .filter(l => l.type === 'stop' || l.type === 'station')
        .map(l => ({
            id: String(l.id),
            name: l.name,
            type: l.type,
            source: 'DB'
        }));

    res.json({ locations: locs });
  } catch (e) { 
    console.error('DB Location search error:', e.message);
    res.status(502).json({ error: e.message }); 
  }
});

// ─── Abfahrten (DB) ──────────────────────────────────────────────────────────
app.get('/api/db/stops/:stopId/departures', async (req, res) => {
  try {
    const stopId = String(req.params.stopId || '').trim();
    if (!stopId) return res.status(400).json({ error: 'missing stopId' });
    if (!hafas) return res.status(503).json({ error: 'hafas not available' });

    const whenRaw = req.query.when ? decodeURIComponent(req.query.when) : null;
    const when = whenRaw ? new Date(whenRaw) : new Date();

    const result = await hafas.departures(stopId, {
      when,
      duration: 120,
      results: 60,
      remarks: true,
      stopovers: false
    });

    const departures = (result.departures || []).map(d => {
      const planned = d.plannedWhen ? new Date(d.plannedWhen).toISOString() : null;
      const actual = d.when ? new Date(d.when).toISOString() : planned;
      const delaySec = d.delay !== undefined ? d.delay : (d.when && d.plannedWhen ? Math.round((new Date(d.when) - new Date(d.plannedWhen)) / 1000) : null);

      return {
        plannedWhen: planned,
        when: actual,
        delay: delaySec,
        platform: d.platform || d.plannedPlatform || null,
        plannedPlatform: d.plannedPlatform || null,
        cancelled: d.cancelled || false,
        direction: d.direction || 'Unbekannt',
        tripId: d.tripId,
        dbTripId: d.tripId,
        line: {
          name: d.line?.name || '???',
          product: d.line?.product || 'train'
        },
        _source: 'Deutsche Bahn'
      };
    });

    res.json({ departures });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ─── Abfahrten ───────────────────────────────────────────────────────────────
app.get('/api/stops/:stopId/departures', async (req, res) => {
  try {
    const stopId = String(req.params.stopId || '').trim();
    if (!stopId) return res.status(400).json({ error: 'missing stopId' });

    // ── ZEITFIX: ISO-String zeichenweise aufsplitten ──────────────────────────
    // NICHT über new Date().getHours() – Render läuft in UTC, das ergäbe
    // 2 Stunden Versatz zur deutschen Lokalzeit.
    let itdDateDay, itdDateMonth, itdDateYear, itdTimeHour, itdTimeMinute;
    const whenRaw = req.query.when ? decodeURIComponent(req.query.when) : null;
    if (whenRaw) {
      const [datePart, timePart] = whenRaw.split('T');
      const [y, mo, d] = datePart.split('-').map(Number);
      const [h, mi]    = (timePart || '00:00').split(':').map(Number);
      itdDateYear = y; itdDateMonth = mo; itdDateDay = d;
      itdTimeHour = h; itdTimeMinute = mi;
    } else {
      const now = new Date();
      itdDateYear = now.getFullYear(); itdDateMonth = now.getMonth()+1; itdDateDay = now.getDate();
      itdTimeHour = now.getHours();    itdTimeMinute = now.getMinutes();
    }
    // ─────────────────────────────────────────────────────────────────────────

    const data = await efaGet('XML_DM_REQUEST', {
      outputFormat: 'rapidJSON', version: EFA_VERSION,
      mode: 'direct', type_dm: 'stopID', name_dm: stopId,
      useRealtime: 1,
      itdDateDay, itdDateMonth, itdDateYear,
      itdTimeHour, itdTimeMinute,
      itdTripDateTimeDepArr: 'dep',
    });

    const stopEvents = Array.isArray(data.stopEvents) ? data.stopEvents : [];

    const departures = stopEvents.map(ev => {
      const planned   = toIsoStringOrNull(ev.departureTimePlanned);
      if (!planned) return null;

      // estimated = null wenn kein Echtzeitsignal.
      // NICHT auf planned defaulten: dann wäre delay=0 statt null und
      // Verfrühungen würden als "pünktlich" angezeigt.
      const estimated = toIsoStringOrNull(ev.departureTimeEstimated);

      // null = kein Signal | negativ = Verfrühung | positiv = Verspätung
      const delaySec = estimated !== null
        ? Math.round((Date.parse(estimated) - Date.parse(planned)) / 1000)
        : null;

      const platform =
        ev.location?.properties?.platform ||
        ev.location?.properties?.platformName ||
        ev.location?.properties?.plannedPlatformName || null;

      const lineName =
        ev.transportation?.number ||
        ev.transportation?.disassembledName ||
        ev.transportation?.name || '???';

      const productName  = (ev.transportation?.product?.name || '').toLowerCase();
      const operatorName = ev.transportation?.operator?.name || null;

      const tripPayload = {
        line:     ev.transportation?.id || null,
        stopID:   stopId,
        tripCode: ev.transportation?.properties?.tripCode ?? null,
        date:     toYyyymmddUtc(planned),
        time:     toHmmUtc(planned)
      };
      const tripId = tripPayload.line && tripPayload.tripCode != null
        ? encodeTripId(tripPayload) : null;

      const cancelled = Array.isArray(ev.realtimeStatus) &&
        ev.realtimeStatus.some(s => String(s).toUpperCase().includes('CANCEL'));

      return {
        plannedWhen:     planned,
        when:            estimated ?? planned,
        delay:           delaySec,
        plannedPlatform: platform,
        platform,
        cancelled,
        direction:       ev.transportation?.destination?.name || '',
        tripId,
        dbTripId:        null,  // ggf. unten per Hafas befüllt
        prognosis:       { tripId, platform },
        line: {
          name:     String(lineName).replace(/^.*?\s+/, '').trim() || String(lineName),
          product:  productName || 'bus',
          operator: operatorName ? { name: operatorName } : undefined
        },
        _source: 'VRR OpenService'
      };
    }).filter(Boolean).slice(0, 60);

    // ── Optionaler DB-Hafas-Abgleich (Züge) ──────────────────────────────────
    if (hafas) {
      const uicMatch = stopId.match(/^(80\d{5})$/);
      if (uicMatch) {
        // UIC-Haltestelle: direkte Abfrage
        try {
          const result = await hafas.departures(uicMatch[1], {
            duration: 60,
            products: { bus: false, tram: false, subway: false,
                        nationalExpress: true, national: true, regional: true, suburban: true }
          });
          const dbRes = result.departures || [];
          departures.forEach(dep => {
            const name = (dep.line?.name || '').toUpperCase();
            const trainPrefixes = ['ICE','IC','ICD','RE','RB','IRE','EC','EN','TGV','NJ','RJ','RS'];
            const isTrain = trainPrefixes.some(p => 
              name === p || 
              name.startsWith(p + ' ') || 
              name.startsWith(p + '-') ||
              (name.startsWith(p) && name.length > p.length && /\d/.test(name.slice(p.length, p.length + 1)))
            ) || /^S\s*\d+/i.test(name);

            if (isTrain) {
              const dbMatch = dbRes.find(d => d.line?.name === dep.line.name);
              if (dbMatch) {
                // Bei Zügen überschreiben wir VRR-Daten komplett mit DB-Daten (mit Sekunden)
                if (dbMatch.delay !== undefined) dep.delay = dbMatch.delay;
                if (dbMatch.tripId)             dep.dbTripId = dbMatch.tripId;
                if (dbMatch.when)               dep.when = dbMatch.when;
                dep._source = 'Deutsche Bahn'; // Kennzeichnung für das Frontend
              }
            }
          });
        } catch (e) { console.warn('DB-Hafas Abgleich fehlgeschlagen:', e.message); }
      } else {
        // Nicht-UIC-Haltestelle: Suche nach der Station und Abgleich nur für Züge
        try {
          const stationSearch = await hafas.locations(stopId, { results: 1 });
          if (Array.isArray(stationSearch) && stationSearch.length > 0) {
            const station = stationSearch[0];
            const result = await hafas.departures(station.id, {
              duration: 60,
              products: { bus: false, tram: false, subway: false,
                          nationalExpress: true, national: true, regional: true, suburban: true }
            });
            const dbRes = result.departures || [];
            departures.forEach(dep => {
              const name = (dep.line?.name || '').toUpperCase();
              const trainPrefixes = ['ICE','IC','ICD','RE','RB','IRE','EC','EN','TGV','NJ','RJ','RS'];
              const isTrain = trainPrefixes.some(p => 
                name === p || 
                name.startsWith(p + ' ') || 
                name.startsWith(p + '-') ||
                (name.startsWith(p) && name.length > p.length && /\d/.test(name.slice(p.length, p.length + 1)))
              ) || /^S\s*\d+/i.test(name);

              if (isTrain) {
                const dbMatch = dbRes.find(d => d.line?.name === dep.line.name);
                if (dbMatch) {
                  if (dbMatch.delay !== undefined) dep.delay = dbMatch.delay;
                  if (dbMatch.tripId)             dep.dbTripId = dbMatch.tripId;
                  if (dbMatch.when)               dep.when = dbMatch.when;
                  dep._source = 'Deutsche Bahn'; // Kennzeichnung für das Frontend
                }
              }
            });
          }
        } catch (e) { console.warn('DB-Hafas Abgleich für Nicht-UIC fehlgeschlagen:', e.message); }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    res.json({ departures });
  } catch (e) { console.error('departures error', e); res.status(502).json({ error: e.message }); }
});

// ─── DB-Zugdetails via Hafas (sekundengenaue Echtzeitdaten) ──────────────────
app.get('/api/train-details/:tripId', async (req, res) => {
    if (!hafas) return res.status(503).json({ error: 'hafas not available' });
    try {
        const tripId = decodeURIComponent(req.params.tripId);
        const result = await hafas.trip(tripId, {
            polylines: false,
            stopovers: true,
            // Detaillierte Echtzeitdaten anfordern
            remarks: true,
            scheduled: false
        });
        const trip = result.trip;

        if (!trip) throw new Error('Trip not found');

        const stopovers = (trip.stopovers || []).map(s => {
            // DB-Hafas liefert ISO-Strings mit Sekunden (z.B. "2024-01-15T14:23:45+01:00")
            // Diese werden 1:1 weitergegeben für sekundengenaue Anzeige
            const plannedArrival = s.plannedArrival ? new Date(s.plannedArrival).toISOString() : null;
            const actualArrival = s.prognosedArrival || s.arrival;
            const arrival = actualArrival ? new Date(actualArrival).toISOString() : null;

            const plannedDeparture = s.plannedDeparture ? new Date(s.plannedDeparture).toISOString() : null;
            const actualDeparture = s.prognosedDeparture || s.departure;
            const departure = actualDeparture ? new Date(actualDeparture).toISOString() : null;

            // Verspätung/Verfrühung in Sekunden berechnen
            let arrivalDelaySec = null;
            if (arrival && plannedArrival) {
                arrivalDelaySec = Math.round((new Date(arrival) - new Date(plannedArrival)) / 1000);
            }
            let departureDelaySec = null;
            if (departure && plannedDeparture) {
                departureDelaySec = Math.round((new Date(departure) - new Date(plannedDeparture)) / 1000);
            }

            return {
                stop: { name: s.stop?.name || '', id: s.stop?.id },
                plannedArrival,
                arrival,
                plannedDeparture,
                departure,
                arrivalDelaySec,    // Neu: Verspätung in Sekunden für präzise Anzeige
                departureDelaySec,  // Neu: Verspätung in Sekunden für präzise Anzeige
                platform: s.platform || null,
                plannedPlatform: s.plannedPlatform || s.platform || null,
                cancelled: s.cancelled || false,
                additional: s.additional || false,
                remarks: s.remarks || []
            };
        });

        // remarks aus dem Trip extrahieren (z.B. "Zug fällt aus", "Gleiswechsel")
        const remarks = (trip.remarks || []).map(r => ({
            text: r.text || r.summary || '',
            type: r.category || 'info'
        }));

        res.json({
            stopovers,
            remarks,
            source: 'Deutsche Bahn (HAFAS)',
            tripId: trip.id,
            line: trip.line ? {
                name: trip.line.name,
                product: trip.line.product,
                operator: trip.line.operator?.name
            } : null
        });
    } catch (e) {
        console.error('train-details error:', e);
        res.status(502).json({ error: e.message });
    }
});

// ─── VRR-Fahrtverlauf ─────────────────────────────────────────────────────────
app.get('/api/trips/:tripId', async (req, res) => {
  try {
    const payload = decodeTripId(req.params.tripId);
    const { line, stopID, tripCode, date, time } = payload || {};
    if (!line || !stopID || tripCode == null || !date || !time)
      return res.status(400).json({ error: 'tripId missing fields' });

    const data = await efaGet('XML_TRIPSTOPTIMES_REQUEST', {
      outputFormat: 'rapidJSON', version: EFA_VERSION,
      mode: 'direct', line, stopID, tripCode, date, time,
      tStOTType: 'ALL', useRealtime: 1
    });

    const seq       = data.transportation?.locationSequence || [];
    const stopovers = (Array.isArray(seq) ? seq : []).map(s => ({
      stop:             { name: s.name || s.parent?.name || '' },
      plannedArrival:   toIsoStringOrNull(s.arrivalTimePlanned),
      arrival:          toIsoStringOrNull(s.arrivalTimeEstimated),
      plannedDeparture: toIsoStringOrNull(s.departureTimePlanned),
      departure:        toIsoStringOrNull(s.departureTimeEstimated),
      plannedPlatform:  s.properties?.plannedPlatformName || s.properties?.platformName || null,
      platform:         s.properties?.platformName || s.properties?.platform || null,
      cancelled:        false,
      additional:       false,
    }));

    res.json({ stopovers, remarks: [], source: 'VRR OpenService' });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ─── DB-Hafas Fahrten nach Name suchen (für Autocomplete)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/db/trips-by-name', async (req, res) => {
    const { query, date } = req.query;
    if (!query) return res.status(400).json({ error: 'Missing query' });
    if (!hafas) return res.status(503).json({ error: 'hafas not available' });

    try {
        const result = await hafas.tripsByName(query, {
            when: date ? new Date(date) : new Date(),
            results: 20,
            onlyCurrentlyRunning: false // WICHTIG: Erlaubt die Suche nach Fahrten in der Zukunft/Vergangenheit
        });

        res.json({
            trips: (result.trips || []).map(t => ({
                id: t.id,
                name: t.line?.name || t.direction || 'Unbekannt',
                direction: t.direction,
                line: t.line,
                plannedDeparture: t.plannedDeparture || (t.stopovers?.[0]?.plannedDeparture)
            }))
        });
    } catch (e) {
        console.error('DB trips by name error:', e.message);
        res.status(500).json({ error: 'Error searching for trips', details: e.message });
    }
});

// ─── DB-Hafas Fahrten nach Nummer und Datum suchen (für Zeitreise)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/db/trip-details', async (req, res) => {
    const { number, date, tripId } = req.query;
    if (!number && !tripId) return res.status(400).json({ error: 'Missing number or tripId' });
    if (!hafas) return res.status(503).json({ error: 'hafas not available' });

    try {
        let finalTripId = tripId;

        // Wenn keine direkte tripId übergeben wurde, suchen wir nach dem Namen
        if (!finalTripId) {
            let result = await hafas.tripsByName(number, {
                when: date ? new Date(date) : new Date(),
                results: 3
            });

            if ((!result.trips || result.trips.length === 0) && isNaN(number)) {
                const cleanNumber = number.replace(/^[A-Z]+\s*/i, '');
                if (cleanNumber !== number) {
                    result = await hafas.tripsByName(cleanNumber, {
                        when: date ? new Date(date) : new Date(),
                        results: 3
                    });
                }
            }

            if (!result.trips || result.trips.length === 0) {
                return res.status(404).json({ error: 'Trip not found' });
            }
            finalTripId = result.trips[0].id;
        }

        const resTrip = await hafas.trip(finalTripId, {
            stopovers: true,
            remarks: true,
            scheduled: true
        });
        const trip = resTrip.trip;

        if (!trip) return res.status(404).json({ error: 'Trip details not found' });

        const stopovers = (trip.stopovers || []).map(s => {
            const plannedArrival = s.plannedArrival ? new Date(s.plannedArrival).toISOString() : null;
            const actualArrival = s.prognosedArrival || s.arrival;
            const arrival = actualArrival ? new Date(actualArrival).toISOString() : null;

            const plannedDeparture = s.plannedDeparture ? new Date(s.plannedDeparture).toISOString() : null;
            const actualDeparture = s.prognosedDeparture || s.departure;
            const departure = actualDeparture ? new Date(actualDeparture).toISOString() : null;

            let arrivalDelaySec = null;
            if (arrival && plannedArrival) {
                arrivalDelaySec = Math.round((new Date(arrival) - new Date(plannedArrival)) / 1000);
            }
            let departureDelaySec = null;
            if (departure && plannedDeparture) {
                departureDelaySec = Math.round((new Date(departure) - new Date(plannedDeparture)) / 1000);
            }

            return {
                stop: { name: s.stop?.name || '', id: s.stop?.id },
                plannedArrival,
                arrival,
                plannedDeparture,
                departure,
                arrivalDelaySec,
                departureDelaySec,
                platform: s.platform || null,
                plannedPlatform: s.plannedPlatform || s.platform || null,
                cancelled: s.cancelled || false,
                additional: s.additional || false,
                remarks: s.remarks || []
            };
        });

        res.json({
            tripId: trip.id,
            line: trip.line,
            stopovers,
            remarks: (trip.remarks || []).map(r => ({
                text: r.text || r.summary || '',
                type: r.category || 'info'
            })),
            source: 'Deutsche Bahn (HAFAS)',
            operator: trip.operator,
            mode: trip.mode
        });
    } catch (e) {
        console.error('DB trip details error:', e);
        res.status(500).json({ error: 'Trip details not found' });
    }
});

// ─── DB IRIS – Zugsuche nach Fahrtnummer ─────────────────────────────────────
// IRIS ist öffentlich (CC BY 4.0), kein API-Key nötig
const IRIS_BASE = 'https://iris.noncd.db.de/iris-tts/timetable';

// Hilfsfunktion: einfaches XML-Attribut extrahieren
function xmlAttr(xml, tag, attr) {
    const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i');
    const m  = re.exec(xml);
    return m ? m[1] : null;
}

function xmlAttrs(xml, tag) {
    const re = new RegExp(`<${tag}([^>]*)>`, 'gi');
    const results = [];
    let m;
    while ((m = re.exec(xml)) !== null) {
        const attrStr = m[1];
        const attrs   = {};
        const attrRe  = /(\w+)="([^"]*)"/g;
        let a;
        while ((a = attrRe.exec(attrStr)) !== null) attrs[a[1]] = a[2];
        results.push(attrs);
    }
    return results;
}

// IRIS Stationssuche (gibt EVA-Nummer zurück)
async function irisStation(query) {
    const url = `${IRIS_BASE}/station/${encodeURIComponent(query)}`;
    const r   = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`IRIS station ${r.status}`);
    const xml  = await r.text();
    // <station name="..." eva="..." ds100="..." .../>
    const stations = xmlAttrs(xml, 'station');
    return stations[0] || null;
}

// IRIS Fahrplan für eine Station + Stunde
async function irisTimetable(eva, dateStr, hour) {
    // dateStr = YYMMDD, hour = HH (zweistellig)
    const url = `${IRIS_BASE}/plan/${eva}/${dateStr}/${hour}`;
    const r   = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return '';
    return r.text();
}

// IRIS Echtzeit-Overlay
async function irisRealtime(eva) {
    const url = `${IRIS_BASE}/fchg/${eva}`;
    const r   = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return '';
    return r.text();
}

// Fahrtnummer-Suche: durchsucht mehrere Stunden an einem Hub-Bahnhof
app.get('/api/iris/trip-search', async (req, res) => {
    const { number, date } = req.query;
    if (!number) return res.status(400).json({ error: 'missing number' });

    try {
        // EVA von Düsseldorf Hbf (8000085) – direkt verwenden, kein Lookup nötig
        const HUBS = [
            { eva: '8000207', name: 'Köln Hbf'           },  // RB Mönchengladbach→Troisdorf
            { eva: '8000248', name: 'Mönchengladbach Hbf' },
            { eva: '8005556', name: 'Troisdorf'           },
            { eva: '8000085', name: 'Düsseldorf Hbf'     },
            { eva: '8000105', name: 'Frankfurt(Main)Hbf'  },
            { eva: '8000096', name: 'Dortmund Hbf'       },
            { eva: '8011160', name: 'Berlin Hbf'         },
            { eva: '8002549', name: 'Hamburg Hbf'        },
            { eva: '8000191', name: 'Essen Hbf'          },
        ];

        const searchDate  = date ? new Date(date) : new Date();
        const yy  = String(searchDate.getFullYear()).slice(2);
        const mm  = String(searchDate.getMonth() + 1).padStart(2, '0');
        const dd  = String(searchDate.getDate()).padStart(2, '0');
        const dateStr = `${yy}${mm}${dd}`;

        const q = number.trim();

        // Mehrere Stunden + Hubs parallel durchsuchen
        const hours = ['06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21'];

        for (const hub of HUBS) {
            // Je 4 Stunden-Blöcke parallel
            for (let i = 0; i < hours.length; i += 4) {
                const chunk = hours.slice(i, i + 4);
                const xmls  = await Promise.all(
                    chunk.map(h => irisTimetable(hub.eva, dateStr, h).catch(() => ''))
                );
                const combined = xmls.join('');
                if (!combined) continue;

                // Alle <s>-Elemente (Stops = Fahrten) durchsuchen
                // <s id="..."><tl ... n="10613" c="RB" .../>...</s>
                const stops = combined.match(/<s\s[^>]*>[\s\S]*?<\/s>/g) || [];

                const match = stops.find(s => {
                    const tl = /<tl([^>]*)>/.exec(s);
                    if (!tl) return false;
                    const n = /\bn="([^"]*)"/.exec(tl[1]);
                    return n && n[1] === q;
                });

                if (match) {
                    // tripId aus id-Attribut des <s>-Elements
                    const idM   = /^<s\s[^>]*\bid="([^"]*)"/.exec(match);
                    const tlM   = /<tl([^>]*)>/.exec(match);
                    const tlStr = tlM ? tlM[1] : '';
                    const cat   = (/\bc="([^"]*)"/.exec(tlStr)||[])[1] || '';
                    const num   = (/\bn="([^"]*)"/.exec(tlStr)||[])[1] || q;

                    // Abfahrtszeit aus <dp pt="...">
                    const dpM   = /<dp[^>]*\bpt="([^"]*)"/.exec(match);
                    const dest  = /<dp[^>]*\bl="([^"]*)"/.exec(match);

                    // Jetzt Fahrtverlauf via v6.db.transport.rest holen
                    // Dafür brauchen wir die tripId – diese aus IRIS-ID ableiten
                    // Format: "8000085-2404180613-1" → suche in DB REST nach Abfahrten
                    const plannedDep = dpM ? dpM[1] : null; // YYMMDDHHMM
                    let fullTime = null;
                    if (plannedDep && plannedDep.length >= 8) {
                        const pYY = plannedDep.slice(0,2), pMM = plannedDep.slice(2,4),
                              pDD = plannedDep.slice(4,6), pHH = plannedDep.slice(6,8),
                              pMi = plannedDep.slice(8,10) || '00';
                        fullTime = `20${pYY}-${pMM}-${pDD}T${pHH}:${pMi}:00`;
                    }

                    // DB REST: Abfahrten am Hub zur gefundenen Zeit → tripId holen
                    if (fullTime) {
                        const depUrl = `https://v6.db.transport.rest/stops/${hub.eva}/departures` +
                                       `?when=${encodeURIComponent(fullTime)}&duration=5&results=30&stopovers=false&remarks=false`;
                        const depR   = await fetch(depUrl, { signal: AbortSignal.timeout(8000) });
                        if (depR.ok) {
                            const depData  = await depR.json();
                            const departures = depData.departures || depData || [];
                            const depMatch   = departures.find(d => {
                                const name = (d.line?.name || '').toUpperCase().replace(/\s+/g,'');
                                const qFull = `${cat}${num}`.toUpperCase().replace(/\s+/g,'');
                                return name === qFull || name.endsWith(num);
                            });

                            if (depMatch?.tripId) {
                                // Fahrtverlauf holen
                                const tripUrl = `https://v6.db.transport.rest/trips/${encodeURIComponent(depMatch.tripId)}?stopovers=true&remarks=true`;
                                const tripR   = await fetch(tripUrl, { signal: AbortSignal.timeout(10000) });
                                if (tripR.ok) {
                                    const tripData = await tripR.json();
                                    const trip     = tripData.trip ?? tripData;
                                    const stopovers = (trip.stopovers || []).map(s => ({
                                        stop: { name: s.stop?.name || '', id: s.stop?.id,
                                                location: s.stop?.location || null },
                                        plannedArrival:    s.plannedArrival   || null,
                                        arrival:           s.arrival          || null,
                                        plannedDeparture:  s.plannedDeparture || null,
                                        departure:         s.departure        || null,
                                        arrivalDelaySec:   s.arrival   && s.plannedArrival   ? Math.round((new Date(s.arrival)-new Date(s.plannedArrival))/1000) : null,
                                        departureDelaySec: s.departure && s.plannedDeparture ? Math.round((new Date(s.departure)-new Date(s.plannedDeparture))/1000) : null,
                                        platform:        s.platform        || null,
                                        plannedPlatform: s.plannedPlatform || null,
                                        cancelled:  s.cancelled  || false,
                                        additional: s.additional || false,
                                        remarks: (s.remarks||[]).map(r=>({text:r.text||'',type:r.type||'info'}))
                                    }));
                                    return res.json({
                                        stopovers,
                                        line:    trip.line || { name: `${cat} ${num}` },
                                        source:  'DB IRIS + REST',
                                        remarks: (trip.remarks||[]).map(r=>({text:r.text||'',type:r.type||'info'})),
                                        tripId:  depMatch.tripId,
                                        dbTripId: depMatch.tripId
                                    });
                                }
                            }
                        }
                    }

                    // Fallback: nur Metadaten zurückgeben wenn kein tripId gefunden
                    return res.json({
                        stopovers: [],
                        line: { name: `${cat} ${num}` },
                        source: 'DB IRIS',
                        remarks: [],
                        irisMatch: true
                    });
                }
            }
        }

        res.status(404).json({ error: `Zug ${number} nicht gefunden` });
    } catch (e) {
        console.error('IRIS trip-search error:', e.message);
        res.status(502).json({ error: e.message });
    }
});

// ─── Server starten ───────────────────────────────────────────────────────────
const port = Number(process.env.PORT || 8787);
app.listen(port, '0.0.0.0', () => console.log(`🚀 dilaeit läuft auf Port ${port}`));
