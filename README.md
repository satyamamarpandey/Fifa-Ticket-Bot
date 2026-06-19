# FIFA Match 104 — Primary Retail Ticket Monitor

A **self-contained, production-ready** Node.js monitor that scans a ticketing
endpoint for genuine **Primary / Standard Retail** tickets for **Match 104 (The
Final)**, applies strict purity + price filtering, and fires an email alert the
moment a real drop appears. It ships with its own **mock server** and **unit
tests**, so the entire thing runs and is testable **offline** — no live
ticketing site and no real SMTP account required.

> This is a **notify-only** tool. It detects a qualifying listing and emails you
> a direct link for **manual** checkout. It does **not** log in, add anything to
> a cart, or auto-purchase. It is built to **reject** resale, verified-fan-resale
> and hospitality inventory and accept only official primary retail.

## Files

| File             | Purpose                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `app.js`         | Monitoring engine: fetch → parse → filter → notify.                 |
| `mockServer.js`  | Zero-dependency sandbox (`/` quiet, `/drop` drop, `/health`).       |
| `.env.example`   | Config template (target, rules, base rates, scheduler, SMTP).       |
| `test/`          | Unit tests for the filter/parser (`npm test`, no extra deps).       |
| `Dockerfile`     | Production container image.                                         |

## Current real pricing (FIFA 2026 Final, MetLife Stadium — June 2026)

Official **primary face values**: Category 1 **$6,730+** (dynamic, up to
~$10,990), Category 2 **$4,210**, Category 3 **$2,790**, Category 4 **$2,030**,
Front Category 1 **$32,970**. A **15% service fee** is added at checkout. Resale
runs **$8,000–$38,000+** — exactly the noise this monitor rejects.

The defaults target **Category 2** (the tier nearest a ~$4,200 budget). Change
`PRICE_CAP` / `OFFICIAL_BASE_RATES` in `.env` to target a different tier.

## The rules (in `app.js` / `.env`)

A listing is alerted on **only if it passes every check**:

1. **Match** is `104` and the name contains `The Final`.
2. **Sale type** is exactly `Primary` (rejects Resale / Hospitality).
3. **No impurity markers** (`resale`, `verified fan resale`, `hospitality`, …)
   in the sale type, category, or flags.
4. **Category** is a known official primary tier (`OFFICIAL_BASE_RATES`).
5. Face price is a number **at or under the budget cap** (default `$4,300`).
6. Face price is **within ±`DEVIATION_TOLERANCE_PCT` of the category's official
   base rate**; a "primary" listing priced outside the band is treated as a
   mis-flagged resale and discarded.

## Production features

- Fail-fast **config validation** at startup.
- Fetch **retries with exponential backoff**; **non-overlapping** scheduler.
- **Graceful shutdown** (SIGINT/SIGTERM) and global error handlers.
- **SMTP verified on boot**; `jsonTransport` console fallback for offline use.
- **Idempotent** alerts (one email per listing per process).
- Leveled logging via `LOG_LEVEL`.
- **Unit tests** (`npm test`) and a **Dockerfile**.

## Email-mode note (offline-friendly)

With `SMTP_HOST/USER/PASS` blank — or `DRY_RUN=true` — the monitor uses
Nodemailer's `jsonTransport` and **prints the alert to the console** instead of
sending it. Fill in real SMTP creds in `.env` to send actual email.

---

## Terminal execution sequence

```bash
# 1. Install dependencies
npm install

# 2. Run the unit tests (no server / network needed)
npm test

# 3. Create your config from the template
cp .env.example .env       # defaults already point at the local mock server

# 4a. Start the mock ticketing server in one terminal
npm run mock               # http://localhost:4040  ( "/" quiet, "/drop" = drop )

# 4b. In a SECOND terminal, scan the QUIET page (expect no alert)
npm start

# 5. Point at the DROP and do a single scan (expect one alert to the console)
TARGET_URL=http://localhost:4040/drop npm run once

# 6. Same data via the JSON API path (engine auto-detects content type)
TARGET_URL='http://localhost:4040/drop?format=json' npm run once
```

### Run continuously

```bash
# Polls every FETCH_INTERVAL_SECONDS (default 60s); heartbeat summary every
# SUMMARY_INTERVAL_SECONDS (default 600s / 10 min).
TARGET_URL=http://localhost:4040/drop npm start
```

### Docker

```bash
docker build -t fifa-ticket-monitor .
docker run --rm --env-file .env fifa-ticket-monitor
```
