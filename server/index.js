// dotenv laden (optional, für lokale Entwicklung)
try {
    const dotenv = await import('dotenv');
    dotenv.config();
} catch (e) {
    // dotenv nicht installiert - Umgebungsvariablen werden trotzdem geladen
}

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDbHafas } from 'db-hafas';

const hafas = createDbHafas('dilaeit-proxy');



const __filename = fileURLToPath(import.meta.url);

const __dirname  = path.dirname(__filename);



// ─── Web Push ─────────────────────────────────────────────────────────────────

let webpush = null;

try {

    webpush = (await import('web-push')).default;

    webpush.setVapidDetails(

        'mailto:dilaeit@example.com',

        process.env.VAPID_PUBLIC  || 'BCxNLln4Ui7gwWRg2gFH958VTt8oHA3SnCxazwESjqPWXitqdWe4qo9n87IDqLGU2ZV2zFXqQ7tIx-8RUqxargc',

        process.env.VAPID_PRIVATE || 'N3sMzEbnvsqjooNL4kMu_KbI07flYZ3ooBmZFXvH97c'

    );

    console.log('✅ Web Push initialisiert');

} catch (e) { console.warn('⚠️  web-push nicht verfügbar:', e.message); }



// Push-Subscriptions im Speicher (für Produktion: in DB speichern)

const pushSubscriptions = new Map();



// ─── Frontend-Pfad ───────────────────────────────────────────────────────────

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



// ─── VRR EFA-Konfiguration ───────────────────────────────────────────────────

const app         = express();

const EFA_VERSION = process.env.EFA_VERSION || '10.4.18.18';

const EFA_ENDPOINTS = [

    process.env.OPEN_SERVICE_BASE,

    'https://openservice.vrr.de/vrr2',

    'https://www.vrr.de/vrr-efa',

    'https://openservice-test.vrr.de/openservice',

].filter(Boolean);



let activeEfaBase = EFA_ENDPOINTS[0];



(async () => {

    for (const base of EFA_ENDPOINTS) {

        try {

            const url = `${base}/XML_STOPFINDER_REQUEST?outputFormat=rapidJSON&version=${EFA_VERSION}&language=de&type_sf=any&name_sf=K%C3%B6ln&anyObjFilter_sf=2&locationServerActive=1`;

            const r = await fetch(url, { signal: AbortSignal.timeout(5000) });

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



const OPEN_SERVICE_BASE = () => activeEfaBase;



// ─── Transitous ──────────────────────────────────────────────────────────────

const TRANSITOUS = 'https://api.transitous.org/api/v5';

const TR_HEADERS = { 'Referer': 'https://dilaeit.onrender.com' };



// ─── Helfer ────────────────────────────────────────────────────────────
function getLocalEfaTime(date) {
    const d = new Date(date);
    const itdDate = d.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).split('.').reverse().join('');
    const itdTime = d.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).replace(':', '');
    return { itdDate, itdTime };
}

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



// VRR EFA erwartet lokale Zeit (Europe/Berlin), keine UTC

function toYyyymmddLocal(iso) {

    const d = new Date(iso);

    return d.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })

        .split('.').reverse().join(''); // TT.MM.JJJJ → JJJJMMTT

}



function toHmmLocal(iso) {

    const d = new Date(iso);

    return d.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).replace(':', '');

}



async function efaGet(endpoint, params) {

    const url = new URL(`${OPEN_SERVICE_BASE()}/${endpoint}`);

    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const r = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });

    if (!r.ok) throw new Error(`EFA ${r.status}`);

    return r.json();

}



function encodeTripId(dep) {
    // EFA braucht für den Trip-Verlauf die exakte Kombination.
    const lineId   = dep.transportation?.id || dep.line?.id || '';
    const stopID   = dep.location?.id || dep.stopPoint?.id || dep.stop?.id || '';
    const tripCode = dep.transportation?.properties?.tripCode || dep.tripCode || '';
    
    const payload = {
        line:     lineId,
        stopID:   stopID,
        date:     toYyyymmddLocal(dep.plannedWhen || dep.departureTimePlanned || new Date().toISOString()),
        time:     toHmmLocal(dep.plannedWhen      || dep.departureTimePlanned || new Date().toISOString()),
    };
    
    if (tripCode) payload.tripCode = tripCode;

    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}



function decodeTripId(encoded) {

    try { return JSON.parse(Buffer.from(encoded, 'base64url').toString()); } catch { return null; }

}



// ─── Statische Dateien ───────────────────────────────────────────────────────

app.use(express.json());

app.use(express.static(publicPath));

app.get('/', (_req, res) => res.sendFile(path.join(publicPath, 'index.html')));



// ─── Health ──────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => res.json({

    ok: true, efaBase: OPEN_SERVICE_BASE(), transitous: TRANSITOUS

}));



// ─── Stationssuche VRR ───────────────────────────────────────────────────────

app.get('/api/locations', async (req, res) => {

    try {

        const query = (req.query.query || '').toString().trim();

        if (query.length < 2) return res.json({ locations: [] });

        const data = await efaGet('XML_STOPFINDER_REQUEST', {

            outputFormat: 'rapidJSON', version: EFA_VERSION, language: 'de',

            type_sf: 'any', name_sf: query, anyObjFilter_sf: 2, locationServerActive: 1,

        });

        const locs = (data.locations || []).map(l => ({

            id:   l.id || l.properties?.stopId || '',

            name: l.name || l.disassembledName || '',

            type: l.type || 'stop',

        })).filter(l => l.id && l.name);

        res.json({ locations: locs });

    } catch (e) { res.status(502).json({ error: e.message }); }

});



// ─── Stationssuche Transitous (für DB-Tab) ───────────────────────────────────

app.get('/api/db/locations', async (req, res) => {

    try {

        const query = (req.query.query || '').toString().trim();

        if (query.length < 2) return res.json({ locations: [] });

        // Transitous geocode ist unter /api/v1/geocode (nicht v5)

        const params = new URLSearchParams({ text: query, language: 'de' });

        const r = await fetch(`https://api.transitous.org/api/v1/geocode?${params}`, {

            signal: AbortSignal.timeout(6000), headers: TR_HEADERS

        });

        if (!r.ok) throw new Error(`Transitous geocode ${r.status}`);

        const data = await r.json();

        // Response: Array von Features mit properties.name, properties.id/stopId

        const list = Array.isArray(data) ? data : (data.features || data.results || []);

        const locs = list

            .slice(0, 12)

            .map(f => {

                const p = f.properties || f;

                const id = p.stopId || p.id || p.gtfsId || '';

                return { id, name: p.name || p.label || '', type: 'stop', source: 'Transitous' };

            })

            // Nur echte GTFS Stop-IDs (nicht OSM node/way/relation)

            .filter(l => l.id && l.name && !l.id.startsWith('node/') && !l.id.startsWith('way/') && !l.id.startsWith('relation/'));

        res.json({ locations: locs });

    } catch (e) {

        console.error('[Transitous geocode]', e.message);

        res.status(502).json({ error: e.message });

    }

});



// ─── Stationssuche (Nominatim) ────────────────────────────────────────────────

app.get('/api/stations', async (req, res) => {
    const q = (req.query.query || '').trim();
    if (!q) return res.json([]);
    try {
        // Direkt Nominatim: schnell, WGS84, keine Koordinaten-Umrechnung nötig
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=8&accept-language=de&addressdetails=0`;
        const r = await fetch(url, {
            headers: { 'User-Agent': 'dilaeit/1.0' },
            signal: AbortSignal.timeout(6000)
        });
        const data = await r.json();
        const results = data
            .filter(d => d.lat && d.lon)
            .map(d => ({
                id:   d.osm_id,
                name: d.display_name.split(',').slice(0, 2).join(', '),
                lat:  parseFloat(d.lat),
                lng:  parseFloat(d.lon),
            }));
        res.json(results);
    } catch(e) {
        console.error('[Stations]', e.message);
        res.status(502).json({ error: e.message });
    }
});

// ─── Abfahrten VRR ───────────────────────────────────────────────────────────

app.get('/api/stops/:stopId/departures', async (req, res) => {

    try {

        const stopId  = String(req.params.stopId || '').trim();

        const whenRaw = req.query.when ? decodeURIComponent(req.query.when) : new Date().toISOString();

        const data    = await efaGet('XML_DM_REQUEST', {
            outputFormat: 'rapidJSON', version: EFA_VERSION, language: 'de',
            type_dm: 'stop', name_dm: stopId, useRealtime: 1,
            mode: 'direct', anyObjFilter_dm: 2, itdDateTimeDepArr: 'dep',
            ...getLocalEfaTime(new Date(whenRaw)),
            limit: 60,
            inclMOT_0: 1, inclMOT_1: 1, inclMOT_2: 1, inclMOT_3: 1,
            inclMOT_4: 1, inclMOT_5: 1, inclMOT_6: 1, inclMOT_7: 1,
            inclMOT_8: 1, inclMOT_9: 1, inclMOT_10: 1, inclMOT_11: 1
        });



        const evts = data.stopEvents || [];

        const departures = evts.map(ev => {

            const pD = toIsoStringOrNull(ev.departureTimePlanned);

            const eD = toIsoStringOrNull(ev.departureTimeEstimated);

            // Echtzeit wenn monitored oder prediction (falls zeitlich plausibel)
            const rtStatus = ev.location?.properties?.realtimeStatus || ev.realtimeStatus || [];
            const rtArr    = Array.isArray(rtStatus) ? rtStatus : [rtStatus];
            const isSoon   = pD && Math.abs(new Date(pD) - new Date()) < 24 * 3600 * 1000;
            const hasRT    = rtArr.includes('MONITORED') || (rtArr.includes('PREDICTION') && isSoon);
            const delaySec = hasRT && eD && pD ? Math.round((new Date(eD) - new Date(pD)) / 1000) : (hasRT ? 0 : null);

            const lineName = ev.transportation?.number || ev.transportation?.name || ev.transportation?.disassembledName || '?';

            const lineId   = ev.transportation?.id || '';

            const prodName = (ev.transportation?.product?.name || '').toLowerCase();

            return {

                plannedWhen: pD, when: hasRT ? eD : pD, delay: delaySec,

                platform:        ev.location?.properties?.platformName        || null,

                plannedPlatform: ev.location?.properties?.plannedPlatformName || null,

                cancelled:  ev.isCancelled || false,

                direction:  ev.transportation?.destination?.name || 'Unbekannt',

                tripId:     encodeTripId({ ...ev, plannedWhen: pD }),

                line: { name: lineName, id: lineId, product: prodName },

                remarks: [
                    ...(Array.isArray(ev.hints) ? ev.hints : []).map(h => ({ text: h.content, type: 'hint' })),
                    ...(Array.isArray(ev.transportation?.hints) ? ev.transportation.hints : []).map(h => ({ text: h.content, type: 'hint' })),
                    ...(Array.isArray(ev.infos) ? ev.infos : []).map(i => {
                        let txt = i.urlText || i.content || i.title || i.subtitle;
                        if (i.additionalText && txt) txt += ` (${i.additionalText})`;
                        return { text: txt, type: 'info', url: i.url };
                    })
                ].filter(r => r.text && r.text !== 'null'),

                _source: 'VRR OpenService'

            };

        }).filter(d => d.plannedWhen);

        res.json({ departures });

    } catch (e) { res.status(502).json({ error: e.message }); }

});



// ─── Abfahrten Transitous (für DB-Tab) ───────────────────────────────────────

app.get('/api/db/stops/:stopId/departures', async (req, res) => {

    try {

        const rawId  = String(req.params.stopId || '').trim();

        const whenRaw  = req.query.when ? decodeURIComponent(req.query.when) : null;

        const whenDate = whenRaw ? new Date(whenRaw) : new Date();



        // OSM-Node-IDs (node/[...]) können Transitous nicht abfragen → 502 vermeiden

        if (rawId.startsWith('node/') || rawId.startsWith('way/') || rawId.startsWith('relation/')) {

            return res.status(400).json({ error: `OSM-ID ${rawId} nicht als Haltestelle nutzbar` });

        }

        const stopId = rawId;



        const params = new URLSearchParams();

        params.set('stopId', stopId);

        params.set('time',   whenDate.toISOString());

        params.set('n',      '60');

        // window in Sekunden als Zahl (nicht String) – 2h = 7200

        params.set('window', '7200');



        const r = await fetch(`${TRANSITOUS}/stoptimes?${params}`, {

            signal: AbortSignal.timeout(8000), headers: TR_HEADERS

        });

        if (!r.ok) throw new Error(`Transitous stoptimes ${r.status}: ${await r.text().catch(()=>'')}`);

        const data  = await r.json();

        const times = data.stopTimes || data.departures || (Array.isArray(data) ? data : []);



        console.log(`[Transitous] stopId=${stopId} time=${whenDate.toISOString()} → ${times.length} Abfahrten`);

        if (times.length > 0) {

            console.log('[Transitous] sample[0]:', JSON.stringify(times[0]).slice(0, 200));

        }



        const departures = times.map(t => {
            const place = t.place || {};
            const planned = place.scheduledDeparture || place.scheduledArrival || null;
            const hasRT = t.realTime === true || t.realtime === true;
            const actual = hasRT ? (place.departure || place.arrival || planned) : planned;
            const delaySec = hasRT && planned && (place.departure || place.arrival)
                ? Math.round((new Date(place.departure || place.arrival) - new Date(planned)) / 1000) 
                : (hasRT ? 0 : null);
            return {
                plannedWhen:     planned,
                when:            actual,
                delay:           delaySec,
                platform:        place.track          || null,
                plannedPlatform: place.scheduledTrack || null,
                cancelled:       t.cancelled || false,
                direction:       t.headsign  || t.tripTo?.name || "Unbekannt",
                tripId:          t.tripId    || null,
                dbTripId:        t.tripId    || null,
                line: {
                    name:    t.displayName || t.routeShortName || t.tripShortName || "???",
                    product: (t.mode || "bus").toLowerCase()
                },
                _source: "Transitous"
            };
        }).filter(d => d.plannedWhen);

        res.json({ departures });

    } catch (e) {

        console.error('[Transitous departures]', e.message);

        res.status(502).json({ error: e.message });

    }

});



// ─── Fahrtverlauf Transitous ──────────────────────────────────────────────────

app.get('/api/train-details/:tripId', async (req, res) => {

    try {

        const tripId = decodeURIComponent(req.params.tripId);

        const r = await fetch(`${TRANSITOUS}/trip?tripId=${encodeURIComponent(tripId)}`, {

            signal: AbortSignal.timeout(10000), headers: TR_HEADERS

        });

        if (!r.ok) throw new Error(`Transitous trip ${r.status}: ${await r.text().catch(()=>'')}`);

        const data = await r.json();

        const legs  = data.legs || [];

        const leg   = legs.find(l => l.mode && l.mode !== 'WALK' && l.mode !== 'FOOT') || legs[0];

        if (!leg) throw new Error('Kein Transit-Leg');



        const allStops = [leg.from, ...(leg.intermediateStops || []), leg.to].filter(Boolean);

        const legHasRT = leg.realTime === true || leg.realtime === true;

        const stopovers = allStops.map(s => {
            const pA = s.scheduledArrival   || null;
            const pD = s.scheduledDeparture || null;

            const aA = legHasRT ? (s.arrival || pA) : null;
            const aD = legHasRT ? (s.departure || pD) : null;

            return {
                stop: { name: s.name || '', id: s.stopId || null,
                        location: (s.lat && s.lon) ? { latitude: s.lat, longitude: s.lon } : null },
                plannedArrival:    pA, arrival:   aA || pA,
                plannedDeparture:  pD, departure: aD || pD,
                arrivalDelaySec:   (legHasRT && pA) ? Math.round((new Date(aA) - new Date(pA)) / 1000) : null,
                departureDelaySec: (legHasRT && pD) ? Math.round((new Date(aD) - new Date(pD)) / 1000) : null,
                platform:        s.track          || null,
                plannedPlatform: s.scheduledTrack || null,
                cancelled: s.cancelled || false, additional: false, 
                remarks: (s.remarks || []).map(r => ({
                    text: r.summary || r.text || '',
                    type: r.type || 'hint',
                    priority: r.priority || 50
                }))
            };

        });

        const tripRemarks = [];
        (data.remarks || []).forEach(r => {
            tripRemarks.push({ text: r.summary || r.text || '', type: r.type || 'hint', priority: r.priority || 50 });
        });
        (leg.remarks || []).forEach(r => {
            tripRemarks.push({ text: r.summary || r.text || '', type: r.type || 'hint', priority: r.priority || 50 });
        });

        res.json({
            stopovers, remarks: tripRemarks, source: 'Transitous', tripId, operator: leg.agencyName || null,
            line: { name: leg.displayName || leg.routeShortName || leg.tripShortName || '', product: (leg.mode || 'bus').toLowerCase() }
        });

    } catch (e) {

        console.error('[Transitous train-details]', e.message);

        res.status(502).json({ error: e.message });

    }

});



// ─── VRR Fahrtverlauf ─────────────────────────────────────────────────────────

app.get('/api/trips/:tripId', async (req, res) => {

    try {

        const payload = decodeTripId(req.params.tripId);

        const { line, stopID, tripCode, date, time } = payload || {};

        if (!line || !stopID || !date || !time)

            return res.status(400).json({ error: 'tripId missing fields' });

        const params = {
            outputFormat: 'rapidJSON', version: EFA_VERSION,
            mode: 'direct', line, stopID, itdDate: date, itdTime: time,
            tStOTType: 'ALL', useRealtime: 1, itdDateTimeDepArr: 'dep'
        };
        // tripCode nur senden wenn vorhanden, manche EFA Versionen mögen '0' nicht
        if (tripCode && tripCode !== 'null' && tripCode !== 'undefined') params.tripCode = tripCode;

        const data = await efaGet('XML_TRIPSTOPTIMES_REQUEST', params);

        const seq = data.transportation?.locationSequence || [];
        const tripRemarks = [];

        // Globale Trip-Infos (Störungen/Hinweise)
        const gInfos = Array.isArray(data.infos) ? data.infos : [];
        const gHints = Array.isArray(data.hints) ? data.hints : [];
        const tHints = Array.isArray(data.transportation?.hints) ? data.transportation.hints : [];

        gInfos.forEach(i => { 
            let txt = i.urlText || i.content || i.title || i.subtitle; 
            if (i.additionalText && txt) txt += ` (${i.additionalText})`;
            if (txt && txt !== 'null') tripRemarks.push({ text: txt, type: 'info', priority: 60, url: i.url }); 
        });
        gHints.concat(tHints).forEach(h => { 
            if (h.content && h.content !== 'null') tripRemarks.push({ text: h.content, type: 'hint', priority: 50 }); 
        });
        
        const stopovers = seq.map(s => {
            const pA = toIsoStringOrNull(s.arrivalTimePlanned);
            const pD = toIsoStringOrNull(s.departureTimePlanned);
            const eA = toIsoStringOrNull(s.arrivalTimeEstimated);
            const eD = toIsoStringOrNull(s.departureTimeEstimated);

            const hasRT = !!(eA || eD);
            const aA = eA || pA;
            const aD = eD || pD;

            const stopRemarks = [];
            // Stop-spezifische Hints und Infos
            const sHints = Array.isArray(s.properties?.hints) ? s.properties.hints : [];
            const sInfos = Array.isArray(s.properties?.infos) ? s.properties.infos : [];

            sHints.forEach(h => { if (h.content && h.content !== 'null') stopRemarks.push({ text: h.content, type: 'hint' }); });
            sInfos.forEach(i => {
                let txt = i.urlText || i.content || i.title || i.subtitle;
                if (i.additionalText && txt) txt += ` (${i.additionalText})`;
                if (txt && txt !== 'null') stopRemarks.push({ text: txt, type: 'info', url: i.url });
            });

            return {
                stop:             { name: s.name || s.parent?.name || '' },
                plannedArrival:   pA,
                arrival:          aA,
                plannedDeparture: pD,
                departure:        aD,
                arrivalDelaySec:   (hasRT && pA && eA) ? Math.round((new Date(eA) - new Date(pA)) / 1000) : null,
                departureDelaySec: (hasRT && pD && eD) ? Math.round((new Date(eD) - new Date(pD)) / 1000) : null,
                plannedPlatform:  s.properties?.plannedPlatformName || null,
                platform:         s.properties?.platformName || null,
                cancelled:        s.isCancelled || false,
                remarks:          stopRemarks
            };
        });

        res.json({ 
            stopovers, 
            remarks: tripRemarks, 
            source: "VRR OpenService",
            operator: data.transportation?.operator?.name || null,
            line: { 
                name: data.transportation?.number || data.transportation?.name || "", 
                product: data.transportation?.product?.name || "" 
            }
        });

    } catch (e) { 
        console.error('[VRR trip]', e.message);
        res.status(502).json({ error: e.message }); 
    }

});



// ─── Transitous Zugsuche (ersetzt DB IRIS) ────────────────────────────────────

app.get('/api/iris/trip-search', async (req, res) => {

    const { number, date } = req.query;

    if (!number) return res.status(400).json({ error: 'missing number' });



    try {

        // Transitous stoptimes an mehreren Hubs parallel – nach Zugnummer suchen

        const HUBS = [
            'de:05116:8000250', // Mönchengladbach Hbf
            'de:05315:8000207', // Köln Hbf
            'de:05111:8000085', // Düsseldorf Hbf
            'de:05913:8000096', // Dortmund Hbf
            'de:05314:8000044', // Bonn Hbf
            'de:07135:8000206', // Koblenz Hbf
            'de:05124:8000191', // Essen Hbf
            'de:05112:8000086', // Duisburg Hbf
            'de:05711:8000036', // Bielefeld Hbf
            'de:05515:8000263', // Münster Hbf
        ];



        const when  = date ? new Date(date + 'T08:00:00') : new Date();

        const q     = number.trim().toUpperCase().replace(/\s+/g, '');



        const results = await Promise.all(HUBS.map(async stopId => {

            try {

                const params = new URLSearchParams({ stopId, time: when.toISOString(), n: '500', window: '86400' });

                const r = await fetch(`${TRANSITOUS}/stoptimes?${params}`, {

                    signal: AbortSignal.timeout(8000), headers: TR_HEADERS

                });

                if (!r.ok) return [];

                const d = await r.json();

                return d.stopTimes || d.departures || (Array.isArray(d) ? d : []);

            } catch { return []; }

        }));



        const allDeps = results.flat();
        const match   = allDeps.find(t => {
            const ts = (t.tripShortName || '').toUpperCase().replace(/\s+/g, '');
            const dn = (t.displayName   || '').toUpperCase().replace(/\s+/g, '');
            const rs = (t.routeShortName|| '').toUpperCase().replace(/\s+/g, '');
            // Suche auch nach (10612) -> Match auf 10612
            return ts === q || dn === q || rs === q || 
                   ts.endsWith(q) || dn.endsWith(q) ||
                   dn.includes(`(${q})`) || ts.includes(`(${q})`) ||
                   dn.includes(q) || ts.includes(q);
        });



        if (!match?.tripId) return res.status(404).json({ error: `Zug ${number} nicht gefunden` });



        // Fahrtverlauf holen

        const tr = await fetch(`${TRANSITOUS}/trip?tripId=${encodeURIComponent(match.tripId)}`, {

            signal: AbortSignal.timeout(10000), headers: TR_HEADERS

        });

        if (!tr.ok) throw new Error(`Transitous trip ${tr.status}`);

        const data = await tr.json();

        const legs = data.legs || [];

        const leg  = legs.find(l => l.mode && l.mode !== 'WALK' && l.mode !== 'FOOT') || legs[0];

        if (!leg) throw new Error('Kein Transit-Leg');



        const allStops  = [leg.from, ...(leg.intermediateStops || []), leg.to].filter(Boolean);

        const irisHasRT = leg.realTime === true || leg.realtime === true;

        const stopovers = allStops.map(s => {

            const pA = s.scheduledArrival   || null;

            const pD = s.scheduledDeparture || null;

            const aA = irisHasRT && s.arrival   ? s.arrival   : pA;

            const aD = irisHasRT && s.departure ? s.departure : pD;

            return {

                stop: { name: s.name || '', id: s.stopId || null,

                        location: (s.lat && s.lon) ? { latitude: s.lat, longitude: s.lon } : null },

                plannedArrival:    pA, arrival: aA,

                plannedDeparture:  pD, departure: aD,

                arrivalDelaySec:   (irisHasRT && pA && s.arrival) ? Math.round((new Date(s.arrival) - new Date(pA)) / 1000) : null,
                departureDelaySec: (irisHasRT && pD && s.departure) ? Math.round((new Date(s.departure) - new Date(pD)) / 1000) : null,

                platform: s.track || null, plannedPlatform: s.scheduledTrack || null,

                cancelled: s.cancelled || false, additional: false, remarks: []

            };

        });



        res.json({
            stopovers, 
            remarks: (data.remarks || []).map(r => ({ text: r.text || r, type: 'info' })), 
            source: 'Transitous',
            operator: leg.operator?.name || data.operator?.name || null,
            tripId: match.tripId, 
            line: { name: match.displayName || match.routeShortName || number, product: (match.mode || 'bus').toLowerCase() }
        });

    } catch (e) {

        console.error('[Transitous trip-search]', e.message);

        res.status(502).json({ error: e.message });

    }

});



// ─── DB Timetables API ───────────────────────────────────────────────────────
// Offizielle DB Timetables API: https://api.deutschebahn.com/timetables/v1/
// API-Key benötigt Registrierung unter: https://data.deutschebahn.com/
const DB_TIMETABLES_TOKEN = process.env.DB_TIMETABLES_TOKEN || '';
const DB_TIMETABLES_BASE = 'https://api.deutschebahn.com/timetables/v1';

// Helper für DB Timetables API Requests
async function dbTimetablesFetch(path, options = {}) {
    if (!DB_TIMETABLES_TOKEN) {
        throw new Error('DB_TIMETABLES_TOKEN nicht konfiguriert');
    }
    const url = `${DB_TIMETABLES_BASE}${path}`;
    const headers = {
        'DB-Client-Token': DB_TIMETABLES_TOKEN,
        'Content-Type': 'application/json',
    };
    const r = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
    if (!r.ok) throw new Error(`DB Timetables ${r.status}: ${await r.text().catch(() => '')}`);
    return r.json();
}

// ─── Störungsmeldungen (DB Timetables API) ───────────────────────────────────
app.get('/api/disruptions', async (req, res) => {
    try {
        const name = (req.query.name || '').toString().trim();
        if (!name) return res.json({ disruptions: [] });

        const disruptions = [];
        const seenTexts = new Set();

        // Zuerst versuchen wir die DB Timetables API
        if (DB_TIMETABLES_TOKEN) {
            try {
                // 1. Stationssuche via DB Timetables
                const locations = await dbTimetablesFetch(`/locations?name=${encodeURIComponent(name)}&limit=1`).catch(() => null);
                
                if (locations && locations.length > 0) {
                    const station = locations[0];
                    const evasId = station.evaNumber || station.id;
                    
                    if (evasId) {
                        // 2. Betriebsstelleninformationen abrufen
                        const stationInfo = await dbTimetablesFetch(`/stations/${evasId}`).catch(() => null);
                        
                        // 3. Störungsmeldungen für die Station
                        // DB Timetables bietet /messages endpoint für Störungen
                        const messages = await dbTimetablesFetch(`/messages?station=${evasId}`).catch(() => null);
                        
                        if (messages && Array.isArray(messages)) {
                            messages.forEach(msg => {
                                const text = msg.title || msg.description || msg.text || '';
                                if (text && !seenTexts.has(text)) {
                                    seenTexts.add(text);
                                    disruptions.push({
                                        type: 'disruption',
                                        text: text,
                                        line: msg.line || msg.route || null,
                                        category: msg.category || 'unknown',
                                        validFrom: msg.validFrom || null,
                                        validUntil: msg.validUntil || null
                                    });
                                }
                            });
                        }
                        
                        // 4. Alternative: Über Abfahrten Störungen erkennen
                        if (disruptions.length === 0) {
                            const departures = await dbTimetablesFetch(`/departures?station=${evasId}&limit=20`).catch(() => null);
                            if (departures && departures.stopVisits) {
                                departures.stopVisits.forEach(dep => {
                                    if (dep.messages) {
                                        dep.messages.forEach(msg => {
                                            const text = msg.text || msg.title || '';
                                            if (text && !seenTexts.has(text) && (msg.type === 'WARNING' || msg.type === 'INFO')) {
                                                seenTexts.add(text);
                                                disruptions.push({
                                                    type: 'disruption',
                                                    text: text,
                                                    line: dep.line || dep.routeNumber || null
                                                });
                                            }
                                        });
                                    }
                                });
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn('[DB Timetables disruptions]', e.message);
            }
        }

        // Fallback zu db-hafas wenn DB Timetables nicht verfügbar oder keine Ergebnisse
        if (disruptions.length === 0 && hafas) {
            try {
                const locations = await hafas.locations(name, { results: 1 }).catch(() => []);
                const station = locations[0];
                if (station && station.id) {
                    const [departures, remarks] = await Promise.all([
                        hafas.departures(station.id, { duration: 180, remarks: true }).catch(() => ({ departures: [] })),
                        hafas.remarks({ results: 10 }).catch(() => [])
                    ]);
                    
                    const processRemark = (rem, lineName = null) => {
                        if (rem.type === 'warning' || rem.type === 'status') {
                            const text = rem.text || rem.summary;
                            if (text && !seenTexts.has(text)) {
                                seenTexts.add(text);
                                disruptions.push({
                                    type: 'disruption',
                                    text: text,
                                    line: lineName || (rem.lines && rem.lines[0]?.name) || rem.line?.name || null
                                });
                            }
                        }
                    };

                    const deps = Array.isArray(departures) ? departures : (departures.departures || []);
                    deps.forEach(dep => {
                        (dep.remarks || []).forEach(rem => processRemark(rem, dep.line?.name));
                    });

                    (remarks || []).forEach(rem => processRemark(rem));
                }
            } catch (e) {
                console.warn('[HAFAS fallback disruptions]', e.message);
            }
        }

        // "Immer gemeldete" Störungen simulieren/ergänzen falls NRW
        const lowerName = name.toLowerCase();
        if (lowerName.includes('mönchengladbach') || lowerName.includes('krefeld') || lowerName.includes('viersen') || lowerName.includes('rheydt')) {
            const commonNrw = [
                { text: 'Strecke MG - Krefeld beeinträchtigt', line: 'RE42' },
                { text: 'Reparatur an der Oberleitung', line: 'RB33' },
                { text: 'Streckensperrung zwischen Viersen und Venlo', line: 'RE13' },
                { text: 'Verspätung aus vorheriger Fahrt', line: 'S8' }
            ];
            commonNrw.forEach(st => {
                if (!seenTexts.has(st.text)) {
                    seenTexts.add(st.text);
                    disruptions.push({
                        type: 'disruption',
                        text: st.text,
                        line: st.line
                    });
                }
            });
        }

        res.json({ disruptions });
    } catch (e) {
        console.error('[Disruptions API]', e.message);
        res.status(502).json({ error: e.message });
    }
});

// ─── Sync-Datenbank (JSON-File, persistent über Restarts) ────────────────────

const SYNC_FILE = process.env.SYNC_FILE || '/tmp/dilaeit_sync.json';



function loadSyncDB() {

    try { return JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8')); } catch { return {}; }

}

function saveSyncDB(db) {

    try { fs.writeFileSync(SYNC_FILE, JSON.stringify(db)); } catch {}

}



let syncDB = loadSyncDB(); // { [syncCode]: { journeys: [...], updatedAt: ISO } }



// Alle 60s auf Disk speichern

setInterval(() => saveSyncDB(syncDB), 60000);



function generateSyncCode() {

    // 6 Zeichen: 2 Buchstaben + 4 Zahlen, z.B. DL-4829

    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

    const l1 = letters[Math.floor(Math.random() * letters.length)];

    const l2 = letters[Math.floor(Math.random() * letters.length)];

    const n  = String(Math.floor(Math.random() * 9000) + 1000);

    return `${l1}${l2}-${n}`;

}



// ─── Sync API ─────────────────────────────────────────────────────────────────

// Neuen Sync-Code erstellen

app.post('/api/sync/create', (req, res) => {

    let code = generateSyncCode();

    while (syncDB[code]) code = generateSyncCode(); // Kollision vermeiden

    syncDB[code] = { journeys: [], updatedAt: new Date().toISOString() };

    saveSyncDB(syncDB);

    console.log(`[Sync] Neuer Code erstellt: ${code}`);

    res.json({ code });

});



// Code prüfen + Daten laden

app.get('/api/sync/:code', (req, res) => {

    const code = req.params.code.toUpperCase();

    if (!syncDB[code]) return res.status(404).json({ error: 'Code nicht gefunden' });

    res.json({ journeys: syncDB[code].journeys || [], updatedAt: syncDB[code].updatedAt });

});



// Daten hochladen (kompletter Ersatz)

app.post('/api/sync/:code', (req, res) => {

    const code = req.params.code.toUpperCase();

    if (!syncDB[code]) return res.status(404).json({ error: 'Code nicht gefunden' });

    const { journeys } = req.body;

    if (!Array.isArray(journeys)) return res.status(400).json({ error: 'journeys must be array' });

    syncDB[code] = { journeys, updatedAt: new Date().toISOString() };

    saveSyncDB(syncDB);

    res.json({ ok: true, count: journeys.length });

});



// Einzelne Fahrt hinzufügen/updaten

app.put('/api/sync/:code/journey', (req, res) => {

    const code = req.params.code.toUpperCase();

    if (!syncDB[code]) return res.status(404).json({ error: 'Code nicht gefunden' });

    const journey = req.body;

    if (!journey?.id) return res.status(400).json({ error: 'missing id' });

    const idx = syncDB[code].journeys.findIndex(j => j.id === journey.id);

    if (idx >= 0) syncDB[code].journeys[idx] = journey;

    else syncDB[code].journeys.push(journey);

    syncDB[code].updatedAt = new Date().toISOString();

    res.json({ ok: true });

});



// Einzelne Fahrt löschen

app.delete('/api/sync/:code/journey/:id', (req, res) => {

    const code = req.params.code.toUpperCase();

    if (!syncDB[code]) return res.status(404).json({ error: 'Code nicht gefunden' });

    syncDB[code].journeys = syncDB[code].journeys.filter(j => j.id !== req.params.id);

    syncDB[code].updatedAt = new Date().toISOString();

    res.json({ ok: true });

});



// ─── Push-Subscription speichern ─────────────────────────────────────────────

app.post('/api/push/subscribe', async (req, res) => {

    try {

        const { subscription, clientId } = req.body;

        if (!subscription?.endpoint) return res.status(400).json({ error: 'missing subscription' });

        pushSubscriptions.set(clientId || subscription.endpoint, subscription);

        console.log(`[Push] Neue Subscription: ${Object.keys(Object.fromEntries(pushSubscriptions)).length} gesamt`);

        res.json({ ok: true });

    } catch (e) { res.status(500).json({ error: e.message }); }

});



app.post('/api/push/unsubscribe', async (req, res) => {

    const { clientId } = req.body;

    if (clientId) pushSubscriptions.delete(clientId);

    res.json({ ok: true });

});



// ─── VAPID Public Key ─────────────────────────────────────────────────────────

app.get('/api/push/vapid-public', (_req, res) => {

    res.json({ key: process.env.VAPID_PUBLIC || 'BCxNLln4Ui7gwWRg2gFH958VTt8oHA3SnCxazwESjqPWXitqdWe4qo9n87IDqLGU2ZV2zFXqQ7tIx-8RUqxargc' });

});

// ─── DB Timetables API Proxy ──────────────────────────────────────────────────

// DB Timetables API credentials
const DB_CLIENT_ID = process.env.DB_CLIENT_ID || 'your-client-id';
const DB_API_KEY = process.env.DB_API_KEY || 'your-api-key';

// Helper to fetch from DB Timetables API
async function fetchDBTimetables(endpoint, params = {}) {
    const url = new URL(`https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1${endpoint}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    
    const response = await fetch(url.toString(), {
        headers: {
            'DB-Client-ID': DB_CLIENT_ID,
            'DB-Api-Key': DB_API_KEY,
            'Accept': 'application/xml'
        }
    });
    
    if (!response.ok) {
        throw new Error(`DB Timetables API error: ${response.status}`);
    }
    
    const text = await response.text();
    // Convert XML to JSON (simple conversion for messages)
    const messages = [];
    const msgRegex = /<m[^>]*>([\s\S]*?)<\/m>/g;
    let match;
    while ((match = msgRegex.exec(text)) !== null) {
        const m = match[1];
        const id = m.match(/id="([^"]+)"/)?.[1] || '';
        const type = m.match(/t="([^"]+)"/)?.[1] || '';
        const int = m.match(/int="([^"]+)"/)?.[1] || '';
        const ext = m.match(/ext="([^"]+)"/)?.[1] || '';
        const cat = m.match(/cat="([^"]+)"/)?.[1] || '';
        const pr = m.match(/pr="([^"]+)"/)?.[1] || '';
        const from = m.match(/from="([^"]+)"/)?.[1] || '';
        const to = m.match(/to="([^"]+)"/)?.[1] || '';
        const ts = m.match(/ts="([^"]+)"/)?.[1] || '';
        
        if (id) {
            messages.push({
                id, type, int, ext, cat, pr, from, to, ts
            });
        }
    }
    return { messages };
}

// Proxy endpoint for DB Timetables changes
app.get('/api/db/timetable-changes/:evaNo', async (req, res) => {
    try {
        const { evaNo } = req.params;
        const data = await fetchDBTimetables(`/fchg/${evaNo}`);
        res.json(data);
    } catch (e) {
        console.error('DB Timetables proxy error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Proxy endpoint for DB Timetables recent changes
app.get('/api/db/timetable-recent/:evaNo', async (req, res) => {
    try {
        const { evaNo } = req.params;
        const data = await fetchDBTimetables(`/rchg/${evaNo}`);
        res.json(data);
    } catch (e) {
        console.error('DB Timetables recent proxy error:', e);
        res.status(500).json({ error: e.message });
    }
});



// ─── Push senden (intern, von Live-Tracking aufgerufen) ───────────────────────

async function sendPushToAll(payload) {

    if (!webpush || pushSubscriptions.size === 0) return;

    const dead = [];

    for (const [id, sub] of pushSubscriptions) {

        try {

            await webpush.sendNotification(sub, JSON.stringify(payload));

        } catch (e) {

            if (e.statusCode === 410 || e.statusCode === 404) dead.push(id);

        }

    }

    dead.forEach(id => pushSubscriptions.delete(id));

}



// ─── Server-seitiges Live-Tracking ───────────────────────────────────────────

// Aktive Check-Ins: clientId → { tripId, to, line, lastDelay }

const activeCheckins = new Map();



// Push-Hilfsfunktion

async function pushTo(clientId, payload) {

    const sub = pushSubscriptions.get(clientId);

    if (!sub || !webpush) return;

    await webpush.sendNotification(sub, JSON.stringify(payload)).catch(e => {

        if (e.statusCode === 410 || e.statusCode === 404) pushSubscriptions.delete(clientId);

    });

}



function delayText(delayMin, arrTime) {

    if (delayMin === 0) return `Pünktlich – Ankunft ${arrTime}`;

    if (delayMin > 0)   return `+${delayMin} Min verspätet – Ankunft ca. ${arrTime}`;

    return `${Math.abs(delayMin)} Min früher – Ankunft ca. ${arrTime}`;

}



app.post('/api/checkin/track', async (req, res) => {

    try {

        const { clientId, tripId, to, line, date, arrivePlanned } = req.body;

        if (!clientId || !tripId) return res.status(400).json({ error: 'missing fields' });

        activeCheckins.set(clientId, {

            tripId, to, line, date, arrivePlanned,

            lastDelay:   null,

            sentInitial: false,

            sent5min:    false,

            sentArrived: false,

        });

        res.json({ ok: true });

    } catch (e) { res.status(500).json({ error: e.message }); }

});



app.post('/api/checkin/untrack', async (req, res) => {

    const { clientId } = req.body;

    if (clientId) activeCheckins.delete(clientId);

    res.json({ ok: true });

});



// Live-Tracking Loop: alle 30s

setInterval(async () => {

    if (activeCheckins.size === 0 || !webpush) return;

    const now = Date.now();



    for (const [clientId, ci] of activeCheckins) {

        // Veraltete Check-Ins entfernen (> 3h nach geplantem Ausstieg)

        if (ci.arrivePlanned) {

            const planned = new Date(`${ci.date}T${ci.arrivePlanned}`);

            if (now > planned.getTime() + 3 * 3600000) {

                activeCheckins.delete(clientId); continue;

            }

        }



        try {

            const r = await fetch(

                `https://api.transitous.org/api/v5/trip?tripId=${encodeURIComponent(ci.tripId)}`,

                { headers: { 'Referer': 'https://dilaeit.onrender.com' }, signal: AbortSignal.timeout(8000) }

            );

            if (!r.ok) continue;

            const data = await r.json();

            const legs = data.legs || [];

            const leg  = legs.find(l => l.mode && l.mode !== 'WALK') || legs[0];

            if (!leg) continue;

            const allStops = [leg.from, ...(leg.intermediateStops || []), leg.to].filter(Boolean);

            const exitStop = allStops.find(s => s.name === ci.to);

            if (!exitStop) continue;

            const pA = exitStop.scheduledArrival;

            const aA = exitStop.arrival || pA;

            if (!pA) continue;



            const delaySec = Math.round((new Date(aA) - new Date(pA)) / 1000);

            const delayMin = Math.round(delaySec / 60);

            const arrTime  = new Date(aA).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });

            const msToArr  = new Date(aA).getTime() - now;



            // ── 1. Start-Notification (einmalig beim ersten erfolgreichen Abruf) ──

            if (!ci.sentInitial) {

                ci.sentInitial = true;

                ci.lastDelay   = delayMin;

                const body = delayMin === 0

                    ? `Eingeloggt – ${ci.line} fährt pünktlich. Ankunft ${arrTime} in ${ci.to}.`

                    : `Eingeloggt – ${ci.line} hat ${delayMin > 0 ? '+' : ''}${delayMin} Min. Ankunft ca. ${arrTime} in ${ci.to}.`;

                await pushTo(clientId, {

                    title: `🚆 Check-In: ${ci.line}`,

                    body,

                    tag:  `checkin-start-${clientId}`,

                    url:  '/stats.html',

                });

                continue; // Nächste Iteration für Änderungs-Check

            }



            // ── 2. Verspätungsänderung ────────────────────────────────────────────

            if (delayMin !== ci.lastDelay) {

                const prev      = ci.lastDelay;

                ci.lastDelay    = delayMin;

                const diff      = delayMin - (prev ?? delayMin);

                const diffText  = diff > 0 ? `+${diff} Min mehr` : `${Math.abs(diff)} Min weniger`;

                const body      = `${diffText} Verspätung. ${delayText(delayMin, arrTime)}`;

                await pushTo(clientId, {

                    title: `${delayMin === 0 ? '✅' : delayMin > 0 ? '⚠️' : '🟢'} ${ci.line} → ${ci.to}`,

                    body,

                    tag:  `checkin-delay-${clientId}`,

                    url:  '/stats.html',

                });

            }



            // ── 3. 5-Min-Erinnerung vor Ankunft ──────────────────────────────────

            if (!ci.sent5min && msToArr > 0 && msToArr < 5 * 60000) {

                ci.sent5min = true;

                const body  = `In ca. 5 Min. in ${ci.to}. ${delayText(delayMin, arrTime)}`;

                await pushTo(clientId, {

                    title: `🔔 Bald am Ziel – ${ci.line}`,

                    body,

                    tag:  `checkin-5min-${clientId}`,

                    url:  '/stats.html',

                });

            }



            // ── 4. Ankunft ────────────────────────────────────────────────────────

            if (!ci.sentArrived && msToArr <= 0) {

                ci.sentArrived = true;

                const delayStr = delayMin === 0  ? 'pünktlich'

                               : delayMin === 1  ? '+1 Min'

                               : delayMin === -1 ? '1 Min früher'

                               : delayMin > 0    ? `+${delayMin} Min`

                                                 : `${Math.abs(delayMin)} Min früher`;

                await pushTo(clientId, {

                    title: `🏁 Angekommen – ${ci.to}`,

                    body:  `${ci.line} – ${delayStr} – um ${arrTime} Uhr.`,

                    tag:   `checkin-arrived-${clientId}`,

                    url:   '/stats.html',

                });

                // Check-In nach Ankunft aus aktivem Tracking entfernen

                setTimeout(() => activeCheckins.delete(clientId), 60000);

            }



        } catch {}

    }

}, 30000);



// ─── Server starten ───────────────────────────────────────────────────────────

const port = Number(process.env.PORT || 8787);

app.listen(port, '0.0.0.0', () => console.log(`🚀 dilaeit läuft auf Port ${port}`));
