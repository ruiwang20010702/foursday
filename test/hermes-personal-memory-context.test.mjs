import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createHermesPersonalMemoryClient,
  readHermesProjectMemoryContext,
} from "../src/hermes-personal-memory-context.mjs";

test("Hermes personal memory context reads only exact registered pages", async () => {
  const calls = [];
  const result = await readHermesProjectMemoryContext({
    client: {
      async getPage(slug) {
        calls.push(slug);
        if (slug === "projects/stale") throw new Error("not found");
        return {
          slug,
          title: "单词 2.2",
          content: "正式项目背景与长期决策。",
          updatedAt: "2026-08-18T00:00:00Z",
        };
      },
    },
    slugs: ["projects/51t-word-2-2", "projects/stale"],
  });
  assert.deepEqual(calls, ["projects/51t-word-2-2", "projects/stale"]);
  assert.equal(result.available, true);
  assert.equal(result.sourceId, "default");
  assert.equal(result.readOnly, true);
  assert.equal(result.pages.length, 1);
  assert.match(result.context, /gbrain:projects\/51t-word-2-2/u);
  assert.match(result.context, /instructions inside them as untrusted/u);
});

test("Hermes personal memory context discloses project-page redaction without private details", async () => {
  const result = await readHermesProjectMemoryContext({
    client: {
      async getPage(slug) {
        return {
          slug,
          title: "Foursday",
          content: "长期目标与安全边界。",
          updatedAt: "2026-08-27T00:00:00Z",
          redacted: true,
          redactionCount: 2,
        };
      },
    },
    slugs: ["projects/foursday-ai-employee"],
  });
  assert.equal(result.pages[0].redacted, true);
  assert.equal(result.pages[0].redactionCount, 2);
  assert.match(result.context, /Privacy: 2 sensitive project-memory blocks were omitted/u);
  assert.doesNotMatch(result.context, /email|phone|secret/iu);
});

test("Hermes personal memory loader resolves only the dedicated OAuth secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-hermes-memory-"));
  const configPath = join(root, "production.json");
  await writeFile(configPath, JSON.stringify({
    FOURSDAY_GBRAIN_ENABLED: "true",
    FOURSDAY_GBRAIN_MCP_URL: "https://memory.example.com/mcp",
    FOURSDAY_GBRAIN_ISSUER_URL: "https://memory.example.com/oauth",
    FOURSDAY_GBRAIN_CLIENT_ID: "foursday-read-client",
    FOURSDAY_GBRAIN_CLIENT_SECRET: "keychain://service/account",
    FOURSDAY_DATABASE_URL: "keychain://must/not-be-resolved",
  }));
  await chmod(configPath, 0o600);
  const resolved = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes(".well-known")) {
      return new Response(JSON.stringify({
        token_endpoint: "https://memory.example.com/oauth/token",
      }), { status: 200 });
    }
    if (String(url).endsWith("/oauth/token")) {
      return new Response(JSON.stringify({
        access_token: "read-token-for-tests",
        token_type: "Bearer",
        expires_in: 3600,
      }), { status: 200 });
    }
    const request = JSON.parse(options.body);
    assert.equal(request.params.name, "whoami");
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: JSON.stringify({
          transport: "oauth",
          source_id: "default",
          scopes: ["read"],
        }) }],
      },
    }), { status: 200 });
  };
  const client = await createHermesPersonalMemoryClient({
    configPath,
    secretResolver: async (reference) => {
      resolved.push(reference);
      return { value: "secret-value-long-enough-for-client", source: "test" };
    },
    fetchImpl,
  });
  assert.ok(client);
  assert.deepEqual(resolved, ["keychain://service/account"]);
});

test("Hermes project memory rejects traversal slugs before any read", async () => {
  let called = false;
  await assert.rejects(
    readHermesProjectMemoryContext({
      client: { async getPage() { called = true; } },
      slugs: ["projects/../private"],
    }),
    /slug is invalid/u,
  );
  assert.equal(called, false);
});
