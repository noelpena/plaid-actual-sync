import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  WEBHOOK_EVENT,
  WEBHOOK_TEST_EVENT,
  WEBHOOK_PAYLOAD_VERSION,
  buildWebhookPayload,
  isValidWebhookUrl,
  mergeWebhookSettings,
  postWebhook,
  resolveWebhookConfig,
  sendSyncWebhook,
  sendTestWebhook,
} from "../webhook.js";

const PAYLOAD_KEYS = [
  "added", "error", "event", "finishedAt", "modified", "removed", "startedAt", "status", "version",
].sort();

// Local receiver. Behaviour per path: /ok → 204, /fail → 500, /slow → never
// responds, /redirect → 302 to /ok. Records every request it gets.
let server;
let baseUrl;
const received = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      received.push({ path: req.url, method: req.method, headers: req.headers, body });
      if (req.url === "/ok") { res.writeHead(204); res.end(); }
      else if (req.url === "/fail") { res.writeHead(500); res.end("nope"); }
      else if (req.url === "/redirect") { res.writeHead(302, { Location: "/ok" }); res.end(); }
      // /slow: leave hanging
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

function lastRequest() {
  return received[received.length - 1];
}

// Captures log output so tests can assert nothing sensitive is printed
function captureLogger() {
  const lines = [];
  return {
    lines,
    log: (...args) => lines.push(args.join(" ")),
    warn: (...args) => lines.push(args.join(" ")),
    error: (...args) => lines.push(args.join(" ")),
  };
}

describe("resolveWebhookConfig", () => {
  test("config.json wins over env vars", () => {
    const cfg = resolveWebhookConfig(
      { webhookUrl: "https://file.example/hook", webhookSecret: "file-secret" },
      { SYNC_WEBHOOK_URL: "https://env.example/hook", SYNC_WEBHOOK_SECRET: "env-secret" }
    );
    assert.deepEqual(cfg, { webhookUrl: "https://file.example/hook", webhookSecret: "file-secret" });
  });

  test("env vars are the fallback", () => {
    const cfg = resolveWebhookConfig(
      { cronSchedule: "0 8 * * *" },
      { SYNC_WEBHOOK_URL: "https://env.example/hook", SYNC_WEBHOOK_SECRET: "env-secret" }
    );
    assert.deepEqual(cfg, { webhookUrl: "https://env.example/hook", webhookSecret: "env-secret" });
  });

  test("existing config without webhook keys and no env → disabled", () => {
    assert.deepEqual(resolveWebhookConfig({ cronSchedule: "0 8 * * *" }, {}), { webhookUrl: "", webhookSecret: "" });
    assert.deepEqual(resolveWebhookConfig(undefined, {}), { webhookUrl: "", webhookSecret: "" });
  });
});

describe("mergeWebhookSettings", () => {
  const existing = { cronSchedule: "0 8 * * *", webhookUrl: "https://a.example/h", webhookSecret: "s1" };

  test("undefined leaves values unchanged and preserves other keys", () => {
    assert.deepEqual(mergeWebhookSettings(existing, {}), existing);
  });

  test("empty string removes the key", () => {
    assert.deepEqual(mergeWebhookSettings(existing, { url: "", secret: "" }), { cronSchedule: "0 8 * * *" });
  });

  test("new values are trimmed and stored", () => {
    assert.deepEqual(
      mergeWebhookSettings({ cronSchedule: "0 2 * * *" }, { url: " https://b.example/h ", secret: " s2 " }),
      { cronSchedule: "0 2 * * *", webhookUrl: "https://b.example/h", webhookSecret: "s2" }
    );
  });

  test("handles a missing sync section (old config.json)", () => {
    assert.deepEqual(mergeWebhookSettings(undefined, {}), {});
  });
});

describe("isValidWebhookUrl", () => {
  test("accepts http and https only", () => {
    assert.equal(isValidWebhookUrl("https://example.com/hook"), true);
    assert.equal(isValidWebhookUrl("http://192.168.1.10:8123/api/webhook/x"), true);
    assert.equal(isValidWebhookUrl("ftp://example.com"), false);
    assert.equal(isValidWebhookUrl("javascript:alert(1)"), false);
    assert.equal(isValidWebhookUrl("not a url"), false);
    assert.equal(isValidWebhookUrl(""), false);
    assert.equal(isValidWebhookUrl(undefined), false);
  });
});

describe("buildWebhookPayload", () => {
  test("contains exactly the documented fields", () => {
    const p = buildWebhookPayload({
      status: "success",
      startedAt: "2026-10-19T08:00:00.000Z",
      finishedAt: "2026-10-19T08:00:05.000Z",
      added: 3, modified: 1, removed: 2,
    });
    assert.deepEqual(Object.keys(p).sort(), PAYLOAD_KEYS);
    assert.deepEqual(p, {
      event: WEBHOOK_EVENT,
      version: WEBHOOK_PAYLOAD_VERSION,
      status: "success",
      startedAt: "2026-10-19T08:00:00.000Z",
      finishedAt: "2026-10-19T08:00:05.000Z",
      added: 3, modified: 1, removed: 2,
      error: null,
    });
  });

  test("drops anything not whitelisted (no transaction/account leakage)", () => {
    const p = buildWebhookPayload({
      status: "success",
      perMapping: [{ name: "My Checking", plaidAccountId: "acc_123" }],
      transactions: [{ amount: 12.34, payee_name: "Coffee" }],
      accessToken: "access-sandbox-xyz",
    });
    assert.deepEqual(Object.keys(p).sort(), PAYLOAD_KEYS);
    const json = JSON.stringify(p);
    for (const leaked of ["My Checking", "acc_123", "Coffee", "access-sandbox-xyz"]) {
      assert.ok(!json.includes(leaked), `payload leaked ${leaked}`);
    }
  });

  test("takes the message from Error objects and truncates long ones", () => {
    assert.equal(buildWebhookPayload({ status: "error", error: new Error("boom") }).error, "boom");
    const long = buildWebhookPayload({ status: "error", error: "x".repeat(2000) }).error;
    assert.equal(long.length, 500);
  });

  test("normalizes bad status and counts", () => {
    const p = buildWebhookPayload({ status: "weird", added: -1, modified: "4", removed: NaN });
    assert.equal(p.status, "error");
    assert.equal(p.added, 0);
    assert.equal(p.modified, 4);
    assert.equal(p.removed, 0);
  });

  test("defaults finishedAt to now", () => {
    const p = buildWebhookPayload({ status: "success" });
    assert.ok(!Number.isNaN(Date.parse(p.finishedAt)));
  });
});

describe("postWebhook", () => {
  test("POSTs JSON with the secret header when configured", async () => {
    const payload = buildWebhookPayload({ status: "success", added: 1 });
    const result = await postWebhook({ url: `${baseUrl}/ok`, secret: "shh" }, payload);
    assert.deepEqual(result, { ok: true, status: 204 });

    const req = lastRequest();
    assert.equal(req.method, "POST");
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.headers["x-webhook-secret"], "shh");
    assert.deepEqual(JSON.parse(req.body), payload);
  });

  test("omits the secret header when no secret is set", async () => {
    await postWebhook({ url: `${baseUrl}/ok` }, buildWebhookPayload({ status: "success" }));
    assert.equal(lastRequest().headers["x-webhook-secret"], undefined);
  });

  test("reports non-2xx responses without throwing", async () => {
    const result = await postWebhook({ url: `${baseUrl}/fail` }, buildWebhookPayload({ status: "success" }));
    assert.deepEqual(result, { ok: false, status: 500, error: "HTTP 500" });
  });

  test("does not follow redirects (secret would be replayed)", async () => {
    const before = received.length;
    const result = await postWebhook({ url: `${baseUrl}/redirect`, secret: "shh" }, buildWebhookPayload({ status: "success" }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 302);
    assert.equal(received.length, before + 1, "redirect target must not be requested");
  });

  test("times out quickly on an unresponsive endpoint", async () => {
    const started = Date.now();
    const result = await postWebhook(
      { url: `${baseUrl}/slow` },
      buildWebhookPayload({ status: "success" }),
      { timeoutMs: 200 }
    );
    assert.deepEqual(result, { ok: false, error: "timed out after 200ms" });
    assert.ok(Date.now() - started < 2000);
  });

  test("handles connection errors without leaking the host", async () => {
    // Grab a free port, then close it so the connection is refused
    const tmp = http.createServer();
    await new Promise((resolve) => tmp.listen(0, "127.0.0.1", resolve));
    const { port } = tmp.address();
    await new Promise((resolve) => tmp.close(resolve));

    const result = await postWebhook({ url: `http://127.0.0.1:${port}/hook` }, buildWebhookPayload({ status: "success" }));
    assert.deepEqual(result, { ok: false, error: "network error (ECONNREFUSED)" });
  });

  test("rejects invalid URLs without making a request", async () => {
    let called = false;
    const result = await postWebhook(
      { url: "ftp://example.com" },
      buildWebhookPayload({ status: "success" }),
      { fetchImpl: () => { called = true; } }
    );
    assert.equal(result.ok, false);
    assert.equal(called, false);
  });

  test("never throws, even if fetch itself throws synchronously", async () => {
    const result = await postWebhook(
      { url: "https://example.com/hook" },
      buildWebhookPayload({ status: "success" }),
      { fetchImpl: () => { throw new Error("https://example.com/hook exploded"); } }
    );
    assert.equal(result.ok, false);
    assert.ok(!result.error.includes("example.com"));
  });
});

describe("sendSyncWebhook", () => {
  test("is a no-op when no URL is configured", async () => {
    let called = false;
    const result = await sendSyncWebhook(
      { cronSchedule: "0 8 * * *", webhookUrl: "", webhookSecret: "" },
      { status: "success" },
      { fetchImpl: () => { called = true; } }
    );
    assert.deepEqual(result, { ok: true, skipped: true });
    assert.equal(called, false);
  });

  test("sends a sync.completed event for a failed sync", async () => {
    const logger = captureLogger();
    const result = await sendSyncWebhook(
      { webhookUrl: `${baseUrl}/ok` },
      { status: "error", startedAt: "2026-10-19T08:00:00.000Z", error: new Error("Plaid is down") },
      { logger }
    );
    assert.equal(result.ok, true);
    const body = JSON.parse(lastRequest().body);
    assert.equal(body.event, WEBHOOK_EVENT);
    assert.equal(body.status, "error");
    assert.equal(body.error, "Plaid is down");
    assert.equal(body.startedAt, "2026-10-19T08:00:00.000Z");
  });

  test("never logs the URL or secret, on success or failure", async () => {
    const secret = "super-secret-value";
    for (const path of ["/ok", "/fail", "/slow"]) {
      const url = `${baseUrl}${path}?token=url-embedded-token`;
      const logger = captureLogger();
      await sendSyncWebhook(
        { webhookUrl: url, webhookSecret: secret },
        { status: "success" },
        { logger, timeoutMs: 200 }
      );
      assert.ok(logger.lines.length > 0, `expected a log line for ${path}`);
      for (const line of logger.lines) {
        assert.ok(!line.includes(secret), `secret logged: ${line}`);
        assert.ok(!line.includes("url-embedded-token"), `URL logged: ${line}`);
        assert.ok(!line.includes("127.0.0.1"), `host logged: ${line}`);
      }
    }
  });

  test("swallows unexpected internal errors", async () => {
    const logger = captureLogger();
    const result = await sendSyncWebhook(
      { webhookUrl: "https://example.com/hook" },
      { status: "success" },
      { logger, fetchImpl: () => Promise.reject(new TypeError("fetch failed")) }
    );
    assert.equal(result.ok, false);
    assert.equal(logger.lines.length, 1);
  });
});

describe("sendTestWebhook", () => {
  test("sends a clearly-labelled test event", async () => {
    const result = await sendTestWebhook({ url: `${baseUrl}/ok`, secret: "t" });
    assert.equal(result.ok, true);
    const body = JSON.parse(lastRequest().body);
    assert.deepEqual(Object.keys(body).sort(), PAYLOAD_KEYS);
    assert.equal(body.event, WEBHOOK_TEST_EVENT);
    assert.equal(body.status, "success");
    assert.equal(body.added + body.modified + body.removed, 0);
    assert.equal(lastRequest().headers["x-webhook-secret"], "t");
  });
});
