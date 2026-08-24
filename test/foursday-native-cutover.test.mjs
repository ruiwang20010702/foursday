import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeFoursdayNativeGatewayAction,
  removeFoursdayProfileConfirmation,
} from "../src/foursday-native-cutover.mjs";

function acceptance(releaseSha, createdAt = "2026-08-20T00:00:00.000Z") {
  return {
    schema: "foursday-shadow-acceptance/v1",
    releaseSha,
    evidenceDigest: "a".repeat(64),
    createdAt,
    scenarios: Object.fromEntries([
      "allowlistedMessage", "projectRoute", "personalMemory", "naturalReply", "followup",
      "codeWork", "ownerIntervention", "restartRecovery", "sendDisabled", "noDuplicate",
    ].map((name) => [name, true])),
  };
}

test("native activation preview and apply bind the exact shadow receipt", () => {
  const releaseSha = "b".repeat(40);
  const preview = authorizeFoursdayNativeGatewayAction("activate", {
    releaseSha,
    acceptance: acceptance(releaseSha),
    now: new Date("2026-08-20T01:00:00.000Z"),
  });
  assert.equal(preview.scenarioCount, 10);
  assert.match(preview.confirmation, /^ACTIVATE-FOURSDAY:/u);
  assert.throws(
    () => authorizeFoursdayNativeGatewayAction("activate", {
      apply: true,
      releaseSha,
      acceptance: acceptance(releaseSha),
      confirmation: "wrong",
      now: new Date("2026-08-20T01:00:00.000Z"),
    }),
    /does not match shadow evidence/u,
  );
  assert.equal(authorizeFoursdayNativeGatewayAction("activate", {
    apply: true,
    releaseSha,
    acceptance: acceptance(releaseSha),
    confirmation: preview.confirmation,
    now: new Date("2026-08-20T01:00:00.000Z"),
  }).releaseSha, releaseSha);
});

test("native activation rejects stale or incomplete evidence", () => {
  const releaseSha = "b".repeat(40);
  const incomplete = acceptance(releaseSha);
  incomplete.scenarios.codeWork = false;
  assert.throws(
    () => authorizeFoursdayNativeGatewayAction("activate", {
      releaseSha,
      acceptance: incomplete,
      now: new Date("2026-08-20T01:00:00.000Z"),
    }),
    /incomplete/u,
  );
});

test("profile removal apply requires a separate exact confirmation", () => {
  const preview = authorizeFoursdayNativeGatewayAction("remove-profile");
  assert.equal(preview.confirmation, removeFoursdayProfileConfirmation);
  assert.throws(
    () => authorizeFoursdayNativeGatewayAction("remove-profile", {
      apply: true,
      confirmation: "wrong",
    }),
    /exact confirmation/u,
  );
});
