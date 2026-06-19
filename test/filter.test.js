'use strict';

/**
 * Unit tests for the pure pieces of the monitor — no network, no SMTP.
 * Run with:  npm test   (uses Node's built-in test runner, no extra deps)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluate,
  parseHtml,
  parseJson,
  parsePrice,
  hasForbiddenMarker,
  validateConfig,
  DEFAULT_BASE_RATES
} = require('../app');

// A deterministic config mirroring production defaults so tests don't depend
// on the ambient environment / .env.
const CFG = {
  matchId: '104',
  matchName: 'The Final',
  primarySaleType: 'Primary',
  priceCap: 4300,
  baseRates: DEFAULT_BASE_RATES,
  deviationTolPct: 0.05
};

const valid = {
  id: 'ok',
  matchId: '104',
  matchName: 'The Final',
  saleType: 'Primary',
  category: 'Category 2',
  price: 4210,
  currency: 'USD',
  flags: [],
  url: 'http://x/checkout'
};

test('parsePrice handles strings, numbers, and junk', () => {
  assert.equal(parsePrice('$4,210'), 4210);
  assert.equal(parsePrice('USD 4210'), 4210);
  assert.equal(parsePrice(4210), 4210);
  assert.ok(Number.isNaN(parsePrice('sold out')));
});

test('hasForbiddenMarker catches impurity words case-insensitively', () => {
  assert.equal(hasForbiddenMarker('Verified Fan RESALE'), true);
  assert.equal(hasForbiddenMarker('Hospitality Suite'), true);
  assert.equal(hasForbiddenMarker('Primary'), false);
});

test('a clean primary Category 2 seat passes', () => {
  const v = evaluate(valid, CFG);
  assert.equal(v.pass, true);
});

test('wrong match is rejected', () => {
  const v = evaluate({ ...valid, matchId: '87', matchName: 'Semi-Final 2' }, CFG);
  assert.equal(v.pass, false);
  assert.match(v.reason, /wrong match/);
});

test('resale sale type is rejected', () => {
  const v = evaluate({ ...valid, saleType: 'Verified Fan Resale', flags: ['resale'] }, CFG);
  assert.equal(v.pass, false);
  assert.match(v.reason, /non-primary sale type|impurity/);
});

test('hospitality is rejected', () => {
  const v = evaluate({ ...valid, saleType: 'Hospitality', category: 'Hospitality Suite' }, CFG);
  assert.equal(v.pass, false);
});

test('a "Primary" listing priced like a resale is rejected (deviation + cap)', () => {
  const v = evaluate({ ...valid, price: 9800 }, CFG);
  assert.equal(v.pass, false);
});

test('over-budget legit primary (Cat 1) is rejected by cap', () => {
  const v = evaluate({ ...valid, category: 'Category 1', price: 6730 }, CFG);
  assert.equal(v.pass, false);
  // Category 1 isn't in the default budget base-rate set, so it's unpriced.
  assert.match(v.reason, /unknown|over budget/);
});

test('unknown category is rejected', () => {
  const v = evaluate({ ...valid, category: 'Category 9' }, CFG);
  assert.equal(v.pass, false);
  assert.match(v.reason, /unknown/);
});

test('price just outside the ±5% band is rejected', () => {
  // Cat 2 base 4210; +5% = 4420.5. 4500 is outside but under a 4600 cap.
  const v = evaluate({ ...valid, price: 4500 }, { ...CFG, priceCap: 4600 });
  assert.equal(v.pass, false);
  assert.match(v.reason, /deviates/);
});

test('parseHtml extracts data-* attributes into listings', () => {
  const html = `
    <div class="ticket-listing" data-listing-id="L1" data-match-id="104"
         data-match-name="The Final" data-sale-type="Primary"
         data-category="Category 2" data-price="4210" data-currency="USD"
         data-flags="" data-url="http://x/buy"></div>`;
  const [l] = parseHtml(html);
  assert.equal(l.id, 'L1');
  assert.equal(l.matchId, '104');
  assert.equal(l.saleType, 'Primary');
  assert.equal(l.price, 4210);
  assert.equal(evaluate(l, CFG).pass, true);
});

test('parseJson normalises a structured payload', () => {
  const [l] = parseJson({ listings: [valid] });
  assert.equal(l.matchId, '104');
  assert.equal(evaluate(l, CFG).pass, true);
});

test('target-price mode: alerts on a primary seat near the target', () => {
  const cfg = { ...CFG, targetPrice: 2000, targetPriceTolPct: 0.1 };
  // Cat 4 at $2,030 is within $1,800-$2,200 -> pass.
  assert.equal(evaluate({ ...valid, category: 'Category 4', price: 2030 }, cfg).pass, true);
  // Cat 2 at $4,210 is far from $2,000 -> reject.
  assert.equal(evaluate({ ...valid, price: 4210 }, cfg).pass, false);
  // Resale near $2,000 is still rejected on sale type.
  assert.equal(evaluate({ ...valid, price: 2000, saleType: 'Verified Fan Resale', flags: ['resale'] }, cfg).pass, false);
});

test('validateConfig rejects a bad target URL', () => {
  assert.throws(() => validateConfig({ ...CFG, targetUrl: 'ftp://nope', fetchIntervalMs: 60000, alertTo: 'a@b.c', smtp: {} }), /TARGET_URL/);
});
