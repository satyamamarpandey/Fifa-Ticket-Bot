/**
 * mockServer.js
 * -----------------------------------------------------------------------------
 * A zero-dependency local sandbox that imitates the ticketing platform so the
 * monitor can be exercised end-to-end with NO external/live environment.
 *
 * It uses Node's built-in `http` module (no Express needed) and exposes two
 * meaningful states:
 *
 *   GET  /         -> a normal "quiet" page. Contains only sold-out / resale /
 *                     hospitality noise — i.e. NOTHING the monitor should alert
 *                     on. This is the steady-state the monitor sees 99% of time.
 *
 *   GET  /drop     -> simulates a genuine primary-retail drop. Contains ONE
 *                     valid "Primary / Standard Retail" Match 104 listing that
 *                     satisfies every rule, surrounded by decoy listings
 *                     (resale, hospitality, wrong match, over-priced "primary")
 *                     so you can prove the filters reject impostors.
 *
 * Both routes also support a structured-API mode: append `?format=json` (or send
 * `Accept: application/json`) and the same data is returned as a JSON payload
 * instead of HTML. This lets you test BOTH parsing paths in app.js.
 *
 * Run:  node mockServer.js          (reads MOCK_PORT from .env, default 4040)
 * -----------------------------------------------------------------------------
 */

'use strict';

require('dotenv').config();
const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.MOCK_PORT) || 4040;

// A stable, direct checkout link the alert email will point at.
const CHECKOUT_URL =
  'http://localhost:' + PORT + '/checkout/match104-final-primary-A17';

/**
 * Canonical listing objects. Each is described once as data, then rendered
 * either as HTML or JSON depending on the request. `flags` carries the impurity
 * markers the monitor must screen for.
 */
const LISTINGS = {
  // ---- The ONE listing that should pass every rule -------------------------
  validPrimary: {
    id: 'L-VALID-104',
    matchId: '104',
    matchName: 'The Final',
    category: 'Primary / Standard Retail',
    price: 4150, // inside the [3800, 4200] base band AND under the 4200 cap
    currency: 'USD',
    flags: [], // pure: no resale / hospitality markers
    url: CHECKOUT_URL,
    label: 'Match 104 — The Final · Category 1 (Primary / Standard Retail)'
  },

  // ---- Decoys that MUST be rejected ---------------------------------------
  // Right match + category, but flagged as resale -> impure.
  resaleDecoy: {
    id: 'L-RESALE-104',
    matchId: '104',
    matchName: 'The Final',
    category: 'Primary / Standard Retail',
    price: 4100,
    currency: 'USD',
    flags: ['verified fan resale'],
    url: 'http://localhost:' + PORT + '/checkout/resale-xyz',
    label: 'Match 104 — The Final · Verified Fan Resale'
  },

  // Right match, but hospitality package -> impure.
  hospitalityDecoy: {
    id: 'L-HOSP-104',
    matchId: '104',
    matchName: 'The Final',
    category: 'Hospitality',
    price: 4000,
    currency: 'USD',
    flags: ['hospitality'],
    url: 'http://localhost:' + PORT + '/checkout/hosp-pkg',
    label: 'Match 104 — The Final · Hospitality Suite'
  },

  // Claims to be primary, but priced FAR outside the official base band ->
  // treated as a mis-flagged resale and discarded by the deviation check.
  overpricedPrimaryDecoy: {
    id: 'L-OVERPRICE-104',
    matchId: '104',
    matchName: 'The Final',
    category: 'Primary / Standard Retail',
    price: 9800, // way above PRIMARY_BASE_MAX and the price cap
    currency: 'USD',
    flags: [],
    url: 'http://localhost:' + PORT + '/checkout/primary-overpriced',
    label: 'Match 104 — The Final · "Primary" (suspicious price)'
  },

  // A perfectly valid primary ticket, but for the WRONG match -> ignored.
  wrongMatchDecoy: {
    id: 'L-PRIMARY-087',
    matchId: '87',
    matchName: 'Semi-Final 2',
    category: 'Primary / Standard Retail',
    price: 2200,
    currency: 'USD',
    flags: [],
    url: 'http://localhost:' + PORT + '/checkout/semifinal',
    label: 'Match 87 — Semi-Final 2 · Primary / Standard Retail'
  }
};

// What each route serves.
const ROUTE_DATA = {
  // Quiet page: only noise, nothing alert-worthy.
  '/': [
    LISTINGS.resaleDecoy,
    LISTINGS.hospitalityDecoy,
    LISTINGS.wrongMatchDecoy
  ],
  // Drop page: the valid ticket buried among decoys.
  '/drop': [
    LISTINGS.resaleDecoy,
    LISTINGS.hospitalityDecoy,
    LISTINGS.overpricedPrimaryDecoy,
    LISTINGS.validPrimary,
    LISTINGS.wrongMatchDecoy
  ]
};

/** Render a single listing as an HTML card. Attributes mirror the JSON keys so
 *  Cheerio selectors in app.js can read them directly. */
function renderCard(t) {
  return `
    <div class="ticket-listing"
         data-listing-id="${t.id}"
         data-match-id="${t.matchId}"
         data-match-name="${t.matchName}"
         data-category="${t.category}"
         data-price="${t.price}"
         data-currency="${t.currency}"
         data-flags="${t.flags.join(',')}"
         data-url="${t.url}">
      <span class="match">Match ${t.matchId} — ${t.matchName}</span>
      <span class="category">${t.category}</span>
      <span class="price">${t.currency} ${t.price.toLocaleString()}</span>
      <a class="buy" href="${t.url}">Buy</a>
    </div>`;
}

/** Wrap listing cards in a minimal page. */
function renderPage(listings, route) {
  const cards = listings.map(renderCard).join('\n');
  const banner =
    route === '/drop'
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

/** Decide whether the caller wants JSON instead of HTML. */
function wantsJson(req, parsedUrl) {
  if (parsedUrl.searchParams.get('format') === 'json') return true;
  const accept = (req.headers.accept || '').toLowerCase();
  return accept.includes('application/json');
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const route = parsedUrl.pathname;

  // Checkout pages are just stubs so the email link resolves to *something*.
  if (route.startsWith('/checkout/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<!DOCTYPE html><html><body><h1>Checkout</h1>` +
        `<p>Mock manual checkout page for ${route}. ` +
        `Hold expires in ~10–15 minutes.</p></body></html>`
    );
    return;
  }

  const data = ROUTE_DATA[route];
  if (!data) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found. Try "/" or "/drop".');
    return;
  }

  if (wantsJson(req, parsedUrl)) {
    // Structured API payload path.
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify(
        {
          match: '104',
          generatedAt: new Date().toISOString(),
          listings: data
        },
        null,
        2
      )
    );
    return;
  }

  // Default: HTML path for Cheerio.
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderPage(data, route));
});

server.listen(PORT, () => {
  console.log('────────────────────────────────────────────────────────────');
  console.log(` Mock ticketing server listening on http://localhost:${PORT}`);
  console.log('   GET /          → quiet page (no alert-worthy tickets)');
  console.log('   GET /drop      → primary-retail drop (triggers an alert)');
  console.log('   add ?format=json to either route for the JSON API path');
  console.log('────────────────────────────────────────────────────────────');
});
