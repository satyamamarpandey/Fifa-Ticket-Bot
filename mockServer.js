/**
 * mockServer.js
 * -----------------------------------------------------------------------------
 * Zero-dependency local sandbox imitating the ticketing platform so the monitor
 * runs end-to-end with NO external/live environment. Uses Node's built-in
 * `http` module (no Express).
 *
 * States:
 *   GET /        quiet page — only resale / hospitality / wrong-match noise.
 *   GET /drop    a genuine primary-retail drop: one valid Match 104 Category 2
 *                seat at official face value, buried among decoys that each
 *                exercise a different rejection rule.
 *   GET /health  liveness probe -> {"status":"ok"}.
 *
 * Append ?format=json (or send Accept: application/json) to "/" or "/drop" to
 * receive the same data as a structured API payload instead of HTML, so both
 * parsing paths in app.js can be tested.
 *
 * Prices reflect FIFA's published primary face values for the 2026 Final
 * (Match 104, MetLife Stadium): Cat 1 $6,730+ (dynamic), Cat 2 $4,210,
 * Cat 3 $2,790, Cat 4 $2,030. Resale runs $8,000+. A 15% service fee applies
 * at checkout (modelled by the monitor, not added here).
 *
 * Run:  node mockServer.js     (reads MOCK_PORT from .env, default 4040)
 * -----------------------------------------------------------------------------
 */

'use strict';

require('dotenv').config();
const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.MOCK_PORT) || 4040;
const CHECKOUT_URL = `http://localhost:${PORT}/checkout/match104-final-cat2-A17`;

// Canonical listings (described once; rendered as HTML or JSON on demand).
const LISTINGS = {
  // The ONE seat that should pass every rule: primary, Category 2, face value.
  validPrimary: {
    id: 'L-VALID-104',
    matchId: '104',
    matchName: 'The Final',
    saleType: 'Primary',
    category: 'Category 2',
    price: 4210, // official Cat 2 face value, within ±5% band and under cap
    currency: 'USD',
    flags: [],
    url: CHECKOUT_URL,
    label: 'Match 104 — The Final · Category 2 (Primary)'
  },

  // Decoys — each must be rejected for a DIFFERENT reason.

  // Resale of a Cat 1 seat -> rejected by sale-type / impurity marker.
  resaleDecoy: {
    id: 'L-RESALE-104',
    matchId: '104',
    matchName: 'The Final',
    saleType: 'Verified Fan Resale',
    category: 'Category 1',
    price: 8200,
    currency: 'USD',
    flags: ['resale'],
    url: `http://localhost:${PORT}/checkout/resale-xyz`,
    label: 'Match 104 — The Final · Verified Fan Resale'
  },

  // Hospitality package -> rejected by sale-type / impurity marker.
  hospitalityDecoy: {
    id: 'L-HOSP-104',
    matchId: '104',
    matchName: 'The Final',
    saleType: 'Hospitality',
    category: 'Hospitality Suite',
    price: 12000,
    currency: 'USD',
    flags: ['hospitality'],
    url: `http://localhost:${PORT}/checkout/hosp-pkg`,
    label: 'Match 104 — The Final · Hospitality Suite'
  },

  // Labelled "Primary" but priced like a resale -> rejected by base-rate
  // deviation AND budget cap (a mis-flagged resale).
  overpricedPrimaryDecoy: {
    id: 'L-OVERPRICE-104',
    matchId: '104',
    matchName: 'The Final',
    saleType: 'Primary',
    category: 'Category 2',
    price: 9800,
    currency: 'USD',
    flags: [],
    url: `http://localhost:${PORT}/checkout/primary-overpriced`,
    label: 'Match 104 — The Final · "Primary" Cat 2 (suspicious price)'
  },

  // Legit primary Category 4 near $2,000 — the "around 2000" target. Passes in
  // both category/budget mode and target-price mode.
  cat4Primary: {
    id: 'L-CAT4-104',
    matchId: '104',
    matchName: 'The Final',
    saleType: 'Primary',
    category: 'Category 4',
    price: 2030, // official Cat 4 face value
    currency: 'USD',
    flags: [],
    url: `http://localhost:${PORT}/checkout/match104-final-cat4-B22`,
    label: 'Match 104 — The Final · Category 4 (Primary, ~$2,000)'
  },

  // Legit primary Cat 1 but above the budget cap -> rejected by cap.
  cat1OverCapDecoy: {
    id: 'L-CAT1-104',
    matchId: '104',
    matchName: 'The Final',
    saleType: 'Primary',
    category: 'Category 1',
    price: 6730,
    currency: 'USD',
    flags: [],
    url: `http://localhost:${PORT}/checkout/cat1`,
    label: 'Match 104 — The Final · Category 1 (over budget)'
  },

  // Perfectly valid primary, but the WRONG match -> ignored.
  wrongMatchDecoy: {
    id: 'L-PRIMARY-087',
    matchId: '87',
    matchName: 'Semi-Final 2',
    saleType: 'Primary',
    category: 'Category 2',
    price: 2200,
    currency: 'USD',
    flags: [],
    url: `http://localhost:${PORT}/checkout/semifinal`,
    label: 'Match 87 — Semi-Final 2 · Category 2 (Primary)'
  }
};

const ROUTE_DATA = {
  '/': [LISTINGS.resaleDecoy, LISTINGS.hospitalityDecoy, LISTINGS.wrongMatchDecoy],
  '/drop': [
    LISTINGS.resaleDecoy,
    LISTINGS.hospitalityDecoy,
    LISTINGS.overpricedPrimaryDecoy,
    LISTINGS.cat1OverCapDecoy,
    LISTINGS.validPrimary,
    LISTINGS.cat4Primary,
    LISTINGS.wrongMatchDecoy
  ]
};

// HTML escaping so listing data can't break out of attributes.
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderCard(t) {
  return `
    <div class="ticket-listing"
         data-listing-id="${esc(t.id)}"
         data-match-id="${esc(t.matchId)}"
         data-match-name="${esc(t.matchName)}"
         data-sale-type="${esc(t.saleType)}"
         data-category="${esc(t.category)}"
         data-price="${esc(t.price)}"
         data-currency="${esc(t.currency)}"
         data-flags="${esc(t.flags.join(','))}"
         data-url="${esc(t.url)}">
      <span class="match">Match ${esc(t.matchId)} — ${esc(t.matchName)}</span>
      <span class="sale-type">${esc(t.saleType)}</span>
      <span class="category">${esc(t.category)}</span>
      <span class="price">${esc(t.currency)} ${Number(t.price).toLocaleString()}</span>
      <a class="buy" href="${esc(t.url)}">Buy</a>
    </div>`;
}

function renderPage(listings, route) {
  const cards = listings.map(renderCard).join('\n');
  const banner = route === '/drop'
    ? '<p id="status">PRIMARY RETAIL DROP IN PROGRESS</p>'
    : '<p id="status">No primary inventory currently available</p>';
  return `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8"><title>FIFA Tickets — Mock</title></head>
  <body>
    <h1>FIFA Official Ticketing (MOCK)</h1>
    ${banner}
    <section id="listings">
${cards}
    </section>
  </body>
</html>`;
}

function wantsJson(req, parsedUrl) {
  if (parsedUrl.searchParams.get('format') === 'json') return true;
  return (req.headers.accept || '').toLowerCase().includes('application/json');
}

const server = http.createServer((req, res) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }
  const route = parsedUrl.pathname;

  if (route === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
    return;
  }

  if (route.startsWith('/checkout/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><body><h1>Checkout</h1><p>Mock manual checkout for ${esc(route)}. Hold expires in ~10–15 minutes.</p></body></html>`);
    return;
  }

  const data = ROUTE_DATA[route];
  if (!data) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found. Try "/" or "/drop".');
    return;
  }

  if (wantsJson(req, parsedUrl)) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ match: '104', generatedAt: new Date().toISOString(), listings: data }, null, 2));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderPage(data, route));
});

server.listen(PORT, () => {
  console.log('────────────────────────────────────────────────────────────');
  console.log(` Mock ticketing server listening on http://localhost:${PORT}`);
  console.log('   GET /          → quiet page (no alert-worthy tickets)');
  console.log('   GET /drop      → primary-retail drop (triggers an alert)');
  console.log('   GET /health    → liveness probe');
  console.log('   add ?format=json to "/" or "/drop" for the JSON API path');
  console.log('────────────────────────────────────────────────────────────');
});

// Graceful shutdown so `npm run mock` exits cleanly under process managers.
function close(signal) {
  console.log(`\nReceived ${signal}; closing mock server.`);
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => close('SIGINT'));
process.on('SIGTERM', () => close('SIGTERM'));

module.exports = { server, LISTINGS, ROUTE_DATA };
