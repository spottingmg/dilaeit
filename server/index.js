/**
 * dilaeit – VRR OpenService Proxy
 *
 * Übersetzt die Frontend-API (/api/*) auf die VRR EFA-API (openservice-test.vrr.de).
 * Wichtig: VRR EFA nutzt NICHT ISO-Timestamps, sondern einzelne Datumsfelder.
 * Dieser Proxy konvertiert ?when=<ISO> in die richtigen EFA-Parameter.
 */

import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8787;

// ─── VRR API Konfiguration ───────────────────────────────────────────────────
// Test-Endpunkt (kein Key nötig). Für Produktion gegen openservice.vrr.de tauschen
// und ACCESS_TOKEN setzen wenn VRR OpenData-Zugang vorhanden.
const VRR_BASE    = process.env.VRR_BASE    || 'https://openservice-test.vrr.de/static03/XML_DM_REQUEST';
const VRR_TRIP    = process.env.VRR_TRIP    || 'https://openservice-test.vrr.de/static03/XML_TRIP_REQUEST2';
const VRR_COORD   = process.env.VRR_COORD   || 'https://openservice-test.vrr.de/static03/XML_COORD_REQUEST';
const VRR_STOPFINDER = process.env.VRR_STOPFINDER || 'https://openservice-test.vrr.de/static03/XML_STOPFINDER_REQUEST';
const ACCESS_TOKEN = process.env.VRR_ACCESS_TOKEN || '';

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

/**
 * ISO-String → EFA-Zeitobjekt
 * VRR EFA erwartet: itdDateDay, itdDateMonth, itdDateYear, itdTimeHour, itdTimeMinute
 */
function isoToEfaTime(isoString) {
    const d = isoString ? new Date(isoString) : new Date();
    return {
        itdDateDay:    d.getDate(),
        itdDateMonth:  d.getMonth() + 1,
        itdDateYear:   d.getFullYear(),
        itdTimeHour:   d.getHours(),
        itdTimeMinute: d.getMinutes(),
    };
}

/** Gemeinsame EFA-Basisparameter */
function efaBaseParams(extraParams = {}) {
    const p = {
        outputFormat:     'rapidJSON',
        coordOutputFormat:'WGS84[dd.ddddd]',
        language:         'de',
        ...extraParams,
    };
    if (ACCESS_TOKEN) p.accessToken = ACCESS_TOKEN;
    return p;
}

async function efaFetch(url, params) {
    const qs = new URLSearchParams(params).toString();
    const fullUrl = `${url}?${qs}`;
    const res = await fetch(fullUrl, {
        headers: { 'Accept': 'application/json' },
        signal:  AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(`VRR API error ${res.status}`), { status: res.status, body: text });
    }
    return res.json();
}

/**
 * Normalisiert eine EFA-Abfahrt auf das vom Frontend erwartete hafas-ähnliche Format.
 * Das Frontend erwartet: { line, direction, plannedWhen, when, delay, platform,
 *                          tripId, cancelled, prognosis }
 */
function normalizeEfaDeparture(efaDep, stopName) {
    const line = efaDep.servingLine || efaDep.transportation || {};
    const realtimeStatus = efaDep.realtimeStatus || efaDep.Realtime || '';
    const isCancelled    = realtimeStatus === 'TRIP_CANCELLED' || efaDep.isCancelled === true;

    // EFA liefert Zeiten als "dateTime"-Objekt oder als Unix-Timestamp
    const plannedDt = efaDep.dateTime       || efaDep.plannedDateTime;
    const realDt    = efaDep.realtimeDateTime || efaDep.realDateTime;

    const toIso = (dt) => {
        if (!dt) return null;
        if (typeof dt === 'string') return dt;
        if (dt.year && dt.month && dt.day) {
            const pad = n => String(n).padStart(2,'0');
            return `${dt.year}-${pad(dt.month)}-${pad(dt.day)}T${pad(dt.hour||0)}:${pad(dt.minute||0)}:00`;
        }
        return null;
    };

    const plannedWhen = toIso(plannedDt);
    const actualWhen  = toIso(realDt);

    // Verspätung in Sekunden berechnen
    let delaySecs = null;
    if (plannedWhen && actualWhen) {
        delaySecs = Math.round((new Date(actualWhen) - new Date(plannedWhen)) / 1000);
    } else if (typeof efaDep.delaySeconds === 'number') {
        delaySecs = efaDep.delaySeconds;
    } else if (typeof efaDep.delay === 'number') {
        delaySecs = efaDep.delay * 60;
    }

    const lineName = line.symbol || line.number || line.name || line.shortName || '?';
    const product  = (line.motType !== undefined)
        ? mapMotType(Number(line.motType))
        : (line.product || '').toLowerCase();

    const tripId   = efaDep.tripID ||
                     efaDep.trip?.id ||
                     line.tripID ||
                     `${lineName}|${plannedWhen || ''}`;

    const platform = efaDep.platformName || efaDep.platform || efaDep.assignedStop?.platform || null;
    const plannedPlatform = efaDep.plannedPlatformName || efaDep.plannedPlatform || platform;

    return {
        tripId,
        direction:     efaDep.destination?.name || line.direction || line.destination || '',
        plannedWhen,
        when:          actualWhen || plannedWhen,
        delay:         delaySecs,
        platform,
        plannedPlatform,
        cancelled:     isCancelled,
        prognosis: {
            platform: platform !== plannedPlatform ? platform : undefined,
        },
        line: {
            id:       line.id || lineName,
            name:     lineName,
            product,
            operator: line.operator ? { name: line.operator.name || line.operator } : undefined,
        },
        remarks: normalizeRemarks(efaDep.infos || efaDep.infoTexts || []),
        stop: {
            id:   efaDep.stopID || efaDep.stop?.id || '',
            name: stopName || efaDep.stopName || '',
        },
    };
}

/** VRR motType → hafas-ähnliches product */
function mapMotType(motType) {
    const map = {
        0:  'national',        // ICE, IC
        1:  'national',        // IC/EC
        2:  'national',        // D-Zug
        3:  'regionalexpress', // IRE
        4:  'regional',        // RE
        5:  'regional',        // RB
        6:  'suburban',        // S-Bahn
        7:  'subway',          // U-Bahn
        8:  'tram',            // Stadtbahn/Straßenbahn
        9:  'bus',             // Bus
        10: 'bus',             // AST
        11: 'ferry',           // Fähre
        17: 'taxi',            // Rufbus
        19: 'bus',             // Schnellbus
    };
    return map[motType] || 'unknown';
}

function normalizeRemarks(infos) {
    if (!Array.isArray(infos)) return [];
    return infos
        .filter(i => i && (i.infoText?.subject || i.subtitle || i.text))
        .map(i => ({
            type: 'hint',
            text: i.infoText?.subject || i.subtitle || i.text || '',
        }));
}

/**
 * Normalisiert einen EFA-Stopover (für Fahrtverlauf).
 */
function normalizeEfaStopover(s) {
    const toIso = (dt) => {
        if (!dt) return null;
        if (typeof dt === 'string') return dt;
        if (dt.year && dt.month && dt.day) {
            const pad = n => String(n).padStart(2,'0');
            return `${dt.year}-${pad(dt.month)}-${pad(dt.day)}T${pad(dt.hour||0)}:${pad(dt.minute||0)}:00`;
        }
        return null;
    };

    return {
        stop: {
            id:   s.stopID || s.id || '',
            name: s.nameWO || s.name || s.fullName || '',
        },
        plannedArrival:    toIso(s.arrivalDateTimePlanned   || s.plannedArrivalDateTime),
        arrival:           toIso(s.arrivalDateTimeEstimated || s.realtimeArrivalDateTime),
        plannedDeparture:  toIso(s.departureDateTimePlanned  || s.plannedDepartureDateTime),
        departure:         toIso(s.departureDateTimeEstimated|| s.realtimeDepartureDateTime),
        platform:          s.disassembledName?.match(/Gleis\s+(.+)/)?.[1] || s.platform || s.platformName || null,
        plannedPlatform:   s.plannedPlatform || s.platform || null,
        cancelled:         s.isCancelled || false,
        additional:        s.isAdditional || false,
        remarks:           normalizeRemarks(s.infos || s.infoTexts || []),
    };
}

// ─── Statische Dateien ───────────────────────────────────────────────────────
// Serviert public/ – funktioniert sowohl lokal als auch auf Render/Fly.io
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Health Check ────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: '0.3.0', backend: 'VRR OpenService' });
});

// ─── Stationssuche ───────────────────────────────────────────────────────────
// GET /api/locations?query=Rheydt&results=10
app.get('/api/locations', async (req, res) => {
    const query   = req.query.query || '';
    const results = Number(req.query.results) || 10;
    if (!query.trim()) return res.status(400).json({ error: 'query required' });

    try {
        const params = efaBaseParams({
            type_sf:              'any',
            name_sf:              query,
            anyMaxSizeHitList:    results,
            anyObjFilter_sf:      2,       // nur Haltestellen
            doNotSearchForStops_sf: 0,
        });
        const data = await efaFetch(VRR_STOPFINDER, params);

        const raw = data?.stopFinder?.points?.point
            || data?.stopFinder?.points
            || data?.locations
            || [];
        const points = Array.isArray(raw) ? raw : [raw];

        const locations = points
            .filter(p => p && (p.name || p.nameWO))
            .map(p => ({
                type: 'stop',
                id:   p.stateless || p.id || p.stopID || '',
                name: p.nameWO || p.name || '',
                location: p.coord ? {
                    latitude:  Number(p.coord.y || p.coord.lat || 0),
                    longitude: Number(p.coord.x || p.coord.lon || 0),
                } : undefined,
            }));

        res.json(locations);
    } catch (e) {
        console.error('locations error', e);
        res.status(502).json({ error: e.message });
    }
});

// ─── Abfahrten ───────────────────────────────────────────────────────────────
// GET /api/stops/:id/departures?when=<ISO>&duration=120&results=40
app.get('/api/stops/:id/departures', async (req, res) => {
    const stopId   = req.params.id;
    const results  = Number(req.query.results)  || 40;
    const duration = Number(req.query.duration) || 120;

    // ── KERN-FIX: ISO-Timestamp in EFA-Datumsfelder aufsplitten ──────────────
    // Vorher: der `when`-Parameter wurde ignoriert → immer aktuelle Zeit
    // Jetzt:  korrekte Konvertierung ISO → itdDate*/itdTime*
    const whenIso  = req.query.when || new Date().toISOString();
    const efaTime  = isoToEfaTime(whenIso);
    // ─────────────────────────────────────────────────────────────────────────

    try {
        const params = efaBaseParams({
            type_dm:                  'stop',
            name_dm:                  stopId,
            mode:                     'direct',
            ptOptionsActive:          1,
            deleteAssignedStops_dm:   1,
            useProxFootSearch:        0,
            limit:                    results,
            depType:                  'stopEvents',
            // Zeitfelder aus ISO-Timestamp
            itdDateDay:               efaTime.itdDateDay,
            itdDateMonth:             efaTime.itdDateMonth,
            itdDateYear:              efaTime.itdDateYear,
            itdTimeHour:              efaTime.itdTimeHour,
            itdTimeMinute:            efaTime.itdTimeMinute,
            // Planungshorizont
            itdTripDateTimeDepArr:    'dep',
            useRealtime:              1,
            includedMeans:            'checkbox',
        });

        const data = await efaFetch(VRR_BASE, params);

        // EFA liefert Abfahrten unter verschiedenen Pfaden je nach Version
        const rawDeps = data?.departureList
            || data?.stopEventResponse?.stopEvents
            || data?.stopEvents
            || [];

        const stopName = data?.dm?.points?.point?.nameWO
            || data?.dm?.points?.point?.name
            || stopId;

        const departures = rawDeps.map(d => normalizeEfaDeparture(d, stopName));

        res.json({ departures, stop: { id: stopId, name: stopName } });
    } catch (e) {
        console.error('departures error', e?.body || e);
        res.status(502).json({ error: e.message });
    }
});

// ─── Fahrtverlauf ─────────────────────────────────────────────────────────────
// GET /api/trips/:tripId
app.get('/api/trips/:tripId', async (req, res) => {
    const rawTripId = decodeURIComponent(req.params.tripId);

    try {
        // VRR EFA Trip-Request: wir nutzen den tripID-Parameter
        const params = efaBaseParams({
            tripID:           rawTripId,
            useRealtime:      1,
        });

        const data = await efaFetch(VRR_TRIP, params);

        // EFA gibt Zwischenhalte an verschiedenen Stellen zurück
        const rawStops = data?.trips?.trip?.stopSeq?.point
            || data?.trip?.stopSeq?.point
            || data?.tripList?.trip?.stopSeq?.point
            || data?.stopovers
            || [];

        const points = Array.isArray(rawStops) ? rawStops : [rawStops];
        const stopovers = points.map(normalizeEfaStopover);

        const remarks = normalizeRemarks(
            data?.trips?.trip?.infoTexts
            || data?.trip?.infoTexts
            || []
        );

        res.json({
            stopovers,
            remarks,
            source: 'VRR OpenService',
        });
    } catch (e) {
        console.error('trip error', e?.body || e);
        res.status(502).json({ error: e.message });
    }
});

// ─── Fallback: alle anderen Routen → public/index.html ──────────────────────
app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Server starten ──────────────────────────────────────────────────────────
createServer(app).listen(PORT, () => {
    console.log(`dilaeit backend läuft auf http://localhost:${PORT}`);
    console.log(`VRR Base: ${VRR_BASE}`);
});
