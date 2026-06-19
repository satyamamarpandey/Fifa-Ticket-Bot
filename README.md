# FIFA Match 104 — Primary Retail Ticket Monitor

A **self-contained** Node.js monitor that scans a ticketing endpoint for genuine
**Primary / Standard Retail** tickets for **Match 104 (The Final)**, applies
strict purity + price filtering, and fires an email alert the moment a real drop
appears. It ships with its own **mock server**, so the entire thing runs and is
testable **offline** with no live ticketing site and no real SMTP account.

> This tool only ever accepts *official primary retail* inventory. It is built to
> explicitly **reject** resale, verified-fan-resale, and hospitality listings.

## Files

| File             | Purpose                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `package.json`   | Dependencies: `axios`, `cheerio`, `nodemailer`, `dotenv`.           |
| `.env.example`   | Template for target, rules, scheduler, and SMTP config.             |
| `mockServer.js`  | Zero-dependency local sandbox (`/` = quiet, `/drop` = real drop).   |
| `app.js`         | The monitoring engine: fetch → parse → filter → notify.             |

## The rules (in `app.js` / `.env`)

A listing is alerted on **only if it passes every check**:

1. **Match** is `104` and the name contains `The Final`.
2. **Category** is exactly `Primary / Standard Retail`.
3. **No impurity markers** (`resale`, `verified fan resale`, `hospitality`, …)
   anywhere in the category or flags.
4. Price is a valid number **at or under the price cap** (default `$4,200`).
5. Price sits **inside the official primary base band** (`$3,800–$4,200`); a
   "primary" listing priced outside the band is treated as a mis-flagged resale
   and discarded.

## Email-mode note (offline-friendly)

If `SMTP_HOST/USER/PASS` are blank — or `DRY_RUN=true` — the monitor uses
Nodemailer's `jsonTransport` and **prints the alert to the console** instead of
sending it. Fill in real SMTP creds in `.env` to send actual email.

---

## Terminal execution sequence

```bash
# 1. Install dependencies
npm install

# 2. Create your config from the template
cp .env.example .env
#    (defaults already point at the local mock server — no edits needed to test)

# 3a. Start the mock ticketing server in one terminal
npm run mock
#     → listening on http://localhost:4040  ( "/" quiet, "/drop" = drop )

# 3b. In a SECOND terminal, run the monitor against the QUIET page.
#     Expect: decoys rejected, "No Primary Seats Found", no email.
npm start

# 4. Now point the monitor at the DROP and do a single scan to see an alert.
#    Expect: decoys rejected, the valid seat passes, alert printed to console.
TARGET_URL=http://localhost:4040/drop npm run once
```

### Try the JSON API path

The mock serves the same data as JSON when you add `?format=json`. The engine
auto-detects the content type and parses accordingly:

```bash
TARGET_URL='http://localhost:4040/drop?format=json' npm run once
```

### Run the monitor continuously

```bash
# Polls every FETCH_INTERVAL_SECONDS (default 60s) and prints a heartbeat
# summary every SUMMARY_INTERVAL_SECONDS (default 600s / 10 min).
TARGET_URL=http://localhost:4040/drop npm start
```
