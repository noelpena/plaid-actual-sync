# Plaid → Actual Budget Sync

Automated bank transaction sync from [Plaid](https://plaid.com) to [Actual Budget](https://actualbudget.org). Self-hosted, Docker-ready, with a web UI for setup and administration. Perfect for homelabbers running CasaOS or any Docker environment.

> **⚠️ v2.0 — Teller replaced with Plaid.** Teller's API service has been discontinued, so this project migrated to Plaid. Plaid's free **Trial plan** (April 2026+) covers this use case: real production bank data, up to 10 bank connections, no credit card. Existing Teller configs cannot be migrated automatically — you'll reconnect your banks through the `/connect` page. See [Migrating from Teller](#-migrating-from-teller-v1x).

## ✨ Features

- 🏦 **Bank connections via Plaid Link** — thousands of US/Canadian institutions
- 🔁 **Incremental cursor-based sync** (`/transactions/sync`) — each run fetches exactly what changed, including corrections and reversals
- 🧩 **Account mappings** — pair any number of bank accounts with Actual Budget accounts
- ⚖️ **Auto-reconcile** — align Actual balances with the bank's reported balance (sign-correct for credit cards)
- 🆔 **Stable transaction IDs** — Plaid IDs used as `imported_id` for exact dedup; failed runs replay safely
- 🩹 **Repair flow** — broken bank logins fixed via Plaid Link update mode without burning connection slots
- 🔧 **Web setup wizard + admin dashboard** — no manual config file editing needed
- 🐳 **Docker & CasaOS ready**

## 💰 The Plaid Trial Plan (free)

| | |
|---|---|
| Cost | Free — no credit card |
| Eligibility | New Plaid teams (US/Canada) created on/after April 15, 2026 |
| Bank connections | **10 production Items, lifetime** — removing one does NOT free the slot |
| API calls | Unlimited on connected Items |
| Products | Transactions, Balance, and more |

**Consequences for this app:**
- Do all testing in **Sandbox** (unlimited, fake banks) — only link real banks in Production
- Use the **Repair** button (Link update mode) for broken logins — it reuses the existing connection; re-linking from scratch burns a slot permanently
- The admin UI shows your `N / 10` slot usage

## 🚀 Quick Start (5 Minutes)

### Prerequisites

- Docker & Docker Compose
- A running [Actual Budget server](https://actualbudget.org/docs/install/)
- A free [Plaid account](https://dashboard.plaid.com/signup)

### Step 1: Get Plaid Credentials

1. Sign up at the [Plaid Dashboard](https://dashboard.plaid.com/signup)
2. Go to **Developers → Keys**: copy your **client ID** and the **Sandbox secret** (grab the Production secret later, once you've tested)

### Step 2: Run the Container

```bash
git clone https://github.com/noelpena/plaid-actual-sync.git
cd plaid-actual-sync
docker compose up -d --build
```

### Step 3: Complete Setup in Your Browser

1. Open `http://localhost:8001` — you'll be redirected to the setup flow
2. **`/connect`**: enter your Plaid client ID + secret + environment, then link a bank through Plaid Link
   - The credentials are checked against Plaid **before** they're saved — a wrong secret or mismatched environment is rejected and nothing is written
   - Secrets are per-environment: the Sandbox secret only works with Sandbox, the Production secret only with Production
   - Need to change them later? Use **Change Plaid credentials** on `/connect` or the **Configuration** tab in `/admin`
   - Sandbox: pick any institution, log in with `user_good` / `pass_good` (or username `user_transactions_dynamic` for realistic transaction data)
3. **`/setup`**: enter your Actual Budget server URL, password, and budget Sync ID
4. **`/admin` → Account Mappings**: pair each bank account with an Actual account (create new ones on the fly)
5. Hit **Sync Now** — done 🎉

> First sync note: right after linking, Plaid may still be preparing transaction history. If the first sync reports nothing, wait a minute and sync again — history depth is controlled by the "days requested" setting (default 90, up to 730).

## 🛠️ How the Sync Works

```
┌─────────────┐      Plaid Link       ┌────────────┐
│   Browser   │──────────────────────▶│   Plaid    │──▶ your bank
└──────┬──────┘   link_token /        └─────┬──────┘
       │          public_token              │ /transactions/sync (cursor)
┌──────▼──────────────────────────────┐     │
│  plaid-actual-sync (this app)       │◀────┘
│  • one access_token per bank Item   │
│  • per-Item sync cursor             │     ┌───────────────┐
│  • transform + import + reconcile   │────▶│ Actual Budget │
│  • cron scheduler                   │     └───────────────┘
└─────────────────────────────────────┘
```

Each sync run, per bank connection (Plaid "Item"):

1. Call `/transactions/sync` from the stored cursor, paging until `has_more` is false
2. Route `added` + `modified` transactions to mappings by account ID and import into Actual (`imported_id` = Plaid transaction ID)
3. Delete `removed` transactions from Actual (reversed pendings; pending→posted swaps arrive as remove+add pairs)
4. Reconcile balances if requested
5. Persist the new cursor — **only after a successful import**, so a crashed run simply replays (dedup makes it idempotent)

### Data conventions handled for you

- **Amount signs**: Plaid reports outflows as positive; Actual uses negative. Flipped on import.
- **Credit/loan balances**: Plaid reports owed amounts as positive; Actual as negative. Flipped during reconcile.
- **Pending transactions**: imported as uncleared; automatically replaced when they post.
- **Payees**: Plaid's enriched `merchant_name` when available, raw description otherwise.

## 🐳 Docker Deployment

Prebuilt multi-arch images (amd64/arm64) are published to Docker Hub as
`noelpena/plaid-actual-sync:latest` by CI on every push to `main`.
[docker-compose.yml](docker-compose.yml) pulls that image by default; uncomment
the `build:` block to build from source instead. CI also rebuilds the image weekly
with the latest stable `@actual-app/api`, so `docker compose pull` keeps it current
with Actual releases.

### Using Docker Compose (Recommended)

See [docker-compose.yml](docker-compose.yml). Volumes persist config, logs, transaction backups, and Actual's data cache:

```yaml
volumes:
  - ./config:/app/config
  - ./logs:/app/logs
  - ./transaction-data:/app/transaction-data
  - ./actual-data:/app/actual-data
```

```bash
git clone https://github.com/noelpena/plaid-actual-sync.git
cd plaid-actual-sync
docker compose up -d          # add --build to build from source
```

### Using Docker Run

```bash
docker run -d \
  --name plaid-actual-sync \
  -p 8001:8001 \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/logs:/app/logs \
  -v $(pwd)/transaction-data:/app/transaction-data \
  -v $(pwd)/actual-data:/app/actual-data \
  -e TZ=America/New_York \
  noelpena/plaid-actual-sync:latest
```

## 🔧 Configuration

Everything is stored in `config/config.json` (created by the setup wizard). Environment variables act as fallbacks when a config value is missing — a value in `config.json` always wins, so once credentials have been saved through the UI, env vars for the same keys are ignored.

To configure with env vars instead of the UI, uncomment the matching lines under `environment:` in `docker-compose.yml`. A `.env` file alone isn't enough: it's excluded from the image, so the container only sees variables compose passes through.

| Env var | config.json equivalent |
|---|---|
| `PLAID_CLIENT_ID` | `plaid.clientId` |
| `PLAID_SECRET` | `plaid.secret` |
| `PLAID_ENV` | `plaid.env` (`sandbox` \| `production`) |
| `PLAID_DAYS_REQUESTED` | `plaid.daysRequested` (30–730; history depth at link time) |
| `ACTUAL_SERVER_URL` | `actual.serverURL` |
| `ACTUAL_PASSWORD` | `actual.password` |
| `ACTUAL_SYNC_ID` | `actual.syncId` |
| `CRON_SCHEDULE` | `sync.cronSchedule` |
| `SYNC_WEBHOOK_URL` | `sync.webhookUrl` (optional — see [Sync Webhook](#-sync-webhook)) |
| `SYNC_WEBHOOK_SECRET` | `sync.webhookSecret` (optional) |

Bank connections (`items`, holding access tokens and sync cursors) and account `mappings` are managed by the app — see [config/config.json.example](config/config.json.example) for the full schema.

### Cron Schedule Examples

| Schedule | Expression |
|---|---|
| Daily at 2 AM | `0 2 * * *` |
| Every 6 hours | `0 */6 * * *` |
| Twice daily (8 AM, 8 PM) | `0 8,20 * * *` |
| Weekly (Monday midnight) | `0 0 * * 1` |

## 📣 Sync Webhook

Optional and off by default. When a webhook URL is set, the app POSTs a JSON summary after **every** sync: scheduled, **Sync Now**, per-mapping sync/reconcile, and `npm run sync`. It fires whether the sync succeeds or fails. Use it to ping Home Assistant, ntfy, Healthchecks.io, n8n, or your own endpoint.

Set it in the setup wizard or **Admin → Configuration → Sync Webhook**. You can also set `SYNC_WEBHOOK_URL` / `SYNC_WEBHOOK_SECRET`; as with the other settings, values in `config.json` take priority. **Send test** posts a `webhook.test` event so you can check your endpoint.

```http
POST <your URL>
Content-Type: application/json
X-Webhook-Secret: <your secret>      # only sent when a secret is configured

{
  "event": "sync.completed",          // "webhook.test" for the Send test button
  "version": 1,                       // payload schema version
  "status": "success",                // "success" | "partial" | "error"
  "startedAt": "2026-10-19T08:00:00.012Z",
  "finishedAt": "2026-10-19T08:00:06.481Z",
  "added": 12,                        // transactions added in Actual
  "modified": 3,                      // transactions updated in Actual
  "removed": 1,                       // removed/reversed transactions deleted from Actual
  "error": null                       // error message when status isn't "success"
}
```

- **Privacy:** the payload never includes transaction, account, or institution details. It contains only the fields above.
- **Best-effort:** delivery has a 5-second timeout and is not retried. Redirects are not followed, so the secret can't be forwarded to another host. A failed delivery is logged but never affects the sync.
- **No secrets in logs:** the webhook URL and secret are never written to logs or sync history. The admin UI masks the secret. Many webhook URLs contain a token, so treat the URL as a secret too.
- **Verifying requests:** compare the `X-Webhook-Secret` header with your secret. Serve the endpoint over HTTPS if it isn't on your LAN.
- `partial` means some bank connections synced and others failed. `error` means nothing synced, or the run failed before it started (bad config, Actual unreachable).

## 📊 Admin Dashboard

Open `http://localhost:8001/admin`:

- **Dashboard** — sync status (with the reason when the last sync failed), setup health, connection slot usage, Actual server and library versions
- **Configuration** — edit Plaid/Actual credentials, the sync schedule, and the optional sync webhook
- **Account Mappings** — bank connections list (repair/remove), account-to-account pairing, per-mapping sync/reconcile
- **Sync Logs** — last 50 sync runs with per-mapping stats

When a bank login breaks (changed password, expired MFA), the connection and its mappings show **Needs reconnect** with a **Repair** button that launches Plaid Link's update mode.

## 🔌 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/manual-sync` | Run a full sync across all bank connections |
| `GET` | `/sync-logs` | Recent sync logs (JSON) |
| `GET` | `/ping` | Health check |
| `GET` | `/api/config/status` | Configuration completeness + slot usage |
| `POST` | `/api/plaid/link-token` | Create a Link token (`{itemId}` = update mode) |
| `POST` | `/api/plaid/exchange` | Exchange a public token, store the Item |
| `GET` | `/api/plaid/accounts` | All bank accounts across Items |
| `GET` | `/api/plaid/items` | List bank connections |
| `POST` | `/api/plaid/items/:id/remove` | Disconnect a bank (⚠️ doesn't refund Trial slots) |
| `POST` | `/api/test/plaid` | Verify Plaid credentials |
| `POST` | `/api/test/actual` | Verify Actual Budget connection |
| `POST` | `/api/test/webhook` | Send a `webhook.test` event (`{url?, secret?}`; falls back to saved settings) |
| `GET/POST/PATCH/DELETE` | `/api/mappings[...]` | Manage account mappings |
| `POST` | `/api/mappings/:id/sync` | Sync one mapping (syncs its whole Item) |
| `POST` | `/api/mappings/:id/reconcile` | Reconcile one mapping to the bank balance |

## 🏠 CasaOS Installation

Import [docker-compose.yml](docker-compose.yml) through CasaOS's **Install a
customized app** — it pulls `noelpena/plaid-actual-sync:latest` and the
`x-casaos` metadata auto-configures the web UI port and icon.

Or build on the host over SSH:

```bash
git clone https://github.com/noelpena/plaid-actual-sync.git
cd plaid-actual-sync
docker compose up -d --build
```

## 🔄 Migrating from Teller (v1.x)

Teller account IDs and access tokens have no Plaid equivalent, so mappings can't be carried over — but your Actual accounts and history are untouched:

1. Pull the v2 source and rebuild (`git pull && docker compose up -d --build`)
2. Go to `/connect`, enter Plaid credentials, and link each bank
3. In **Account Mappings**, map each bank account to its **existing** Actual account (pick "Use existing Actual account" — don't create duplicates)
4. Old Teller mappings are ignored by the sync; delete them from the mappings list when ready

Duplicate protection: incoming transactions carry stable Plaid IDs and are also fuzzy-matched by Actual (same amount/date), so re-mapping to the same Actual account won't double-import recent history in most cases.

## 🔍 Troubleshooting

### First sync returns 0 transactions

Plaid prepares transaction history in the background after linking — typically 30 days almost immediately, full history within a minute or two. Sync again shortly.

### OAuth banks (Chase, Bank of America, …) won't connect

OAuth institutions require an **HTTPS redirect URI** registered in the Plaid Dashboard (Developers → API → Allowed redirect URIs). Put the app behind a reverse proxy with TLS and register `https://your-domain/connect`. Non-OAuth banks work over plain HTTP.

### "ITEM_LOGIN_REQUIRED" / Needs reconnect

The bank login broke upstream. Click **Repair** on the connection — this launches Link's update mode and does **not** use a Trial plan slot.

### Hit the 10-connection Trial limit

The limit is lifetime (removals don't refund). Upgrade to Plaid's Pay-as-you-go plan (no minimum) or contact Plaid.

### Sandbox testing tips

- Realistic data: link with username `user_transactions_dynamic` (any password)
- Force a broken login to test Repair: `POST https://sandbox.plaid.com/sandbox/item/reset_login`
- Seed new transactions: `POST https://sandbox.plaid.com/sandbox/transactions/create`

### Actual Budget connection fails

- Verify the server URL is reachable **from inside the container** (use container-network hostnames, not `localhost`)
- Confirm the password and Sync ID

### "Your budget was updated by a newer version of Actual"

The budget file is newer than the Actual library (`@actual-app/api`) inside this app.
Whichever Actual app opens your budget upgrades it to that app's version, so this
usually happens after the Actual desktop app or web app updates. Your server's version
doesn't matter here: an older server can store a newer budget.

The dashboard shows both versions under **Current Configuration**. To fix it, update
this app:

```bash
docker compose pull && docker compose up -d
```

The published image is rebuilt weekly with the latest stable `@actual-app/api`.

**Building from source:** set `ACTUAL_VERSION` in `.env` to your newest Actual version
(e.g. `26.11.0`), uncomment the `build:` block in
[docker-compose.yml](docker-compose.yml), and run `docker compose up -d --build`.

### "SQLITE_CORRUPT" / "malformed database schema"

The local copy of the budget in `actual-data/` is damaged. Stop the container, delete
the budget folder inside `actual-data/`, and start it again. The budget is downloaded
again from your server.

### View detailed logs

```bash
docker logs -f plaid-actual-sync
cat logs/sync.log
curl http://localhost:8001/sync-logs
```

## 📁 File Structure

```
.
├── server.js           # Express server: web UI, admin API, cron scheduler
├── sync.js             # Sync engine: cursor sync → transform → import → reconcile
├── plaid.js            # Plaid API client (link tokens, exchange, /transactions/sync)
├── actual-budget.js    # Opens the Actual budget; version-mismatch errors
├── webhook.js          # Optional sync-completion webhook
├── test/               # Unit tests (npm test)
├── static/             # Web UI (connect, setup wizard, admin dashboard)
├── config/             # config.json (created by setup wizard)
├── logs/               # sync.log
├── transaction-data/   # Per-sync JSON backups
└── actual-data/        # Actual Budget local data cache
```

## 🔐 Security Best Practices

- Plaid **access tokens and your secret** live in `config/config.json` — never expose that volume publicly
- Run behind a reverse proxy with auth (the admin UI has no built-in login); HTTPS also unlocks OAuth banks
- Bind the port to localhost or your LAN interface: `127.0.0.1:8001:8001`

## 🤝 Contributing

```bash
git clone https://github.com/noelpena/plaid-actual-sync.git
cd plaid-actual-sync
npm install
npm run dev          # requires config/config.json or env vars
npm test             # unit tests (Node's built-in test runner)
```

## 📄 License

MIT

## 🙏 Acknowledgments

- [Actual Budget](https://actualbudget.org) — the excellent open-source budgeting app
- [Plaid](https://plaid.com) — bank data API with a genuinely free tier
- Originally built on [Teller](https://teller.io) (v1.x), migrated after Teller's API discontinuation

## 📞 Support

Open an issue on GitHub.
