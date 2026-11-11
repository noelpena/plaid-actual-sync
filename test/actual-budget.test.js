import { test } from "node:test";
import assert from "node:assert/strict";
import { openBudget, ACTUAL_API_VERSION } from "../actual-budget.js";

// Mimics @actual-app/api: downloadBudget resolves even when the budget fails
// to load; loadBudget throws with the error code when it isn't open.
function fakeActual({ loadError } = {}) {
  return {
    downloadBudget: async () => {},
    getBudgets: async () => [
      { cloudFileId: "f1", groupId: "sync-1", state: "remote" },
      { id: "budget-1", cloudFileId: "f1", groupId: "sync-1" },
    ],
    loadBudget: async (id) => {
      assert.equal(id, "budget-1");
      if (loadError) throw Object.assign(new Error("This budget cannot be loaded"), { code: loadError });
    },
  };
}

test("opens a budget that loaded fine", async () => {
  await openBudget(fakeActual(), "sync-1");
});

test("explains a budget that is newer than the library", async () => {
  await assert.rejects(openBudget(fakeActual({ loadError: "out-of-sync-migrations" }), "sync-1"), (e) => {
    assert.equal(e.code, "out-of-sync-migrations");
    assert.match(e.message, /newer version of Actual/);
    assert.ok(e.message.includes(ACTUAL_API_VERSION));
    return true;
  });
});

test("passes other load errors through unchanged", async () => {
  await assert.rejects(openBudget(fakeActual({ loadError: "budget-not-found" }), "sync-1"), {
    code: "budget-not-found",
    message: "This budget cannot be loaded",
  });
});

test("fails when the downloaded budget isn't stored locally", async () => {
  const actual = { ...fakeActual(), getBudgets: async () => [] };
  await assert.rejects(openBudget(actual, "sync-1"), /isn't available locally/);
});
