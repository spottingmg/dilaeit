import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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
    return Buffer.from(JSON.stringify({
        line:     dep.transportation?.id || dep.line?.id || '',
        stopID:   dep.location?.id || dep.stopPoint?.id || dep.stop?.id || '',
        tripCode: dep.transportation?.properties?.tripCode || dep.tripCode || '',
        date:     toYyyymmddLocal(dep.plannedWhen || dep.departureTimePlanned || new Date().toISOString()),
        time:     toHmmLocal(dep.plannedWhen      || dep.departureTimePlanned || new Date().toISOString()),
    })).toString('base64url');
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

// ─── Abfahrten VRR ───────────────────────────────────────────────────────────
app.get('/api/stops/:stopId/departures', async (req, res) => {
    try {
        const stopId  = String(req.params.stopId || '').trim();
        const whenRaw = req.query.when ? decodeURIComponent(req.query.when) : new Date().toISOString();
        const data    = await efaGet('XML_DM_REQUEST', {
            outputFormat: 'rapidJSON', version: EFA_VERSION, language: 'de',
            type_dm: 'stop', name_dm: stopId, useRealtime: 1,
            mode: 'direct', ptOptionsActive: 1, deleteAssignedStops_dm: 0,
            itdDateTimeDepArr: 'dep',
            itdDate: toYyyymmddLocal(whenRaw),
            itdTime: toHmmLocal(whenRaw),
            limit: 60,
        });

        const evts = data.stopEvents || [];
        const departures = evts.map(ev => {
            const pD = toIsoStringOrNull(ev.departureTimePlanned);
            const aD = toIsoStringOrNull(ev.departureTimeEstimated);
            const delaySec = pD && aD ? Math.round((new Date(aD) - new Date(pD)) / 1000) : null;
            const lineName = ev.transportation?.number || ev.transportation?.name || ev.transportation?.disassembledName || '?';
            const lineId   = ev.transportation?.id || '';
            const prodName = (ev.transportation?.product?.name || '').toLowerCase();
            return {
                plannedWhen: pD, when: aD || pD, delay: delaySec,
                platform:        ev.departureTimePlanned && ev.location?.properties?.platformName || null,
                plannedPlatform: ev.location?.properties?.plannedPlatformName || null,
                cancelled:  ev.isCancelled || false,
                direction:  ev.transportation?.destination?.name || 'Unbekannt',
                tripId:     encodeTripId({ ...ev, plannedWhen: pD }),
                line: { name: lineName, id: lineId, product: prodName },
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
            const place   = t.place || {};
            // Transitous gibt scheduled* als Soll-Zeit und departure/arrival als RT
            const planned = place.scheduledDeparture || place.scheduledArrival || null;
            const actual  = (place.departure !== place.scheduledDeparture ? place.departure : null)
                         || (place.arrival   !== place.scheduledArrival   ? place.arrival   : null)
                         || planned;
            const delaySec = planned && actual && actual !== planned
                ? Math.round((new Date(actual) - new Date(planned)) / 1000) : null;
            return {
                plannedWhen:     planned,
                when:            actual,
                delay:           delaySec,
                platform:        place.track          || null,
                plannedPlatform: place.scheduledTrack || null,
                cancelled:       t.cancelled || false,
                direction:       t.headsign  || t.tripTo?.name || 'Unbekannt',
                tripId:          t.tripId    || null,
                dbTripId:        t.tripId    || null,
                line: {
                    name:    t.displayName || t.routeShortName || t.tripShortName || '???',
                    product: (t.mode || 'bus').toLowerCase()
                },
                _source: 'Transitous'
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

        const remarks = [];
        if (leg.interlineWithPreviousLeg) {
            const fromLine = leg.tripFrom?.displayName || leg.tripFrom?.routeShortName || '';
            const fromDest = leg.tripFrom?.headsign    || leg.tripFrom?.name           || '';
            remarks.push({ text: fromLine ? `Wendet aus ${fromLine}${fromDest ? ` (${fromDest})` : ''}` : 'Durchbindung – Fahrzeug kommt von vorheriger Fahrt', type: 'hint', priority: 80 });
        }
        if (leg.tripTo) {
            const toLine = leg.tripTo.displayName || leg.tripTo.routeShortName || '';
            const toDest = leg.tripTo.headsign    || leg.tripTo.name           || '';
            if (toLine) remarks.push({ text: `Fährt weiter als ${toLine}${toDest ? ` nach ${toDest}` : ''}`, type: 'hint', priority: 80 });
        }

        const allStops = [leg.from, ...(leg.intermediateStops || []), leg.to].filter(Boolean);
        const stopovers = allStops.map(s => {
            const pA = s.scheduledArrival   || null;
            const aA = s.arrival            || null;
            const pD = s.scheduledDeparture || null;
            const aD = s.departure          || null;
            return {
                stop: { name: s.name || '', id: s.stopId || null,
                        location: (s.lat && s.lon) ? { latitude: s.lat, longitude: s.lon } : null },
                plannedArrival:    pA, arrival:   aA || pA,
                plannedDeparture:  pD, departure: aD || pD,
                arrivalDelaySec:   aA && pA ? Math.round((new Date(aA) - new Date(pA)) / 1000) : null,
                departureDelaySec: aD && pD ? Math.round((new Date(aD) - new Date(pD)) / 1000) : null,
                platform:        s.track          || null,
                plannedPlatform: s.scheduledTrack || null,
                cancelled: s.cancelled || false, additional: false, remarks: []
            };
        });
        res.json({
            stopovers, remarks, source: 'Transitous', tripId,
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
        if (!line || !stopID || tripCode == null || !date || !time)
            return res.status(400).json({ error: 'tripId missing fields' });
        const data = await efaGet('XML_TRIPSTOPTIMES_REQUEST', {
            outputFormat: 'rapidJSON', version: EFA_VERSION,
            mode: 'direct', line, stopID, tripCode, date, time,
            tStOTType: 'ALL', useRealtime: 1
        });
        const seq = data.transportation?.locationSequence || [];

        // Debug: VRR EFA Top-Level Keys loggen
        console.log('[VRR trip keys]', Object.keys(data));
        if (seq[0]) console.log('[VRR stop[0] keys]', Object.keys(seq[0]));
        const anyInfo = data.infos || data.hints || data.messages || data.infoLinks || [];
        if (anyInfo.length) console.log('[VRR infos sample]', JSON.stringify(anyInfo[0]).slice(0,300));

        // VRR EFA Infotexte auf Trip-Ebene
        const tripRemarks = [];
        for (const info of (data.infos || data.hints || data.messages || data.infoLinks || [])) {
            const text = info.infoLinkText || info.subtitle || info.content || info.text || info.description || '';
            if (text) tripRemarks.push({ text, type: 'hint', priority: info.priority || 50 });
        }

        const stopovers = (Array.isArray(seq) ? seq : []).map(s => {
            const stopRemarks = [];
            for (const info of (s.infos || s.messages || s.hints || [])) {
                const text = info.infoLinkText || info.subtitle || info.content || info.text || '';
                if (text) stopRemarks.push({ text, type: 'hint', priority: info.priority || 50 });
            }
            const planned = s.properties?.plannedPlatformName || null;
            const actual  = s.properties?.platformName        || null;
            if (planned && actual && planned !== actual) {
                stopRemarks.push({ text: 'Platform change', type: 'hint', priority: 70 });
            }
            return {
                stop:             { name: s.name || s.parent?.name || '' },
                plannedArrival:   toIsoStringOrNull(s.arrivalTimePlanned),
                arrival:          toIsoStringOrNull(s.arrivalTimeEstimated),
                plannedDeparture: toIsoStringOrNull(s.departureTimePlanned),
                departure:        toIsoStringOrNull(s.departureTimeEstimated),
                plannedPlatform:  planned,
                platform:         actual,
                cancelled: s.isNotServiced || false,
                additional: false,
                remarks: stopRemarks,
            };
        });
        res.json({ stopovers, remarks: tripRemarks, source: 'VRR OpenService' });
    } catch (e) { res.status(502).json({ error: e.message }); }
});

// ─── Transitous Zugsuche (ersetzt DB IRIS) ────────────────────────────────────
app.get('/api/iris/trip-search', async (req, res) => {
    const { number, date } = req.query;
    if (!number) return res.status(400).json({ error: 'missing number' });

    try {
        // Transitous stoptimes an mehreren Hubs parallel – nach Zugnummer suchen
        const HUBS = [
            'de:05166:8000248', // Mönchengladbach Hbf
            'de:05315:8000207', // Köln Hbf
            'de:05111:8000085', // Düsseldorf Hbf
            'de:05913:8000096', // Dortmund Hbf
            'de:05315:8005556', // Troisdorf
            'de:05124:8000191', // Essen Hbf
        ];

        const when  = date ? new Date(date + 'T08:00:00') : new Date();
        const q     = number.trim().toUpperCase().replace(/\s+/g, '');

        const results = await Promise.all(HUBS.map(async stopId => {
            try {
                const params = new URLSearchParams({ stopId, time: when.toISOString(), n: '200', window: '86400' });
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
            return ts === q || dn === q || rs === q || ts.endsWith(q) || dn.endsWith(q);
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
        const stopovers = allStops.map(s => ({
            stop: { name: s.name || '', id: s.stopId || null,
                    location: (s.lat && s.lon) ? { latitude: s.lat, longitude: s.lon } : null },
            plannedArrival:    s.scheduledArrival   || null,
            arrival:           s.arrival            || s.scheduledArrival || null,
            plannedDeparture:  s.scheduledDeparture || null,
            departure:         s.departure          || s.scheduledDeparture || null,
            arrivalDelaySec:   s.arrival && s.scheduledArrival ? Math.round((new Date(s.arrival) - new Date(s.scheduledArrival)) / 1000) : null,
            departureDelaySec: s.departure && s.scheduledDeparture ? Math.round((new Date(s.departure) - new Date(s.scheduledDeparture)) / 1000) : null,
            platform: s.track || null, plannedPlatform: s.scheduledTrack || null,
            cancelled: s.cancelled || false, additional: false, remarks: []
        }));

        const irisRemarks = [];
        if (leg.interlineWithPreviousLeg) {
            const fromLine = leg.tripFrom?.displayName || leg.tripFrom?.routeShortName || '';
            const fromDest = leg.tripFrom?.headsign    || leg.tripFrom?.name           || '';
            irisRemarks.push({ text: fromLine ? `Wendet aus ${fromLine}${fromDest ? ` (${fromDest})` : ''}` : 'Durchbindung – Fahrzeug kommt von vorheriger Fahrt', type: 'hint', priority: 80 });
        }
        if (leg.tripTo) {
            const toLine = leg.tripTo.displayName || leg.tripTo.routeShortName || '';
            const toDest = leg.tripTo.headsign    || leg.tripTo.name           || '';
            if (toLine) irisRemarks.push({ text: `Fährt weiter als ${toLine}${toDest ? ` nach ${toDest}` : ''}`, type: 'hint', priority: 80 });
        }

        res.json({
            stopovers, remarks: irisRemarks, source: 'Transitous',
            tripId: match.tripId, dbTripId: match.tripId,
            line: { name: match.displayName || match.routeShortName || number, product: (match.mode || 'bus').toLowerCase() }
        });
    } catch (e) {
        console.error('[Transitous trip-search]', e.message);
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
