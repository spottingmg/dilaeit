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

// ─── db-hafas (optional, dynamischer Import) ─────────────────────────────────
// `import { createDbHafas } from 'db-hafas'` FUNKTIONIERT NICHT –
// db-hafas v6 hat keinen Named Export. Der fehlerhafte Named Import
// wirft beim Serverstart einen SyntaxError/ReferenceError und
// verhindert, dass Express überhaupt startet → alle Routen 404.
// Lösung: dynamischer await import() mit Default-Export.
let hafas = null;
try {
  const mod = await import('db-hafas');
  const createFn = mod.default ?? mod.createDbHafas ?? mod.createHafas;
  if (typeof createFn === 'function') {
    hafas = createFn('dilaeit-app');
    console.log('✅ db-hafas initialisiert');
  } else {
    console.warn('⚠️  db-hafas: kein gültiger Default-Export. Exports:', Object.keys(mod));
  }
} catch (e) {
  console.warn('⚠️  db-hafas nicht verfügbar:', e.message, '→ nur VRR/REST');
}


// ─── GTFS-RT: deaktiviert (zu hoher RAM-Verbrauch beim Parsen des Feeds) ─────
// Die DB REST API (v6.db.transport.rest) liefert Delays inkl. Verfrühung
// bereits direkt in den /trips/:id Stopovers – kein separater Feed nötig.
const findGtfsRtUpdates = async () => null;
const gtfsRtEnabled = false;
const gtfsRtRawBuffer = null;
const gtfsRtLastFetch = 0;

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

// ─── Stationssuche (DB) – via v6.db.transport.rest, kein Hafas nötig ────────
app.get('/api/db/locations', async (req, res) => {
  try {
    const query = (req.query.query || '').toString().trim();
    if (query.length < 2) return res.json({ locations: [] });

    const url = `https://v6.db.transport.rest/locations?query=${encodeURIComponent(query)}&results=12&fuzzy=true`;
    const r   = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`DB API ${r.status}`);
    const data = await r.json();

    const locs = (Array.isArray(data) ? data : [])
      .filter(l => l.type === 'stop' || l.type === 'station')
      .map(l => ({ id: String(l.id), name: l.name, type: l.type, source: 'DB' }));

    res.json({ locations: locs });
  } catch (e) {
    console.error('DB locations error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─── Abfahrten (DB) – via v6.db.transport.rest ───────────────────────────────
app.get('/api/db/stops/:stopId/departures', async (req, res) => {
  try {
    const stopId = String(req.params.stopId || '').trim();
    if (!stopId) return res.status(400).json({ error: 'missing stopId' });

    const whenRaw = req.query.when ? decodeURIComponent(req.query.when) : null;
    const when    = whenRaw || new Date().toISOString();

    const url = `https://v6.db.transport.rest/stops/${encodeURIComponent(stopId)}/departures` +
                `?when=${encodeURIComponent(when)}&duration=120&results=60&remarks=true`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`DB API ${r.status}`);
    const data = await r.json();

    const departures = (data.departures || []).map(d => {
      const planned  = d.plannedWhen ? new Date(d.plannedWhen).toISOString() : null;
      const actual   = d.when        ? new Date(d.when).toISOString()        : planned;
      const delaySec = d.delay !== undefined ? d.delay
                     : (d.when && d.plannedWhen ? Math.round((new Date(d.when) - new Date(d.plannedWhen)) / 1000) : null);
      return {
        plannedWhen: planned, when: actual, delay: delaySec,
        platform: d.platform || d.plannedPlatform || null,
        plannedPlatform: d.plannedPlatform || null,
        cancelled: d.cancelled || false,
        direction: d.direction || 'Unbekannt',
        tripId: d.tripId, dbTripId: d.tripId,
        occupancy: d.occupancy ?? null,
        line: { name: d.line?.name || '???', product: d.line?.product || 'train' },
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

// ─── DB-Zugdetails – via v6.db.transport.rest ────────────────────────────────
app.get('/api/train-details/:tripId', async (req, res) => {
    try {
        const tripId = decodeURIComponent(req.params.tripId);
        const url = `https://v6.db.transport.rest/trips/${encodeURIComponent(tripId)}?stopovers=true&remarks=true`;
        const r   = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`DB API ${r.status}`);
        const data = await r.json();
        const trip = data.trip ?? data;
        if (!trip?.stopovers) throw new Error('Keine Stopovers');

        // Debug: log first stopover to see available delay fields
        if (trip.stopovers?.[0]) {
            const s0 = trip.stopovers[0];
            console.log('[train-details] stopover fields sample:', JSON.stringify({
                name: s0.stop?.name,
                delay: s0.delay,
                arrivalDelay: s0.arrivalDelay,
                departureDelay: s0.departureDelay,
                arrival: s0.arrival,
                plannedArrival: s0.plannedArrival,
                departure: s0.departure,
                plannedDeparture: s0.plannedDeparture,
            }));
        }
        const stopovers = trip.stopovers.map(s => {
            const plannedArrival   = s.plannedArrival   ? new Date(s.plannedArrival).toISOString()   : null;
            const arrival          = s.arrival          ? new Date(s.arrival).toISOString()          : null;
            const plannedDeparture = s.plannedDeparture ? new Date(s.plannedDeparture).toISOString() : null;
            const departure        = s.departure        ? new Date(s.departure).toISOString()        : null;
            return {
                stop: {
                    name: s.stop?.name || '',
                    id:   s.stop?.id,
                    // Koordinaten für Karte mitgeben
                    location: s.stop?.location
                        ? { latitude: s.stop.location.latitude, longitude: s.stop.location.longitude }
                        : null
                },
                plannedArrival, arrival, plannedDeparture, departure,
                // Delay-Berechnung: mehrere Quellen, erste nicht-null gewinnt
                // 1. Explizite Felder (arrivalDelay/departureDelay) vom API
                // 2. Zeitdifferenz Ist-Soll (wenn beide vorhanden)
                // 3. Trip-level delay (s.delay) - gilt für alle Halte gleichmäßig
                // 4. Aus departure-plannedDeparture wenn departure gesetzt (db-vendo-client)
                arrivalDelaySec: (() => {
                    if (s.arrivalDelay   !== undefined && s.arrivalDelay   !== null) return s.arrivalDelay;
                    if (arrival   && plannedArrival)   return Math.round((new Date(arrival)   - new Date(plannedArrival))   / 1000);
                    if (s.delay !== undefined && s.delay !== null)                   return s.delay;
                    return null;
                })(),
                departureDelaySec: (() => {
                    if (s.departureDelay !== undefined && s.departureDelay !== null) return s.departureDelay;
                    if (departure && plannedDeparture) return Math.round((new Date(departure) - new Date(plannedDeparture)) / 1000);
                    if (s.delay !== undefined && s.delay !== null)                   return s.delay;
                    return null;
                })(),
                platform: s.platform || null,
                plannedPlatform: s.plannedPlatform || s.platform || null,
                cancelled: s.cancelled || false,
                additional: s.additional || false,
                remarks: s.remarks || []
            };
        });

        res.json({
            stopovers,
            remarks: (trip.remarks || []).map(r => ({ text: r.text || r.summary || '', type: r.category || 'info' })),
            source: 'Deutsche Bahn',
            tripId: trip.id,
            line: trip.line ? { name: trip.line.name, product: trip.line.product, operator: trip.line.operator?.name } : null
        });
    } catch (e) {
        console.error('train-details error:', e.message);
        res.status(502).json({ error: e.message });
    }
});

// ─── VRR-Fahrtverlauf ────────────────────────────────────────────────────────
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
    const stopovers = (Array.isArray(seq) ? seq : []).map(s => {
      const plannedArrival   = toIsoStringOrNull(s.arrivalTimePlanned);
      const arrival          = toIsoStringOrNull(s.arrivalTimeEstimated);
      const plannedDeparture = toIsoStringOrNull(s.departureTimePlanned);
      const departure        = toIsoStringOrNull(s.departureTimeEstimated);

      // Delay in Sekunden (kann negativ sein = Verfrühung)
      const arrivalDelaySec   = arrival   && plannedArrival
        ? Math.round((new Date(arrival)   - new Date(plannedArrival))   / 1000) : null;
      const departureDelaySec = departure && plannedDeparture
        ? Math.round((new Date(departure) - new Date(plannedDeparture)) / 1000) : null;

      return {
        stop:             { name: s.name || s.parent?.name || '' },
        plannedArrival, arrival, plannedDeparture, departure,
        arrivalDelaySec, departureDelaySec,
        plannedPlatform:  s.properties?.plannedPlatformName || s.properties?.platformName || null,
        platform:         s.properties?.platformName || s.properties?.platform || null,
        cancelled:        false,
        additional:       false,
      };
    });

    res.json({ stopovers, remarks: [], source: 'VRR OpenService' });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ─── Fahrten nach Nummer suchen (Autocomplete) – via v6.db.transport.rest ────
app.get('/api/db/trips-by-name', async (req, res) => {
    const { query, date } = req.query;
    if (!query) return res.status(400).json({ error: 'Missing query' });
    try {
        const when = date ? `${date}T08:00:00` : new Date().toISOString();
        const q    = query.trim().toUpperCase().replace(/\s+/g, '');
        const seen = new Set();
        let trips  = [];

        // Schnell: DB /trips?query Endpoint (kein Hbf-Umweg)
        try {
            const searchUrl = `https://v6.db.transport.rest/trips?query=${encodeURIComponent(query)}&onlyCurrentlyRunning=false&when=${encodeURIComponent(when)}`;
            const sr = await fetch(searchUrl, { signal: AbortSignal.timeout(5000) });
            if (sr.ok) {
                const sd = await sr.json();
                trips = (sd.trips || [])
                    .filter(t => {
                        const name = (t.line?.name || '').toUpperCase().replace(/\s+/g, '');
                        return (name === q || name.includes(q)) && t.id && !seen.has(t.id) && seen.add(t.id);
                    })
                    .slice(0, 15)
                    .map(t => ({
                        id: t.id,
                        name: t.line?.name || query,
                        direction: t.destination?.name || t.direction || 'Unbekannt',
                        line: t.line,
                        plannedDeparture: t.plannedWhen || t.departure || null
                    }));
            }
        } catch {}

        // Fallback: Köln Hbf (nur 2h, 80 Ergebnisse – viel schneller als Frankfurt/720min)
        if (!trips.length) {
            const url = `https://v6.db.transport.rest/stops/8000207/departures` +
                        `?when=${encodeURIComponent(when)}&duration=120&results=80&remarks=false`;
            const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (!r.ok) throw new Error(`DB API ${r.status}`);
            const data = await r.json();
            trips = (data.departures || [])
                .filter(d => {
                    const name = (d.line?.name || '').toUpperCase().replace(/\s+/g, '');
                    return (name === q || name.includes(q)) && d.tripId && !seen.has(d.tripId) && seen.add(d.tripId);
                })
                .slice(0, 15)
                .map(d => ({
                    id: d.tripId,
                    name: d.line?.name || query,
                    direction: d.direction || 'Unbekannt',
                    line: d.line,
                    plannedDeparture: d.plannedWhen || null
                }));
        }

        res.json({ trips });
    } catch (e) {
        console.error('trips-by-name error:', e.message);
        res.json({ trips: [], error: e.message });
    }
});

// ─── Fahrtverlauf nach Nummer/TripId – via v6.db.transport.rest ──────────────
app.get('/api/db/trip-details', async (req, res) => {
    const { number, date, tripId } = req.query;
    if (!number && !tripId) return res.status(400).json({ error: 'Missing number or tripId' });
    try {
        let finalTripId = tripId;
        if (!finalTripId) {
            const when = date ? `${date}T08:00:00` : new Date().toISOString();
            const url  = `https://v6.db.transport.rest/stops/8000085/departures` +
                         `?when=${encodeURIComponent(when)}&duration=720&results=300&remarks=false`;
            const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (!r.ok) throw new Error(`DB API ${r.status}`);
            const data = await r.json();
            const q = number.trim().toUpperCase().replace(/\s+/g, '');
            const match = (data.departures || []).find(d => {
                const name = (d.line?.name || '').toUpperCase().replace(/\s+/g, '');
                return name === q && d.tripId;
            });
            if (!match?.tripId) return res.status(404).json({ error: 'Fahrt nicht gefunden' });
            finalTripId = match.tripId;
        }

        const tripUrl = `https://v6.db.transport.rest/trips/${encodeURIComponent(finalTripId)}?stopovers=true&remarks=true`;
        const tr = await fetch(tripUrl, { signal: AbortSignal.timeout(10000) });
        if (!tr.ok) throw new Error(`DB trip API ${tr.status}`);
        const tData = await tr.json();
        const trip  = tData.trip ?? tData;
        if (!trip?.stopovers) throw new Error('Keine Stopovers');

        const stopovers = trip.stopovers.map(s => {
            const pA = s.plannedArrival   ? new Date(s.plannedArrival).toISOString()   : null;
            const a  = s.arrival          ? new Date(s.arrival).toISOString()          : null;
            const pD = s.plannedDeparture ? new Date(s.plannedDeparture).toISOString() : null;
            const d  = s.departure        ? new Date(s.departure).toISOString()        : null;
            return {
                stop: { name: s.stop?.name || '', id: s.stop?.id },
                plannedArrival: pA, arrival: a, plannedDeparture: pD, departure: d,
                arrivalDelaySec: (() => {
                    if (s.arrivalDelay   !== undefined && s.arrivalDelay   !== null) return s.arrivalDelay;
                    if (a && pA) return Math.round((new Date(a) - new Date(pA)) / 1000);
                    if (s.delay !== undefined && s.delay !== null) return s.delay;
                    return null;
                })(),
                departureDelaySec: (() => {
                    if (s.departureDelay !== undefined && s.departureDelay !== null) return s.departureDelay;
                    if (d && pD) return Math.round((new Date(d) - new Date(pD)) / 1000);
                    if (s.delay !== undefined && s.delay !== null) return s.delay;
                    return null;
                })(),
                platform: s.platform || null, plannedPlatform: s.plannedPlatform || null,
                cancelled: s.cancelled || false, additional: s.additional || false,
                remarks: s.remarks || []
            };
        });

        res.json({
            tripId: trip.id, line: trip.line, stopovers,
            remarks: (trip.remarks || []).map(r => ({ text: r.text || r.summary || '', type: r.category || 'info' })),
            source: 'Deutsche Bahn', operator: trip.line?.operator, mode: trip.line?.product
        });
    } catch (e) {
        console.error('DB trip-details error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── Server starten ───────────────────────────────────────────────────────────
const port = Number(process.env.PORT || 8787);
app.listen(port, '0.0.0.0', () => console.log(`🚀 dilaeit läuft auf Port ${port}`));
