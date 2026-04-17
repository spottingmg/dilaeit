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

// ─── Transitous / MOTIS2 ─────────────────────────────────────────────────────
const MOTIS   = 'https://api.transitous.org/api/v1';
const MOTIS_H = {
    'User-Agent': 'dilaeit/1.0 (https://dilaeit.onrender.com)',
    'Referer':    'https://dilaeit.onrender.com'
};
const motisProduct = m => {
    switch ((m || '').toUpperCase()) {
        case 'HIGHSPEED_RAIL': case 'LONG_DISTANCE': return 'nationalExpress';
        case 'INTER_REGIONAL_RAIL': case 'REGIONAL_FAST_RAIL':
        case 'REGIONAL_RAIL': return 'regional';
        case 'SUBURBAN': return 'suburban'; case 'METRO': return 'subway';
        case 'TRAM': return 'tram'; case 'BUS': case 'COACH': return 'bus';
        case 'FERRY': return 'ferry'; default: return 'train';
    }
};

// MOTIS stopId-Normalisierung:
// geocode gibt zurück: "de-DELFI_de:05116:23022:1:1" (mit feed-prefix + steig)
// stoptimes braucht:   "de:05116:23022" (nur GTFS-ID, ohne feed-prefix, ohne steig)
function motisStopId(id) {
    if (!id) return id;
    // Feed-prefix entfernen: "de-DELFI_de:05116:23022:1:1" → "de:05116:23022:1:1"
    const gtfs = id.includes('_') ? id.split('_')[1] : id;
    // Steig-Suffix entfernen: "de:05116:23022:1:1" → "de:05116:23022"
    const parts = gtfs.split(':');
    return parts.length > 3 ? parts.slice(0, 3).join(':') : gtfs;
}

async function motisGet(path) {
    const url = MOTIS + path;
    const r   = await fetch(url, { headers: MOTIS_H, signal: AbortSignal.timeout(8000) });
    const txt = await r.text();
    if (!r.ok) throw Object.assign(new Error(`MOTIS ${r.status}: ${txt.slice(0,200)}`), { motisBody: txt });
    try { return JSON.parse(txt); }
    catch(e) { throw new Error(`MOTIS JSON: ${txt.slice(0,100)}`); }
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

// Hilfs-Cache für EVA-Mapping
const evaMappingCache = new Map();

async function getEvaForStop(stopId) {
    if (evaMappingCache.has(stopId)) return evaMappingCache.get(stopId);
    
    // Wenn es schon nach EVA aussieht (80xxxxx oder 7xxxxx)
    if (/^(80|7)\d{5}$/.test(stopId)) return stopId;

    try {
        // Über Marudor VRR-Profil nach der Station suchen
        const url = `https://marudor.de/api/hafas/v2/location?searchTerm=${encodeURIComponent(stopId)}&profile=vrr`;
        const r = await fetch(url, { headers: { 'User-Agent': 'dilaeit-proxy/1.0' }, signal: AbortSignal.timeout(4000) });
        if (r.ok) {
            const data = await r.json();
            if (Array.isArray(data) && data.length > 0) {
                const eva = data[0].evaNumber;
                if (eva) {
                    evaMappingCache.set(stopId, eva);
                    return eva;
                }
            }
        }
    } catch (e) { console.warn(`EVA mapping failed for ${stopId}:`, e.message); }
    return stopId; // Fallback auf Original
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

// ─── MOTIS Debug ─────────────────────────────────────────────────────────────
// /api/motis-debug             → testet geocode "Köln Hbf"
// /api/motis-debug?q=MG        → geocode für beliebige Station
// /api/motis-debug?stopId=...  → testet stoptimes mit ID-Varianten
app.get('/api/motis-debug', async (req, res) => {
    const { q, stopId } = req.query;
    try {
        const testQuery = q || 'Mönchengladbach Hbf';
        const geoData   = await motisGet(`/geocode?text=${encodeURIComponent(testQuery)}&lang=de`);
        const items     = (Array.isArray(geoData) ? geoData : []).slice(0, 5);

        const geocodeResult = {
            query:    testQuery,
            count:    Array.isArray(geoData) ? geoData.length : 0,
            firstFull: items[0] || null,
            allKeys:  items[0] ? Object.keys(items[0]).join(', ') : '',
            preview:  items.map(l => ({
                id:          l.id,
                name:        l.name,
                type:        l.type,
                motisStopId: motisStopId(l.id),
                lat:         l.lat,
                lon:         l.lon
            }))
        };

        if (!stopId && items[0]?.id) {
            // Automatisch stoptimes mit dem ersten geocode-Ergebnis testen
            const sid  = motisStopId(items[0].id);
            const unix = Math.floor(Date.now() / 1000);
            let stoptimesResult;
            try {
                const d = await motisGet(`/stoptimes?stopId=${encodeURIComponent(sid)}&startTime=${unix}&duration=3600&n=3`);
                stoptimesResult = { ok: true, stopId: sid, count: (d.stopTimes||[]).length, first: (d.stopTimes||[])[0], allKeys: d ? Object.keys(d).join(', ') : '' };
            } catch(e) {
                stoptimesResult = { ok: false, stopId: sid, error: e.message };
            }
            return res.json({ geocode: geocodeResult, stoptimes: stoptimesResult });
        }

        if (stopId) {
            const unix    = Math.floor(Date.now() / 1000);
            const sid     = motisStopId(stopId);
            const tests   = [sid, stopId, stopId.includes('_') ? stopId.split('_')[1] : stopId];
            const results = [];
            for (const id of [...new Set(tests)]) {
                try {
                    const d = await motisGet(`/stoptimes?stopId=${encodeURIComponent(id)}&startTime=${unix}&duration=3600&n=3`);
                    results.push({ id, ok: true, count: (d.stopTimes||[]).length, first: (d.stopTimes||[])[0] });
                } catch(e) {
                    results.push({ id, ok: false, error: e.message });
                }
            }
            return res.json({ stopId, computed: sid, geocode: geocodeResult, stoptimes: results });
        }

        res.json({ geocode: geocodeResult });
    } catch(e) {
        res.status(502).json({ error: e.message, body: e.motisBody?.slice(0,500) });
    }
});


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
    const raw  = await motisGet(`/geocode?text=${encodeURIComponent(query)}&lang=de`);
    const seen = new Set(); const locs = [];
    for (const l of (Array.isArray(raw) ? raw : [])) {
        if (!l.name) continue;
        const sid = motisStopId(l.id || '');
        if (!sid || seen.has(sid)) continue;
        seen.add(sid);
        locs.push({ id: sid, name: l.name, lat: l.lat, lon: l.lon, type: 'stop', source: 'Transitous' });
        if (locs.length >= 12) break;
    }
    res.json({ locations: locs });
  } catch(e) {
    console.error('MOTIS geocode error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─── Abfahrten via Transitous/MOTIS ─────────────────────────────────────────
app.get('/api/db/stops/:stopId/departures', async (req, res) => {
  try {
    const rawId     = String(req.params.stopId || '').trim();
    if (!rawId) return res.status(400).json({ error: 'missing stopId' });
    const stopId    = motisStopId(rawId);   // "de:05116:23022" ohne feed-prefix
    const whenRaw   = req.query.when ? decodeURIComponent(req.query.when) : null;
    const startUnix = whenRaw ? Math.floor(new Date(whenRaw).getTime()/1000) : Math.floor(Date.now()/1000);
    const n         = Math.min(parseInt(req.query.results||'50',10), 100);

    console.log(`[stoptimes] ${rawId} → ${stopId}`);
    const data  = await motisGet(`/stoptimes?stopId=${encodeURIComponent(stopId)}&startTime=${startUnix}&duration=7200&n=${n}`);
    const items = data.stopTimes || (Array.isArray(data) ? data : []);
    console.log(`[stoptimes] ${items.length} results`);

    const departures = items.map(st => {
        const schMs    = st.scheduledTime != null ? st.scheduledTime * 1000 : null;
        const rtMs     = st.realtimeTime  != null ? st.realtimeTime  * 1000 : schMs;
        const delaySec = st.realtimeDelay != null ? st.realtimeDelay
            : (schMs != null && rtMs != null && schMs !== rtMs ? Math.round((rtMs-schMs)/1000) : null);
        const route    = st.route || {};
        return {
            plannedWhen:     schMs != null ? new Date(schMs).toISOString() : null,
            when:            rtMs  != null ? new Date(rtMs).toISOString()  : null,
            delay:           delaySec,
            platform:        st.realtimePlatform  || st.platform || null,
            plannedPlatform: st.scheduledPlatform || st.platform || null,
            cancelled:       st.cancelled  || false,
            direction:       st.headsign   || 'Unbekannt',
            tripId:          st.tripId     || null,
            dbTripId:        st.tripId     || null,
            line: {
                name:    route.shortName || st.routeShortName || st.displayName || route.longName || '?',
                product: motisProduct(route.mode || st.mode || ''),
                fahrtNr: (st.displayName||'').match(/\((\d+)\)/)?.[1] || null
            },
            _source: 'Transitous (MOTIS)'
        };
    });
    res.json({ departures });
  } catch(e) {
    console.error('[stoptimes] error:', e.message);
    res.status(502).json({ error: e.message });
  }
});


// ─── Abfahrten ───────────────────────────────────────────────────────────────
app.get('/api/stops/:stopId/departures', async (req, res) => {
  try {
    const stopId = String(req.params.stopId || '').trim();
    if (!stopId) return res.status(400).json({ error: 'missing stopId' });

    // VRR-Suche soll NUR EFA-Daten nutzen
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

    const data = await efaGet('XML_DM_REQUEST', {
        outputFormat: 'rapidJSON', version: EFA_VERSION,
        mode: 'direct', type_dm: 'stopID', name_dm: stopId,
        useRealtime: 1, itdDateDay, itdDateMonth, itdDateYear, itdTimeHour, itdTimeMinute,
        itdTripDateTimeDepArr: 'dep',
    });

    const finalDepartures = (data.stopEvents || []).map(ev => {
        const planned = toIsoStringOrNull(ev.departureTimePlanned);
        if (!planned) return null;

        const lineName = ev.transportation?.number || ev.transportation?.disassembledName || ev.transportation?.name || '???';
        const direction = ev.transportation?.destination?.name || '';
        const estimated = toIsoStringOrNull(ev.departureTimeEstimated);
        
        const hasRealtime = Array.isArray(ev.realtimeStatus)
            ? ev.realtimeStatus.length > 0 && !ev.realtimeStatus.some(s => /NO_?RT|UNAVAIL/i.test(String(s)))
            : estimated !== null;
            
        // EFA liefert oft 0 für Verfrühung, wir berechnen es manuell aus der Differenz
        const delaySec = estimated !== null
            ? Math.round((Date.parse(estimated) - Date.parse(planned)) / 1000)
            : (hasRealtime ? 0 : null);

        const platform = ev.location?.properties?.platform || ev.location?.properties?.platformName || null;
        const tripPayload = {
            line: ev.transportation?.id || null,
            stopID: stopId,
            tripCode: ev.transportation?.properties?.tripCode ?? null,
            date: toYyyymmddUtc(planned),
            time: toHmmUtc(planned)
        };
        const tripId = tripPayload.line && tripPayload.tripCode != null ? encodeTripId(tripPayload) : null;
        const cancelled = Array.isArray(ev.realtimeStatus) && ev.realtimeStatus.some(s => String(s).toUpperCase().includes('CANCEL'));

        return {
            plannedWhen: planned, when: estimated ?? planned, delay: delaySec,
            plannedPlatform: platform, platform, cancelled, direction,
            tripId, dbTripId: null, prognosis: { tripId, platform },
            line: {
                name: String(lineName).replace(/^.*?\s+/, '').trim() || String(lineName),
                product: (ev.transportation?.product?.name || 'bus').toLowerCase(),
                operator: ev.transportation?.operator?.name ? { name: ev.transportation?.operator?.name } : undefined
            },
            _source: 'VRR OpenService'
        };
    }).filter(Boolean);

    res.json({ departures: finalDepartures });
  } catch (e) {
    console.error('VRR Departures error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─── Hilfsfunktion für Marudor-API (sekundengenau, echte Verfrühung) ──────────
async function fetchMarudorTrip(tripId) {
    try {
        // marudor tripId ist meist identisch mit HAFAS tripId
        const url = `https://marudor.de/api/journey/v1/trip/${encodeURIComponent(tripId)}`;
        const r = await fetch(url, {
            headers: { 'User-Agent': 'dilaeit-proxy/1.0' },
            signal: AbortSignal.timeout(8000)
        });
        if (!r.ok) return null;
        const data = await r.json();
        if (!data || !data.stops) return null;

        const stopovers = data.stops.map(s => {
            const pA = s.arrival?.scheduledTime;
            const a  = s.arrival?.time;
            const pD = s.departure?.scheduledTime;
            const d  = s.departure?.time;
            return {
                stop: {
                    name: s.station.name,
                    id:   s.station.id,
                    location: s.station.location ? { latitude: s.station.location.latitude || s.station.location.lat, longitude: s.station.location.longitude || s.station.location.lng } : null
                },
                plannedArrival: pA, arrival: a,
                plannedDeparture: pD, departure: d,
                arrivalDelaySec: (a && pA) ? Math.round((new Date(a) - new Date(pA)) / 1000) : (s.arrival?.delay ?? null),
                departureDelaySec: (d && pD) ? Math.round((new Date(d) - new Date(pD)) / 1000) : (s.departure?.delay ?? null),
                platform: s.realtimePlatform || s.platform || null,
                plannedPlatform: s.platform || null,
                cancelled: s.arrival?.cancelled || s.departure?.cancelled || false,
                additional: s.additional || false,
                remarks: [] // Marudor hat remarks woanders oder anders strukturiert
            };
        });

        return {
            tripId: data.tripId || tripId,
            line: { name: data.train?.name || '', product: data.train?.type || 'train' },
            stopovers,
            remarks: [],
            source: 'Bahn.expert (Marudor)'
        };
    } catch (e) {
        console.warn('Marudor fetch failed:', e.message);
        return null;
    }
}

// ─── DB-Zugdetails – via Marudor (Primary) oder v6.db.transport.rest (Fallback) 
app.get('/api/train-details/:tripId', async (req, res) => {
    try {
        const tripId  = decodeURIComponent(req.params.tripId);
        const isHafas = tripId.includes('|');
        if (!isHafas) {
            try {
                const data  = await motisGet(`/trip/${encodeURIComponent(tripId)}`);
                const stops = data.stopTimes || data.stops || [];
                if (stops.length > 0) {
                    const stopovers = stops.map(s => {
                        const sA=s.scheduledArrivalTime??s.scheduledTime??null, rA=s.realtimeArrivalTime??null;
                        const sD=s.scheduledDepartureTime??s.scheduledTime??null, rD=s.realtimeDepartureTime??null;
                        const aD=s.arrivalDelay??s.realtimeDelay??(sA&&rA?rA-sA:null);
                        const dD=s.departureDelay??s.realtimeDelay??(sD&&rD?rD-sD:null);
                        return {
                            stop:{ name:s.stop?.name||s.name||'', id:s.stop?.id||s.stopId||null,
                                location:s.stop?.lat!=null?{latitude:s.stop.lat,longitude:s.stop.lon}:s.lat!=null?{latitude:s.lat,longitude:s.lon}:null },
                            plannedArrival:sA?new Date(sA*1000).toISOString():null, arrival:rA?new Date(rA*1000).toISOString():null,
                            plannedDeparture:sD?new Date(sD*1000).toISOString():null, departure:rD?new Date(rD*1000).toISOString():null,
                            arrivalDelaySec:aD, departureDelaySec:dD,
                            platform:s.realtimePlatform||s.track||s.platform||null,
                            plannedPlatform:s.scheduledPlatform||s.track||s.platform||null,
                            cancelled:s.cancelled||false, additional:s.additional||false,
                            remarks:(s.alerts||[]).map(a=>({text:a.headerText||a.text||'',type:'info'}))
                        };
                    });
                    let pl=null;
                    if(data.shape?.length) pl={type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'LineString',coordinates:data.shape.map(p=>[p.lon??p.lng,p.lat])},properties:{}}]};
                    else if(data.polyline) pl=data.polyline;
                    const route=data.route||{};
                    return res.json({ stopovers, polyline:pl,
                        remarks:(data.alerts||[]).map(a=>({text:a.headerText||'',type:'info'})),
                        source:'Transitous (MOTIS)', tripId:data.tripId||tripId,
                        line:{name:route.shortName||data.routeShortName||'',product:motisProduct(route.mode||'')} });
                }
            } catch(e){ console.warn('MOTIS trip failed:', e.message); }
        }
        const marudorData = await fetchMarudorTrip(tripId);
        if (marudorData) return res.json(marudorData);
        const r2=await fetch(`https://v6.db.transport.rest/trips/${encodeURIComponent(tripId)}?stopovers=true&remarks=true&polyline=true`,{signal:AbortSignal.timeout(8000)});
        if(!r2.ok) throw new Error(`DB REST ${r2.status}`);
        const d2=await r2.json(), trip=d2.trip??d2;
        if(!trip?.stopovers) throw new Error('Keine Stopovers');
        const stopovers=trip.stopovers.map(s=>{
            const pA=s.plannedArrival?new Date(s.plannedArrival).toISOString():null, a=s.arrival?new Date(s.arrival).toISOString():null;
            const pD=s.plannedDeparture?new Date(s.plannedDeparture).toISOString():null, d=s.departure?new Date(s.departure).toISOString():null;
            return{stop:{name:s.stop?.name||'',id:s.stop?.id,location:s.stop?.location?{latitude:s.stop.location.latitude,longitude:s.stop.location.longitude}:null},
                plannedArrival:pA,arrival:a,plannedDeparture:pD,departure:d,
                arrivalDelaySec:s.arrivalDelay??(a&&pA?Math.round((new Date(a)-new Date(pA))/1000):null),
                departureDelaySec:s.departureDelay??(d&&pD?Math.round((new Date(d)-new Date(pD))/1000):null),
                platform:s.platform||null,plannedPlatform:s.plannedPlatform||null,
                cancelled:s.cancelled||false,additional:s.additional||false,remarks:s.remarks||[]};
        });
        let pl=null; if(trip.polyline?.features||trip.polyline?.type) pl=trip.polyline;
        res.json({stopovers,polyline:pl,remarks:(trip.remarks||[]).map(r=>({text:r.text||r.summary||'',type:r.category||'info'})),
            source:'Deutsche Bahn (HAFAS)',tripId:trip.id,line:trip.line?{name:trip.line.name,product:trip.line.product}:null});
    } catch(e){
        console.error('train-details error:', e.message);
        res.status(502).json({error:e.message});
    }
});


app.get('/api/trips/:tripId', async (req, res) => {
  try {
    const payload = decodeTripId(req.params.tripId);
    const { line, stopID, tripCode, date, time } = payload || {};
    if (!line || !stopID || tripCode == null || !date || !time)
      return res.status(400).json({ error: 'tripId missing fields' });

    // 1. Versuch: In Marudor nach diesem Trip suchen (via Linienname & Datum)
    // VRR Linien IDs sind oft komplex, wir extrahieren den Namen (z.B. "009" oder "RE1")
    const cleanLine = line.split(':').pop().replace(/^0+/, ''); // "vrr:21009" -> "9"
    const searchUrl = `https://marudor.de/api/hafas/v2/departures?evaNumber=${encodeURIComponent(stopID)}&profile=vrr`;
    try {
        const sr = await fetch(searchUrl, { headers: { 'User-Agent': 'dilaeit-proxy/1.0' }, signal: AbortSignal.timeout(5000) });
        if (sr.ok) {
            const sData = await sr.json();
            const match = sData.find(d => {
                const dLine = (d.train?.name || '').replace(/\s+/g, '');
                return dLine.includes(cleanLine) && d.direction;
            });
            if (match?.journeyId) {
                const marudorData = await fetchMarudorTrip(match.journeyId);
                if (marudorData) return res.json(marudorData);
            }
        }
    } catch (e) { console.warn('Marudor trip detail lookup failed, using EFA:', e.message); }

    // 2. Fallback: VRR OpenService (Original-Logik)
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
      // Wenn estimated == planned → 0 (pünktlich, grün). Wenn null → kein Signal.
      const arrivalDelaySec   = arrival   && plannedArrival
        ? Math.round((new Date(arrival)   - new Date(plannedArrival))   / 1000)
        : (s.arrivalTimePlanned && !s.arrivalTimeEstimated ? null : null);
      const departureDelaySec = departure && plannedDeparture
        ? Math.round((new Date(departure) - new Date(plannedDeparture)) / 1000)
        : (s.departureTimePlanned && s.departureTimeEstimated && departure === null
           ? 0 : null);  // estimated gesetzt aber gleich wie planned → 0

      return {
        stop:             { 
            name: s.name || s.parent?.name || '',
            id: s.id || s.parent?.id || '',
            location: s.coord ? { latitude: s.coord[0], longitude: s.coord[1] } : null
        },
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
        const when    = date ? `${date}T08:00:00` : new Date().toISOString();
        const startTs = Math.floor(new Date(when).getTime() / 1000);
        const q       = query.trim().toUpperCase().replace(/\s+/g, '');
        const isNum   = /^\d+$/.test(q);
        const seen    = new Set(); const trips = [];

        // Hub-Stationen via geocode → korrekte MOTIS-IDs
        const hubNames = ['Köln Hbf','Düsseldorf Hbf','Essen Hbf','Mönchengladbach Hbf'];
        const hubGeo   = await Promise.allSettled(
            hubNames.map(n => motisGet(`/geocode?text=${encodeURIComponent(n)}&lang=de`)
                .then(d => motisStopId((Array.isArray(d)?d:[]).find(l=>l.id)?.id||''))
                .catch(()=>null))
        );
        const hubIds = hubGeo.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value);

        const stRes = await Promise.allSettled(
            hubIds.map(sid => motisGet(`/stoptimes?stopId=${encodeURIComponent(sid)}&startTime=${startTs}&duration=86400&n=200`)
                .then(d=>d.stopTimes||[]).catch(()=>[]))
        );
        for (const r of stRes) {
            if (r.status!=='fulfilled') continue;
            for (const st of r.value) {
                const tid=st.tripId||''; if(!tid||seen.has(tid)) continue;
                const disp=(st.displayName||'').toUpperCase().replace(/\s+/g,'');
                const short=(st.routeShortName||'').toUpperCase().replace(/\s+/g,'');
                const fn=(disp.match(/\((\d+)\)/)||[])[1]||'';
                const match=isNum?(fn===q||tid.toUpperCase().includes(q)):(short===q||short.startsWith(q)||disp.startsWith(q));
                if (match) {
                    seen.add(tid);
                    const schMs=st.scheduledTime?st.scheduledTime*1000:null;
                    trips.push({ id:tid, name:st.routeShortName||st.displayName||query,
                        direction:st.headsign||'Unbekannt',
                        line:{name:st.routeShortName||st.displayName||query,product:motisProduct((st.route||{}).mode||''),fahrtNr:fn||null},
                        plannedDeparture:schMs?new Date(schMs).toISOString():null });
                }
            }
        }
        res.json({ trips: trips.slice(0, 20) });
    } catch(e) {
        console.error('trips-by-name error:', e.message);
        res.json({ trips:[], error:e.message });
    }
});

// ─── Fahrtverlauf nach Nummer/TripId – via v6.db.transport.rest ──────────────

app.get('/api/db/trip-details', async (req, res) => {
    const { number, date, tripId, direction } = req.query;
    if (!number && !tripId) return res.status(400).json({ error: 'Missing number or tripId' });
    try {
        let finalTripId = tripId;
        if (!finalTripId) {
            const when    = date ? `${date}T08:00:00` : new Date().toISOString();
            const q       = number.trim().toUpperCase().replace(/\s+/g, '');
            const dir     = direction ? direction.trim().toLowerCase() : null;
            const fahrtNr = q.replace(/^[A-Z]+\s*/, '');
            // Parallel an 3 NRW-Knotenpunkten suchen
            const hubs  = [
                'https://v6.db.transport.rest/stops/8000207/departures', // Köln Hbf
                'https://v6.db.transport.rest/stops/8000244/departures', // Düsseldorf Hbf
                'https://v6.db.transport.rest/stops/8000105/departures', // Essen Hbf
            ];
            const params = `?when=${encodeURIComponent(when)}&duration=120&results=100&remarks=false`;
            const settled = await Promise.allSettled(
                hubs.map(h => fetch(h + params, { signal: AbortSignal.timeout(6000) }).then(r => r.ok ? r.json() : null))
            );
            
            let candidates = [];
            for (const r of settled) {
                if (r.status !== 'fulfilled' || !r.value) continue;
                for (const d of (r.value.departures || [])) {
                    const name = (d.line?.name || '').toUpperCase().replace(/\s+/g, '');
                    const fn   = (d.line?.fahrtNr || '').toString();
                    if ((name === q || fn === fahrtNr || fn === q) && d.tripId) {
                        candidates.push(d);
                    }
                }
            }
            
            // Besten Treffer auswählen (nach Richtung filtern falls vorhanden)
            if (candidates.length > 0) {
                if (dir) {
                    const exactMatch = candidates.find(c => (c.direction || '').toLowerCase().includes(dir));
                    finalTripId = exactMatch ? exactMatch.tripId : candidates[0].tripId;
                } else {
                    finalTripId = candidates[0].tripId;
                }
            }
            
            if (!finalTripId) return res.status(404).json({ error: 'Fahrt nicht gefunden' });
        }

        // 1. Versuch: Marudor (für Sekunden und echte Verfrühung)
        const marudorData = await fetchMarudorTrip(finalTripId);
        if (marudorData) return res.json(marudorData);

        // 2. Fallback: DB REST API
        const tripUrl = `https://v6.db.transport.rest/trips/${encodeURIComponent(finalTripId)}?stopovers=true&remarks=true&polyline=true`;
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
                stop: {
                    name: s.stop?.name || '',
                    id:   s.stop?.id,
                    location: s.stop?.location
                        ? { latitude: s.stop.location.latitude || s.stop.location.lat, longitude: s.stop.location.longitude || s.stop.location.lng }
                        : null
                },
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
            source: 'Deutsche Bahn', operator: trip.line?.operator, mode: trip.line?.product,
            polyline: trip.polyline || null
        });
    } catch (e) {
        console.error('DB trip-details error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── Server starten ───────────────────────────────────────────────────────────
const port = Number(process.env.PORT || 8787);
app.listen(port, '0.0.0.0', async () => {
    console.log(`🚀 dilaeit läuft auf Port ${port}`);
    
    // Startup-Test: Marudor-API Connectivity Check
    try {
        const testRes = await fetch('https://marudor.de/api/hafas/v1/irisCompatibleAbfahrten/8000105', { // Essen Hbf (NRW Hub)
            headers: { 'User-Agent': 'dilaeit-startup-check/1.0' },
            signal: AbortSignal.timeout(5000)
        });
        if (testRes.ok) {
            console.log('✅ Marudor-API (Bahn.expert) ist erreichbar');
        } else {
            console.warn(`⚠️ Marudor-API Startup-Check: Status ${testRes.status}`);
        }
    } catch (e) {
        console.warn('⚠️ Marudor-API Startup-Check fehlgeschlagen:', e.message);
    }
});
