/**
 * app.js — FIFA Match 104 (The Final) primary-retail ticket monitor
 * -----------------------------------------------------------------------------
 * Pipeline per cycle:
 *   1. FETCH    the target URL with Axios (defaults to the local mock server).
 *   2. PARSE    the response: Cheerio for HTML, native JSON for API payloads.
 *   3. FILTER   every listing through strict purity + price rules.
 *   4. NOTIFY   via Nodemailer the instant a listing passes ALL rules.
 *
 * Design goals:
 *   - Fully testable OFFLINE. With no SMTP creds (or DRY_RUN=true) the email is
 *     rendered through Nodemailer's jsonTransport and printed to the console.
 *   - Idempotent alerts. A given listing only ever fires one email.
 *   - Run modes:  `node app.js`         -> long-running scheduler
 *                 `node app.js --once`  -> a single scan, then exit (for tests)
 * -----------------------------------------------------------------------------
 */

'use strict';

require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');

// ─── Configuration (env with safe defaults) ─────────────────────────────────
const CONFIG = {
  targetUrl: process.env.TARGET_URL || 'http://localhost:4040/',
  matchId: String(process.env.TARGET_MATCH_ID || '104').trim(),
  matchName: process.env.TARGET_MATCH_NAME || 'The Final',
  priceCap: Number(process.env.PRICE_CAP || 4200),
  primaryCategory: process.env.PRIMARY_CATEGORY || 'Primary / Standard Retail',
  baseMin: Number(process.env.PRIMARY_BASE_MIN || 3800),
  baseMax: Number(process.env.PRIMARY_BASE_MAX || 4200),
  currency: process.env.CURRENCY || 'USD',
  fetchIntervalMs: Number(process.env.FETCH_INTERVAL_SECONDS || 60) * 1000,
  summaryIntervalMs: Number(process.env.SUMMARY_INTERVAL_SECONDS || 600) * 1000,
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  },
  alertFrom: process.env.ALERT_FROM || 'FIFA Ticket Monitor <monitor@example.com>',
  alertTo: process.env.ALERT_TO || 'you@example.com',
  dryRun: String(process.env.DRY_RUN || 'false') === 'true'
};

// Impurity markers. If a listing's category OR flags contain ANY of these
// (case-insensitive substring match), it is NOT pure primary retail and is
// discarded — no matter how attractive the price looks.
const FORBIDDEN_MARKERS = [
  'resale',
  'verified fan resale',
  'hospitality',
  'vip',
  'package',
  'platinum',
  'secondary'
];

// Remembers listing IDs we've already alerted on, so we never double-send.
const alertedListingIds = new Set();

// ─── Small helpers ──────────────────────────────────────────────────────────
const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}]`, ...a);

/** Normalise a price that may arrive as "$4,150", "USD 4150" or a number. */
function parsePrice(raw) {
  if (typeof raw === 'number') return raw;
  if (raw == null) return NaN;
  // Strip everything that isn't a digit or a decimal point.
  const cleaned = String(raw).replace(/[^0-9.]/g, '');
  return cleaned === '' ? NaN : Number(cleaned);
}

/** True if `text` contains any forbidden impurity marker. */
function hasForbiddenMarker(text) {
  const hay = String(text || '').toLowerCase();
  return FORBIDDEN_MARKERS.some((m) => hay.includes(m));
}

// ─── Step 2a: HTML parsing (Cheerio) ────────────────────────────────────────
/**
 * Extract a normalised listing array from an HTML document.
 * Each `.ticket-listing` node carries its metadata in data-* attributes that
 * mirror the platform's DOM, so we read attributes rather than scraping text
 * (more robust against layout / whitespace changes).
 */
function parseHtml(html) {
  const $ = cheerio.load(html);
  const listings = [];

  $('.ticket-listing').each((_, el) => {
    const node = $(el);
    // Prefer the structured data-* attributes; fall back to visible text only
    // if an attribute is missing, keeping the parser resilient.
    const flagsAttr = node.attr('data-flags') || '';
    listings.push({
      id:
        node.attr('data-listing-id') ||
        node.find('.match').text().trim() ||
        `html-${listings.length}`,
      matchId: (node.attr('data-match-id') || '').trim(),
      matchName: (node.attr('data-match-name') || '').trim(),
      category:
        (node.attr('data-category') || node.find('.category').text()).trim(),
      price: parsePrice(node.attr('data-price') || node.find('.price').text()),
      currency: (node.attr('data-currency') || CONFIG.currency).trim(),
      // Flags come as a comma-separated list in the attribute.
      flags: flagsAttr
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean),
      url: node.attr('data-url') || node.find('a.buy').attr('href') || ''
    });
  });

  return listings;
}

// ─── Step 2b: JSON parsing (structured API) ─────────────────────────────────
/** Normalise a structured JSON payload into the same listing shape. */
function parseJson(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.listings)
    ? payload.listings
    : [];
  return rows.map((r, i) => ({
    id: r.id || `json-${i}`,
    matchId: String(r.matchId != null ? r.matchId : '').trim(),
    matchName: String(r.matchName || '').trim(),
    category: String(r.category || '').trim(),
    price: parsePrice(r.price),
    currency: String(r.currency || CONFIG.currency).trim(),
    flags: Array.isArray(r.flags) ? r.flags : [],
    url: r.url || ''
  }));
}

// ─── Step 3: the strict filter ──────────────────────────────────────────────
/**
 * Decide whether a single normalised listing is a genuine, alert-worthy,
 * pure primary-retail seat for Match 104. Returns { pass, reason }.
 *
 * The checks are ordered cheapest-first and each documents WHY it rejects.
 */
function evaluate(listing) {
  // (1) Right match? We only care about Match 104 — The Final.
  if (listing.matchId !== CONFIG.matchId) {
    return { pass: false, reason: `wrong match (${listing.matchId})` };
  }
  if (
    CONFIG.matchName &&
    !listing.matchName.toLowerCase().includes(CONFIG.matchName.toLowerCase())
  ) {
    return { pass: false, reason: `match name mismatch (${listing.matchName})` };
  }

  // (2) Purity — category must be EXACTLY the official primary category.
  //     Any other category (Hospitality, etc.) is rejected here.
  if (
    listing.category.toLowerCase() !== CONFIG.primaryCategory.toLowerCase()
  ) {
    return { pass: false, reason: `non-primary category (${listing.category})` };
  }

  // (3) Purity — no impurity markers in the category text or the flags list.
  //     This catches "resale", "verified fan resale", "hospitality", etc. even
  //     when a seller tries to label a resale as "Primary".
  const flagText = listing.flags.join(' ');
  if (hasForbiddenMarker(listing.category) || hasForbiddenMarker(flagText)) {
    return {
      pass: false,
      reason: `impurity flag present (${listing.flags.join(',') || 'category'})`
    };
  }

  // (4) Price sanity — must be a real number.
  if (!Number.isFinite(listing.price)) {
    return { pass: false, reason: 'unparseable price' };
  }

  // (5) Hard price cap.
  if (listing.price > CONFIG.priceCap) {
    return { pass: false, reason: `over price cap (${listing.price})` };
  }

  // (6) Base-rate deviation — a *genuine* primary seat sits inside the official
  //     base band. A "primary" listing priced below/above the band is almost
  //     certainly a mis-flagged resale or data error, so discard it.
  if (listing.price < CONFIG.baseMin || listing.price > CONFIG.baseMax) {
    return {
      pass: false,
      reason: `price deviates from official base band (${listing.price} not in ${CONFIG.baseMin}-${CONFIG.baseMax})`
    };
  }

  // Survived every rule → genuine primary retail seat.
  return { pass: true, reason: 'pure primary retail — all rules passed' };
}

// ─── Notification layer (Nodemailer) ────────────────────────────────────────
let transporterPromise = null;

/**
 * Build (once) a Nodemailer transporter. If SMTP creds are missing or DRY_RUN
 * is set, we use jsonTransport so the message is serialised and printed rather
 * than sent — keeping the whole app testable with no live SMTP server.
 */
function getTransporter() {
  if (transporterPromise) return transporterPromise;

  const haveSmtp = CONFIG.smtp.host && CONFIG.smtp.user && CONFIG.smtp.pass;
  if (CONFIG.dryRun || !haveSmtp) {
    log(
      'Email mode: CONSOLE (jsonTransport).',
      CONFIG.dryRun ? 'DRY_RUN=true.' : 'No SMTP credentials configured.'
    );
    transporterPromise = Promise.resolve(
      nodemailer.createTransport({ jsonTransport: true })
    );
  } else {
    log(`Email mode: SMTP via ${CONFIG.smtp.host}:${CONFIG.smtp.port}`);
    transporterPromise = Promise.resolve(
      nodemailer.createTransport({
        host: CONFIG.smtp.host,
        port: CONFIG.smtp.port,
        secure: CONFIG.smtp.secure,
        auth: { user: CONFIG.smtp.user, pass: CONFIG.smtp.pass }
      })
    );
  }
  return transporterPromise;
}

/** Compose and dispatch the alert email for a passing listing. */
async function sendAlert(listing) {
  const priceStr = `${listing.currency} ${listing.price.toLocaleString()}`;
  const subject = `🎟️ PRIMARY RETAIL DROP — Match ${listing.matchId} ${CONFIG.matchName} @ ${priceStr}`;

  const instruction =
    'Action required: Ticket holds on official platforms typically expire ' +
    'within 10 to 15 minutes of user selection. Access the link immediately ' +
    'to secure your manual checkout seat.';

  const text = [
    `A genuine PRIMARY / STANDARD RETAIL ticket for Match ${listing.matchId} ` +
      `(${listing.matchName}) just passed every filter.`,
    '',
    `Match:           Match ${listing.matchId} — ${listing.matchName}`,
    `Category:        ${listing.category}`,
    `Verified price:  ${priceStr} (official primary base band ${CONFIG.baseMin}-${CONFIG.baseMax})`,
    `Listing ID:      ${listing.id}`,
    `Purchase link:   ${listing.url}`,
    '',
    instruction
  ].join('\n');

  const html = `
    <h2>🎟️ Primary Retail Drop — Match ${listing.matchId} (${CONFIG.matchName})</h2>
    <table cellpadding="6" style="border-collapse:collapse">
      <tr><td><b>Match</b></td><td>Match ${listing.matchId} — ${listing.matchName}</td></tr>
      <tr><td><b>Category</b></td><td>${listing.category}</td></tr>
      <tr><td><b>Verified primary price</b></td><td>${priceStr}</td></tr>
      <tr><td><b>Official base band</b></td><td>${CONFIG.currency} ${CONFIG.baseMin.toLocaleString()} – ${CONFIG.baseMax.toLocaleString()}</td></tr>
      <tr><td><b>Listing ID</b></td><td>${listing.id}</td></tr>
    </table>
    <p><a href="${listing.url}"
          style="display:inline-block;padding:12px 20px;background:#0a7d2c;color:#fff;text-decoration:none;border-radius:6px">
       ➜ Go directly to the purchase page
    </a></p>
    <p style="color:#b00020;font-weight:bold">${instruction}</p>
  `;

  const transporter = await getTransporter();
  const info = await transporter.sendMail({
    from: CONFIG.alertFrom,
    to: CONFIG.alertTo,
    subject,
    text,
    html
  });

  // jsonTransport returns the serialised message on `info.message`.
  if (info && info.message) {
    log('ALERT email (console mode) ↓');
    console.log(info.message.toString());
  } else {
    log(`ALERT email sent → ${CONFIG.alertTo} (messageId: ${info.messageId})`);
  }
}

// ─── Step 1 + orchestration: one monitoring cycle ───────────────────────────
let lastSummaryAt = 0;
let lastCycleHadPrimary = false;

/** Fetch, parse, filter, and (if warranted) alert. Returns # of passing seats. */
async function runCycle() {
  let response;
  try {
    response = await axios.get(CONFIG.targetUrl, {
      timeout: 15000,
      // Accept both content types; we branch on the response header below.
      headers: { Accept: 'text/html, application/json' },
      // We want to read 4xx bodies too rather than throw immediately.
      validateStatus: (s) => s >= 200 && s < 500
    });
  } catch (err) {
    log(`FETCH error: ${err.message}`);
    return 0;
  }

  if (response.status !== 200) {
    log(`Non-200 from target (${response.status}); skipping cycle.`);
    return 0;
  }

  // Branch on content type: JSON API vs HTML page.
  const contentType = String(response.headers['content-type'] || '');
  let listings;
  if (contentType.includes('application/json')) {
    listings = parseJson(response.data);
  } else {
    // Axios may have already parsed JSON into an object; coerce to string only
    // when we genuinely have HTML markup.
    const body =
      typeof response.data === 'string'
        ? response.data
        : String(response.data);
    listings = parseHtml(body);
  }

  // Evaluate every listing; collect the winners.
  const passing = [];
  for (const listing of listings) {
    const verdict = evaluate(listing);
    if (verdict.pass) {
      passing.push(listing);
    } else {
      // Verbose per-listing rejection logging helps demonstrate the filters.
      log(`  ✗ rejected ${listing.id}: ${verdict.reason}`);
    }
  }

  lastCycleHadPrimary = passing.length > 0;

  for (const listing of passing) {
    if (alertedListingIds.has(listing.id)) {
      log(`  • already alerted on ${listing.id}; skipping duplicate.`);
      continue;
    }
    log(`  ✓ MATCH ${listing.id}: ${CONFIG.matchName} @ ${listing.currency} ${listing.price}`);
    try {
      await sendAlert(listing);
      alertedListingIds.add(listing.id);
    } catch (err) {
      log(`  ! failed to send alert for ${listing.id}: ${err.message}`);
    }
  }

  return passing.length;
}

/** Emit the heartbeat summary at most once per SUMMARY_INTERVAL. */
function maybePrintSummary(force = false) {
  const now = Date.now();
  if (!force && now - lastSummaryAt < CONFIG.summaryIntervalMs) return;
  lastSummaryAt = now;
  const status = lastCycleHadPrimary ? 'Active' : 'No Primary Seats Found';
  console.log(
    `Monitoring active for Match ${CONFIG.matchId}. ` +
      `Current Status: [${status}]. Time: [${ts()}].`
  );
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────
async function main() {
  const once = process.argv.includes('--once');

  log('FIFA Ticket Monitor starting.');
  log(`Target:   ${CONFIG.targetUrl}`);
  log(`Match:    ${CONFIG.matchId} — ${CONFIG.matchName}`);
  log(`Rules:    category="${CONFIG.primaryCategory}", cap=${CONFIG.currency} ${CONFIG.priceCap}, base band ${CONFIG.baseMin}-${CONFIG.baseMax}`);
  log(`Interval: ${CONFIG.fetchIntervalMs / 1000}s, summary every ${CONFIG.summaryIntervalMs / 1000}s`);

  // Run an immediate first cycle so we don't wait a full interval.
  const hits = await runCycle();
  maybePrintSummary(true); // always print one summary on startup

  if (once) {
    log(`Single-run complete. Passing primary seats this scan: ${hits}.`);
    process.exit(0);
  }

  // Long-running scheduler.
  setInterval(async () => {
    await runCycle();
    maybePrintSummary();
  }, CONFIG.fetchIntervalMs);
}

// Exported for unit testing of the pure pieces; run main() when invoked directly.
module.exports = { evaluate, parseHtml, parseJson, parsePrice, hasForbiddenMarker };

if (require.main === module) {
  main().catch((err) => {
    log(`Fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}
