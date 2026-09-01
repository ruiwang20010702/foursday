import asyncio
import os
from pathlib import Path
import sys
import tempfile
import textwrap
import unittest

from dws_personal.bridge import JsonLineDwsBridge


class DwsBridgeTest(unittest.IsolatedAsyncioTestCase):
    async def test_json_line_sidecar_delivers_events_and_receipts(self):
        with tempfile.TemporaryDirectory() as root:
            script = Path(root, "fake_sidecar.py")
            script.write_text(textwrap.dedent("""
                import json, sys
                print(json.dumps({"type": "ready"}), flush=True)
                print(json.dumps({"type": "event", "record": {
                    "id": "message-1", "senderUserId": "trusted-user"
                }}), flush=True)
                for line in sys.stdin:
                    frame = json.loads(line)
                    result = {"success": True}
                    if frame.get("action") == "send":
                        result["messageId"] = "sent-1"
                    print(json.dumps({
                        "type": "response", "id": frame["id"], "result": result
                    }), flush=True)
                    if frame.get("action") == "shutdown":
                        break
            """), encoding="utf-8")
            bridge = JsonLineDwsBridge(
                node_path=sys.executable,
                sidecar_path=str(script),
                environment={"PATH": "/usr/bin:/bin"},
            )
            events = []
            acknowledgements = []

            async def on_event(record):
                events.append(record)
                async def acknowledge():
                    acknowledgements.append(await bridge.ack_control("a" * 64, "event-1"))
                asyncio.create_task(acknowledge())

            await bridge.start(on_event)
            await asyncio.sleep(0.02)
            self.assertEqual(events, [])
            await bridge.release_events()
            self.assertEqual(events[0]["id"], "message-1")
            receipt = await bridge.send({"content": "done"})
            self.assertEqual(receipt["messageId"], "sent-1")
            self.assertEqual(await bridge.claim_responsibility({
                "conversationId": "c1", "messageId": "m1",
            }), {"success": True})
            self.assertEqual(await bridge.release_responsibility({
                "conversationId": "c1", "messageId": "m1",
            }), {"success": True})
            self.assertEqual(await bridge.settle_responsibility({
                "conversationId": "c1", "messageId": "m1",
            }), {"success": True})
            self.assertEqual(await bridge.group_responsibility({
                "messages": [{"id": "m1", "content": "task"}],
            }), {"success": True})
            self.assertEqual(await bridge.classify_response_duty({
                "content": "task", "messageCount": 1,
            }), {"success": True})
            background = {
                "taskId": "a" * 64, "executionId": "b" * 64,
                "ownerRevision": 1, "sendGeneration": 2,
            }
            self.assertEqual(await bridge.inspect_background(background), {"success": True})
            self.assertEqual(await bridge.acknowledge_background(background), {"success": True})
            self.assertEqual(await bridge.activate_background(background), {"success": True})
            self.assertEqual(await bridge.start_background(background), {"success": True})
            self.assertEqual(await bridge.finish_background({
                **background, "outcome": "completed",
            }), {"success": True})
            self.assertEqual(await bridge.reconcile(), {"success": True})
            for _ in range(20):
                if acknowledgements:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(acknowledgements, [{"success": True}])
            await bridge.stop()

    async def test_sidecar_stderr_is_bounded_and_cannot_block_readiness(self):
        with tempfile.TemporaryDirectory() as root:
            script = Path(root, "noisy_sidecar.py")
            script.write_text(textwrap.dedent("""
                import json, sys
                for index in range(5000):
                    print(f"diagnostic-{index}", file=sys.stderr, flush=True)
                print(
                    "dws_sidecar_target_failed:user:2:0123456789abcdef:network_unavailable",
                    file=sys.stderr,
                    flush=True,
                )
                print(
                    "dws_sidecar_manual_reply_probe_failed:tls_timeout",
                    file=sys.stderr,
                    flush=True,
                )
                print(
                    "dws_sidecar_target_failed:enterprise:3:fedcba9876543210:scan_incomplete",
                    file=sys.stderr,
                    flush=True,
                )
                print(json.dumps({"type": "ready"}), flush=True)
                for line in sys.stdin:
                    frame = json.loads(line)
                    print(json.dumps({
                        "type": "response", "id": frame["id"],
                        "result": {"success": True}
                    }), flush=True)
                    if frame.get("action") == "shutdown":
                        break
            """), encoding="utf-8")
            bridge = JsonLineDwsBridge(
                node_path=sys.executable,
                sidecar_path=str(script),
                environment={"PATH": "/usr/bin:/bin"},
                startup_timeout=10,
            )
            await bridge.start(lambda _record: asyncio.sleep(0))
            self.assertLessEqual(len(bridge._stderr_codes), 20)
            self.assertIn(
                "target:user:2:0123456789abcdef:network_unavailable",
                bridge._stderr_codes,
            )
            self.assertIn("manual_reply_probe:tls_timeout", bridge._stderr_codes)
            self.assertEqual(
                bridge._stderr_codes[-1],
                "target:enterprise:3:fedcba9876543210:scan_incomplete",
            )
            await bridge.stop()

    def test_environment_factory_passes_only_bridge_configuration(self):
        with tempfile.TemporaryDirectory() as root:
            sidecar = Path(root, "sidecar.mjs")
            sidecar.write_text("", encoding="utf-8")
            previous = dict(os.environ)
            try:
                os.environ.update({
                    "FOURSDAY_NODE_PATH": sys.executable,
                    "FOURSDAY_DWS_SIDECAR": str(sidecar),
                    "DWS_PATH": "/absolute/dws",
                    "DWS_PERSONAL_ALLOWED_USERS": "trusted",
                    "DWS_PERSONAL_ENTERPRISE_USERS_ENABLED": "true",
                    "DWS_PERSONAL_COMMAND_LOCK": str(Path(root, "dws-command.lock")),
                    "DWS_PERSONAL_EVENT_WAKE_ENABLED": "true",
                    "DWS_PERSONAL_HISTORY_SETTLE_MS": "120000",
                    "DWS_PERSONAL_OUTBOUND_QUIET_MS": "8000",
                    "DWS_PERSONAL_OUTBOUND_MAX_QUIET_MS": "20000",
                    "DWS_PERSONAL_SEMANTIC_INTERVENTION_ENABLED": "true",
                    "DWS_PERSONAL_SEMANTIC_INTERVENTION_TIMEOUT_MS": "30000",
                    "DWS_PERSONAL_RESPONSIBILITY_REACTIONS_ENABLED": "true",
                    "DWS_PERSONAL_RESPONSIBILITY_REACTION": "OK",
                    "FOURSDAY_CODEX_PATH": "/absolute/codex",
                    "CODEX_HOME": str(Path(root, "codex-home")),
                    "FOURSDAY_PROJECT_REGISTRY": str(Path(root, "projects.json")),
                    "FOURSDAY_FALLBACK_WORKSPACE": str(Path(root, "fallback")),
                    "FOURSDAY_PROFILE_INSTRUCTIONS_FILE": str(Path(root, "SOUL.md")),
                    "FOURSDAY_PROJECT_SKILL_FILE": str(Path(root, "SKILL.md")),
                    "FOURSDAY_PYTHON_PATH": "/absolute/python",
                    "FOURSDAY_DWS_HOME": root,
                    "FOURSDAY_CONTROL_FILE": str(Path(root, "control.json")),
                    "DATABASE_URL": "must-not-cross",
                    "AI_EMPLOYEE_DATA_KEY": "must-not-cross",
                })
                bridge = JsonLineDwsBridge.from_environment()
            finally:
                os.environ.clear()
                os.environ.update(previous)
            self.assertEqual(bridge.environment["DWS_PATH"], "/absolute/dws")
            self.assertEqual(bridge.environment["HOME"], root)
            self.assertEqual(bridge.environment["FOURSDAY_CONTROL_FILE"], str(Path(root, "control.json")))
            self.assertEqual(bridge.environment["DWS_PERSONAL_EVENT_WAKE_ENABLED"], "true")
            self.assertEqual(bridge.environment["DWS_PERSONAL_ENTERPRISE_USERS_ENABLED"], "true")
            self.assertEqual(bridge.environment["DWS_PERSONAL_COMMAND_LOCK"], str(Path(root, "dws-command.lock")))
            self.assertEqual(bridge.environment["DWS_PERSONAL_HISTORY_SETTLE_MS"], "120000")
            self.assertEqual(bridge.environment["DWS_PERSONAL_OUTBOUND_QUIET_MS"], "8000")
            self.assertEqual(bridge.environment["DWS_PERSONAL_OUTBOUND_MAX_QUIET_MS"], "20000")
            self.assertEqual(bridge.environment["DWS_PERSONAL_SEMANTIC_INTERVENTION_ENABLED"], "true")
            self.assertEqual(bridge.environment["DWS_PERSONAL_SEMANTIC_INTERVENTION_TIMEOUT_MS"], "30000")
            self.assertEqual(bridge.environment["DWS_PERSONAL_RESPONSIBILITY_REACTIONS_ENABLED"], "true")
            self.assertEqual(bridge.environment["DWS_PERSONAL_RESPONSIBILITY_REACTION"], "OK")
            self.assertEqual(bridge.environment["FOURSDAY_NODE_PATH"], sys.executable)
            self.assertEqual(bridge.environment["FOURSDAY_CODEX_PATH"], "/absolute/codex")
            self.assertEqual(bridge.environment["CODEX_HOME"], str(Path(root, "codex-home")))
            self.assertNotIn("FOURSDAY_DWS_HOME", bridge.environment)
            self.assertNotIn("DATABASE_URL", bridge.environment)
            self.assertNotIn("AI_EMPLOYEE_DATA_KEY", bridge.environment)
            self.assertEqual(bridge.request_timeout, 300.0)


if __name__ == "__main__":
    unittest.main()
