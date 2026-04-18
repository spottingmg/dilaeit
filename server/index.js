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
const app = express();
const EFA_VERSION = process.env.EFA_VERSION || '10.4.18.18';

// VRR EFA-Endpunkte mit Fallback-Kette
const EFA_ENDPOINTS = [
    process.env.OPEN_SERVICE_BASE,
    'https://openservice.vrr.de/vrr2',
    'https://www.vrr.de/vrr-efa',
    'https://openservice-test.vrr.de/openservice',
].filter(Boolean);

let activeEfaBase = EFA_ENDPOINTS[0];

// Beim Start den ersten erreichbaren Endpunkt ermitteln
(async () => {
    for (const base of EFA_ENDPOINTS) {
        try {
            const url = `${base}/XML_STOPFINDER_REQUEST?outputFormat=rapidJSON&version=${EFA_VERSION}&language=de&type_sf=any&name_sf=K%C3%B6ln&anyObjFilter_sf=2&locationServerActive=1`;
            const r   = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (r.ok) {
                const d = await r.json();
                if (d?.locations?.length > 0) {
                    activeEfaBase = base;
                    console.log(`✅ VRR EFA aktiv: ${base}`);
                    return;
                }
            }
        } catch {}
        console.warn(`⚠️  VRR EFA nicht erreichbar: ${base}`);
    }
    console.error('❌ Kein VRR EFA-Endpunkt erreichbar!');
})();

// Dynamisches OPEN_SERVICE_BASE – nutzt immer den aktiven Endpunkt
const OPEN_SERVICE_BASE = () => activeEfaBase;

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
  const url = new URL(`${OPEN_SERVICE_BASE()}/${endpoint}`);
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
  ok: true, hafas: !!hafas, openServiceBase: OPEN_SERVICE_BASE()
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

    // Primär: v6.db.transport.rest (CORS-offen, schnell für Stationssuche)
    const url = `https://v6.db.transport.rest/locations?query=${encodeURIComponent(query)}&results=12&fuzzy=true`;
    const r   = await fetch(url, { signal: AbortSignal.timeout(6000) });
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

// ─── Abfahrten (DB) – bahnhof.de (RIS-Qualität, kein Key) ────────────────────
app.get('/api/db/stops/:stopId/departures', async (req, res) => {
  try {
    const stopId  = String(req.params.stopId || '').trim();
    if (!stopId) return res.status(400).json({ error: 'missing stopId' });

    const whenRaw = req.query.when ? decodeURIComponent(req.query.when) : null;

    // bahnhof.de liefert immer ab jetzt, timeOffset in Minuten
    // Wenn when in der Vergangenheit oder weit in der Zukunft → v6 als Fallback
    let useBahnhof = true;
    let timeOffset = 0;
    if (whenRaw) {
        const diff = Math.round((new Date(whenRaw) - Date.now()) / 60000);
        if (diff < -5 || diff > 360) useBahnhof = false; // bahnhof.de nur ±6h ab jetzt
        else timeOffset = Math.max(0, diff);
    }

    if (useBahnhof) {
        try {
            const url = `https://www.bahnhof.de/api/boards/departures` +
                        `?evaNumbers=${encodeURIComponent(stopId)}&duration=120&locale=de` +
                        (timeOffset > 0 ? `&timeOffset=${timeOffset}` : '');
            const r = await fetch(url, {
                signal: AbortSignal.timeout(8000),
                headers: { 'User-Agent': 'dilaeit/1.0 (https://dilaeit.onrender.com)' }
            });
            if (!r.ok) throw new Error(`bahnhof.de ${r.status}`);
            const data = await r.json();

            const entries = data.entries || data.departures || (Array.isArray(data) ? data : []);
            const departures = entries.map(e => {
                const transport = e.transport || {};
                const time      = e.time?.departure || e.departure || {};
                const planned   = time.scheduled ? new Date(time.scheduled).toISOString() : null;
                const actual    = time.actual     ? new Date(time.actual).toISOString()   : planned;
                const delaySec  = (time.delay !== undefined && time.delay !== null)
                    ? time.delay * 60  // bahnhof.de gibt Minuten
                    : (planned && actual ? Math.round((new Date(actual) - new Date(planned)) / 1000) : null);
                return {
                    plannedWhen: planned, when: actual, delay: delaySec,
                    platform:        e.platform?.actual    || e.platform?.scheduled    || null,
                    plannedPlatform: e.platform?.scheduled || null,
                    cancelled:  e.cancelled  || e.isCancelled  || false,
                    direction:  transport.destination?.name || e.destination || 'Unbekannt',
                    tripId:     transport.tripId || e.tripId || null,
                    dbTripId:   transport.tripId || e.tripId || null,
                    occupancy:  e.occupancy ?? null,
                    line: {
                        name:    transport.line || transport.number || e.line?.name || '???',
                        product: transport.type?.toLowerCase() || e.line?.product || 'train'
                    },
                    _source: 'Deutsche Bahn (RIS)'
                };
            }).filter(d => d.plannedWhen);

            return res.json({ departures });
        } catch (e) {
            console.warn('bahnhof.de departures failed, fallback to v6:', e.message);
        }
    }

    // Fallback: v6.db.transport.rest
    const when = whenRaw || new Date().toISOString();
    const url  = `https://v6.db.transport.rest/stops/${encodeURIComponent(stopId)}/departures` +
                 `?when=${encodeURIComponent(when)}&duration=120&results=60&remarks=true`;
    const r    = await fetch(url, { signal: AbortSignal.timeout(10000) });
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

    // ── DB-Abgleich für Züge via v6.db.transport.rest ────────────────────────
    const trainPrefixes = ['ICE','IC','ICD','RE','RB','IRE','EC','EN','TGV','NJ','RJ','RS'];
    const hasTrains = departures.some(dep => {
        const name = (dep.line?.name || '').toUpperCase();
        return trainPrefixes.some(p => name === p || name.startsWith(p+' ') || name.startsWith(p+'-') || (name.startsWith(p) && /\d/.test(name[p.length]))) || /^S\s*\d+/i.test(name);
    });
    if (hasTrains) {
        try {
            const whenRaw2 = req.query.when ? decodeURIComponent(req.query.when) : new Date().toISOString();
            const dbUrl  = `https://v6.db.transport.rest/stops/${encodeURIComponent(stopId)}/departures?when=${encodeURIComponent(whenRaw2)}&duration=60&results=60&remarks=false`;
            const dbR    = await fetch(dbUrl, { signal: AbortSignal.timeout(6000) });
            if (dbR.ok) {
                const dbData = await dbR.json();
                const dbDeps = dbData.departures || [];
                departures.forEach(dep => {
                    const name = (dep.line?.name || '').toUpperCase();
                    const isTrain = trainPrefixes.some(p => name === p || name.startsWith(p+' ') || name.startsWith(p+'-') || (name.startsWith(p) && /\d/.test(name[p.length]))) || /^S\s*\d+/i.test(name);
                    if (!isTrain) return;
                    const dbMatch = dbDeps.find(d => d.line?.name === dep.line.name);
                    if (dbMatch) {
                        if (dbMatch.delay !== undefined) dep.delay = dbMatch.delay;
                        if (dbMatch.tripId)             dep.dbTripId = dbMatch.tripId;
                        if (dbMatch.when)               dep.when = dbMatch.when;
                        dep._source = 'Deutsche Bahn';
                    }
                });
            }
        } catch (e) { console.warn('DB-Abgleich fehlgeschlagen:', e.message); }
    }
    // ─────────────────────────────────────────────────────────────────────────

    res.json({ departures });
  } catch (e) { console.error('departures error', e); res.status(502).json({ error: e.message }); }
});

// ─── DB-Zugdetails – app.services-bahn.de (Vendo/Movas, RIS-Qualität) ─────────
const VENDO_BASE = 'https://app.services-bahn.de/mob';

function vendoCorrelationId() {
    // Einfache UUID v4-ähnliche ID ohne externe Deps
    const s = () => Math.random().toString(36).slice(2, 10);
    return `${s()}${s()}_${s()}${s()}`;
}

app.get('/api/train-details/:tripId', async (req, res) => {
    try {
        const tripId = decodeURIComponent(req.params.tripId);

        // Vendo zuglauf – kein API-Key, HAFAS-kompatible trip IDs
        const url = `${VENDO_BASE}/zuglauf/${encodeURIComponent(tripId)}`;
        const r   = await fetch(url, {
            signal: AbortSignal.timeout(10000),
            headers: {
                'Accept':            'application/x.db.vendo.mob.zuglauf.v2+json',
                'Content-Type':      'application/x.db.vendo.mob.zuglauf.v2+json',
                'X-Correlation-ID':  vendoCorrelationId(),
                'User-Agent':        'dilaeit/1.0 (https://dilaeit.onrender.com)'
            }
        });

        if (!r.ok) throw new Error(`vendo ${r.status}: ${await r.text().catch(()=>'')}`);
        const data = await r.json();

        // Vendo zuglauf Format: data.zuglaufAbschnitte[] oder data.halte[]
        const halte = data.halte || data.zuglaufAbschnitte || data.stops || [];

        const stopovers = halte.map(h => {
            // Vendo Felder: ankunftsDatum, ezAnkunftsDatum, abfahrtsDatum, ezAbfahrtsDatum
            const pA = h.ankunftsDatum     ? new Date(h.ankunftsDatum).toISOString()   : null;
            const aA = h.ezAnkunftsDatum   ? new Date(h.ezAnkunftsDatum).toISOString() : null;
            const pD = h.abfahrtsDatum     ? new Date(h.abfahrtsDatum).toISOString()   : null;
            const aD = h.ezAbfahrtsDatum   ? new Date(h.ezAbfahrtsDatum).toISOString(): null;

            // Koordinaten
            const loc = h.station?.koordinaten || h.koordinaten || null;

            return {
                stop: {
                    name:     h.station?.name || h.name || '',
                    id:       h.station?.evaNumber || h.evaNumber || h.id || null,
                    location: loc ? { latitude: loc.breite || loc.lat, longitude: loc.laenge || loc.lon } : null
                },
                plannedArrival:    pA,
                arrival:           aA || pA,
                plannedDeparture:  pD,
                departure:         aD || pD,
                arrivalDelaySec:   aA && pA ? Math.round((new Date(aA) - new Date(pA)) / 1000) : null,
                departureDelaySec: aD && pD ? Math.round((new Date(aD) - new Date(pD)) / 1000) : null,
                platform:        h.gleis?.aktuell     || h.gleis     || h.platform || null,
                plannedPlatform: h.gleis?.geplant     || h.gleis     || null,
                cancelled:  h.haltAusfall   || h.cancelled  || false,
                additional: h.haltZusatz    || h.additional || false,
                remarks: (h.hinweise || h.remarks || []).map(m => ({
                    text: m.text || m.message || '',
                    type: m.typ  || m.type    || 'info'
                }))
            };
        });

        const transport = data.transport || data.zuglauf || data.line || {};
        res.json({
            stopovers,
            remarks: (data.hinweise || data.remarks || []).map(m => ({
                text: m.text || '', type: m.typ || 'info'
            })),
            source:  'Deutsche Bahn (RIS)',
            tripId:  data.tripId || tripId,
            line: {
                name:    transport.kurzText || transport.name || transport.nummer || '',
                product: transport.typ?.toLowerCase() || 'train',
                operator: transport.betreiber?.name || null
            }
        });

    } catch (e) {
        // Fallback: v6.db.transport.rest
        console.warn('vendo zuglauf failed, fallback v6:', e.message);
        try {
            const tripId = decodeURIComponent(req.params.tripId);
            const url = `https://v6.db.transport.rest/trips/${encodeURIComponent(tripId)}?stopovers=true&remarks=true`;
            const r   = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (!r.ok) throw new Error(`v6 ${r.status}`);
            const data = await r.json();
            const trip = data.trip ?? data;
            if (!trip?.stopovers) throw new Error('no stopovers');

            const stopovers = trip.stopovers.map(s => {
                const pA = s.plannedArrival   ? new Date(s.plannedArrival).toISOString()   : null;
                const a  = s.arrival          ? new Date(s.arrival).toISOString()          : null;
                const pD = s.plannedDeparture ? new Date(s.plannedDeparture).toISOString() : null;
                const d  = s.departure        ? new Date(s.departure).toISOString()        : null;
                return {
                    stop: { name: s.stop?.name || '', id: s.stop?.id,
                            location: s.stop?.location ? { latitude: s.stop.location.latitude, longitude: s.stop.location.longitude } : null },
                    plannedArrival: pA, arrival: a, plannedDeparture: pD, departure: d,
                    arrivalDelaySec:   a && pA ? Math.round((new Date(a)-new Date(pA))/1000) : null,
                    departureDelaySec: d && pD ? Math.round((new Date(d)-new Date(pD))/1000) : null,
                    platform: s.platform || null, plannedPlatform: s.plannedPlatform || null,
                    cancelled: s.cancelled || false, additional: s.additional || false, remarks: s.remarks || []
                };
            });
            res.json({ stopovers,
                remarks: (trip.remarks||[]).map(r=>({text:r.text||'',type:r.type||'info'})),
                source: 'Deutsche Bahn', tripId: trip.id,
                line: trip.line ? { name: trip.line.name, product: trip.line.product } : null });
        } catch (e2) {
            res.status(502).json({ error: e.message });
        }
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
    const stopovers = (Array.isArray(seq) ? seq : []).map(s => ({
      stop:             { name: s.name || s.parent?.name || '' },
      plannedArrival:   toIsoStringOrNull(s.arrivalTimePlanned),
      arrival:          toIsoStringOrNull(s.arrivalTimeEstimated),
      plannedDeparture: toIsoStringOrNull(s.departureTimePlanned),
      departure:        toIsoStringOrNull(s.departureTimeEstimated),
      plannedPlatform:  s.properties?.plannedPlatformName || s.properties?.platformName || null,
      platform:         s.properties?.platformName || s.properties?.platform || null,
      cancelled: false, additional: false,
    }));
    res.json({ stopovers, remarks: [], source: 'VRR OpenService' });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ─── trips-by-name & trip-details – via v6.db.transport.rest ─────────────────
app.get('/api/db/trips-by-name', async (req, res) => {
    const { query, date } = req.query;
    if (!query) return res.status(400).json({ error: 'Missing query' });
    try {
        const when = date ? `${date}T08:00:00` : new Date().toISOString();
        const url  = `https://v6.db.transport.rest/stops/8000085/departures?when=${encodeURIComponent(when)}&duration=720&results=200&remarks=false`;
        const r    = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`DB API ${r.status}`);
        const data = await r.json();
        const q = query.trim().toUpperCase().replace(/\s+/g,'');
        const seen = new Set();
        const trips = (data.departures||[]).filter(d => {
            const name = (d.line?.name||'').toUpperCase().replace(/\s+/g,'');
            return (name===q||name.includes(q)) && d.tripId && !seen.has(d.tripId) && seen.add(d.tripId);
        }).slice(0,15).map(d => ({
            id: d.tripId, name: d.line?.name||query,
            direction: d.direction||'Unbekannt', line: d.line,
            plannedDeparture: d.plannedWhen||null
        }));
        res.json({ trips });
    } catch (e) { res.json({ trips: [], error: e.message }); }
});

app.get('/api/db/trip-details', async (req, res) => {
    const { number, date, tripId } = req.query;
    if (!number && !tripId) return res.status(400).json({ error: 'Missing number or tripId' });
    try {
        let finalTripId = tripId;
        if (!finalTripId) {
            const when = date ? `${date}T08:00:00` : new Date().toISOString();
            const url  = `https://v6.db.transport.rest/stops/8000085/departures?when=${encodeURIComponent(when)}&duration=720&results=300&remarks=false`;
            const r    = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (!r.ok) throw new Error(`DB API ${r.status}`);
            const data = await r.json();
            const q    = number.trim().toUpperCase().replace(/\s+/g,'');
            const match = (data.departures||[]).find(d => (d.line?.name||'').toUpperCase().replace(/\s+/g,'')===q && d.tripId);
            if (!match?.tripId) return res.status(404).json({ error: 'Fahrt nicht gefunden' });
            finalTripId = match.tripId;
        }
        const tr = await fetch(`https://v6.db.transport.rest/trips/${encodeURIComponent(finalTripId)}?stopovers=true&remarks=true`, { signal: AbortSignal.timeout(10000) });
        if (!tr.ok) throw new Error(`DB trip API ${tr.status}`);
        const tData = await tr.json();
        const trip  = tData.trip ?? tData;
        if (!trip?.stopovers) throw new Error('Keine Stopovers');
        const stopovers = trip.stopovers.map(s => {
            const pA=s.plannedArrival?new Date(s.plannedArrival).toISOString():null;
            const a=s.arrival?new Date(s.arrival).toISOString():null;
            const pD=s.plannedDeparture?new Date(s.plannedDeparture).toISOString():null;
            const d=s.departure?new Date(s.departure).toISOString():null;
            return { stop:{name:s.stop?.name||'',id:s.stop?.id},
                plannedArrival:pA,arrival:a,plannedDeparture:pD,departure:d,
                arrivalDelaySec:a&&pA?Math.round((new Date(a)-new Date(pA))/1000):null,
                departureDelaySec:d&&pD?Math.round((new Date(d)-new Date(pD))/1000):null,
                platform:s.platform||null,plannedPlatform:s.plannedPlatform||null,
                cancelled:s.cancelled||false,additional:s.additional||false,remarks:s.remarks||[] };
        });
        res.json({ tripId:trip.id, line:trip.line, stopovers,
            remarks:(trip.remarks||[]).map(r=>({text:r.text||'',type:r.type||'info'})),
            source:'Deutsche Bahn', dbTripId: finalTripId });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
