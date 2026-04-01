import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

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

// ─── db-hafas (optional) ─────────────────────────────────────────────────────
import hafasModule from 'db-hafas';
const createHafas = hafasModule.createHafas || hafasModule;
let hafas = null;
try {
  hafas = createHafas('dilaeit-app');
  console.log('✅ db-hafas initialisiert');
} catch (e) {
  console.warn('⚠️  db-hafas konnte nicht initialisiert werden:', e.message);
}

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

// ─── Stationssuche ───────────────────────────────────────────────────────────
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
          const dbRes = await hafas.departures(uicMatch[1], {
            duration: 60,
            products: { bus: false, tram: false, subway: false,
                        nationalExpress: true, national: true, regional: true, suburban: true }
          });
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
          if (stationSearch?.length > 0) {
            const station = stationSearch[0];
            const dbRes = await hafas.departures(station.id, {
              duration: 60,
              products: { bus: false, tram: false, subway: false,
                          nationalExpress: true, national: true, regional: true, suburban: true }
            });
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
        const trip = await hafas.trip(tripId, {
            polylines: false,
            stopovers: true,
            // Detaillierte Echtzeitdaten anfordern
            remarks: true,
            scheduled: false
        });

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
        const trips = await hafas.tripsByName(query, {
            when: date ? new Date(date) : new Date(),
            results: 20
        });

        res.json({
            trips: (trips || []).map(t => ({
                id: t.id,
                name: t.line?.name || t.direction || 'Unbekannt',
                direction: t.direction,
                line: t.line,
                plannedDeparture: t.plannedDeparture || (t.stopovers?.[0]?.plannedDeparture)
            }))
        });
    } catch (e) {
        console.error('DB trips by name error:', e);
        res.status(500).json({ error: 'Error searching for trips' });
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
            let trips = await hafas.tripsByName(number, {
                when: date ? new Date(date) : new Date(),
                results: 3
            });

            if ((!trips || trips.length === 0) && isNaN(number)) {
                const cleanNumber = number.replace(/^[A-Z]+\s*/i, '');
                if (cleanNumber !== number) {
                    trips = await hafas.tripsByName(cleanNumber, {
                        when: date ? new Date(date) : new Date(),
                        results: 3
                    });
                }
            }

            if (!trips || trips.length === 0) {
                return res.status(404).json({ error: 'Trip not found' });
            }
            finalTripId = trips[0].id;
        }

        const trip = await hafas.trip(finalTripId, {
            stopovers: true,
            remarks: true,
            scheduled: true
        });

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

// ─── Server starten ───────────────────────────────────────────────────────────
const port = Number(process.env.PORT || 8787);
app.listen(port, '0.0.0.0', () => console.log(`🚀 dilaeit läuft auf Port ${port}`));
