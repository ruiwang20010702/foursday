import hashlib
import json
import os
import tempfile
import unittest

from project_router.registry import ProjectRegistry


class ProjectRouterTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.vocab = os.path.join(self.temp.name, "vocab-2-2")
        self.foursday = os.path.join(self.temp.name, "foursday")
        self.fallback = os.path.join(self.temp.name, "unrouted")
        for path in [self.vocab, self.foursday, self.fallback]:
            os.mkdir(path)
        self.registry_path = os.path.join(self.temp.name, "projects.json")
        with open(self.registry_path, "w", encoding="utf-8") as handle:
            json.dump({
                "schemaVersion": 1,
                "projects": [
                    {
                        "id": "vocab_2_2",
                        "name": "单词 2.2",
                        "aliases": ["单词2.2", "2.2试题", "应用题生产"],
                        "root": self.vocab,
                        "gitRemote": None,
                        "gbrainSlugs": ["projects/51talk-vocab-2-2"],
                        "dingtalkSources": [{
                            "id": "project_index",
                            "name": "项目说明",
                            "kind": "doc",
                            "nodeId": "EXAMPLEPROJECTDOCNODE1234567890",
                        }],
                        "runInstructions": "优先读取项目说明和当前进度台账。",
                    },
                    {
                        "id": "foursday",
                        "name": "Foursday",
                        "aliases": ["AI员工", "工作分身"],
                        "root": self.foursday,
                        "gitRemote": "https://github.com/example/foursday.git",
                        "gbrainSlugs": ["projects/foursday"],
                        "runInstructions": "运行项目测试后再汇报。",
                    },
                ],
            }, handle, ensure_ascii=False)
        self.registry = ProjectRegistry.load(
            self.registry_path,
            fallback_workspace=self.fallback,
        )

    def test_explicit_alias_routes_without_project_requester_configuration(self):
        route = self.registry.route(
            text="娜娜老师问：2.2试题目前生产了多少？",
            session_key="direct-1:teacher-nana",
        )
        self.assertEqual(route.status, "matched")
        self.assertEqual(route.project.id, "vocab_2_2")
        self.assertEqual(route.workspace_path, os.path.realpath(self.vocab))
        self.assertNotIn("requester", route.project.to_dict())
        self.assertNotIn("capabilities", route.project.to_dict())
        self.assertEqual(route.project.dingtalk_sources[0].id, "project_index")

    def test_followup_reuses_session_project_without_repeating_alias(self):
        first = self.registry.route(
            text="核对单词2.2生产数量",
            session_key="direct-1:teacher-nana",
        )
        followup = self.registry.route(
            text="已放行多少？为什么最低的批次比较差？",
            session_key="direct-1:teacher-nana",
        )
        self.assertEqual(first.project.id, "vocab_2_2")
        self.assertEqual(followup.status, "bound")
        self.assertEqual(followup.project.id, "vocab_2_2")

    def test_codex_project_selection_hash_is_reloaded_on_next_turn(self):
        binding_path = os.path.join(self.temp.name, "routes-selected.json")
        registry = ProjectRegistry.load(
            self.registry_path,
            fallback_workspace=self.fallback,
            binding_path=binding_path,
        )
        session_key = "direct-link:enterprise-user"
        with open(binding_path, "w", encoding="utf-8") as handle:
            json.dump({
                "schemaVersion": 1,
                "bindings": {
                    hashlib.sha256(session_key.encode("utf-8")).hexdigest(): "vocab_2_2",
                },
            }, handle)
        os.chmod(binding_path, 0o600)
        selected = registry.route(text="继续处理这份文档", session_key=session_key)
        self.assertEqual(selected.status, "bound")
        self.assertEqual(selected.project.id, "vocab_2_2")

    def test_project_name_inside_a_file_path_does_not_hijack_bound_session(self):
        first = self.registry.route(
            text="核对单词2.2生产数量",
            session_key="direct-path:teacher-nana",
        )
        followup = self.registry.route(
            text="请把结果写到 outputs/foursday-shadow/说明.md",
            session_key="direct-path:teacher-nana",
        )
        self.assertEqual(first.project.id, "vocab_2_2")
        self.assertEqual(followup.status, "bound")
        self.assertEqual(followup.project.id, "vocab_2_2")

    def test_natural_explicit_project_name_can_switch_a_bound_session(self):
        self.registry.route(
            text="核对单词2.2生产数量",
            session_key="direct-switch:teacher-nana",
        )
        switched = self.registry.route(
            text="再看看 Foursday 项目现在怎么样",
            session_key="direct-switch:teacher-nana",
        )
        self.assertEqual(switched.status, "matched")
        self.assertEqual(switched.project.id, "foursday")

    def test_followup_binding_survives_gateway_restart(self):
        binding_path = os.path.join(self.temp.name, "routes.json")
        registry = ProjectRegistry.load(
            self.registry_path,
            fallback_workspace=self.fallback,
            binding_path=binding_path,
        )
        registry.route(
            text="核对单词2.2生产数量",
            session_key="direct-1:teacher-nana",
        )
        self.assertEqual(oct(os.stat(binding_path).st_mode & 0o777), "0o600")
        restarted = ProjectRegistry.load(
            self.registry_path,
            fallback_workspace=self.fallback,
            binding_path=binding_path,
        )
        followup = restarted.route(
            text="已放行多少？",
            session_key="direct-1:teacher-nana",
        )
        self.assertEqual(followup.status, "bound")
        self.assertEqual(followup.project.id, "vocab_2_2")
        with open(binding_path, "r", encoding="utf-8") as handle:
            persisted = json.load(handle)["bindings"]
        self.assertNotIn("direct-1:teacher-nana", persisted)
        self.assertIn(
            hashlib.sha256("direct-1:teacher-nana".encode("utf-8")).hexdigest(),
            persisted,
        )

    def test_ambiguous_or_unknown_message_never_guesses_project(self):
        ambiguous_path = os.path.join(self.temp.name, "ambiguous.json")
        with open(ambiguous_path, "w", encoding="utf-8") as handle:
            json.dump({
                "schemaVersion": 1,
                "projects": [
                    {"id": "a", "name": "项目A", "aliases": ["共同项目"], "root": self.vocab},
                    {"id": "b", "name": "项目B", "aliases": ["共同项目"], "root": self.foursday},
                ],
            }, handle, ensure_ascii=False)
        registry = ProjectRegistry.load(ambiguous_path, fallback_workspace=self.fallback)
        ambiguous = registry.route(text="共同项目现在怎样？", session_key="new-1")
        unknown = registry.route(text="帮我看看这个", session_key="new-2")
        self.assertEqual(ambiguous.status, "ambiguous")
        self.assertEqual(ambiguous.project, None)
        self.assertEqual(unknown.status, "unmatched")
        self.assertEqual(unknown.workspace_path, os.path.realpath(self.fallback))

    def test_registry_rejects_governance_and_business_metric_fields(self):
        for forbidden in ["requesters", "capabilities", "evidenceMetrics", "produced_questions"]:
            invalid = os.path.join(self.temp.name, f"invalid-{forbidden}.json")
            with open(invalid, "w", encoding="utf-8") as handle:
                json.dump({
                    "schemaVersion": 1,
                    "projects": [{
                        "id": "bad",
                        "name": "Bad",
                        "aliases": ["bad"],
                        "root": self.vocab,
                        forbidden: {},
                    }],
                }, handle)
            with self.assertRaises(ValueError):
                ProjectRegistry.load(invalid, fallback_workspace=self.fallback)

    def test_registry_rejects_invalid_dingtalk_sources(self):
        invalid_sources = [
            [{"id": "source", "name": "Source", "kind": "write", "nodeId": "EXAMPLEPROJECTDOCNODE1234567890"}],
            [{"id": "source", "name": "Source", "kind": "doc", "nodeId": "short"}],
            [{"id": "provided_1", "name": "Reserved", "kind": "doc", "nodeId": "EXAMPLEPROJECTDOCNODE1234567890"}],
            [
                {"id": "same", "name": "One", "kind": "doc", "nodeId": "EXAMPLEPROJECTDOCNODE1234567890"},
                {"id": "same", "name": "Two", "kind": "doc", "nodeId": "EXAMPLEPROJECTDOCNODE0987654321"},
            ],
        ]
        for index, sources in enumerate(invalid_sources):
            path = os.path.join(self.temp.name, f"invalid-source-{index}.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump({
                    "schemaVersion": 1,
                    "projects": [{
                        "id": "bad",
                        "name": "Bad",
                        "aliases": ["bad"],
                        "root": self.vocab,
                        "dingtalkSources": sources,
                    }],
                }, handle)
            with self.assertRaises(ValueError):
                ProjectRegistry.load(path, fallback_workspace=self.fallback)

    def test_v2_work_scopes_inherit_one_workspace_and_related_binding(self):
        path = os.path.join(self.temp.name, "work-scopes.json")
        binding_path = os.path.join(self.temp.name, "work-scope-routes.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({
                "schemaVersion": 2,
                "workspaces": [{
                    "id": "vocab_repo",
                    "root": self.vocab,
                    "gitRemote": None,
                    "runInstructions": "Read the ledger.",
                }],
                "scopes": [{
                    "id": "vocab_2_2",
                    "name": "单词 2.2",
                    "aliases": ["单词2.2"],
                    "workspaceId": "vocab_repo",
                    "gbrainSlugs": ["projects/51t-word-2-2"],
                }, {
                    "id": "vocab_2_2_content",
                    "name": "单词 2.2 内容生产",
                    "aliases": ["应用题生产"],
                    "parentId": "vocab_2_2",
                    "gbrainSlugs": ["projects/51t-word-2-2-content-production"],
                }],
            }, handle, ensure_ascii=False)
        session_key = "direct:worker"
        with open(binding_path, "w", encoding="utf-8") as handle:
            json.dump({
                "schemaVersion": 2,
                "bindings": {
                    hashlib.sha256(session_key.encode("utf-8")).hexdigest(): {
                        "primaryScopeId": "vocab_2_2_content",
                        "relatedScopeIds": ["vocab_2_2"],
                        "relatedGbrainSlugs": ["projects/51t-word-2-2-learning-report"],
                        "evidenceSourceIds": [],
                        "rationale": "Content production is primary; learning report is related.",
                        "updatedAt": "2026-08-26T00:00:00Z",
                    },
                },
            }, handle)
        os.chmod(binding_path, 0o600)
        registry = ProjectRegistry.load(
            path,
            fallback_workspace=self.fallback,
            binding_path=binding_path,
        )
        route = registry.route(text="继续处理", session_key=session_key)
        self.assertEqual(route.status, "bound")
        self.assertEqual(route.project.id, "vocab_2_2_content")
        self.assertEqual(route.project.workspace_id, "vocab_repo")
        self.assertEqual(route.project.lineage, ("vocab_2_2", "vocab_2_2_content"))
        self.assertEqual(route.workspace_path, os.path.realpath(self.vocab))
        self.assertEqual([item.id for item in route.related_projects], ["vocab_2_2"])
        self.assertIn("projects/51t-word-2-2", route.project.gbrain_slugs)
        self.assertIn("projects/51t-word-2-2-content-production", route.project.gbrain_slugs)
        self.assertIn("Related gbrain project pages", route.context)


if __name__ == "__main__":
    unittest.main()
