import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("enterprise diagnosis traces the current scan without exposing raw command output", async () => {
  const source = await readFile(
    new URL("../scripts/诊断EnterpriseSidecar.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /fetchEnterpriseDirectScan/u);
  assert.match(source, /dws:\$\{args\.slice\(0, 3\)\.join\(":"\)\}/u);
  assert.match(source, /ciphertextMismatch/u);
  assert.match(source, /unknownCommand/u);
  assert.match(source, /messagesSent: 0/u);
  assert.match(source, /productionStateWritten: false/u);
  assert.doesNotMatch(source, /failureTrace\.push\(\{[\s\S]*?stderr:/u);
  assert.doesNotMatch(source, /failureTrace\.push\(\{[\s\S]*?stdout:/u);
});
