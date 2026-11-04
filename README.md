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

> **Not eligible for the Trial plan?** Teams created before April 15, 2026, or with a pending/approved Production application, can't get it and can't switch to it. Older teams are on **Limited Production** (the previous free tier: live data, but a capped number of API calls) or a paid plan — this app works the same either way. Submitting a Production access application is one-way: you can't return to the Trial plan afterward.

## 🚀 Quick Start (5 Minutes)

### Prerequisites

- Docker & Docker Compose
- A running [Actual Budget server](https://actualbudget.org/docs/install/)
- A free [Plaid account](https://dashboard.plaid.com/signup)

### Step 1: Get Plaid Credentials

1. Sign up at the [Plaid Dashboard](https://dashboard.plaid.com/signup) and verify your email
2. Apply for the free **Trial plan** — the button on the Dashboard home page, or [dashboard.plaid.com/trial-plan](https://dashboard.plaid.com/trial-plan). Signing up alone only gives you Sandbox; Plaid emails you once Production is enabled, and until then only the Sandbox secret works
3. Go to **Developers → Keys**: copy your **client ID** and the **Sandbox secret**. The Production secret is on the same page — it's a different value, and only works once Production is enabled

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

> First sync note: Plaid loads history in two phases after linking — an initial pull of recent transactions, then a historical pull back to your "days requested" setting (default 90, up to 730). If the first sync comes back empty or short, wait a bit and sync again; the more history you request, the longer the historical pull takes.

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
- **Balances**: reconcile uses Plaid's cached balances (the free endpoint), which Plaid keeps at least as fresh as the last transaction update — not a live query to the bank.

## 🐳 Docker Deployment

Prebuilt multi-arch images (amd64/arm64) are published to Docker Hub as
`noelpena/plaid-actual-sync:latest` by CI on every push to `main`.
[docker-compose.yml](docker-compose.yml) pulls that image by default; uncomment
`build: .` to build from source instead.

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

Bank connections (`items`, holding access tokens and sync cursors) and account `mappings` are managed by the app — see [config/config.json.example](config/config.json.example) for the full schema.

### Cron Schedule Examples

| Schedule | Expression |
|---|---|
| Daily at 2 AM | `0 2 * * *` |
| Every 6 hours | `0 */6 * * *` |
| Twice daily (8 AM, 8 PM) | `0 8,20 * * *` |
| Weekly (Monday midnight) | `0 0 * * 1` |

Plaid checks each institution for new transactions roughly 1–4 times per day, so syncing more often than every few hours won't surface anything new.

## 📊 Admin Dashboard

Open `http://localhost:8001/admin`:

- **Dashboard** — sync status, setup health, connection slot usage
- **Configuration** — edit Plaid/Actual credentials and the sync schedule
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

Plaid prepares history in two phases after linking: an initial pull of recent transactions, then the full historical pull. The sync response reports where it is (`NOT_READY` → `INITIAL_UPDATE_COMPLETE` → `HISTORICAL_UPDATE_COMPLETE`), and the app skips persisting the cursor until data is ready. Sync again after a short wait — larger "days requested" values take longer.

### OAuth banks (Chase, Bank of America, …) won't connect

On Plaid's side, OAuth institutions need two things in Production:

1. An **HTTPS redirect URI** registered in the Plaid Dashboard (Developers → API → Allowed redirect URIs), e.g. `https://your-domain/connect` behind a reverse proxy with TLS. Non-OAuth banks work over plain HTTP.
2. **Per-institution OAuth approval** from Plaid, tracked on the Dashboard's OAuth institutions page. Production access must be enabled first; some institutions (e.g. Charles Schwab) take up to 5 business days after that. Trial plan users are exempt from the Chase security questionnaire and the compliance registration until they upgrade.

Sandbox needs neither — OAuth flows work there without approval and accept plain `http://localhost` redirect URIs.

> **Current limitation:** this app does not yet pass a `redirect_uri` when creating Link tokens, which Plaid requires for OAuth institutions on the web. Until that's added, OAuth banks can't be linked even with the Dashboard steps above done.

### "ITEM_LOGIN_REQUIRED" / Needs reconnect

The bank login broke upstream. Click **Repair** on the connection — this launches Link's update mode and does **not** use a Trial plan slot.

### Hit the 10-connection Trial limit

The limit is lifetime (removals don't refund). Upgrade to Plaid's **Pay-as-you-go** plan (no minimum, self-service in the Dashboard) or contact Plaid about Growth/Custom plans. When you apply, request **Transactions** and **Balance**: after upgrading you keep Production access only to the products on your request form, and subscription products already on your Items start billing.

### Sandbox testing tips

- Realistic data: link with username `user_transactions_dynamic` (any non-blank password)
- Use a non-OAuth test bank such as First Platypus Bank (`ins_109508`) — special test usernames are ignored at OAuth sandbox institutions
- Sandbox Items automatically enter `ITEM_LOGIN_REQUIRED` 30 days after creation, so a **Needs reconnect** flag in Sandbox is expected — use it to try Repair
- Force a broken login immediately: `POST https://sandbox.plaid.com/sandbox/item/reset_login`
- Seed new transactions: `POST https://sandbox.plaid.com/sandbox/transactions/create`

### Actual Budget connection fails

- Verify the server URL is reachable **from inside the container** (use container-network hostnames, not `localhost`)
- Confirm the password and Sync ID

### "SQLITE_CORRUPT" / "malformed database schema" / "No budget file is open"

The `@actual-app/api` package version must **match your Actual server version** — a newer
SDK migrating a budget file from an older server can corrupt the local copy. This project
pins it in [package.json](package.json) (currently `^26.7.0`). Check your server version:

```bash
curl https://your-actual-server/info      # look at build.version
```

If it differs, edit the `@actual-app/api` line in `package.json` to match, then rebuild
(`docker compose up -d --build`) and delete the cached budget folder inside `actual-data/`.

> **Hosted Actual (PikaPods, Fly.io, etc.)** auto-updates, so its version can drift ahead of
> the pin over time. If a sync starts failing with SQLITE errors after a while, re-check
> `/info` and bump the pin.

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
```

## 📄 License

MIT

## 🙏 Acknowledgments

- [Actual Budget](https://actualbudget.org) — the excellent open-source budgeting app
- [Plaid](https://plaid.com) — bank data API with a genuinely free tier
- Originally built on [Teller](https://teller.io) (v1.x), migrated after Teller's API discontinuation

## 📞 Support

Open an issue on GitHub.
