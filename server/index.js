import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// --- HAFAS SETUP ---
// Wir laden nur die Hauptfunktion. Das DB-Profil ist der Standard.
const { createHafas } = require('db-hafas');

// Initialisierung (User-Agent ist wichtig für die DB)
const hafas = createHafas('dilaeit-app');

// --- PFADE ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// ... Rest des Codes bleibt identisch
// Statische Dateien (Frontend)
app.use(express.static(path.join(__dirname, 'public')));

// --- EFA KONFIGURATION ---
const OPEN_SERVICE_BASE = process.env.OPEN_SERVICE_BASE || 'https://openservice-test.vrr.de/openservice';
const EFA_VERSION = process.env.EFA_VERSION || '10.4.18.18';

// --- HILFSFUNKTIONEN ---
function toIsoStringOrNull(v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toYyyymmddUtc(iso) {
    const d = new Date(iso);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

function toHmmUtc(iso) {
    const d = new Date(iso);
    return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
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
    const res = await fetch(url, { headers: { 'user-agent': 'dilaeit-vrr-proxy/0.1' } });
    if (!res.ok) throw new Error(`EFA HTTP ${res.status}`);
    return res.json();
}

// --- API ROUTES ---

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/locations', async (req, res) => {
    try {
        const query = (req.query.query || '').trim();
        if (query.length < 2) return res.json({ locations: [] });
        const data = await efaGet('XML_STOPFINDER_REQUEST', {
            outputFormat: 'rapidJSON', version: EFA_VERSION, type_sf: 'any', name_sf: query
        });
        const locs = (data.locations || [])
            .filter(l => l?.properties?.stopId)
            .map(l => ({ id: String(l.properties.stopId), name: l.name, type: l.type }));
        res.json({ locations: locs });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stops/:id/departures', async (req, res) => {
    try {
        const { id } = req.params;
        const vrrData = await efaGet('XML_DM_REQUEST', {
            outputFormat: 'rapidJSON', version: EFA_VERSION, mode: 'direct', type_dm: 'any', name_dm: id, useRealtime: 1
        });

        let departures = vrrData.departures || [];
        const uicMatch = id.match(/80\d{5}/);

        // Hybrid-Check: Wenn es ein Bahnhof ist, frage die DB nach Verspätungen & TripIDs
        if (uicMatch) {
            try {
                const dbRes = await hafas.departures(uicMatch[0], { duration: 60 });
                departures.forEach(vDep => {
                    const line = vDep.servingLine?.symbol || vDep.servingLine?.number;
                    const dbMatch = dbRes.find(d => d.line.name === line);
                    if (dbMatch) {
                        vDep.delay = dbMatch.delay;
                        vDep.dbTripId = dbMatch.tripId; // WICHTIG für Sekunden-Verlauf
                        if (dbMatch.when) vDep.realDateTime = dbMatch.when;
                    }
                });
            } catch (e) { console.warn("DB-Hafas Abgleich fehlgeschlagen"); }
        }

        const result = departures.map(d => {
            const planned = toIsoStringOrNull(d.dateTime || d.plannedWhen);
            const tripPayload = {
                line: d.servingLine?.id || null,
                stopID: id,
                tripCode: d.servingLine?.properties?.tripCode ?? null,
                date: planned ? toYyyymmddUtc(planned) : null,
                time: planned ? toHmmUtc(planned) : null
            };

            return {
                tripId: tripPayload.line ? encodeTripId(tripPayload) : null,
                dbTripId: d.dbTripId || null,
                line: { name: d.servingLine?.symbol || d.servingLine?.number },
                direction: d.servingLine?.direction,
                plannedWhen: planned,
                when: toIsoStringOrNull(d.realDateTime || d.dateTime || d.when),
                delay: d.delay || 0,
                platform: d.servingLine?.platformName || d.platformName,
                hasLive: !!(d.realDateTime || d.delay !== undefined)
            };
        });
        res.json({ departures: result });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// NEU: Hochpräziser Fahrtverlauf von der DB
app.get('/api/train-details/:tripId', async (req, res) => {
    try {
        const { tripId } = req.params;
        const trip = await hafas.trip(tripId);
        
        const stopovers = trip.stopovers.map(s => ({
            stop: { name: s.stop.name },
            plannedArrival: s.plannedArrival,
            arrival: s.prognosedArrival || s.arrival,
            plannedDeparture: s.plannedDeparture,
            departure: s.prognosedDeparture || s.departure,
            platform: s.platform
        }));
        
        res.json({ stopovers });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// VRR Fallback für Bus/Bahn
app.get('/api/trips/:tripId', async (req, res) => {
    try {
        const payload = decodeTripId(req.params.tripId);
        const data = await efaGet('XML_TRIPSTOPTIMES_REQUEST', {
            outputFormat: 'rapidJSON', version: EFA_VERSION, mode: 'direct',
            line: payload.line, stopID: payload.stopID, tripCode: payload.tripCode,
            date: payload.date, time: payload.time, tStOTType: 'ALL', useRealtime: 1
        });
        const seq = data.transportation?.locationSequence || [];
        const stopovers = seq.map(s => ({
            stop: { name: s.name || '' },
            plannedArrival: toIsoStringOrNull(s.arrivalTimePlanned),
            arrival: toIsoStringOrNull(s.arrivalTimeEstimated),
            plannedDeparture: toIsoStringOrNull(s.departureTimePlanned),
            departure: toIsoStringOrNull(s.departureTimeEstimated)
        }));
        res.json({ stopovers });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server läuft auf Port ${PORT}`);
});
