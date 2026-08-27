import assert from "node:assert/strict";
import test from "node:test";
import {
  createPersonalMemoryClient,
  PersonalMemoryClient,
} from "../src/personal-memory-client.mjs";

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status, headers },
  );
}

function mcpResult(value) {
  return response({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(value) }],
    },
  });
}

function client(fetchImpl) {
  return new PersonalMemoryClient({
    mcpUrl: "https://memory.example.test/mcp",
    issuerUrl: "https://memory.example.test",
    clientId: "foursday-reader",
    clientSecret: "s".repeat(32),
    fetchImpl,
    now: () => 1_000_000,
  });
}

function discovery() {
  return response({
    token_endpoint: "https://memory.example.test/oauth/token",
  });
}

function token(value = "access-token-value") {
  return response({ access_token: value, token_type: "Bearer", expires_in: 3600 });
}

test("个人记忆客户端只接受同源 HTTPS 与有效 OAuth 身份", () => {
  assert.throws(
    () => new PersonalMemoryClient({
      mcpUrl: "http://memory.example.test/mcp",
      issuerUrl: "https://memory.example.test",
      clientId: "foursday-reader",
      clientSecret: "s".repeat(32),
    }),
    /credential-free HTTPS/u,
  );
  assert.throws(
    () => new PersonalMemoryClient({
      mcpUrl: "https://memory.example.test/mcp",
      issuerUrl: "https://issuer.example.test",
      clientId: "foursday-reader",
      clientSecret: "s".repeat(32),
    }),
    /share one HTTPS origin/u,
  );
  assert.equal(createPersonalMemoryClient({ personalMemoryEnabled: false }), null);
});

test("探针只放行 default source 的只读 OAuth 客户端", async () => {
  const calls = [];
  const memory = client(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return discovery();
    if (calls.length === 2) return token();
    return mcpResult({
      transport: "oauth",
      source_id: "default",
      scopes: ["read"],
    });
  });
  assert.deepEqual(await memory.probe(), {
    ready: true,
    sourceId: "default",
    readOnly: true,
  });
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[1].options.body.includes("client_secret="), true);
  assert.equal(calls[2].options.headers.authorization, "Bearer access-token-value");
  assert.equal(calls[2].options.body.includes('"name":"whoami"'), true);

  for (const identity of [
    { transport: "unsupported", scopes: ["read"], source_id: "default" },
    { transport: "oauth", scopes: ["read", "write"], source_id: "default" },
    { transport: "oauth", scopes: ["read"], source_id: "foursday" },
  ]) {
    let count = 0;
    const rejected = client(async () => {
      count += 1;
      if (count === 1) return discovery();
      if (count === 2) return token();
      return mcpResult(identity);
    });
    await assert.rejects(
      rejected.probe(),
      /not read-only default-scoped/u,
    );
  }
});

test("检索只返回有界、可读且不含敏感材料的个人知识", async () => {
  let count = 0;
  const memory = client(async () => {
    count += 1;
    if (count === 1) return discovery();
    if (count === 2) return token();
    return mcpResult([
      {
        slug: "projects/foursday",
        type: "project",
        title: "Foursday",
        chunk_text: "这是与当前项目直接相关的正式知识。",
        source_kind: "curated",
      },
      {
        slug: "people/private",
        type: "person",
        chunk_text: "手机号是 13800138000",
      },
      {
        slug: "projects/secret",
        type: "project",
        sensitivity: "confidential",
        chunk_text: "不应返回",
      },
      {
        slug: "projects/other-source",
        source_id: "other",
        type: "project",
        chunk_text: "跨来源结果不应返回",
      },
    ]);
  });
  assert.deepEqual(await memory.searchContext("Foursday", { limit: 4 }), [{
    slug: "projects/foursday",
    type: "project",
    title: "Foursday",
    statement: "这是与当前项目直接相关的正式知识。",
    sourceKind: "curated",
    updatedAt: null,
  }]);
  await assert.rejects(
    memory.callTool("put_page", {}),
    /not allowed/u,
  );
});

test("项目目录分页统计只保留default中的可读项目页", async () => {
  let count = 0;
  const calls = [];
  const memory = client(async (_url, options = {}) => {
    count += 1;
    if (count === 1) return discovery();
    if (count === 2) return token();
    const request = JSON.parse(options.body);
    calls.push(request.params.arguments);
    if (calls.length === 1) {
      return mcpResult([
        { slug: "projects/a", type: "project", title: "项目 A", source_id: "default" },
        { slug: "projects/private", type: "project", title: "项目 B", sensitivity: "confidential" },
        { slug: "projects/other", type: "project", title: "项目 C", source_id: "other" },
      ]);
    }
    return mcpResult([]);
  });
  assert.deepEqual(await memory.listProjects({ maximum: 3 }), {
    sourceId: "default",
    projects: [{ slug: "projects/a", title: "项目 A", updatedAt: null }],
    truncated: false,
  });
  assert.equal(calls[0].type, "project");
  assert.equal(calls[0].source_id, "default");
  assert.equal(calls[0].offset, 0);
  assert.equal(calls[1].offset, 3);
  await assert.rejects(memory.listProjects({ maximum: 1_001 }), /limit/u);
});

test("包含凭据或敏感人物信息的查询不会离开 Foursday 进程", async () => {
  let called = false;
  const memory = client(async () => {
    called = true;
    throw new Error("must not call network");
  });
  assert.deepEqual(await memory.searchContext("token: secret-value"), []);
  assert.deepEqual(await memory.searchContext("手机号是 13800138000"), []);
  assert.equal(called, false);
});

test("精确页面读取拒绝越权路径、身份漂移和秘密正文", async () => {
  let count = 0;
  const memory = client(async () => {
    count += 1;
    if (count === 1) return discovery();
    if (count === 2) return token();
    return mcpResult({
      slug: "projects/foursday",
      type: "project",
      title: "Foursday",
      content: "正式项目知识",
    });
  });
  assert.deepEqual(await memory.getPage("projects/foursday"), {
    slug: "projects/foursday",
    type: "project",
    title: "Foursday",
    content: "正式项目知识",
    updatedAt: null,
  });
  await assert.rejects(memory.getPage("../secret"), /slug is invalid/u);

  for (const page of [
    { slug: "projects/other", content: "正文" },
    { slug: "projects/foursday", source_id: "other", content: "正文" },
    { slug: "projects/foursday", content: "token: secret-value" },
  ]) {
    let next = 0;
    const rejected = client(async () => {
      next += 1;
      if (next === 1) return discovery();
      if (next === 2) return token();
      return mcpResult(page);
    });
    await assert.rejects(rejected.getPage("projects/foursday"));
  }
});

test("项目记忆按Markdown内容块脱敏并显式返回不完整标记", async () => {
  let count = 0;
  const memory = client(async () => {
    count += 1;
    if (count === 1) return discovery();
    if (count === 2) return token();
    return mcpResult({
      slug: "projects/foursday",
      source_id: "default",
      type: "project",
      title: "Foursday",
      compiled_truth: [
        "# Foursday",
        "",
        "长期目标是构建个人记忆驱动的工作分身。",
        "",
        "- 历史贡献者邮箱：agent@example.local",
        "",
        "## 当前原则",
        "",
        "所有外部动作必须保留可审计证据。",
      ].join("\n"),
    });
  });

  const page = await memory.getPage("projects/foursday");
  assert.equal(page.redacted, true);
  assert.equal(page.redactionCount, 1);
  assert.match(page.content, /个人记忆驱动的工作分身/u);
  assert.match(page.content, /所有外部动作必须保留/u);
  assert.doesNotMatch(page.content, /邮箱|agent@example\.local/u);
});

test("人物隐私、凭据、全页敏感和脱敏残留继续失败关闭", async () => {
  const pages = [{
    slug: "people/example",
    type: "person",
    content: "工作邮箱：person@example.com",
  }, {
    slug: "projects/foursday",
    type: "project",
    content: "token: secret-value",
  }, {
    slug: "projects/foursday",
    type: "project",
    content: "电子邮箱：owner@example.com",
  }, {
    slug: "projects/foursday",
    type: "project",
    content: "# 项目联系人\n\n电子邮箱：owner@example.com",
  }, {
    slug: "projects/foursday",
    type: "project",
    content: "13800\n138000",
  }];
  for (const [index, page] of pages.entries()) {
    let count = 0;
    const memory = client(async () => {
      count += 1;
      if (count === 1) return discovery();
      if (count === 2) return token();
      return mcpResult(page);
    });
    await assert.rejects(
      memory.getPage(page.slug),
      /content is unavailable/u,
      `sensitive page fixture ${index + 1} must fail closed`,
    );
  }
});

test("401 会刷新一次令牌且不无限重试", async () => {
  const tokens = [];
  let calls = 0;
  const memory = client(async (_url, options = {}) => {
    calls += 1;
    if (String(_url).includes("well-known")) return discovery();
    if (String(_url).includes("oauth/token")) {
      const value = `access-token-value-${tokens.length + 1}`;
      tokens.push(value);
      return token(value);
    }
    assert.equal(options.headers.authorization, `Bearer ${tokens.at(-1)}`);
    if (tokens.length === 1) return response({}, { status: 401 });
    return mcpResult({
      transport: "oauth",
      source_id: "default",
      scopes: ["read"],
    });
  });
  await memory.probe();
  assert.deepEqual(tokens, ["access-token-value-1", "access-token-value-2"]);
  assert.equal(calls, 6);
});
