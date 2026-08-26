import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  promotePersonalGbrainCandidate,
  retirePersonalGbrainPromotion,
} from "./personal-gbrain-writer.mjs";
import { verifyPersonalGbrainCandidateEvidence } from "./personal-gbrain-candidate.mjs";
import { legacyProjectsFromWorkScopes } from "./foursday-work-scope-registry.mjs";

async function loadPrivateRegistry(path) {
  const absolute = resolve(path);
  const metadata = await stat(absolute);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Hermes project registry must be a private regular file");
  }
  const registry = JSON.parse(await readFile(absolute, "utf8"));
  if (
    !(registry.schemaVersion === 1 && Array.isArray(registry.projects)) &&
    registry.schemaVersion !== 2
  ) throw new Error("Hermes project registry is invalid");
  if (registry.schemaVersion === 2) legacyProjectsFromWorkScopes(registry);
  return registry;
}

function projectRoot(registry, projectId) {
  const projects = registry.schemaVersion === 1
    ? registry.projects
    : legacyProjectsFromWorkScopes(registry);
  const matches = projects.filter((project) => project?.id === projectId);
  if (matches.length !== 1 || typeof matches[0].root !== "string") {
    const error = new Error("Personal gbrain candidate project is no longer registered");
    error.code = "PROJECT_UNREGISTERED";
    throw error;
  }
  return matches[0].root;
}

function candidateFromLease(lease) {
  return {
    schema: "foursday-personal-gbrain-candidate/v1",
    type: lease.type,
    projectId: lease.projectId,
    factKey: lease.factKey,
    title: lease.title,
    statement: lease.statement,
    sensitivity: lease.sensitivity,
    confidence: lease.confidence,
    observedAt: lease.createdAt,
    sourceSessionHash: lease.sourceSessionHash,
    evidence: lease.evidence,
  };
}

export async function promoteOnePersonalGbrainCandidate({
  store,
  config,
  registry,
  registryPath,
  owner,
  promote = promotePersonalGbrainCandidate,
  now = new Date(),
} = {}) {
  if (!config?.personalMemoryWriteEnabled) {
    return { enabled: false, processed: 0, reason: "personal_memory_write_disabled" };
  }
  const loadedRegistry = registry ?? await loadPrivateRegistry(registryPath);
  const lease = await store.leaseNext({ owner, now });
  if (!lease) return { enabled: true, processed: 0, status: "idle" };
  try {
    const result = await promote(candidateFromLease(lease), {
      projectRoot: projectRoot(loadedRegistry, lease.projectId),
      writerRoot: config.personalMemoryWriterRoot,
      remoteUrl: config.personalMemoryGitRemote,
      branch: config.personalMemoryGitBranch,
      gbrainPath: config.personalMemoryGbrainPath,
      ghPath: config.ghPath,
    });
    await store.complete(lease.id, owner, result, now);
    return {
      enabled: true,
      processed: 1,
      status: "promoted",
      candidateId: lease.id,
      slug: result.slug,
      commit: result.commit,
      readBack: result.readBack,
    };
  } catch (error) {
    const failed = await store.fail(lease.id, owner, error, { now });
    return {
      enabled: true,
      processed: 1,
      status: failed.status,
      candidateId: lease.id,
      errorCode: failed.lastErrorCode,
    };
  }
}

export async function retireOnePersonalGbrainCandidate({
  store,
  config,
  owner,
  retire = retirePersonalGbrainPromotion,
  now = new Date(),
} = {}) {
  if (!config?.personalMemoryWriteEnabled) {
    return { enabled: false, processed: 0, reason: "personal_memory_write_disabled" };
  }
  const lease = await store.leaseRetirement({ owner, now });
  if (!lease) return { enabled: true, processed: 0, status: "idle" };
  try {
    const retirement = await retire({
      slug: lease.authoritySlug,
      contentSha256: lease.authoritySha256,
    }, {
      writerRoot: config.personalMemoryWriterRoot,
      remoteUrl: config.personalMemoryGitRemote,
      branch: config.personalMemoryGitBranch,
      gbrainPath: config.personalMemoryGbrainPath,
      ghPath: config.ghPath,
      now,
    });
    await store.completeRetirement(lease.id, owner, retirement, now);
    return {
      enabled: true,
      processed: 1,
      status: "revoked",
      candidateId: lease.id,
      slug: retirement.slug,
      commit: retirement.commit,
      readBack: retirement.readBack,
    };
  } catch (error) {
    const pending = await store.failRetirement(lease.id, owner, error, now);
    return {
      enabled: true,
      processed: 1,
      status: pending.status,
      candidateId: lease.id,
      errorCode: pending.lastErrorCode,
    };
  }
}

export { loadPrivateRegistry };

export async function reconcilePromotedPersonalGbrainCandidates({
  store,
  config,
  registry,
  registryPath,
  retire = retirePersonalGbrainPromotion,
  limit = 100,
  now = new Date(),
} = {}) {
  if (!config?.personalMemoryWriteEnabled) {
    return { enabled: false, inspected: 0, revoked: 0 };
  }
  const loadedRegistry = registry ?? await loadPrivateRegistry(registryPath);
  const rows = await store.list({ status: "promoted", limit });
  const report = { enabled: true, inspected: rows.length, revoked: 0, healthy: 0, failed: 0 };
  for (const row of rows) {
    const candidate = candidateFromLease(row);
    let invalidated = false;
    try {
      await verifyPersonalGbrainCandidateEvidence(candidate, {
        projectRoot: projectRoot(loadedRegistry, row.projectId),
      });
      report.healthy += 1;
      continue;
    } catch (error) {
      // Source removal or digest drift invalidates only the Foursday-managed
      // derived page. Preserve Git history and mark it superseded.
      invalidated = ["ENOENT", "EVIDENCE_CHANGED", "PROJECT_UNREGISTERED"]
        .includes(String(error?.code ?? "")) ||
        /symlink|escapes the project root|regular file/u.test(String(error?.message ?? ""));
    }
    if (!invalidated) {
      report.failed += 1;
      continue;
    }
    try {
      const retirement = await retire({
        slug: row.authoritySlug,
        contentSha256: row.authoritySha256,
      }, {
        writerRoot: config.personalMemoryWriterRoot,
        remoteUrl: config.personalMemoryGitRemote,
        branch: config.personalMemoryGitBranch,
        gbrainPath: config.personalMemoryGbrainPath,
        ghPath: config.ghPath,
        now,
      });
      await store.revoke(row.id, retirement, now);
      report.revoked += 1;
    } catch {
      report.failed += 1;
    }
  }
  return report;
}
