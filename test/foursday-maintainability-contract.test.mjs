import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = (path) => readFile(new URL(path, `file://${root}/`), "utf8");

test("DWS sidecar remains a bounded composition root", async () => {
  const sidecar = await source("src/hermes-dws-sidecar.mjs");
  assert.ok(sidecar.split("\n").length <= 800);
  for (const forbidden of [
    "sendLedger.set(",
    "enterpriseIdentityQueue.set(",
    "responsibilityReactions.set(",
    "dws.sendMessage(",
    "const performCheck =",
    "const emitMessage =",
  ]) assert.doesNotMatch(sidecar, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("control authorities have one named production owner", async () => {
  const owners = {
    "src/foursday-task-ledger.mjs": ["document.executions", "document.tasks"],
    "src/foursday-control-store.mjs": ["ownerRevision", "sendGeneration"],
    "src/foursday-thread-bindings.mjs": ["codexThreadId"],
    "src/foursday-delivery-coordinator.mjs": ["sendLedger.set("],
    "src/foursday-runtime-state.mjs": ["saveFoursdayRuntimeState"],
  };
  for (const [path, markers] of Object.entries(owners)) {
    const contents = await source(path);
    for (const marker of markers) assert.match(contents, new RegExp(
      marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
      "u",
    ));
  }
});
