import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { loadConfig } from "./config.mjs";
import { isMainModule } from "./main-module.mjs";
import { PersonalGbrainCandidateStore } from "./personal-gbrain-candidate-store.mjs";
import { verifyPersonalGbrainCandidateEvidence } from "./personal-gbrain-candidate.mjs";
import { createPostgresPool } from "./postgres.mjs";
import { applyProductionConfigFile } from "./production-config-file.mjs";
import { legacyProjectsFromWorkScopes } from "./foursday-work-scope-registry.mjs";

async function privateJson(path, label) {
  const absolute = resolve(path);
  const metadata = await stat(absolute);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must be a private regular file`);
  }
  const value = JSON.parse(await readFile(absolute, "utf8"));
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function projectFromRegistry(registry, projectId) {
  const matches = legacyProjectsFromWorkScopes(registry)
    .filter((project) => project?.id === projectId);
  if (matches.length !== 1 || typeof matches[0].root !== "string") {
    throw new Error("Hermes memory candidate project is not registered");
  }
  return matches[0];
}

export async function admitHermesMemoryCandidate(request, {
  configPath = process.env.FOURSDAY_PRODUCTION_CONFIG,
  registryPath = process.env.FOURSDAY_PROJECT_REGISTRY,
  environment = process.env,
  poolFactory = createPostgresPool,
} = {}) {
  if (!configPath || !registryPath) {
    throw new Error("Hermes memory candidate sidecar is not configured");
  }
  await applyProductionConfigFile({ path: configPath, environment });
  const config = loadConfig({ requireTargets: false, production: true });
  if (!config.personalMemoryWriteEnabled) {
    throw new Error("Personal gbrain automatic writes are disabled");
  }
  const registry = await privateJson(registryPath, "Hermes project registry");
  const project = projectFromRegistry(registry, request?.projectId);
  const sourceSessionHash = String(request?.sourceSessionHash ?? "");
  if (!/^[a-f0-9]{64}$/u.test(sourceSessionHash)) {
    throw new Error("Hermes memory candidate requires a bound session identity");
  }
  const sourcePrincipalId = String(request?.sourcePrincipalId ?? "").trim();
  if (!sourcePrincipalId || sourcePrincipalId.length > 500 || /[\u0000-\u001f\u007f]/u.test(sourcePrincipalId)) {
    throw new Error("Hermes memory candidate requires a bound requester identity");
  }
  const candidate = await verifyPersonalGbrainCandidateEvidence({
    ...request,
    schema: "foursday-personal-gbrain-candidate/v1",
    observedAt: request?.observedAt ?? new Date().toISOString(),
    sourceSessionHash,
  }, { projectRoot: project.root });
  const pool = poolFactory(config);
  try {
    const store = await new PersonalGbrainCandidateStore({
      pool,
      tenantId: config.tenantId,
      dataKey: config.dataKey,
    }).open();
    const stored = await store.propose(candidate, new Date(), { sourcePrincipalId });
    return {
      accepted: true,
      id: stored.id,
      status: stored.status,
      projectId: stored.projectId,
      candidateKey: stored.candidateKey,
      automaticPromotionQueued: true,
      personalWorktreeTouched: false,
    };
  } finally {
    await pool.end();
  }
}

async function runStdio() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const result = await admitHermesMemoryCandidate(JSON.parse(line));
      process.stdout.write(`${JSON.stringify({ success: true, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        success: false,
        error: String(error?.code ?? error?.name ?? "memory_candidate_rejected"),
      })}\n`);
    }
  }
}

if (isMainModule(import.meta.url)) await runStdio();
