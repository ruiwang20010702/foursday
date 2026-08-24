import assert from "node:assert/strict";
import test from "node:test";
import {
  foursdayHelp,
  publicFoursdayInstall,
  publicFoursdayStatus,
  runFoursdayCli,
} from "../scripts/新环境向导.mjs";

test("public CLI exposes only the Foursday product lifecycle", async () => {
  const help = await runFoursdayCli(["help"]);
  assert.equal(help, foursdayHelp);
  assert.deepEqual(help.usage, [
    "foursday install [--apply]",
    "foursday configure [--apply] [--replace] [--cron] --registry /absolute/private/projects.json",
    "foursday login [--apply]",
    "foursday verify [--apply]",
    "foursday accept --release-sha SHA --ledger FILE --restart-evidence FILE --code-evidence FILE --output FILE [--apply]",
    "foursday gateway <status|install-shadow|start-shadow|activate|stop|restart|uninstall|remove-profile> [options]",
    "foursday status",
    "foursday control <status|tasks|schedules|memory|evidence|ACTION> [options]",
    "foursday control-mcp",
    "foursday dashboard [--port PORT]",
  ]);
  assert.doesNotMatch(JSON.stringify(help), /legacy|ai-employee|migrate|worker|executor/iu);
  assert.doesNotMatch(help.architecture, /Hermes/iu);
});

test("control MCP and optional dashboard are thin CLI surfaces", async () => {
  let mcpCalled = false;
  const mcp = await runFoursdayCli(["control-mcp"], {
    controlMcp: async () => { mcpCalled = true; },
  });
  assert.equal(mcp, null);
  assert.equal(mcpCalled, true);
  let siteOptions;
  const site = await runFoursdayCli(["dashboard", "--port", "0"], {
    controlSite: async (options) => {
      siteOptions = options;
      return { url: "http://127.0.0.1:12345/", readOnly: true };
    },
  });
  assert.equal(site.readOnly, true);
  assert.equal(siteOptions.port, 0);
});

test("Codex shadow verification is a preview until apply", async () => {
  const calls = [];
  const result = await runFoursdayCli(["verify"], {
    codexShadow: async (options) => {
      calls.push(options);
      return { apply: options.apply, workspace: "ephemeral", messageSent: false };
    },
  });
  assert.equal(result.apply, false);
  assert.equal(result.workspace, "ephemeral");
  assert.equal(result.messageSent, false);
  assert.equal(calls[0].apply, false);
});

test("Codex login is isolated and remains a preview until apply", async () => {
  const calls = [];
  const result = await runFoursdayCli(["login"], {
    codexLogin: async (options) => {
      calls.push(options);
      return { apply: options.apply, isolatedFromUserCodex: true, credentialsCopied: false };
    },
  });
  assert.equal(result.apply, false);
  assert.equal(result.isolatedFromUserCodex, true);
  assert.equal(result.credentialsCopied, false);
  assert.equal(calls[0].apply, false);
});

test("public CLI rejects removed runtime commands", async () => {
  for (const command of ["init", "secrets", "migrate", "service", "worker", "executor"]) {
    await assert.rejects(runFoursdayCli([command]), /Unknown command/u);
  }
});

test("public status hides the embedded control-plane implementation", () => {
  const status = publicFoursdayStatus({
    schema: "foursday-native-gateway-status/v1",
    label: "internal-service-label",
    runtime: "internal-runtime-name",
    profile: "foursday",
    installed: true,
    ready: false,
  });
  assert.equal(status.schema, "foursday-status/v1");
  assert.equal(status.product, "Foursday");
  assert.equal(status.controlPlane, "embedded");
  assert.equal(status.installed, true);
  assert.equal(status.ready, false);
  assert.doesNotMatch(JSON.stringify(status), /hermes|internal-runtime|service-label/iu);
});

test("native install remains zero-write unless apply is explicit", async () => {
  const preview = await runFoursdayCli(["install"]);
  assert.equal(preview.apply, false);
  assert.equal(preview.productionWrite, false);
  assert.equal(preview.messagesSent, 0);
  assert.equal(preview.pinnedRuntimeVerified, true);
  assert.deepEqual(preview.components, [
    "dws-personal-dingtalk",
    "project-router",
    "personal-gbrain",
    "codex-policy-bridge",
    "foursday-mcp",
    "session-gateway",
  ]);
  assert.doesNotMatch(JSON.stringify(preview), /hermes/iu);
});

test("public install result keeps attribution internals out of the product surface", () => {
  const result = publicFoursdayInstall({
    apply: false,
    installed: false,
    upstream: { version: "1.0.0", commit: "a".repeat(40), installerSha256: "b".repeat(64) },
    layout: { hermesHome: "/private/internal" },
    messagesSent: 0,
    productionWrite: false,
  });
  assert.equal(result.schema, "foursday-install/v1");
  assert.doesNotMatch(JSON.stringify(result), /hermes|internal/u);
});
