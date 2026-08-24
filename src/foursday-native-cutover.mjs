const acceptanceScenarios = Object.freeze([
  "allowlistedMessage",
  "projectRoute",
  "personalMemory",
  "naturalReply",
  "followup",
  "codeWork",
  "ownerIntervention",
  "restartRecovery",
  "sendDisabled",
  "noDuplicate",
]);

const fullSha = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;

export const removeFoursdayProfileConfirmation = "REMOVE-FOURSDAY-PROFILE";

export function assertFoursdayNativeShadowAcceptance(receipt, {
  releaseSha,
  now = new Date(),
  maximumAgeMs = 7 * 24 * 60 * 60 * 1_000,
} = {}) {
  if (!fullSha.test(String(releaseSha ?? ""))) {
    throw new Error("Foursday activation requires an exact release SHA");
  }
  if (
    !receipt ||
    Array.isArray(receipt) ||
    receipt.schema !== "foursday-shadow-acceptance/v1" ||
    receipt.releaseSha !== releaseSha ||
    !digest.test(String(receipt.evidenceDigest ?? ""))
  ) throw new Error("Foursday shadow acceptance receipt is invalid");
  const createdAt = new Date(receipt.createdAt).getTime();
  const age = now.getTime() - createdAt;
  if (!Number.isFinite(age) || age < 0 || age > maximumAgeMs) {
    throw new Error("Foursday shadow acceptance receipt is stale");
  }
  const missing = acceptanceScenarios.filter(
    (scenario) => receipt.scenarios?.[scenario] !== true,
  );
  if (missing.length > 0) {
    throw new Error(`Foursday shadow acceptance is incomplete: ${missing.join(",")}`);
  }
  return {
    valid: true,
    releaseSha,
    scenarioCount: acceptanceScenarios.length,
    evidenceDigest: receipt.evidenceDigest,
  };
}

export function nativeActivationConfirmation({ releaseSha, evidenceDigest }) {
  if (!fullSha.test(String(releaseSha ?? "")) || !digest.test(String(evidenceDigest ?? ""))) {
    throw new Error("Foursday activation confirmation inputs are invalid");
  }
  return `ACTIVATE-FOURSDAY:${releaseSha}:${evidenceDigest.slice(0, 16)}`;
}

export function authorizeFoursdayNativeGatewayAction(action, {
  apply = false,
  releaseSha = null,
  acceptance = null,
  confirmation = null,
  now = new Date(),
} = {}) {
  if (action === "activate") {
    const verified = assertFoursdayNativeShadowAcceptance(acceptance, { releaseSha, now });
    const expectedConfirmation = nativeActivationConfirmation(verified);
    if (apply && confirmation !== expectedConfirmation) {
      throw new Error("Foursday activation confirmation does not match shadow evidence");
    }
    return {
      gated: true,
      releaseSha: verified.releaseSha,
      scenarioCount: verified.scenarioCount,
      evidenceDigest: verified.evidenceDigest,
      confirmation: expectedConfirmation,
    };
  }
  if (
    action === "remove-profile" &&
    apply &&
    confirmation !== removeFoursdayProfileConfirmation
  ) {
    throw new Error("Foursday profile removal requires the exact confirmation");
  }
  return {
    gated: action === "remove-profile",
    confirmation: action === "remove-profile"
      ? removeFoursdayProfileConfirmation
      : null,
  };
}
