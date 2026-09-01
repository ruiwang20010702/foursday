import asyncio
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from gateway.config import PlatformConfig
from gateway.authz_mixin import GatewayAuthorizationMixin
from gateway.platform_registry import PlatformEntry, platform_registry
from gateway.platforms.base import ProcessingOutcome
from dws_personal import register
from dws_personal.adapter import (
    DwsPersonalAdapter,
    _TURN_CONSUMED_DELIVERY_VERSION,
    _TURN_DELIVERY_VERSION,
    _provided_dingtalk_sources,
    _shadow_evidence,
)
from project_router.runtime_context import current_routed_principal_id
from agent.runtime_cwd import resolve_agent_cwd


class FakePluginContext:
    def __init__(self):
        self.platform = None

    def register_platform(self, **kwargs):
        self.platform = kwargs
        entry = PlatformEntry(
            **kwargs,
            plugin_name="dws-personal-test",
            source="plugin",
        )
        platform_registry.register(entry)


_bootstrap_context = FakePluginContext()
register(_bootstrap_context)


class FakeBridge:
    def __init__(self):
        self.callback = None
        self.started = False
        self.stopped = False
        self.sent = []
        self.acked = []
        self.claimed = []
        self.released = []
        self.settled = []
        self.grouped = []
        self.group_result = None
        self.response_duties = []
        self.response_duty_result = None
        self.background = {}
        self.background_calls = []
        self.startup_releases = 0
        self.reconciles = 0
        self.send_result = {"success": True, "messageId": "sent-1"}

    async def start(self, callback):
        self.callback = callback
        self.started = True

    async def stop(self):
        self.stopped = True

    async def emit(self, record):
        await self.callback(record)

    async def release_events(self):
        self.startup_releases += 1

    async def reconcile(self):
        self.reconciles += 1
        return {"success": True}

    async def send(self, payload):
        self.sent.append(payload)
        return self.send_result

    async def ack_control(self, task_id, event_id):
        self.acked.append((task_id, event_id))
        return {"success": True}

    async def claim_responsibility(self, payload):
        self.claimed.append(dict(payload))
        return {"success": True}

    async def release_responsibility(self, payload):
        self.released.append(dict(payload))
        return {"success": True}

    async def settle_responsibility(self, payload):
        self.settled.append(dict(payload))
        return {"success": True}

    async def group_responsibility(self, payload):
        self.grouped.append(dict(payload))
        messages = list(payload.get("messages") or [])
        return self.group_result or {
            "success": True,
            "groups": [list(range(len(messages)))],
            "source": "test_default",
        }

    async def classify_response_duty(self, payload):
        self.response_duties.append(dict(payload))
        return self.response_duty_result or {
            "success": True,
            "decision": "action_required",
            "source": "codex",
            "confidence": 0.99,
        }

    async def inspect_background(self, payload):
        self.background_calls.append(("inspect", dict(payload)))
        return dict(self.background.get("inspect") or {
            "success": False, "staleGeneration": True,
        })

    async def acknowledge_background(self, payload):
        self.background_calls.append(("acknowledge", dict(payload)))
        return dict(self.background.get("acknowledge") or {"success": True})

    async def activate_background(self, payload):
        self.background_calls.append(("activate", dict(payload)))
        return dict(self.background.get("activate") or {
            "success": True, "activated": False,
        })

    async def start_background(self, payload):
        self.background_calls.append(("start", dict(payload)))
        return dict(self.background.get("start") or {"success": True})

    async def finish_background(self, payload):
        self.background_calls.append(("finish", dict(payload)))
        return dict(self.background.get("finish") or {
            "success": True, "execution": {"state": payload.get("outcome")},
        })


class GenerationFenceBridge(FakeBridge):
    def __init__(self):
        super().__init__()
        self.current_owner_revision = 0
        self.current_generation = 0
        self.delivered = []
        self.final_delivery = asyncio.Event()

    async def send(self, payload):
        self.sent.append(payload)
        if (
            payload.get("ownerRevision") != self.current_owner_revision
            or payload.get("sendGeneration") != self.current_generation
        ):
            return {
                "success": False,
                "staleGeneration": True,
                "error": "stale generation",
            }
        self.delivered.append(payload)
        self.final_delivery.set()
        return {
            "success": True,
            "messageId": f"sent-{len(self.delivered)}",
        }


class BufferedFakeBridge(FakeBridge):
    def __init__(self, record):
        super().__init__()
        self.record = record
        self.released = False

    async def release_events(self):
        self.released = True
        await self.callback(self.record)


@dataclass
class FakeRoute:
    workspace_path: str
    context: str
    project: object


class FakeRouter:
    def __init__(self, workspace):
        self.workspace = workspace
        self.fallback_workspace = workspace
        self.calls = []
        self.cleared = []

    def clear_binding(self, session_key):
        self.cleared.append(session_key)

    def route(self, *, text, session_key):
        self.calls.append({"text": text, "session_key": session_key})
        return FakeRoute(
            workspace_path=self.workspace,
            context="Foursday project route: 单词 2.2 (vocab_2_2).",
            project=SimpleNamespace(id="vocab_2_2", root=self.workspace),
        )


class FakeMemory:
    async def context_for_route(self, _route):
        return "Source: gbrain:projects/51t-word-2-2\n长期项目背景。"


class DwsPersonalPluginTest(unittest.IsolatedAsyncioTestCase):
    def test_registers_external_platform_without_core_changes(self):
        ctx = FakePluginContext()
        register(ctx)
        self.assertEqual(ctx.platform["name"], "dws_personal")
        self.assertEqual(ctx.platform["allowed_users_env"], "DWS_PERSONAL_ALLOWED_USERS")
        self.assertEqual(ctx.platform["allow_all_env"], "DWS_PERSONAL_ALLOW_ALL_USERS")
        self.assertTrue(callable(ctx.platform["adapter_factory"]))

    def test_local_markdown_citations_do_not_create_a_second_attachment_send(self):
        citation = Path(self.temp.name) / "design.md"
        citation.write_text("design evidence\n", encoding="utf-8")
        paths, text = self.adapter.extract_local_files(
            f"1. 结论（[技术设计文档]({citation}:92)）"
        )
        self.assertEqual(len(paths), 1)
        self.assertIn("结论", text)
        self.assertEqual(self.adapter.filter_local_delivery_paths(paths), [])
        self.assertEqual(
            self.adapter.filter_media_delivery_paths([(str(citation), False)]),
            [(str(citation.resolve()), False)],
        )

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addAsyncCleanup(asyncio.to_thread, self.temp.cleanup)
        self.bridge = FakeBridge()
        self.router = FakeRouter(self.temp.name)
        self.adapter = DwsPersonalAdapter(
            PlatformConfig(
                enabled=True,
                extra={
                    "allowed_users": ["trusted-user"],
                    "allowed_groups": ["trusted-group"],
                    "toolsets": ["coding"],
                    "bundle_quiet_ms": 0,
                },
            ),
            bridge=self.bridge,
            router=self.router,
        )
        self.events = []
        self.principals = []
        self.workspaces = []

        async def handler(event):
            self.events.append(event)
            self.principals.append(current_routed_principal_id())
            self.workspaces.append(str(resolve_agent_cwd()))
            return None

        self.adapter.set_message_handler(handler)
        self.assertTrue(await self.adapter.connect())

    async def asyncTearDown(self):
        await self.adapter.disconnect()

    async def test_startup_releases_buffer_before_requesting_reconcile(self):
        await asyncio.sleep(0.3)
        self.assertEqual(self.bridge.startup_releases, 1)
        self.assertEqual(self.bridge.reconciles, 1)

    async def test_direct_message_becomes_hermes_event_and_keeps_identity(self):
        context_path = str((Path(self.temp.name) / "state" / "work-contexts.json").resolve())
        with patch.dict(os.environ, {"FOURSDAY_WORK_CONTEXT_FILE": context_path}):
            await self.bridge.emit({
                "id": "message-1",
                "senderUserId": "trusted-user",
                "senderName": "娜娜老师",
                "senderOpenDingTalkId": "open-trusted",
                "conversationId": "direct-1",
                "content": "2.2目前生产了多少试题？",
                "createTime": "2026-08-18T14:00:00+08:00",
                "chatType": "direct",
                "mentionedSelf": False,
                "isSelf": False,
                "detectedAt": "2026-08-18T14:00:01.200+08:00",
                "detectionLatencyMs": 1200,
                "wakeSource": "dws_event",
                "taskBoundary": {
                    "intent": "new_task",
                    "source": "codex",
                    "confidence": 0.93,
                },
            })
        await asyncio.sleep(0)
        self.assertEqual(len(self.events), 1)
        event = self.events[0]
        self.assertTrue(event.text.startswith("2.2目前生产了多少试题？\n\n<!-- foursday-context:"))
        self.assertEqual(event.source.platform.value, "dws_personal")
        self.assertEqual(event.source.chat_id, "direct-1")
        self.assertEqual(event.source.user_id, "trusted-user")
        self.assertEqual(event.source.user_id_alt, "open-trusted")
        self.assertEqual(event.message_id, "message-1")
        self.assertEqual(event.metadata["task_boundary"]["intent"], "new_task")
        self.assertFalse(hasattr(event.source, "workspace_path"))
        self.assertIn("单词 2.2", event.channel_prompt)
        token_match = re.search(r"fctx_[a-f0-9]{64}", event.channel_prompt)
        self.assertIsNotNone(token_match)
        contexts = json.loads(Path(context_path).read_text(encoding="utf-8"))["contexts"]
        self.assertEqual(contexts[token_match.group(0)]["projectId"], "vocab_2_2")
        self.assertIn("单词 2.2", contexts[token_match.group(0)]["projectContext"])
        self.assertEqual(contexts[token_match.group(0)]["memoryContext"], "")
        self.assertEqual(contexts[token_match.group(0)]["requesterRole"], "trusted")
        self.assertEqual(
            contexts[token_match.group(0)]["responseDuty"]["decision"],
            "action_required",
        )
        self.assertEqual(event.metadata["response_duty"]["source"], "codex")
        self.assertEqual(contexts[token_match.group(0)]["providedDingtalkSources"], [])
        self.assertRegex(contexts[token_match.group(0)]["sourcePrincipalHandle"], r"^[a-f0-9]{64}$")
        self.assertNotIn("trusted-user", json.dumps(contexts))
        self.assertEqual(Path(context_path).stat().st_mode & 0o077, 0)
        self.assertEqual(self.router.calls[0]["session_key"], "direct-1:trusted-user")
        self.assertEqual(self.adapter.toolsets_for_source(event.source), ["coding"])
        self.assertEqual(self.principals, ["trusted-user"])
        self.assertEqual(len(self.workspaces), 1)
        self.assertEqual(Path(self.workspaces[0]).resolve(), Path(self.temp.name).resolve())
        self.assertIsNone(current_routed_principal_id())
        self.assertTrue(event.source.role_authorized)
        self.assertEqual(self.bridge.claimed[-1], {
            "conversationId": "direct-1",
            "messageId": "message-1",
            "sourceMessageIds": ["message-1"],
            "ownerRevision": 0,
            "sendGeneration": 0,
        })
        self.assertEqual(self.bridge.released, [])
        self.assertEqual(self.bridge.settled[-1], {
            "conversationId": "direct-1",
            "messageId": "message-1",
        })

    async def test_owner_message_links_become_private_ephemeral_sources(self):
        context_path = str((Path(self.temp.name) / "state-owner-link" / "work-contexts.json").resolve())
        link = "https://alidocs.dingtalk.com/i/nodes/OWNERPROVIDEDDOCNODE123456789012?utm_scene=team_space"
        with patch.dict(os.environ, {
            "FOURSDAY_WORK_CONTEXT_FILE": context_path,
            "DINGTALK_SELF_USER_ID": "trusted-user",
        }):
            await self.bridge.emit({
                "id": "owner-link-message",
                "senderUserId": "trusted-user",
                "senderName": "Owner",
                "senderOpenDingTalkId": "open-owner",
                "conversationId": "owner-self-chat",
                "content": f"请读取这份正本：{link}",
                "createTime": "2026-08-26T12:14:45+08:00",
                "chatType": "direct",
                "mentionedSelf": False,
                "isSelf": False,
            })
        await asyncio.sleep(0)
        event = self.events[-1]
        token = re.search(r"fctx_[a-f0-9]{64}", event.channel_prompt).group(0)
        context = json.loads(Path(context_path).read_text(encoding="utf-8"))["contexts"][token]
        self.assertEqual(context["projectId"], "shared_link")
        self.assertEqual(context["requesterRole"], "owner")
        self.assertEqual(len(context["providedDingtalkSources"]), 1)
        source = context["providedDingtalkSources"][0]
        self.assertEqual(source["sourceId"], "provided_1")
        self.assertEqual(source["nodeId"], "OWNERPROVIDEDDOCNODE123456789012")
        self.assertEqual(source["requesterRole"], "owner")
        self.assertRegex(source["messageHash"], r"^[a-f0-9]{64}$")
        self.assertNotIn("utm_scene", json.dumps(context))
        self.assertNotIn("alidocs.dingtalk.com", json.dumps(context))
        self.assertIn("Never probe, install or call dws", event.channel_prompt)
        self.assertNotIn("owner-self-chat:trusted-user", self.router.cleared)
        self.assertIn("prior primary scope was none", event.channel_prompt)

    async def test_enterprise_verified_sender_enters_without_explicit_user_allowlist(self):
        await self.adapter.disconnect()
        self.bridge = FakeBridge()
        self.adapter = DwsPersonalAdapter(
            PlatformConfig(enabled=True, extra={
                "allowed_users": ["owner-user"],
                "enterprise_users": True,
                "bundle_quiet_ms": 0,
            }),
            bridge=self.bridge,
            router=self.router,
        )
        self.events = []
        self.adapter.set_message_handler(lambda event: self._capture(event))
        self.assertTrue(await self.adapter.connect())
        context_path = str((Path(self.temp.name) / "state-enterprise" / "work-contexts.json").resolve())
        base = {
            "senderUserId": "enterprise-user",
            "senderName": "Enterprise user",
            "senderOpenDingTalkId": "open-enterprise",
            "conversationId": "enterprise-direct",
            "content": "请读取 https://alidocs.dingtalk.com/i/nodes/ENTERPRISEDOCNODE123456789012345",
            "createTime": "2026-08-26T14:00:00+08:00",
            "chatType": "direct",
            "mentionedSelf": False,
            "isSelf": False,
        }
        class AuthorizationProbe(GatewayAuthorizationMixin):
            pass

        probe = AuthorizationProbe()
        probe.adapters = {self.adapter.platform: self.adapter}
        probe._profile_adapters = {}
        probe.pairing_store = None
        probe.pairing_stores = {}
        unverified_source = self.adapter.build_source(
            chat_id="enterprise-direct",
            chat_type="dm",
            user_id="enterprise-user",
            user_name="Enterprise user",
        )
        self.assertFalse(unverified_source.role_authorized)
        with patch.dict(os.environ, {
            "GATEWAY_ALLOWED_USERS": "",
            "GATEWAY_ALLOW_ALL_USERS": "",
            "DWS_PERSONAL_ALLOWED_USERS": "",
        }):
            self.assertFalse(probe._is_user_authorized(unverified_source))
        with patch.dict(os.environ, {"FOURSDAY_WORK_CONTEXT_FILE": context_path}):
            await self.bridge.emit({**base, "id": "unverified-enterprise", "enterpriseVerified": False})
            await self.bridge.emit({**base, "id": "verified-enterprise", "enterpriseVerified": True})
        await asyncio.sleep(0)
        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.events[0].source.user_id, "enterprise-user")
        self.assertEqual(self.events[0].metadata["enterprise_verified"], True)
        token = re.search(r"fctx_[a-f0-9]{64}", self.events[0].channel_prompt).group(0)
        context = json.loads(Path(context_path).read_text(encoding="utf-8"))["contexts"][token]
        self.assertEqual(context["projectId"], "shared_link")
        self.assertEqual(context["requesterRole"], "trusted")
        self.assertEqual(context["providedDingtalkSources"][0]["sourceId"], "provided_1")
        self.assertEqual(context["providedDingtalkSources"][0]["nodeId"], "ENTERPRISEDOCNODE123456789012345")
        self.assertTrue(self.events[0].source.role_authorized)

        probe.adapters = {self.events[0].source.platform: self.adapter}
        with patch.dict(os.environ, {
            "GATEWAY_ALLOWED_USERS": "",
            "GATEWAY_ALLOW_ALL_USERS": "",
            "DWS_PERSONAL_ALLOWED_USERS": "",
        }):
            self.assertTrue(probe._is_user_authorized(self.events[0].source))

    async def test_gateway_authorization_is_event_scoped_and_not_persisted(self):
        source = self.adapter.build_source(
            chat_id="future-direct",
            chat_type="dm",
            user_id="trusted-user",
            user_name="Trusted",
        )
        self.assertFalse(source.role_authorized)
        await self.adapter.disconnect()
        next_source = self.adapter.build_source(
            chat_id="future-direct",
            chat_type="dm",
            user_id="trusted-user",
            user_name="Trusted",
        )
        self.assertFalse(next_source.role_authorized)

    async def test_enterprise_link_only_message_uses_isolated_unrouted_context(self):
        await self.adapter.disconnect()
        self.bridge = FakeBridge()
        router = SimpleNamespace(
            fallback_workspace=self.temp.name,
            clear_binding=lambda _session_key: None,
            route=lambda **_kwargs: FakeRoute(
                workspace_path=self.temp.name,
                context="No project was identified. Read only the provided source before asking for a project.",
                project=None,
            ),
        )
        self.adapter = DwsPersonalAdapter(
            PlatformConfig(enabled=True, extra={
                "allowed_users": ["owner-user"],
                "enterprise_users": True,
                "bundle_quiet_ms": 0,
            }),
            bridge=self.bridge,
            router=router,
        )
        self.events = []
        self.adapter.set_message_handler(lambda event: self._capture(event))
        self.assertTrue(await self.adapter.connect())
        context_path = str((Path(self.temp.name) / "state-unrouted-link" / "work-contexts.json").resolve())
        with patch.dict(os.environ, {"FOURSDAY_WORK_CONTEXT_FILE": context_path}):
            await self.bridge.emit({
                "id": "enterprise-link-only",
                "senderUserId": "enterprise-user",
                "senderName": "Enterprise user",
                "senderOpenDingTalkId": "open-enterprise",
                "conversationId": "enterprise-new-conversation",
                "content": "https://alidocs.dingtalk.com/i/nodes/ENTERPRISEDOCNODE123456789012345",
                "createTime": "2026-08-26T14:05:00+08:00",
                "chatType": "direct",
                "mentionedSelf": False,
                "isSelf": False,
                "enterpriseVerified": True,
            })
        await asyncio.sleep(0)
        self.assertEqual(len(self.events), 1)
        token = re.search(r"fctx_[a-f0-9]{64}", self.events[0].channel_prompt).group(0)
        context = json.loads(Path(context_path).read_text(encoding="utf-8"))["contexts"][token]
        self.assertEqual(context["projectId"], "shared_link")
        self.assertEqual(Path(context["workspace"]).resolve(), Path(self.temp.name).resolve())
        self.assertEqual(context["providedDingtalkSources"][0]["sourceId"], "provided_1")
        with patch.dict(os.environ, {"FOURSDAY_WORK_CONTEXT_FILE": context_path}):
            await self.bridge.emit({
                "id": "enterprise-link-followup",
                "senderUserId": "enterprise-user",
                "senderName": "Enterprise user",
                "senderOpenDingTalkId": "open-enterprise",
                "conversationId": "enterprise-new-conversation",
                "content": "继续概括这份文档",
                "createTime": "2026-08-26T14:05:30+08:00",
                "chatType": "direct",
                "mentionedSelf": False,
                "isSelf": False,
                "enterpriseVerified": True,
            })
        await asyncio.sleep(0.1)
        self.assertEqual(len(self.events), 2)
        followup_token = re.search(
            r"fctx_[a-f0-9]{64}", self.events[-1].channel_prompt,
        ).group(0)
        followup_context = json.loads(
            Path(context_path).read_text(encoding="utf-8")
        )["contexts"][followup_token]
        self.assertEqual(
            followup_context["providedDingtalkSources"][0]["nodeId"],
            "ENTERPRISEDOCNODE123456789012345",
        )

    def test_link_extraction_is_exact_bounded_and_deduplicated(self):
        link = "https://alidocs.dingtalk.com/i/nodes/OWNERPROVIDEDDOCNODE123456789012"
        sources = _provided_dingtalk_sources(
            f"{link}?a=1 {link}?a=2 https://example.com/i/nodes/OTHERDOCNODE1234567890123456",
            message_ids=["message-1"],
            requester_role="owner",
        )
        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0]["nodeId"], "OWNERPROVIDEDDOCNODE123456789012")
        self.assertEqual(sources[0]["requesterRole"], "owner")
        many = " ".join(
            f"https://alidocs.dingtalk.com/i/nodes/BOUNDEDDOCUMENTNODE1234567890{index}"
            for index in range(8)
        )
        bounded = _provided_dingtalk_sources(
            many,
            message_ids=["message-2"],
            requester_role="trusted",
        )
        self.assertEqual(len(bounded), 4)
        self.assertEqual([item["sourceId"] for item in bounded], [
            "provided_1", "provided_2", "provided_3", "provided_4",
        ])

    async def test_current_runtime_status_injects_live_snapshot_and_skips_stale_memory(self):
        await self.adapter.disconnect()
        self.bridge = FakeBridge()
        self.adapter = DwsPersonalAdapter(
            PlatformConfig(enabled=True, extra={
                "allowed_users": ["trusted-user"],
                "bundle_quiet_ms": 0,
            }),
            bridge=self.bridge,
            router=self.router,
            memory=FakeMemory(),
        )
        self.adapter.set_message_handler(lambda event: self._capture(event))
        self.assertTrue(await self.adapter.connect())
        canonical_temp = Path(self.temp.name).resolve()
        release_path = canonical_temp / "foursday-release.json"
        state_path = canonical_temp / "dws.json"
        release_sha = "a" * 40
        release_path.write_text(json.dumps({
            "schema": "foursday-profile-release/v1",
            "foursdayVersion": "0.8.0-rc.1",
            "foursdayCommit": release_sha,
        }), encoding="utf-8")
        state_path.write_text(json.dumps({
            "sendBlocked": False,
            "eventWake": {"ready": True},
        }), encoding="utf-8")
        release_path.chmod(0o600)
        state_path.chmod(0o600)
        with patch.dict(os.environ, {
            "FOURSDAY_PROFILE_RELEASE_FILE": str(release_path),
            "FOURSDAY_RELEASE_SHA": release_sha,
            "FOURSDAY_MODE": "shadow",
            "DWS_PERSONAL_SEND_ENABLED": "false",
            "DWS_PERSONAL_STATE_FILE": str(state_path),
        }):
            await self.bridge.emit({
                "id": "status-message",
                "senderUserId": "trusted-user",
                "senderName": "娜娜老师",
                "senderOpenDingTalkId": "open-trusted",
                "conversationId": "status-conversation",
                "content": "Foursday 当前版本、模式和真实发送状态是什么？",
                "createTime": "2026-08-25T11:15:36+08:00",
                "chatType": "direct",
                "mentionedSelf": False,
                "isSelf": False,
            })
        await asyncio.sleep(0)
        event = self.events[-1]
        self.assertIn('"source":"live_profile"', event.channel_prompt)
        self.assertIn('"version":"0.8.0-rc.1"', event.channel_prompt)
        self.assertIn('"mode":"shadow"', event.channel_prompt)
        self.assertIn('"sendEnabled":false', event.channel_prompt)
        self.assertIn("Do not call tools for these fields", event.channel_prompt)
        self.assertNotIn("长期项目背景", event.channel_prompt)
        self.assertEqual(event.metadata["personal_memory_status"], "skipped_live_status")

    async def test_outbound_markdown_is_rendered_as_stable_dingtalk_plain_text(self):
        receipt = await self.adapter.send(
            "direct-1",
            "当前状态：\n\n- 版本：`v1`\n- 模式：**active**\n- 发送：`true`",
            metadata={
                "foursday_owner_revision": 0,
                "foursday_send_generation": 1,
            },
        )
        self.assertTrue(receipt.success)
        self.assertEqual(
            self.bridge.sent[-1]["content"],
            "当前状态：\n\n• 版本：v1\n• 模式：active\n• 发送：true",
        )

    async def test_startup_events_are_released_after_adapter_connects(self):
        await self.adapter.disconnect()
        record = {
            "id": "startup-message",
            "senderUserId": "trusted-user",
            "senderName": "娜娜老师",
            "senderOpenDingTalkId": "open-trusted",
            "conversationId": "startup-conversation",
            "content": "启动回放",
            "createTime": "2026-08-18T14:00:00+08:00",
            "chatType": "direct",
            "mentionedSelf": False,
            "isSelf": False,
        }
        self.bridge = BufferedFakeBridge(record)
        self.adapter = DwsPersonalAdapter(
            PlatformConfig(enabled=True, extra={
                "allowed_users": ["trusted-user"],
                "bundle_quiet_ms": 0,
            }),
            bridge=self.bridge,
            router=self.router,
        )
        self.adapter.set_message_handler(lambda event: self._capture(event))
        self.assertTrue(await self.adapter.connect())
        self.assertFalse(self.bridge.released)
        await asyncio.sleep(0.3)
        self.assertTrue(self.bridge.released)
        self.assertEqual(self.events[-1].text, "启动回放")

    async def test_image_attachment_reaches_hermes_event_and_private_work_context(self):
        context_path = str((Path(self.temp.name) / "state-image" / "work-contexts.json").resolve())
        image = Path(self.temp.name) / "downloaded.png"
        image.write_bytes(b"\x89PNG\r\n\x1a\n")
        image.chmod(0o600)
        with patch.dict(os.environ, {"FOURSDAY_WORK_CONTEXT_FILE": context_path}):
            await self.bridge.emit({
                "id": "message-image",
                "senderUserId": "trusted-user",
                "senderName": "娜娜老师",
                "senderOpenDingTalkId": "open-trusted",
                "conversationId": "direct-image",
                "content": "",
                "attachments": [{
                    "path": str(image.resolve()),
                    "name": "question.png",
                    "mimeType": "image/png",
                }],
                "createTime": "2026-08-18T14:00:00+08:00",
                "chatType": "direct",
                "mentionedSelf": False,
                "isSelf": False,
            })
        await asyncio.sleep(0)
        self.assertEqual(len(self.events), 1)
        event = self.events[0]
        self.assertEqual(event.message_type.value, "photo")
        self.assertEqual(event.media_urls, [str(image.resolve())])
        self.assertEqual(event.media_types, ["image/png"])
        token = re.search(r"fctx_[a-f0-9]{64}", event.text).group(0)
        context = json.loads(Path(context_path).read_text(encoding="utf-8"))["contexts"][token]
        self.assertEqual(context["attachments"][0]["path"], str(image.resolve()))
        self.assertEqual(context["attachments"][0]["mimeType"], "image/png")

    async def test_unknown_user_and_unmentioned_group_are_dropped(self):
        base = {
            "senderName": "外部人员",
            "senderOpenDingTalkId": "open-external",
            "content": "执行项目工作",
            "createTime": "2026-08-18T14:00:00+08:00",
            "isSelf": False,
        }
        await self.bridge.emit({
            **base,
            "id": "message-2",
            "senderUserId": "unknown-user",
            "conversationId": "direct-2",
            "chatType": "direct",
            "mentionedSelf": False,
        })
        await self.bridge.emit({
            **base,
            "id": "message-3",
            "senderUserId": "trusted-user",
            "conversationId": "trusted-group",
            "chatType": "group",
            "mentionedSelf": False,
        })
        await asyncio.sleep(0)
        self.assertEqual(self.events, [])

    async def test_group_mention_and_personal_send_receipt(self):
        await self.bridge.emit({
            "id": "message-4",
            "senderUserId": "trusted-user",
            "senderName": "娜娜老师",
            "senderOpenDingTalkId": "open-trusted",
            "conversationId": "trusted-group",
            "content": "请核对2.2项目",
            "createTime": "2026-08-18T14:00:00+08:00",
            "chatType": "group",
            "mentionedSelf": True,
            "isSelf": False,
        })
        await asyncio.sleep(0)
        self.assertEqual(len(self.events), 1)
        receipt = await self.adapter.send(
            "trusted-group",
            "已经核对完成。",
            reply_to="message-4",
            metadata={
                "foursday_owner_revision": 0,
                "foursday_send_generation": 1,
            },
        )
        self.assertTrue(receipt.success)
        self.assertEqual(receipt.message_id, "sent-1")
        self.assertEqual(self.bridge.sent[0]["conversationId"], "trusted-group")
        self.assertEqual(self.bridge.sent[0]["content"], "已经核对完成。")
        self.assertEqual(self.bridge.claimed[-1]["messageId"], "message-4")
        self.assertEqual(self.bridge.released[-1], {
            "conversationId": "trusted-group",
            "messageId": "message-4",
        })
        self.assertTrue(self.events[0].source.role_authorized)

        class AuthorizationProbe(GatewayAuthorizationMixin):
            pass

        probe = AuthorizationProbe()
        probe.adapters = {self.events[0].source.platform: self.adapter}
        probe._profile_adapters = {}
        probe.pairing_store = None
        probe.pairing_stores = {}
        with patch.dict(os.environ, {
            "GATEWAY_ALLOWED_USERS": "",
            "GATEWAY_ALLOW_ALL_USERS": "",
            "DWS_PERSONAL_ALLOWED_USERS": "",
        }):
            self.assertTrue(probe._is_user_authorized(self.events[0].source))

    async def test_interim_background_ack_keeps_responsibility_for_final_delivery(self):
        await self.bridge.emit({
            "id": "message-background-ack",
            "senderUserId": "trusted-user",
            "senderName": "请求人",
            "senderOpenDingTalkId": "open-trusted",
            "conversationId": "background-conversation",
            "content": "请完成一个长任务",
            "createTime": "2026-09-01T13:00:00+08:00",
            "chatType": "direct",
            "mentionedSelf": False,
            "isSelf": False,
            "ownerRevision": 2,
            "sendGeneration": 4,
        })
        await asyncio.sleep(0.05)
        event = self.events[-1]
        payload = self.adapter._execution_payload(event)
        self.bridge.background["inspect"] = {
            "success": True,
            "shouldAcknowledge": True,
            "acknowledgment": "收到，我先完成分析和验证，整理好结果后再同步。",
            "executionId": payload["executionId"],
        }
        released_before = len(self.bridge.released)
        token = _TURN_DELIVERY_VERSION.set({
            "conversationId": "background-conversation",
            "messageId": "message-background-ack",
            "ownerRevision": 2,
            "sendGeneration": 4,
            "executionId": payload["executionId"],
            "backgroundExecution": False,
        })
        try:
            self.assertTrue(await self.adapter._ensure_background_ack(event))
        finally:
            _TURN_DELIVERY_VERSION.reset(token)
        self.assertEqual(len(self.bridge.released), released_before)
        sent = self.bridge.sent[-1]
        self.assertEqual(sent["metadata"]["foursday_delivery_kind"], "interim_ack")
        self.assertEqual(sent["metadata"]["foursday_execution_id"], payload["executionId"])
        self.assertEqual(self.bridge.background_calls[-1][0], "acknowledge")

    async def test_internal_background_event_reuses_the_same_session_without_user_dedupe(self):
        base = {
            "id": "message-background-resume",
            "senderUserId": "trusted-user",
            "senderName": "请求人",
            "senderOpenDingTalkId": "open-trusted",
            "conversationId": "background-resume-conversation",
            "content": "请完成多步骤分析",
            "createTime": "2026-09-01T13:10:00+08:00",
            "chatType": "direct",
            "mentionedSelf": False,
            "isSelf": False,
            "ownerRevision": 3,
            "sendGeneration": 7,
        }
        await self.bridge.emit(base)
        await asyncio.sleep(0.05)
        first_count = len(self.events)
        task_id = hashlib.sha256(
            b"background-resume-conversation:trusted-user"
        ).hexdigest()
        execution_id = hashlib.sha256(
            f"{task_id}\0{3}\0{7}".encode("utf-8")
        ).hexdigest()
        await self.bridge.emit({
            **base,
            "content": "Continue the durable Foursday task in this same Codex Thread.",
            "internalBackground": True,
            "taskId": task_id,
            "executionId": execution_id,
            "wakeSource": "background",
        })
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.events), first_count + 1)
        resumed = self.events[-1]
        self.assertTrue(resumed.metadata["background_execution"])
        self.assertEqual(resumed.metadata["task_id"], task_id)
        self.assertEqual(resumed.metadata["execution_id"], execution_id)
        self.assertIn("Continue the durable Foursday task", resumed.text)

    async def test_failed_processing_releases_responsibility_without_sending(self):
        await self.bridge.emit({
            "id": "message-failed",
            "senderUserId": "trusted-user",
            "senderName": "娜娜老师",
            "senderOpenDingTalkId": "open-trusted",
            "conversationId": "direct-failed",
            "content": "请处理这个任务",
            "createTime": "2026-08-18T14:00:00+08:00",
            "chatType": "direct",
            "mentionedSelf": False,
            "isSelf": False,
        })
        await asyncio.sleep(0)
        event = self.events[-1]
        await self.adapter.on_processing_complete(event, ProcessingOutcome.FAILURE)
        self.assertEqual(self.bridge.released[-1], {
            "conversationId": "direct-failed",
            "messageId": "message-failed",
        })
        self.assertEqual(self.bridge.sent, [])

    async def test_project_memory_is_private_context_not_a_second_message(self):
        await self.adapter.disconnect()
        self.adapter = DwsPersonalAdapter(
            PlatformConfig(
                enabled=True,
                extra={"allowed_users": ["trusted-user"], "bundle_quiet_ms": 0},
            ),
            bridge=self.bridge,
            router=self.router,
            memory=FakeMemory(),
        )
        self.adapter.set_message_handler(lambda event: self._capture(event))
        self.assertTrue(await self.adapter.connect())
        context_path = str((Path(self.temp.name) / "state-memory" / "work-contexts.json").resolve())
        with patch.dict(os.environ, {"FOURSDAY_WORK_CONTEXT_FILE": context_path}):
            await self.bridge.emit({
                "id": "message-memory",
                "senderUserId": "trusted-user",
                "senderName": "娜娜老师",
                "senderOpenDingTalkId": "open-trusted",
                "conversationId": "direct-memory",
                "content": "2.2现在怎么样？",
                "createTime": "2026-08-18T14:00:00+08:00",
                "chatType": "direct",
                "mentionedSelf": False,
                "isSelf": False,
            })
        await asyncio.sleep(0)
        self.assertIn("gbrain:projects/51t-word-2-2", self.events[-1].channel_prompt)
        self.assertEqual(self.events[-1].metadata["personal_memory_status"], "available")
        token = re.search(r"fctx_[a-f0-9]{64}", self.events[-1].channel_prompt).group(0)
        contexts = json.loads(Path(context_path).read_text(encoding="utf-8"))["contexts"]
        self.assertIn("长期项目背景", contexts[token]["memoryContext"])

    async def _capture(self, event):
        self.events.append(event)

    async def test_nearby_messages_are_bundled_before_one_agent_turn(self):
        await self.adapter.disconnect()
        self.bridge = FakeBridge()
        self.adapter = DwsPersonalAdapter(
            PlatformConfig(enabled=True, extra={
                "allowed_users": ["trusted-user"],
                "bundle_quiet_ms": 20,
                "bundle_max_wait_ms": 2_000,
            }),
            bridge=self.bridge,
            router=self.router,
        )
        self.adapter.set_message_handler(lambda event: self._capture(event))
        self.assertTrue(await self.adapter.connect())
        base = {
            "senderUserId": "trusted-user",
            "senderName": "娜娜老师",
            "senderOpenDingTalkId": "open-trusted",
            "conversationId": "direct-bundle",
            "chatType": "direct",
            "mentionedSelf": False,
            "isSelf": False,
        }
        await self.bridge.emit({
            **base,
            "id": "bundle-1",
            "content": "我看2.2试题已经生产了一批",
            "createTime": "2026-08-18T14:00:00+08:00",
        })
        await self.bridge.emit({
            **base,
            "id": "bundle-2",
            "content": "帮我核对目前总量",
            "createTime": "2026-08-18T14:00:01+08:00",
        })
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.events), 1)
        self.assertEqual(
            self.events[0].text,
            "我看2.2试题已经生产了一批\n帮我核对目前总量",
        )
        self.assertEqual(self.events[0].metadata["bundle_size"], 2)
        self.assertEqual(
            self.events[0].metadata["source_message_ids"],
            ["bundle-1", "bundle-2"],
        )

    async def test_one_startup_reconcile_semantically_groups_messages_despite_source_gap(self):
        await self.adapter.disconnect()
        self.bridge = FakeBridge()
        self.adapter = DwsPersonalAdapter(
            PlatformConfig(enabled=True, extra={
                "allowed_users": ["trusted-user"],
                "bundle_quiet_ms": 20,
                "bundle_max_wait_ms": 2_000,
            }),
            bridge=self.bridge,
            router=self.router,
        )
        self.events = []
        self.adapter.set_message_handler(lambda event: self._capture(event))
        self.assertTrue(await self.adapter.connect())
        base = {
            "senderUserId": "trusted-user",
            "senderName": "娜娜老师",
            "senderOpenDingTalkId": "open-trusted",
            "conversationId": "direct-startup-replay",
            "chatType": "direct",
            "mentionedSelf": False,
            "isSelf": False,
            "detectedAt": "2026-08-28T08:00:00Z",
            "wakeSource": "startup",
        }
        await self.bridge.emit({
            **base,
            "id": "startup-1",
            "content": "先说明背景",
            "createTime": "2026-08-28T07:18:27Z",
        })
        await self.bridge.emit({
            **base,
            "id": "startup-2",
            "content": "再给出同一任务的具体要求",
            "createTime": "2026-08-28T07:19:06Z",
        })
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.events[0].metadata["bundle_size"], 2)
        self.assertEqual(
            self.events[0].metadata["source_message_ids"],
            ["startup-1", "startup-2"],
        )
        self.assertEqual(self.bridge.grouped[-1]["messages"][1]["id"], "startup-2")

    async def test_codex_grouping_splits_independent_tasks_and_claims_each_anchor(self):
        await self.adapter.disconnect()
        self.bridge = FakeBridge()
        self.bridge.group_result = {
            "success": True,
            "groups": [[0], [1]],
            "source": "codex",
            "confidence": 0.99,
        }
        self.adapter = DwsPersonalAdapter(
            PlatformConfig(enabled=True, extra={
                "allowed_users": ["trusted-user"],
                "bundle_quiet_ms": 20,
                "bundle_max_wait_ms": 2_000,
            }),
            bridge=self.bridge,
            router=self.router,
        )
        self.events = []
        self.adapter.set_message_handler(lambda event: self._capture(event))
        self.assertTrue(await self.adapter.connect())
        base = {
            "senderUserId": "trusted-user",
            "senderName": "娜娜老师",
            "senderOpenDingTalkId": "open-trusted",
            "conversationId": "direct-two-tasks",
            "chatType": "direct",
            "mentionedSelf": False,
            "isSelf": False,
        }
        await self.bridge.emit({
            **base,
            "id": "task-a",
            "content": "请核对单词2.2试题数量",
            "createTime": "2026-08-18T14:00:00+08:00",
        })
        await self.bridge.emit({
            **base,
            "id": "task-b",
            "content": "另外请整理Foursday发布说明",
            "createTime": "2026-08-18T14:00:01+08:00",
        })
        for _ in range(100):
            if len(self.events) == 2:
                break
            await asyncio.sleep(0.01)
        self.assertEqual([event.text for event in self.events], [
            "请核对单词2.2试题数量",
            "另外请整理Foursday发布说明",
        ])
        self.assertEqual([event.message_id for event in self.events], ["task-a", "task-b"])
        self.assertEqual([claim["messageId"] for claim in self.bridge.claimed[-2:]], [
            "task-a", "task-b",
        ])

    async def test_file_message_and_followup_text_share_one_context_attachment(self):
        await self.adapter.disconnect()
        self.bridge = FakeBridge()
        self.adapter = DwsPersonalAdapter(
            PlatformConfig(enabled=True, extra={
                "allowed_users": ["trusted-user"],
                "bundle_quiet_ms": 20,
                "bundle_max_wait_ms": 2_000,
            }),
            bridge=self.bridge,
            router=self.router,
        )
        self.adapter.set_message_handler(lambda event: self._capture(event))
        self.assertTrue(await self.adapter.connect())
        context_path = str((Path(self.temp.name) / "state-file" / "work-contexts.json").resolve())
        attachment = Path(self.temp.name).resolve() / "downloaded.txt"
        attachment.write_text("verified attachment\n", encoding="utf-8")
        attachment.chmod(0o600)
        base = {
            "senderUserId": "trusted-user",
            "senderName": "娜娜老师",
            "senderOpenDingTalkId": "open-trusted",
            "conversationId": "direct-file-bundle",
            "chatType": "direct",
            "mentionedSelf": False,
            "isSelf": False,
        }
        with patch.dict(os.environ, {"FOURSDAY_WORK_CONTEXT_FILE": context_path}):
            await self.bridge.emit({
                **base,
                "id": "file-bundle-1",
                "content": "[文件] downloaded.txt",
                "attachments": [{
                    "path": str(attachment),
                    "name": "downloaded.txt",
                    "mimeType": "text/plain",
                }],
                "createTime": "2026-08-18T14:00:00+08:00",
            })
            await self.bridge.emit({
                **base,
                "id": "file-bundle-2",
                "content": "读取并概括这个附件",
                "createTime": "2026-08-18T14:00:01+08:00",
            })
            await asyncio.sleep(0.05)
        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.events[0].metadata["bundle_size"], 2)
        token = re.search(r"fctx_[a-f0-9]{64}", self.events[0].text).group(0)
        context = json.loads(Path(context_path).read_text(encoding="utf-8"))["contexts"][token]
        self.assertEqual(len(context["attachments"]), 1)
        self.assertEqual(context["attachments"][0]["name"], "downloaded.txt")
        self.assertEqual(context["attachments"][0]["path"], str(attachment))

    async def test_followup_bundle_is_not_stranded_while_first_agent_turn_runs(self):
        await self.adapter.disconnect()
        self.bridge = FakeBridge()
        self.adapter = DwsPersonalAdapter(
            PlatformConfig(enabled=True, extra={
                "allowed_users": ["trusted-user"],
                "bundle_quiet_ms": 20,
                "bundle_max_wait_ms": 8_000,
            }),
            bridge=self.bridge,
            router=self.router,
        )
        first_started = asyncio.Event()
        release_first = asyncio.Event()
        followup_delivered = asyncio.Event()

        async def blocking_handler(event):
            self.events.append(event)
            if event.text == "第一句":
                first_started.set()
                await release_first.wait()
            else:
                followup_delivered.set()

        self.adapter.set_message_handler(blocking_handler)
        self.assertTrue(await self.adapter.connect())
        base = {
            "senderUserId": "trusted-user",
            "senderName": "娜娜老师",
            "senderOpenDingTalkId": "open-trusted",
            "conversationId": "direct-running-followup",
            "chatType": "direct",
            "mentionedSelf": False,
            "isSelf": False,
        }
        await self.bridge.emit({
            **base,
            "id": "running-1",
            "content": "第一句",
            "createTime": "2026-08-18T14:00:00+08:00",
        })
        await asyncio.wait_for(first_started.wait(), timeout=1)
        try:
            await self.bridge.emit({
                **base,
                "id": "running-2",
                "content": "第二句",
                "createTime": "2026-08-18T14:00:05+08:00",
            })
            await self.bridge.emit({
                **base,
                "id": "running-3",
                "content": "第三句",
                "createTime": "2026-08-18T14:00:09+08:00",
            })
            await asyncio.sleep(0.05)
            release_first.set()
            await asyncio.wait_for(followup_delivered.wait(), timeout=1)
        finally:
            release_first.set()
            await asyncio.sleep(0)
        self.assertEqual([event.text for event in self.events], [
            "第一句",
            "第二句\n第三句",
        ])
        self.assertEqual(self.events[1].metadata["bundle_size"], 2)

    async def test_queue_mode_rebinds_followup_turn_to_latest_send_generation(self):
        await self.adapter.disconnect()
        self.bridge = GenerationFenceBridge()
        self.bridge.current_generation = 1
        self.adapter = DwsPersonalAdapter(
            PlatformConfig(enabled=True, extra={
                "allowed_users": ["trusted-user"],
                "bundle_quiet_ms": 0,
            }),
            bridge=self.bridge,
            router=self.router,
        )
        self.adapter._busy_text_mode = "queue"
        self.adapter._busy_text_debounce_seconds = 0.01
        self.adapter._busy_text_hard_cap_seconds = 0.02
        first_started = asyncio.Event()
        release_first = asyncio.Event()
        handled = []
        handled_message_ids = []
        handled_metadata = []
        handled_markers = []
        context_path = str((
            Path(self.temp.name) / "state-generation" / "work-contexts.json"
        ).resolve())

        async def generation_handler(event):
            markers = re.findall(r"fctx_[a-f0-9]{64}", event.text)
            visible = re.sub(
                r"\n*<!--\s*foursday-context:fctx_[a-f0-9]{64}\s*-->\s*",
                "",
                event.text,
            ).strip()
            handled.append(visible)
            handled_message_ids.append(event.message_id)
            handled_metadata.append(dict(event.metadata))
            handled_markers.append(markers)
            if visible == "第一句":
                first_started.set()
                await release_first.wait()
                return "旧回复"
            return "最终回复"

        self.adapter.set_message_handler(generation_handler)
        self.assertTrue(await self.adapter.connect())
        base = {
            "senderUserId": "trusted-user",
            "senderName": "娜娜老师",
            "senderOpenDingTalkId": "open-trusted",
            "conversationId": "direct-generation-queue",
            "chatType": "direct",
            "mentionedSelf": False,
            "isSelf": False,
            "ownerRevision": 0,
        }
        with patch.dict(os.environ, {"FOURSDAY_WORK_CONTEXT_FILE": context_path}):
            await self.bridge.emit({
                **base,
                "id": "generation-1",
                "content": "第一句",
                "createTime": "2026-08-25T18:59:39+08:00",
                "sendGeneration": 1,
            })
            await asyncio.wait_for(first_started.wait(), timeout=1)
            try:
                await self.bridge.emit({
                    **base,
                    "id": "generation-2",
                    "content": "第二句",
                    "createTime": "2026-08-25T18:59:42+08:00",
                    "sendGeneration": 2,
                })
                await self.bridge.emit({
                    **base,
                    "id": "generation-3",
                    "content": "第三句",
                    "createTime": "2026-08-25T18:59:46+08:00",
                    "sendGeneration": 3,
                })
                self.bridge.current_generation = 3
                await asyncio.sleep(0.03)
                release_first.set()
                await asyncio.wait_for(self.bridge.final_delivery.wait(), timeout=1)
            finally:
                release_first.set()
                await asyncio.sleep(0)

        self.assertEqual(handled, ["第一句", "第二句\n\n第三句"])
        self.assertEqual(handled_message_ids, ["generation-1", "generation-3"])
        self.assertEqual(handled_metadata[1]["send_generation"], 3)
        self.assertEqual(handled_metadata[1]["bundle_size"], 2)
        self.assertEqual(len(handled_markers[1]), 1)
        contexts = json.loads(Path(context_path).read_text(encoding="utf-8"))["contexts"]
        self.assertEqual(contexts[handled_markers[1][0]]["sendGeneration"], 3)
        self.assertEqual(
            handled_metadata[1]["source_message_ids"],
            ["generation-2", "generation-3"],
        )
        self.assertEqual(
            [payload["sendGeneration"] for payload in self.bridge.sent],
            [1, 3],
        )
        self.assertEqual(
            [payload["content"] for payload in self.bridge.delivered],
            ["最终回复"],
        )
        self.assertIn({
            "conversationId": "direct-generation-queue",
            "messageId": "generation-1",
        }, self.bridge.released)
        self.assertIn({
            "conversationId": "direct-generation-queue",
            "messageId": "generation-3",
        }, self.bridge.released)

    async def test_only_consumed_latest_or_processing_root_can_adopt_newer_generation(self):
        bridge = GenerationFenceBridge()
        bridge.current_generation = 3
        self.adapter._bridge = bridge
        latest = {
            "conversationId": "direct-anchor",
            "messageId": "message-3",
            "ownerRevision": 0,
            "sendGeneration": 3,
            "turnStartedMonotonic": 1.0,
            "detectionLatencyMs": 10,
            "bundleWaitMs": 20,
            "wakeSource": "test",
        }
        self.adapter._latest_delivery_versions["direct-anchor"] = dict(latest)
        consumed = dict(latest)
        delivery_token = _TURN_DELIVERY_VERSION.set({
            "conversationId": "direct-anchor",
            "messageId": "message-1",
            "ownerRevision": 0,
            "sendGeneration": 1,
        })
        consumed_token = _TURN_CONSUMED_DELIVERY_VERSION.set(consumed)
        try:
            exact = await self.adapter.send(
                "direct-anchor", "最终回复", reply_to="message-3"
            )
            self.assertTrue(exact.success)
            self.assertEqual(bridge.sent[-1]["sendGeneration"], 3)

            bridge.current_generation = 4
            latest = {
                "conversationId": "direct-anchor",
                "messageId": "message-4",
                "ownerRevision": 0,
                "sendGeneration": 4,
            }
            self.adapter._latest_delivery_versions["direct-anchor"] = dict(latest)
            old_anchor = await self.adapter.send(
                "direct-anchor", "旧锚点回复", reply_to="message-3"
            )
            empty_anchor = await self.adapter.send(
                "direct-anchor", "空锚点回复"
            )
            wrong_conversation = await self.adapter.send(
                "other-conversation", "错会话回复", reply_to="message-4"
            )
            self.assertTrue(old_anchor.success)
            self.assertTrue(old_anchor.message_id.startswith("suppressed-stale-"))
            self.assertTrue(empty_anchor.success)
            self.assertTrue(empty_anchor.message_id.startswith("suppressed-stale-"))
            self.assertFalse(wrong_conversation.success)

            consumed.clear()
            consumed.update(latest)
            processing_root = await self.adapter.send(
                "direct-anchor",
                "队列最终回复",
                reply_to="message-1",
                metadata={"notify": True},
            )
            self.assertTrue(processing_root.success)
            self.assertEqual(bridge.sent[-1]["sendGeneration"], 4)

            latest = {
                "conversationId": "direct-anchor",
                "messageId": "message-5",
                "ownerRevision": 0,
                "sendGeneration": 5,
            }
            self.adapter._latest_delivery_versions["direct-anchor"] = dict(latest)
            bridge.current_generation = 5
            after_return_race = await self.adapter.send(
                "direct-anchor",
                "处理返回后的旧回复",
                reply_to="message-1",
                metadata={"notify": True},
            )
            self.assertTrue(after_return_race.success)
            self.assertTrue(
                after_return_race.message_id.startswith("suppressed-stale-")
            )

            consumed.clear()
            consumed.update(latest)
            bridge.current_owner_revision = 1
            takeover = await self.adapter.send(
                "direct-anchor",
                "接管后的旧回复",
                reply_to="message-1",
                metadata={"notify": True},
            )
            self.assertTrue(takeover.success)
            self.assertTrue(takeover.message_id.startswith("suppressed-stale-"))
        finally:
            _TURN_CONSUMED_DELIVERY_VERSION.reset(consumed_token)
            _TURN_DELIVERY_VERSION.reset(delivery_token)

        self.assertEqual(
            [
                (payload["ownerRevision"], payload["sendGeneration"])
                for payload in bridge.sent
            ],
            [(0, 3), (0, 1), (0, 1), (0, 4), (0, 1), (0, 5)],
        )
        self.assertEqual(
            [payload["content"] for payload in bridge.delivered],
            ["最终回复", "队列最终回复"],
        )

    async def test_messages_beyond_source_max_wait_become_sequential_session_turns(self):
        await self.adapter.disconnect()
        self.bridge = FakeBridge()
        self.adapter = DwsPersonalAdapter(
            PlatformConfig(enabled=True, extra={
                "allowed_users": ["trusted-user"],
                "bundle_quiet_ms": 20,
                "bundle_max_wait_ms": 100,
            }),
            bridge=self.bridge,
            router=self.router,
        )
        self.adapter.set_message_handler(lambda event: self._capture(event))
        self.assertTrue(await self.adapter.connect())
        base = {
            "senderUserId": "trusted-user",
            "senderName": "娜娜老师",
            "senderOpenDingTalkId": "open-trusted",
            "conversationId": "direct-followup",
            "chatType": "direct",
            "mentionedSelf": False,
            "isSelf": False,
        }
        await self.bridge.emit({
            **base,
            "id": "followup-1",
            "content": "第一句",
            "createTime": "2026-08-18T14:00:00+08:00",
        })
        await self.bridge.emit({
            **base,
            "id": "followup-2",
            "content": "三十秒后的第二句",
            "createTime": "2026-08-18T14:00:30+08:00",
        })
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.events), 2)
        self.assertEqual(self.events[0].text, "第一句")
        self.assertEqual(self.events[1].text, "三十秒后的第二句")
        self.assertEqual(
            self.router.calls[0]["session_key"],
            self.router.calls[1]["session_key"],
        )

    async def test_task_takeover_interrupts_active_session_and_emits_audit_event(self):
        interrupted = []
        audited = []

        async def interrupt(session_key, chat_id, metadata=None):
            interrupted.append((session_key, chat_id, metadata))

        async def audit(event, source):
            audited.append((event, source))

        self.adapter.interrupt_session_activity = interrupt
        self.adapter.set_platform_event_handler(audit)
        await self.bridge.emit({
            "control": "task_takeover",
            "id": "takeover-1",
            "conversationId": "direct-1",
            "participantUserId": "trusted-user",
            "chatType": "direct",
            "createTime": "2026-08-18T14:00:02+08:00",
        })
        self.assertEqual(interrupted[0][:2], ("direct-1:trusted-user", "direct-1"))
        self.assertEqual(audited[0][0]["type"], "task_takeover")
        self.assertEqual(audited[0][0]["participant_id"], "trusted-user")

        await self.bridge.emit({
            "control": "message_withdrawn",
            "id": "withdrawn-1",
            "messageId": "message-1",
            "conversationId": "direct-1",
            "participantUserId": "trusted-user",
            "chatType": "direct",
            "createTime": "2026-08-18T14:00:03+08:00",
        })
        self.assertEqual(audited[-1][0]["type"], "message_withdrawn")
        self.assertEqual(audited[-1][0]["message_id"], "message-1")

    async def test_owner_communication_takeover_does_not_cancel_work_but_correction_restarts_turn(self):
        interrupted = []
        audited = []

        async def interrupt(session_key, chat_id, metadata=None):
            interrupted.append((session_key, chat_id, metadata))

        async def audit(event, source):
            audited.append((event, source))

        self.adapter.interrupt_session_activity = interrupt
        self.adapter.set_platform_event_handler(audit)
        base = {
            "conversationId": "direct-1",
            "participantUserId": "trusted-user",
            "chatType": "direct",
            "createTime": "2026-08-18T14:00:03+08:00",
            "ownerRevision": 1,
            "sendGeneration": 2,
        }
        await self.bridge.emit({
            **base,
            "control": "communication_takeover",
            "id": "communication-1",
            "ownerMessageId": "owner-1",
            "ownerContent": "我已经回复对方了",
            "classificationSource": "codex",
            "classificationConfidence": 0.94,
        })
        self.assertEqual(interrupted, [])
        self.assertEqual(audited[-1][0]["type"], "communication_takeover")

        await self.bridge.emit({
            **base,
            "control": "task_correction",
            "id": "correction-1",
            "ownerMessageId": "owner-2",
            "ownerContent": "改成先核对全量口径",
            "ownerRevision": 2,
            "sendGeneration": 3,
            "taskId": "a" * 64,
            "controlEventId": "event-1",
        })
        await asyncio.sleep(0)
        self.assertEqual(interrupted[-1][:2], ("direct-1:trusted-user", "direct-1"))
        self.assertEqual(audited[-1][0]["type"], "task_correction")
        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.events[0].text, "改成先核对全量口径")
        self.assertEqual(self.events[0].metadata["owner_revision"], 2)
        self.assertEqual(self.events[0].metadata["send_generation"], 3)
        self.assertEqual(self.bridge.acked, [("a" * 64, "event-1")])

    async def test_unknown_send_receipt_is_suppressed_without_gateway_fallback(self):
        self.bridge.send_result = {
            "success": False,
            "outcomeUnknown": True,
            "error": "missing server message id",
        }
        receipt = await self.adapter.send(
            "direct-1",
            "测试",
            metadata={
                "foursday_owner_revision": 0,
                "foursday_send_generation": 1,
            },
        )
        self.assertTrue(receipt.success)
        self.assertTrue(receipt.message_id.startswith("suppressed-unknown-"))

    async def test_internal_gateway_busy_notice_is_silently_suppressed(self):
        before = len(self.bridge.sent)
        for content in [
            "↪ Redirected current run (iteration 0/500). I'll adjust using your correction.",
            "⚡ Interrupting current task (iteration 0/500). I'll respond to your message shortly.",
            "⏳ Queued for the next turn. I'll respond once the current task finishes.",
            "⏩ Steered into current run. Your message arrives after the next tool call.",
        ]:
            receipt = await self.adapter.send("direct-1", content)
            self.assertTrue(receipt.success)
            self.assertTrue(receipt.message_id.startswith("suppressed-internal-"))
        self.assertEqual(len(self.bridge.sent), before)

    async def test_stale_owner_revision_is_silently_suppressed(self):
        self.bridge.send_result = {
            "success": False,
            "staleGeneration": True,
            "error": "stale generation",
        }
        receipt = await self.adapter.send(
            "direct-1",
            "旧回复",
            metadata={
                "foursday_owner_revision": 0,
                "foursday_send_generation": 1,
            },
        )
        self.assertTrue(receipt.success)
        self.assertTrue(receipt.message_id.startswith("suppressed-stale-"))

    async def test_secret_or_irreversible_commitment_never_reaches_dws(self):
        before = len(self.bridge.sent)
        secret = await self.adapter.send(
            "direct-1",
            "请记录 password=super-secret-value",
        )
        commitment = await self.adapter.send(
            "direct-1",
            "我承诺批准这次不可撤销付款。",
        )
        self.assertFalse(secret.success)
        self.assertFalse(commitment.success)
        self.assertFalse(secret.retryable)
        self.assertFalse(commitment.retryable)
        self.assertEqual(len(self.bridge.sent), before)

    async def test_shadow_evidence_is_private_and_contains_no_message_or_identity(self):
        evidence = Path(self.temp.name).resolve() / "shadow-evidence.jsonl"
        self.bridge.send_result = {
            "success": False,
            "sendDisabled": True,
            "error": "DWS personal send is disabled",
        }
        with patch.dict(os.environ, {
            "FOURSDAY_SHADOW_EVIDENCE_FILE": str(evidence),
            "FOURSDAY_MODE": "shadow",
            "FOURSDAY_RELEASE_SHA": "a" * 40,
        }):
            await self.bridge.emit({
                "id": "private-message-id",
                "senderUserId": "trusted-user",
                "senderName": "Private Name",
                "senderOpenDingTalkId": "private-open-id",
                "conversationId": "private-conversation-id",
                "content": "private message body",
                "createTime": "2026-08-18T14:00:00+08:00",
                "chatType": "direct",
                "mentionedSelf": False,
                "isSelf": False,
                "detectedAt": "2026-08-18T14:00:01.200+08:00",
                "detectionLatencyMs": 1200,
                "wakeSource": "dws_event",
                "ownerRevision": 0,
                "sendGeneration": 1,
            })
            await asyncio.sleep(0)
            reply = await self.adapter.send(
                "private-conversation-id",
                "private natural reply",
                reply_to="private-message-id",
                metadata={
                    "foursday_owner_revision": 0,
                    "foursday_send_generation": 1,
                },
            )
            duplicate = await self.adapter.send(
                "private-conversation-id",
                "private natural reply",
                reply_to="private-message-id",
                metadata={
                    "foursday_owner_revision": 0,
                    "foursday_send_generation": 1,
                },
            )
        self.assertTrue(reply.success)
        self.assertTrue(duplicate.success)
        self.assertTrue(reply.message_id.startswith("shadow-"))
        rows = [json.loads(line) for line in evidence.read_text().splitlines()]
        self.assertEqual([row["type"] for row in rows], ["inbound", "reply_attempt"])
        serialized = json.dumps(rows, ensure_ascii=False)
        for private in [
            "private-message-id",
            "trusted-user",
            "Private Name",
            "private-open-id",
            "private-conversation-id",
            "private message body",
            "private natural reply",
        ]:
            self.assertNotIn(private, serialized)
        self.assertEqual(rows[-1]["mode"], "shadow")
        self.assertEqual(rows[-1]["releaseSha"], "a" * 40)
        self.assertRegex(rows[-1]["recordedAt"], r"^\d{4}-")
        self.assertFalse(rows[-1]["bridgeSuccess"])
        self.assertEqual(rows[0]["detectionLatencyMs"], 1200)
        self.assertEqual(rows[0]["wakeSource"], "dws_event")
        self.assertGreaterEqual(rows[0]["bundleWaitMs"], 0)
        self.assertIn("detectionLatencyMs", rows[-1])
        self.assertIn("bundleWaitMs", rows[-1])
        self.assertIn("agentDurationMs", rows[-1])
        self.assertIn("wakeSource", rows[-1])
        self.assertEqual(rows[-1]["ownerRevision"], 0)
        self.assertEqual(rows[-1]["sendGeneration"], 1)
        self.assertTrue(rows[-1]["latestReplyAnchor"])
        self.assertFalse(rows[-1]["generationRebound"])
        self.assertEqual(evidence.stat().st_mode & 0o077, 0)

    def test_shadow_evidence_rejects_symbolic_link_target(self):
        root = Path(self.temp.name).resolve()
        target = root / "target.jsonl"
        target.write_text("", encoding="utf-8")
        evidence = root / "evidence.jsonl"
        evidence.symlink_to(target)
        with patch.dict(os.environ, {
            "FOURSDAY_SHADOW_EVIDENCE_FILE": str(evidence),
        }):
            with self.assertRaisesRegex(RuntimeError, "private regular file"):
                _shadow_evidence({"type": "inbound"})


if __name__ == "__main__":
    unittest.main()
