import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { applyProductionConfigFile } from "../src/production-config-file.mjs";

async function fixture(t, values, mode = 0o600) {
  const root = await mkdtemp(join(tmpdir(), "foursday-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "foursday.json");
  await writeFile(path, `${JSON.stringify(values)}\n`, { mode });
  await chmod(path, mode);
  return path;
}

function base() {
  return {
    FOURSDAY_DATABASE_URL: "env://FOURSDAY_SECRET_DATABASE_URL",
    FOURSDAY_DATA_KEY: "env://FOURSDAY_SECRET_DATA_KEY",
    FOURSDAY_TENANT_ID: "personal",
    FOURSDAY_DWS_PATH: "/absolute/dws",
    FOURSDAY_DINGTALK_USERS: "trusted-user",
    FOURSDAY_GBRAIN_ENABLED: false,
    FOURSDAY_GBRAIN_WRITE_ENABLED: false,
  };
}

test("minimal production config resolves only declared secret references", async (t) => {
  const path = await fixture(t, base());
  const environment = {
    FOURSDAY_SECRET_DATABASE_URL: "postgresql://user:pass@localhost:5432/foursday",
    FOURSDAY_SECRET_DATA_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
  const result = await applyProductionConfigFile({ path, environment });
  assert.deepEqual(result.resolvedSecretKeys.sort(), ["FOURSDAY_DATABASE_URL", "FOURSDAY_DATA_KEY"]);
  assert.equal(environment.FOURSDAY_TENANT_ID, "personal");
  assert.match(environment.FOURSDAY_DATABASE_URL, /^postgresql:/u);
  assert.doesNotMatch(JSON.stringify(result), /user:pass|BwcHBw/u);
});

test("unknown fields, compound values, inline secrets and broad permissions fail closed", async (t) => {
  const environment = {
    FOURSDAY_SECRET_DATABASE_URL: "postgresql://user:pass@localhost:5432/foursday",
    FOURSDAY_SECRET_DATA_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
  await assert.rejects(
    applyProductionConfigFile({ path: await fixture(t, { ...base(), OLD_WORKER_MODE: true }), environment }),
    /Unsupported config key/u,
  );
  await assert.rejects(
    applyProductionConfigFile({ path: await fixture(t, { ...base(), FOURSDAY_DINGTALK_USERS: [] }), environment }),
    /must be scalar/u,
  );
  await assert.rejects(
    applyProductionConfigFile({ path: await fixture(t, { ...base(), FOURSDAY_DATA_KEY: "inline-secret" }), environment }),
    /external reference/u,
  );
  await assert.rejects(
    applyProductionConfigFile({ path: await fixture(t, base(), 0o640), environment }),
    /must not be readable/u,
  );
});

test("gbrain write mode requires same-origin OAuth and a dedicated absolute checkout", () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    FOURSDAY_GBRAIN_ENABLED: "true",
    FOURSDAY_GBRAIN_MCP_URL: "https://gbrain.example.com/mcp",
    FOURSDAY_GBRAIN_ISSUER_URL: "https://other.example.com/oauth",
    FOURSDAY_GBRAIN_CLIENT_ID: "foursday-client",
    FOURSDAY_GBRAIN_CLIENT_SECRET: "x".repeat(32),
  });
  try {
    assert.throws(() => loadConfig(), /share one HTTPS origin/u);
    process.env.FOURSDAY_GBRAIN_ISSUER_URL = "https://gbrain.example.com/oauth";
    process.env.FOURSDAY_GBRAIN_WRITE_ENABLED = "true";
    assert.throws(() => loadConfig(), /FOURSDAY_GBRAIN_GIT_REMOTE/u);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("public example contains only FOURSDAY fields and external secret references", async () => {
  const example = JSON.parse(await readFile(new URL("../deploy/foursday.example.json", import.meta.url), "utf8"));
  assert.ok(Object.keys(example).every((key) => key.startsWith("FOURSDAY_")));
  for (const key of ["FOURSDAY_DATABASE_URL", "FOURSDAY_DATA_KEY", "FOURSDAY_GBRAIN_CLIENT_SECRET"]) {
    assert.match(example[key], /^(?:env|keychain):\/\//u);
  }
  assert.equal(example.FOURSDAY_DINGTALK_EVENT_WAKE_ENABLED, true);
  assert.equal(example.FOURSDAY_DINGTALK_ENTERPRISE_USERS, true);
  assert.equal(example.FOURSDAY_DINGTALK_FALLBACK_MS, 30_000);
  assert.equal(example.FOURSDAY_DINGTALK_HISTORY_SETTLE_MS, 120_000);
  assert.equal(example.FOURSDAY_DINGTALK_OUTBOUND_QUIET_MS, 8_000);
  assert.equal(example.FOURSDAY_DINGTALK_OUTBOUND_MAX_QUIET_MS, 20_000);
});
