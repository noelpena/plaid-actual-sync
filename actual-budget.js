// Opening the Actual budget, plus version info for the admin UI.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Installed @actual-app/api version (the package doesn't export its package.json).
export const ACTUAL_API_VERSION = (() => {
  try {
    const pkgPath = path.join(__dirname, "node_modules", "@actual-app", "api", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
  } catch (_) {
    return "unknown";
  }
})();

// Error codes the Actual library uses when the budget file is newer than the
// library (it was opened by a newer Actual app, e.g. the auto-updating desktop app).
const TOO_NEW_CODES = new Set(["out-of-sync-migrations", "out-of-sync-data"]);

export function budgetTooNewMessage() {
  return (
    `Your budget was updated by a newer version of Actual than this app supports ` +
    `(@actual-app/api ${ACTUAL_API_VERSION}). Update plaid-actual-sync: pull the latest ` +
    `image (docker compose pull && docker compose up -d) or rebuild. If you build from ` +
    `source with ACTUAL_VERSION set, raise it to your newest Actual version.`
  );
}

// Download the budget and make sure it actually opened.
//
// actual.downloadBudget() doesn't throw when the budget fails to load: it logs
// "Error updating", closes the budget and returns. Later API calls then crash
// with unrelated errors. Calling loadBudget() on the same budget is a no-op when
// it's open, and throws the real error code when it isn't.
export async function openBudget(actual, syncId, options) {
  await actual.downloadBudget(syncId, options);

  const budgets = await actual.getBudgets();
  const local = budgets.find(b => b.groupId === syncId && b.id);
  if (!local) {
    throw new Error(`Budget ${syncId} was downloaded but isn't available locally`);
  }

  try {
    await actual.loadBudget(local.id);
  } catch (e) {
    if (TOO_NEW_CODES.has(e?.code)) {
      const err = new Error(budgetTooNewMessage(), { cause: e });
      err.code = e.code;
      throw err;
    }
    throw e;
  }
}

// Actual server version from its public /info endpoint, or null if unreachable.
export async function getActualServerVersion(serverURL) {
  if (!serverURL) return null;
  try {
    const res = await fetch(new URL("/info", serverURL), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.build?.version || null;
  } catch (_) {
    return null;
  }
}
