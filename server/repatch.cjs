const fs = require('fs');
const path = require('path');

const indexJsPath = path.join(__dirname, 'index.js');
let indexJs = fs.readFileSync(indexJsPath, 'utf8');

// Update Transitous search HUBS and matching in index.js
const oldHubs = `        const HUBS = [
            'de:05116:8000250', // Mönchengladbach Hbf
            'de:05315:8000207', // Köln Hbf
            'de:05111:8000085', // Düsseldorf Hbf
            'de:05913:8000096', // Dortmund Hbf
            'de:05314:8000044', // Bonn Hbf
            'de:07135:8000206', // Koblenz Hbf
            'de:05124:8000191', // Essen Hbf
        ];`;

const newHubs = `        const HUBS = [
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
        ];`;

indexJs = indexJs.replace(oldHubs, newHubs);

// Update n=200 to n=500
indexJs = indexJs.replace("n: '200', window: '86400'", "n: '500', window: '86400'");

// Update Transitous JSON response in index.js to include operator and remarks
const oldResJson = `        res.json({

            stopovers, remarks: [], source: 'Transitous',

            tripId: match.tripId, dbTripId: match.tripId,

            line: { name: match.displayName || match.routeShortName || number, product: (match.mode || 'bus').toLowerCase() }

        });`;

const newResJson = `        res.json({
            stopovers, 
            remarks: (data.remarks || []).map(r => ({ text: r.text || r, type: 'info' })), 
            source: 'Transitous',
            operator: leg.operator?.name || data.operator?.name || null,
            tripId: match.tripId, 
            line: { name: match.displayName || match.routeShortName || number, product: (match.mode || 'bus').toLowerCase() }
        });`;

indexJs = indexJs.replace(oldResJson, newResJson);

// Fix trip-search.html matching and hubs
const tripSearchPath = path.join(__dirname, '..', 'public', 'trip-search.html');
let tripSearch = fs.readFileSync(tripSearchPath, 'utf8');

const oldTransitousHubs = `const TRANSITOUS_HUBS = [
    "de:05116:23007", // MG Hbf
    "de:05111:15151", // Düsseldorf Hbf
    "de:05315:11201"  // Köln Hbf
];`;

const newTransitousHubs = `const TRANSITOUS_HUBS = [
    "de:05116:23007", // MG Hbf
    "de:05111:15151", // Düsseldorf Hbf
    "de:05315:11201", // Köln Hbf
    "de:05913:00001", // Dortmund Hbf
    "de:05112:13101", // Duisburg Hbf
    "de:05124:11101", // Essen Hbf
    "de:07135:00206", // Koblenz Hbf
    "de:05314:00044"  // Bonn Hbf
];`;

tripSearch = tripSearch.replace(oldTransitousHubs, newTransitousHubs);
tripSearch = tripSearch.replace("n=200", "n=500");

// Verbesserte Suche nach Zugnummer
const oldMatchesSearch = `                    const matches = tripUp === q || tripUp.endsWith(q) || tripUp.includes(q)
                                 || displayUp === q || displayUp.includes("(" + q + ")") || displayUp.includes(q)
                                 || routeUp === q || routeUp.includes(q)
                                 || nameUp.includes(q);`;

const newMatchesSearch = `                    const matches = q.length >= 3 && (
                                    tripUp === q || tripUp.endsWith(q) || tripUp.includes(q)
                                 || displayUp === q || displayUp.includes("(" + q + ")") || displayUp.includes(q)
                                 || routeUp === q || routeUp.includes(q)
                                 || nameUp.includes(q) || nameUp.includes("(" + q + ")")
                                 );`;

tripSearch = tripSearch.replace(oldMatchesSearch, newMatchesSearch);
fs.writeFileSync(tripSearchPath, tripSearch);
console.log('trip-search.html patched');
