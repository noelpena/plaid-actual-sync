// Optional sync-completion webhook.
//
// After every sync (scheduled or manual, success or failure) a small JSON
// summary is POSTed to sync.webhookUrl. The payload deliberately carries no
// transaction or account details — only status, timestamps, counts and an
// error message. Delivery is best-effort: short timeout, failures are logged,
// and nothing here ever throws into the sync.
//
// The URL and secret are never logged — webhook URLs (Slack, Discord, ntfy,
// Home Assistant…) often embed a token themselves.

export const WEBHOOK_EVENT = "sync.completed";
export const WEBHOOK_TEST_EVENT = "webhook.test";
export const WEBHOOK_PAYLOAD_VERSION = 1;
export const WEBHOOK_TIMEOUT_MS = 5000;
export const WEBHOOK_SECRET_HEADER = "X-Webhook-Secret";

const MAX_ERROR_LENGTH = 500;
const STATUSES = new Set(["success", "partial", "error"]);

// Resolve webhook settings with the same precedence as the other settings:
// config.json value first, env var as fallback. Empty/missing → disabled.
export function resolveWebhookConfig(fileSync = {}, env = process.env) {
  return {
    webhookUrl: fileSync?.webhookUrl || env.SYNC_WEBHOOK_URL || "",
    webhookSecret: fileSync?.webhookSecret || env.SYNC_WEBHOOK_SECRET || "",
  };
}

export function isValidWebhookUrl(url) {
  if (typeof url !== "string" || !url.trim()) return false;
  try {
    const { protocol } = new URL(url.trim());
    return protocol === "http:" || protocol === "https:";
  } catch (_) {
    return false;
  }
}

// Merge webhook edits into an existing `sync` section of config.json.
// - url/secret undefined → keep the existing value
// - "" → remove the key (fall back to env / disabled)
// - anything else → store it (trimmed)
// Unknown keys (cronSchedule, …) are preserved.
export function mergeWebhookSettings(existingSync, { url, secret } = {}) {
  const next = { ...(existingSync || {}) };
  for (const [key, value] of [["webhookUrl", url], ["webhookSecret", secret]]) {
    if (value === undefined || value === null) continue;
    const trimmed = String(value).trim();
    if (trimmed) next[key] = trimmed;
    else delete next[key];
  }
  return next;
}

function toCount(n) {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
}

function toErrorMessage(err) {
  if (err == null || err === "") return null;
  let msg;
  if (typeof err === "string") msg = err;
  else if (typeof err.message === "string") msg = err.message;
  else {
    try { msg = JSON.stringify(err); } catch (_) { msg = String(err); }
  }
  return msg.length > MAX_ERROR_LENGTH ? msg.slice(0, MAX_ERROR_LENGTH - 1) + "…" : msg;
}

// Build the payload. Only whitelisted fields — callers can't leak extra data
// by passing richer objects in.
export function buildWebhookPayload({
  event = WEBHOOK_EVENT,
  status,
  startedAt = null,
  finishedAt = new Date().toISOString(),
  added = 0,
  modified = 0,
  removed = 0,
  error = null,
} = {}) {
  return {
    event,
    version: WEBHOOK_PAYLOAD_VERSION,
    status: STATUSES.has(status) ? status : "error",
    startedAt,
    finishedAt,
    added: toCount(added),
    modified: toCount(modified),
    removed: toCount(removed),
    error: toErrorMessage(error),
  };
}

// Describe a delivery failure without echoing the URL. fetch's own error
// messages (and their causes) can include the hostname, so only codes/names
// are surfaced.
function describeFailure(err, timeoutMs) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return `timed out after ${timeoutMs}ms`;
  }
  const code = err?.cause?.code || err?.code;
  if (code) return `network error (${code})`;
  return `request failed (${err?.name || "Error"})`;
}

// POST a payload. Never throws; resolves to { ok, status?, error? } where
// `error` is safe to log or show (no URL, no secret).
export async function postWebhook(
  { url, secret } = {},
  payload,
  { timeoutMs = WEBHOOK_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}
) {
  if (!isValidWebhookUrl(url)) {
    return { ok: false, error: "webhook URL is missing or not a valid http(s) URL" };
  }
  try {
    const headers = { "Content-Type": "application/json", "User-Agent": "plaid-actual-sync" };
    if (secret) headers[WEBHOOK_SECRET_HEADER] = secret;

    const res = await fetchImpl(url.trim(), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      // Don't follow redirects: a custom secret header would be replayed to
      // whatever host the redirect points at.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain/discard the body so the connection is released
    try { await res.body?.cancel(); } catch (_) {}

    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: describeFailure(err, timeoutMs) };
  }
}

// Notify the configured webhook that a sync finished. No-op when no URL is
// configured. Never throws; failures are logged without the URL or secret.
export async function sendSyncWebhook(syncConfig, result, options = {}) {
  const logger = options.logger || console;
  try {
    const { webhookUrl, webhookSecret } = syncConfig || {};
    if (!webhookUrl) return { ok: true, skipped: true };

    const payload = buildWebhookPayload({ ...result, event: WEBHOOK_EVENT });
    const outcome = await postWebhook({ url: webhookUrl, secret: webhookSecret }, payload, options);
    if (outcome.ok) logger.log(`📣 Sync webhook delivered (HTTP ${outcome.status})`);
    else logger.warn(`⚠️  Sync webhook failed: ${outcome.error}`);
    return outcome;
  } catch (err) {
    logger.warn(`⚠️  Sync webhook failed: ${err?.name || "Error"}`);
    return { ok: false, error: "internal error" };
  }
}

// Send a clearly-labelled test event (used by the "Send test" buttons).
export async function sendTestWebhook({ url, secret }, options = {}) {
  const now = new Date().toISOString();
  const payload = buildWebhookPayload({
    event: WEBHOOK_TEST_EVENT,
    status: "success",
    startedAt: now,
    finishedAt: now,
  });
  return postWebhook({ url, secret }, payload, options);
}
