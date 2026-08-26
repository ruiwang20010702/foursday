import assert from "node:assert/strict";
import test from "node:test";
import {
  legacyProjectsFromWorkScopes,
  normalizeWorkScopeRegistry,
} from "../src/foursday-work-scope-registry.mjs";

test("work-scope registry separates executable workspaces from inherited business scopes", () => {
  const document = {
    schemaVersion: 2,
    workspaces: [{
      id: "vocab_repo",
      root: "/private/vocab",
      gitRemote: "https://github.com/example/vocab.git",
      runInstructions: "Read project instructions first.",
    }],
    scopes: [{
      id: "vocab_2_2",
      name: "单词 2.2",
      aliases: ["单词2.2"],
      workspaceId: "vocab_repo",
      gbrainSlugs: ["projects/51t-word-2-2"],
    }, {
      id: "vocab_2_2_content",
      name: "单词 2.2 内容生产",
      aliases: ["应用题生产"],
      parentId: "vocab_2_2",
      gbrainSlugs: ["projects/51t-word-2-2-content-production"],
    }],
  };
  const registry = normalizeWorkScopeRegistry(document);
  assert.equal(registry.workspaces.length, 1);
  assert.equal(registry.scopes[1].workspaceId, "vocab_repo");
  assert.deepEqual(registry.scopes[1].lineage, ["vocab_2_2", "vocab_2_2_content"]);
  assert.deepEqual(registry.scopes[1].gbrainSlugs, [
    "projects/51t-word-2-2",
    "projects/51t-word-2-2-content-production",
  ]);
  const legacy = legacyProjectsFromWorkScopes(document);
  assert.equal(legacy[1].root, "/private/vocab");
  assert.equal(legacy[1].parentId, "vocab_2_2");
});

test("work-scope registry rejects cycles and scope-level permission fields", () => {
  assert.throws(() => normalizeWorkScopeRegistry({
    schemaVersion: 2,
    workspaces: [{ id: "repo", root: "/private/repo" }],
    scopes: [
      { id: "a", name: "A", aliases: [], parentId: "b", workspaceId: "repo" },
      { id: "b", name: "B", aliases: [], parentId: "a" },
    ],
  }), /cycle/u);
  assert.throws(() => normalizeWorkScopeRegistry({
    schemaVersion: 2,
    workspaces: [{ id: "repo", root: "/private/repo" }],
    scopes: [{ id: "a", name: "A", aliases: [], workspaceId: "repo", capabilities: ["deploy"] }],
  }), /scope is invalid/u);
  assert.throws(() => normalizeWorkScopeRegistry({
    schemaVersion: 2,
    workspaces: [{ id: "repo", root: "/private/repo" }],
    scopes: [
      { id: "same", name: "One", aliases: [], workspaceId: "repo" },
      { id: "same", name: "Two", aliases: [], workspaceId: "repo" },
    ],
  }), /duplicated/u);
});

test("legacy project registries remain readable without changing their authority", () => {
  const registry = normalizeWorkScopeRegistry({
    schemaVersion: 1,
    projects: [{
      id: "legacy",
      name: "Legacy",
      aliases: [],
      root: "/private/legacy",
      gbrainSlugs: ["projects/legacy"],
    }],
  });
  assert.equal(registry.sourceSchemaVersion, 1);
  assert.equal(registry.scopes[0].workspaceId, "legacy");
  assert.deepEqual(registry.scopes[0].lineage, ["legacy"]);
});
