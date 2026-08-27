import {
  containsCredentialMaterial,
  containsSensitivePersonMaterial,
} from "./memory-candidate.mjs";

const allowedTools = new Set(["whoami", "search", "get_page"]);
const allowedPageTypes = new Set([
  "atom", "company", "concept", "conversation", "person",
  "preference", "project", "prospective", "source",
]);

function safeHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  return url;
}

function parseMcpBody(body) {
  const text = String(body ?? "").trim();
  if (text.startsWith("{")) return JSON.parse(text);
  const data = text.split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (data.length === 0) throw new Error("Personal memory MCP returned an invalid response");
  return JSON.parse(data.at(-1));
}

function toolText(result) {
  if (result?.isError) throw new Error("Personal memory MCP tool returned an error");
  const blocks = result?.content;
  if (!Array.isArray(blocks)) {
    throw new Error("Personal memory MCP tool response is invalid");
  }
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function bounded(value, limit) {
  const text = String(value ?? "").replace(/\0/gu, "").trim();
  return text.length <= limit ? text : text.slice(0, limit);
}

function safeKnowledgeText(value) {
  const text = bounded(value, 2_000);
  if (
    !text ||
    containsCredentialMaterial(text) ||
    containsSensitivePersonMaterial(text)
  ) return null;
  return text;
}

const projectMemoryRedactionMarker = "> [已省略包含人物隐私的项目记忆内容块]";

function substantiveProjectMemoryBlock(value) {
  const lines = String(value).split("\n").filter((line) => {
    const trimmed = line.trim();
    return trimmed &&
      !/^#{1,6}\s+/u.test(trimmed) &&
      !/^```/u.test(trimmed) &&
      !/^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/u.test(trimmed);
  });
  const text = lines.join(" ")
    .replace(/^(?:[-*+]\s+|>\s*)/gu, "")
    .replace(/[*_`~|#[\]()>-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return /[\p{L}\p{N}]{4,}/u.test(text);
}

function redactSensitiveProjectMemory(content) {
  const parts = String(content).split(/(\n[ \t]*\n+)/u);
  let redactionCount = 0;
  let retainedBlockCount = 0;
  const projected = parts.map((part, index) => {
    if (index % 2 === 1 || !part.trim()) return part;
    if (containsSensitivePersonMaterial(part)) {
      redactionCount += 1;
      return projectMemoryRedactionMarker;
    }
    if (substantiveProjectMemoryBlock(part)) retainedBlockCount += 1;
    return part;
  }).join("").trim();
  if (
    redactionCount === 0 || retainedBlockCount === 0 || !projected ||
    containsCredentialMaterial(projected) ||
    containsSensitivePersonMaterial(projected)
  ) throw new Error("Personal memory page content is unavailable");
  return { content: projected, redactionCount };
}

export class PersonalMemoryClient {
  constructor({
    mcpUrl,
    issuerUrl,
    clientId,
    clientSecret,
    timeoutMs = 10_000,
    fetchImpl = fetch,
    now = () => Date.now(),
  }) {
    this.mcpUrl = safeHttpsUrl(mcpUrl, "Personal memory MCP URL");
    this.issuerUrl = safeHttpsUrl(issuerUrl, "Personal memory issuer URL");
    if (this.mcpUrl.origin !== this.issuerUrl.origin) {
      throw new Error("Personal memory MCP and issuer must share one HTTPS origin");
    }
    if (!/^[A-Za-z0-9._:-]{8,200}$/u.test(String(clientId ?? ""))) {
      throw new Error("Personal memory OAuth client id is invalid");
    }
    if (typeof clientSecret !== "string" || clientSecret.length < 24) {
      throw new Error("Personal memory OAuth client secret is invalid");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
      throw new Error("Personal memory timeout must be 1000-60000 ms");
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.now = now;
    this.cachedToken = null;
    this.requestId = 0;
  }

  async token(force = false) {
    if (
      !force &&
      this.cachedToken &&
      this.cachedToken.expiresAt > this.now() + 30_000
    ) return this.cachedToken.value;
    const metadataUrl = new URL(
      "/.well-known/oauth-authorization-server",
      this.issuerUrl,
    );
    const metadataResponse = await this.fetch(metadataUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!metadataResponse.ok) {
      throw new Error("Personal memory OAuth discovery failed");
    }
    const metadata = await metadataResponse.json();
    const tokenEndpoint = safeHttpsUrl(
      metadata?.token_endpoint,
      "Personal memory token endpoint",
    );
    if (tokenEndpoint.origin !== this.issuerUrl.origin) {
      throw new Error("Personal memory token endpoint changed origin");
    }
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: "read",
    });
    const response = await this.fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error("Personal memory OAuth token request failed");
    const token = await response.json();
    if (
      typeof token?.access_token !== "string" ||
      token.access_token.length < 16 ||
      !/^Bearer$/iu.test(String(token.token_type ?? "Bearer"))
    ) {
      throw new Error("Personal memory OAuth token response is invalid");
    }
    const expiresIn = Number(token.expires_in ?? 3_600);
    this.cachedToken = {
      value: token.access_token,
      expiresAt: this.now() + Math.max(60, expiresIn) * 1_000,
    };
    return this.cachedToken.value;
  }

  async callTool(name, args = {}, { retry = true } = {}) {
    if (!allowedTools.has(name)) throw new Error("Personal memory tool is not allowed");
    const accessToken = await this.token();
    const response = await this.fetch(this.mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.requestId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if ((response.status === 401 || response.status === 403) && retry) {
      this.cachedToken = null;
      await this.token(true);
      return this.callTool(name, args, { retry: false });
    }
    if (!response.ok) throw new Error("Personal memory MCP request failed");
    const envelope = parseMcpBody(await response.text());
    if (envelope?.error || !envelope?.result) {
      throw new Error("Personal memory MCP returned a protocol error");
    }
    return envelope.result;
  }

  async probe() {
    const identity = JSON.parse(toolText(await this.callTool("whoami")) || "{}");
    const scopes = Array.isArray(identity.scopes) ? identity.scopes : [];
    if (
      identity.transport !== "oauth" ||
      identity.source_id !== "default" ||
      !scopes.includes("read") ||
      scopes.includes("write") ||
      scopes.includes("admin")
    ) {
      throw new Error("Personal memory OAuth client is not read-only default-scoped");
    }
    return { ready: true, sourceId: "default", readOnly: true };
  }

  async searchContext(query, { limit = 8 } = {}) {
    const text = bounded(query, 4_000);
    if (!text) return [];
    if (
      containsCredentialMaterial(text) ||
      containsSensitivePersonMaterial(text)
    ) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw new Error("Personal memory search limit must be 1-10");
    }
    const resultText = toolText(await this.callTool("search", {
      query: text,
      limit,
    }));
    let rows;
    try {
      rows = JSON.parse(resultText || "[]");
    } catch {
      throw new Error("Personal memory search returned invalid JSON");
    }
    if (!Array.isArray(rows)) throw new Error("Personal memory search result is invalid");
    const output = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const slug = String(row?.slug ?? "").trim();
      const type = String(row?.type ?? "concept").trim();
      const statement = safeKnowledgeText(row?.chunk_text ?? row?.content ?? "");
      if (
        !/^[\p{L}\p{N}._/-]{1,300}$/u.test(slug) ||
        slug.startsWith("/") ||
        slug.includes("//") ||
        slug.split("/").includes("..") ||
        !allowedPageTypes.has(type) ||
        (row?.source_id != null && row.source_id !== "default") ||
        row?.sensitivity === "confidential" ||
        !statement
      ) continue;
      bytes += Buffer.byteLength(statement);
      if (bytes > 16 * 1024) break;
      output.push({
        slug,
        type,
        title: safeKnowledgeText(row?.title) ?? "",
        statement,
        sourceKind: bounded(row?.source_kind, 50) || null,
        updatedAt: row?.updated_at ?? null,
      });
    }
    return output;
  }

  async getPage(slug, { maxContentBytes = 256 * 1024 } = {}) {
    const normalized = String(slug ?? "").trim();
    if (
      !/^[\p{L}\p{N}._/-]{1,300}$/u.test(normalized) ||
      normalized.startsWith("/") ||
      normalized.includes("//") ||
      normalized.split("/").includes("..")
    ) throw new Error("Personal memory slug is invalid");
    const page = JSON.parse(toolText(await this.callTool("get_page", {
      slug: normalized,
    })) || "{}");
    if (page.slug !== normalized) throw new Error("Personal memory page identity mismatch");
    if (page.source_id != null && page.source_id !== "default") {
      throw new Error("Personal memory page source mismatch");
    }
    const content = String(page.compiled_truth ?? page.content ?? "");
    if (
      !content.trim() ||
      Buffer.byteLength(content) > maxContentBytes ||
      page.sensitivity === "confidential" ||
      containsCredentialMaterial(content)
    ) throw new Error("Personal memory page content is unavailable");
    let projectedContent = content;
    let redactionCount = 0;
    if (containsSensitivePersonMaterial(content)) {
      if (page.type !== "project") {
        throw new Error("Personal memory page content is unavailable");
      }
      const redacted = redactSensitiveProjectMemory(content);
      projectedContent = redacted.content;
      redactionCount = redacted.redactionCount;
    }
    return {
      slug: page.slug,
      type: page.type,
      title: safeKnowledgeText(page.title) ?? "",
      content: projectedContent,
      updatedAt: page.updated_at ?? null,
      ...(redactionCount > 0 ? { redacted: true, redactionCount } : {}),
    };
  }
}

export function createPersonalMemoryClient(config, options = {}) {
  if (!config.personalMemoryEnabled) return null;
  return new PersonalMemoryClient({
    mcpUrl: config.personalMemoryMcpUrl,
    issuerUrl: config.personalMemoryIssuerUrl,
    clientId: config.personalMemoryClientId,
    clientSecret: config.personalMemoryClientSecret,
    timeoutMs: config.personalMemoryTimeoutMs,
    ...options,
  });
}
