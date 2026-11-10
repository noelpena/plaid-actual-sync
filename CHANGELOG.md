# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Optional sync-completion webhook.** After every sync (scheduled, manual,
  per-mapping, or `npm run sync`; success or failure), the app POSTs a JSON
  summary to `sync.webhookUrl` (env fallback: `SYNC_WEBHOOK_URL`). The payload
  contains `event`, `version`, `status`, `startedAt`, `finishedAt`, `added`,
  `modified`, `removed` and `error`. It has no transaction or account details.
- Optional `sync.webhookSecret` (env fallback: `SYNC_WEBHOOK_SECRET`), sent as
  the `X-Webhook-Secret` header and masked in the admin UI.
- Webhook URL and secret fields, plus a **Send test** button, in the setup
  wizard and on the admin Configuration tab. New `POST /api/test/webhook`
  endpoint.
- Unit tests (`npm test`, Node's built-in test runner).

### Changed

- Saving settings from the setup wizard or admin Configuration tab now keeps
  any other keys in the `sync` section of `config.json`. Before, the whole
  section was replaced.

### Notes

- Fully opt-in. Existing `config.json` files work unchanged, and nothing is
  sent until a webhook URL is configured.
- Delivery is best-effort: 5-second timeout, no retries, redirects not
  followed. Failures are logged without the URL or secret and never affect
  the sync.
