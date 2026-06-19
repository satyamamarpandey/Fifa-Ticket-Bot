/**
 * app.js — FIFA Match 104 (The Final) primary-retail ticket monitor
 * -----------------------------------------------------------------------------
 * Pipeline per cycle:  FETCH (axios, with retry) -> PARSE (cheerio HTML or JSON
 * API) -> FILTER (strict purity + official base-rate + budget rules) -> NOTIFY
 * (nodemailer; console fallback when no SMTP creds).
 *
 * Production characteristics:
 *   - Fail-fast config validation at startup.
 *   - Real FIFA 2026 Final base rates baked in (overridable via env).
 *   - Fetch retries with exponential backoff; non-overlapping scheduler.
 *   - Graceful shutdown (SIGINT/SIGTERM) and global error handlers.
 *   - SMTP verified on boot; jsonTransport fallback keeps it testable offline.
 *   - Idempotent alerts (a given listing fires at most once per process).
 *   - Leveled logging via LOG_LEVEL.
 *   - Pure functions exported for unit testing.
 *
 * Run modes:  `node app.js`        long-running scheduler
 *             `node app.js --once`  single scan then exit (CI / smoke test)
 * -----------------------------------------------------------------------------
 */

'use strict';

require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');

// ─── Logging ────────────────────────────────────────────────────────────────
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const ACTIVE_LEVEL = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;
const ts = () => new Date().toISOString();
function emit(level, ...a) {
  if (LEVELS[level] < ACTIVE_LEVEL) return;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${ts()}] [${level.toUpperCase()}]`, ...a);
}
const log = {
  debug: (...a) => emit('debug', ...a),
  info: (...a) => emit('info', ...a),
  warn: (...a) => emit('warn', ...a),
  error: (...a) => emit('error', ...a)
};

// ─── Config helpers ─────────────────────────────────────────────────────────
function num(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}
function bool(name, def = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  return String(raw).toLowerCase() === 'true';
}

/**
 * Official FIFA World Cup 2026 Final (Match 104, MetLife Stadium) primary
 * face-value base rates by category, in USD. Source: FIFA published primary
 * pricing, June 2026. Category 1 / Front Category 1 are dynamically priced and
 * excluded from the default budget-oriented set — add them via env if needed.
 * Override wholesale with OFFICIAL_BASE_RATES as a JSON object.
 */
const DEFAULT_BASE_RATES = {
  'Category 2': 4210,
  'Category 3': 2790,
  'Category 4': 2030
};
function parseBaseRates(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    return null;
  } catch {
    return null;
  }
}

const CONFIG = {
  targetUrl: process.env.TARGET_URL || 'http://localhost:4040/',
  matchId: String(process.env.TARGET_MATCH_ID || '104').trim(),
  matchName: process.env.TARGET_MATCH_NAME || 'The Final',

  // Only this sale channel is "primary retail"; everything else is impure.
  primarySaleType: (process.env.PRIMARY_SALE_TYPE || 'Primary').trim(),

  // Budget ceiling applied to the FACE value (the listed ticket price).
  priceCap: num('PRICE_CAP', 4300),

  // Per-category official base rates and the allowed deviation around them.
  baseRates: parseBaseRates(process.env.OFFICIAL_BASE_RATES) || DEFAULT_BASE_RATES,
  deviationTolPct: num('DEVIATION_TOLERANCE_PCT', 0.05),

  // FIFA's checkout service fee, informational (shown in the alert).
  serviceFeePct: num('SERVICE_FEE_PCT', 0.15),

  currency: process.env.CURRENCY || 'USD',

  fetchIntervalMs: num('FETCH_INTERVAL_SECONDS', 60) * 1000,
  summaryIntervalMs: num('SUMMARY_INTERVAL_SECONDS', 600) * 1000,
  fetchTimeoutMs: num('FETCH_TIMEOUT_SECONDS', 15) * 1000,
  fetchRetries: num('FETCH_RETRIES', 3),

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: num('SMTP_PORT', 587),
    secure: bool('SMTP_SECURE', false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  },
  alertFrom: process.env.ALERT_FROM || 'FIFA Ticket Monitor <monitor@example.com>',
  alertTo: process.env.ALERT_TO || 'you@example.com',
  dryRun: bool('DRY_RUN', false)
};

// Impurity markers screened across saleType, category, and flags.
const FORBIDDEN_MARKERS = [
  'resale',
  'verified fan resale',
  'hospitality',
  'vip',
  'package',
  'platinum',
  'secondary',
  'reseller'
];

/** Validate config at startup and throw on anything that would silently break. */
function validateConfig(cfg = CONFIG) {
  const errors = [];
  if (!/^https?:\/\//i.test(cfg.targetUrl)) errors.push(`TARGET_URL must be http(s): "${cfg.targetUrl}"`);
  if (!cfg.matchId) errors.push('TARGET_MATCH_ID is required');
  if (!(cfg.priceCap > 0)) errors.push(`PRICE_CAP must be > 0 (got ${cfg.priceCap})`);
  if (!(cfg.deviationTolPct >= 0 && cfg.deviationTolPct < 1)) errors.push(`DEVIATION_TOLERANCE_PCT must be in [0,1) (got ${cfg.deviationTolPct})`);
  if (!cfg.baseRates || Object.keys(cfg.baseRates).length === 0) errors.push('OFFICIAL_BASE_RATES is empty');
  for (const [k, v] of Object.entries(cfg.baseRates || {})) {
    if (!(Number(v) > 0)) errors.push(`base rate for "${k}" must be > 0 (got ${v})`);
  }
  if (!(cfg.fetchIntervalMs >= 1000)) errors.push('FETCH_INTERVAL_SECONDS must be >= 1');
  if (!cfg.alertTo) errors.push('ALERT_TO is required');
  // SMTP is all-or-nothing: either provide host+user+pass, or none (console mode).
  const some = cfg.smtp.host || cfg.smtp.user || cfg.smtp.pass;
  const all = cfg.smtp.host && cfg.smtp.user && cfg.smtp.pass;
  if (some && !all) errors.push('Partial SMTP config: set SMTP_HOST, SMTP_USER and SMTP_PASS together (or none for console mode)');
  if (errors.length) throw new Error('Invalid configuration:\n  - ' + errors.join('\n  - '));
}

// ─── Parsing helpers ────────────────────────────────────────────────────────
/** Normalise a price that may arrive as "$4,210", "USD 4210", or a number. */
function parsePrice(raw) {
  if (typeof raw === 'number') return raw;
  if (raw == null) return NaN;
  const cleaned = String(raw).replace(/[^0-9.]/g, '');
  return cleaned === '' ? NaN : Number(cleaned);
}

/** True if `text` contains any forbidden impurity marker (case-insensitive). */
function hasForbiddenMarker(text) {
  const hay = String(text || '').toLowerCase();
  return FORBIDDEN_MARKERS.some((m) => hay.includes(m));
}

/** Extract normalised listings from an HTML document via Cheerio. */
function parseHtml(html) {
  const $ = cheerio.load(html);
  const listings = [];
  $('.ticket-listing').each((_, el) => {
    const node = $(el);
    const flagsAttr = node.attr('data-flags') || '';
    listings.push({
      id: node.attr('data-listing-id') || `html-${listings.length}`,
      matchId: (node.attr('data-match-id') || '').trim(),
      matchName: (node.attr('data-match-name') || '').trim(),
      // Sale channel drives the purity check; fall back to visible text.
      saleType: (node.attr('data-sale-type') || node.find('.sale-type').text() || '').trim(),
      category: (node.attr('data-category') || node.find('.category').text() || '').trim(),
      price: parsePrice(node.attr('data-price') || node.find('.price').text()),
      currency: (node.attr('data-currency') || CONFIG.currency).trim(),
      flags: flagsAttr.split(',').map((f) => f.trim()).filter(Boolean),
      url: node.attr('data-url') || node.find('a.buy').attr('href') || ''
    });
  });
  return listings;
}

/** Normalise a structured JSON payload into the same listing shape. */
function parseJson(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : payload && Array.isArray(payload.listings)
    ? payload.listings
    : [];
  return rows.map((r, i) => ({
    id: r.id || `json-${i}`,
    matchId: String(r.matchId != null ? r.matchId : '').trim(),
    matchName: String(r.matchName || '').trim(),
    saleType: String(r.saleType || '').trim(),
    category: String(r.category || '').trim(),
    price: parsePrice(r.price),
    currency: String(r.currency || CONFIG.currency).trim(),
    flags: Array.isArray(r.flags) ? r.flags : [],
    url: r.url || ''
  }));
}

// ─── The strict filter ──────────────────────────────────────────────────────
/**
 * Decide whether a normalised listing is a genuine, alert-worthy, pure
 * primary-retail seat for the target match. Returns { pass, reason }.
 * `cfg` is injectable so the rules are unit-testable in isolation.
 */
function evaluate(listing, cfg = CONFIG) {
  // (1) Right match — only Match 104 / The Final.
  if (listing.matchId !== cfg.matchId) {
    return { pass: false, reason: `wrong match (${listing.matchId || 'n/a'})` };
  }
  if (cfg.matchName && !listing.matchName.toLowerCase().includes(cfg.matchName.toLowerCase())) {
    return { pass: false, reason: `match name mismatch (${listing.matchName})` };
  }

  // (2) Purity — sale channel must be exactly the primary type.
  if (listing.saleType.toLowerCase() !== cfg.primarySaleType.toLowerCase()) {
    return { pass: false, reason: `non-primary sale type (${listing.saleType || 'n/a'})` };
  }

  // (3) Purity — no impurity markers anywhere (catches resale/hospitality even
  //     if a seller tries to relabel them as "Primary").
  const haystack = `${listing.saleType} ${listing.category} ${listing.flags.join(' ')}`;
  if (hasForbiddenMarker(haystack)) {
    return { pass: false, reason: `impurity marker present (${listing.flags.join(',') || listing.category})` };
  }

  // (4) Category must be a known official primary tier.
  const baseRate = cfg.baseRates[listing.category];
  if (!(Number(baseRate) > 0)) {
    return { pass: false, reason: `unknown / unpriced category (${listing.category || 'n/a'})` };
  }

  // (5) Price must parse.
  if (!Number.isFinite(listing.price)) {
    return { pass: false, reason: 'unparseable price' };
  }

  // (6) Budget cap on face value.
  if (listing.price > cfg.priceCap) {
    return { pass: false, reason: `over budget cap (${listing.price} > ${cfg.priceCap})` };
  }

  // (7) Base-rate deviation — a genuine primary seat sits within tolerance of
  //     its category's official face value. Anything outside is treated as a
  //     mis-flagged resale / data error and discarded.
  const lo = baseRate * (1 - cfg.deviationTolPct);
  const hi = baseRate * (1 + cfg.deviationTolPct);
  if (listing.price < lo || listing.price > hi) {
    return {
      pass: false,
      reason: `price deviates from official ${listing.category} base ${baseRate} (allowed ${Math.round(lo)}-${Math.round(hi)})`
    };
  }

  return { pass: true, reason: `pure primary retail (${listing.category} @ base ${baseRate})`, baseRate };
}

// ─── Notification layer ─────────────────────────────────────────────────────
let transporter = null;

/** Build (once) and verify a Nodemailer transporter. */
async function initTransporter() {
  const haveSmtp = CONFIG.smtp.host && CONFIG.smtp.user && CONFIG.smtp.pass;
  if (CONFIG.dryRun || !haveSmtp) {
    log.info(`Email mode: CONSOLE (jsonTransport). ${CONFIG.dryRun ? 'DRY_RUN=true.' : 'No SMTP credentials configured.'}`);
    transporter = nodemailer.createTransport({ jsonTransport: true });
    return;
  }
  log.info(`Email mode: SMTP ${CONFIG.smtp.host}:${CONFIG.smtp.port} (secure=${CONFIG.smtp.secure})`);
  transporter = nodemailer.createTransport({
    host: CONFIG.smtp.host,
    port: CONFIG.smtp.port,
    secure: CONFIG.smtp.secure,
    auth: { user: CONFIG.smtp.user, pass: CONFIG.smtp.pass }
  });
  // Fail fast if credentials/host are wrong rather than at first alert.
  await transporter.verify();
  log.info('SMTP connection verified.');
}

/** Compose and dispatch the alert email for a passing listing. */
async function sendAlert(listing) {
  const face = listing.price;
  const total = Math.round(face * (1 + CONFIG.serviceFeePct));
  const priceStr = `${listing.currency} ${face.toLocaleString()}`;
  const totalStr = `${listing.currency} ${total.toLocaleString()}`;
  const subject = `🎟️ PRIMARY RETAIL DROP — Match ${listing.matchId} ${CONFIG.matchName} (${listing.category}) @ ${priceStr}`;

  const instruction =
    'Action required: Ticket holds on official platforms typically expire ' +
    'within 10 to 15 minutes of user selection. Access the link immediately ' +
    'to secure your manual checkout seat.';

  const text = [
    `A genuine PRIMARY / STANDARD RETAIL ticket for Match ${listing.matchId} (${listing.matchName}) just passed every filter.`,
    '',
    `Match:           Match ${listing.matchId} — ${listing.matchName}`,
    `Category:        ${listing.category} (sale type: ${listing.saleType})`,
    `Verified price:  ${priceStr} face  (~${totalStr} incl. ${Math.round(CONFIG.serviceFeePct * 100)}% service fee)`,
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
      <tr><td><b>Sale type</b></td><td>${listing.saleType}</td></tr>
      <tr><td><b>Verified primary price</b></td><td>${priceStr} face</td></tr>
      <tr><td><b>Est. total incl. ${Math.round(CONFIG.serviceFeePct * 100)}% fee</b></td><td>${totalStr}</td></tr>
      <tr><td><b>Listing ID</b></td><td>${listing.id}</td></tr>
    </table>
    <p><a href="${listing.url}" style="display:inline-block;padding:12px 20px;background:#0a7d2c;color:#fff;text-decoration:none;border-radius:6px">➜ Go directly to the purchase page</a></p>
    <p style="color:#b00020;font-weight:bold">${instruction}</p>
  `;

  const info = await transporter.sendMail({ from: CONFIG.alertFrom, to: CONFIG.alertTo, subject, text, html });
  if (info && info.message) {
    log.info('ALERT email (console mode) ↓');
    console.log(info.message.toString());
  } else {
    log.info(`ALERT email sent → ${CONFIG.alertTo} (messageId: ${info.messageId})`);
  }
}

// ─── Fetch with retry/backoff ───────────────────────────────────────────────
async function fetchTarget() {
  let lastErr;
  for (let attempt = 0; attempt <= CONFIG.fetchRetries; attempt++) {
    try {
      const res = await axios.get(CONFIG.targetUrl, {
        timeout: CONFIG.fetchTimeoutMs,
        headers: { Accept: 'text/html, application/json' },
        validateStatus: (s) => s >= 200 && s < 500
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < CONFIG.fetchRetries) {
        const backoff = 1000 * Math.pow(2, attempt);
        log.warn(`Fetch attempt ${attempt + 1} failed (${err.message}); retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

// ─── Orchestration ──────────────────────────────────────────────────────────
const alertedListingIds = new Set();
let lastSummaryAt = 0;
let lastCycleHadPrimary = false;
let cycleInFlight = false;

/** One full cycle. Returns the number of passing seats. */
async function runCycle() {
  if (cycleInFlight) {
    log.debug('Previous cycle still running; skipping this tick.');
    return 0;
  }
  cycleInFlight = true;
  try {
    let response;
    try {
      response = await fetchTarget();
    } catch (err) {
      log.error(`FETCH failed after retries: ${err.message}`);
      return 0;
    }

    const contentType = String(response.headers['content-type'] || '');
    let listings;
    if (contentType.includes('application/json')) {
      listings = parseJson(response.data);
    } else {
      const body = typeof response.data === 'string' ? response.data : String(response.data);
      listings = parseHtml(body);
    }
    log.debug(`Parsed ${listings.length} listing(s) from ${contentType.includes('json') ? 'JSON' : 'HTML'}`);

    const passing = [];
    for (const listing of listings) {
      const verdict = evaluate(listing);
      if (verdict.pass) passing.push(listing);
      else log.debug(`  ✗ ${listing.id}: ${verdict.reason}`);
    }
    lastCycleHadPrimary = passing.length > 0;

    for (const listing of passing) {
      if (alertedListingIds.has(listing.id)) {
        log.debug(`  • already alerted on ${listing.id}; skipping.`);
        continue;
      }
      log.info(`  ✓ MATCH ${listing.id}: ${CONFIG.matchName} ${listing.category} @ ${listing.currency} ${listing.price}`);
      try {
        await sendAlert(listing);
        alertedListingIds.add(listing.id);
      } catch (err) {
        log.error(`  ! failed to send alert for ${listing.id}: ${err.message}`);
      }
    }
    return passing.length;
  } finally {
    cycleInFlight = false;
  }
}

/** Heartbeat summary, throttled to SUMMARY_INTERVAL. */
function maybePrintSummary(force = false) {
  const now = Date.now();
  if (!force && now - lastSummaryAt < CONFIG.summaryIntervalMs) return;
  lastSummaryAt = now;
  const status = lastCycleHadPrimary ? 'Active' : 'No Primary Seats Found';
  console.log(`Monitoring active for Match ${CONFIG.matchId}. Current Status: [${status}]. Time: [${ts()}].`);
}

// ─── Scheduler + lifecycle ──────────────────────────────────────────────────
let timer = null;
let shuttingDown = false;

async function loop() {
  if (shuttingDown) return;
  await runCycle();
  maybePrintSummary();
  if (!shuttingDown) timer = setTimeout(loop, CONFIG.fetchIntervalMs);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}; shutting down gracefully.`);
  if (timer) clearTimeout(timer);
  if (transporter && typeof transporter.close === 'function') transporter.close();
  process.exit(0);
}

async function main() {
  const once = process.argv.includes('--once');

  validateConfig();
  log.info('FIFA Ticket Monitor starting.');
  log.info(`Target:   ${CONFIG.targetUrl}`);
  log.info(`Match:    ${CONFIG.matchId} — ${CONFIG.matchName}`);
  log.info(`Rules:    saleType="${CONFIG.primarySaleType}", cap=${CONFIG.currency} ${CONFIG.priceCap}, tol=±${CONFIG.deviationTolPct * 100}%`);
  log.info(`Base rates: ${JSON.stringify(CONFIG.baseRates)}`);
  log.info(`Interval: ${CONFIG.fetchIntervalMs / 1000}s, summary every ${CONFIG.summaryIntervalMs / 1000}s`);

  await initTransporter();

  if (once) {
    const hits = await runCycle();
    maybePrintSummary(true);
    log.info(`Single-run complete. Passing primary seats this scan: ${hits}.`);
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // First cycle immediately, then self-scheduling (overlap-safe) loop.
  await runCycle();
  maybePrintSummary(true);
  timer = setTimeout(loop, CONFIG.fetchIntervalMs);
}

// Never crash silently on an unexpected async error.
process.on('unhandledRejection', (reason) => log.error(`Unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`));
process.on('uncaughtException', (err) => {
  log.error(`Uncaught exception: ${err.stack || err.message}`);
  process.exit(1);
});

module.exports = {
  evaluate,
  parseHtml,
  parseJson,
  parsePrice,
  hasForbiddenMarker,
  validateConfig,
  DEFAULT_BASE_RATES,
  CONFIG
};

if (require.main === module) {
  main().catch((err) => {
    log.error(`Fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}
