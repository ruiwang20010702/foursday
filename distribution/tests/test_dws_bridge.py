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
            self.assertEqual(bridge._stderr_codes[-1], "manual_reply_probe:tls_timeout")
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
                    "DWS_PERSONAL_EVENT_WAKE_ENABLED": "true",
                    "DWS_PERSONAL_HISTORY_SETTLE_MS": "120000",
                    "DWS_PERSONAL_OUTBOUND_QUIET_MS": "8000",
                    "DWS_PERSONAL_OUTBOUND_MAX_QUIET_MS": "20000",
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
            self.assertEqual(bridge.environment["DWS_PERSONAL_HISTORY_SETTLE_MS"], "120000")
            self.assertEqual(bridge.environment["DWS_PERSONAL_OUTBOUND_QUIET_MS"], "8000")
            self.assertEqual(bridge.environment["DWS_PERSONAL_OUTBOUND_MAX_QUIET_MS"], "20000")
            self.assertNotIn("FOURSDAY_DWS_HOME", bridge.environment)
            self.assertNotIn("DATABASE_URL", bridge.environment)
            self.assertNotIn("AI_EMPLOYEE_DATA_KEY", bridge.environment)
            self.assertEqual(bridge.request_timeout, 300.0)


if __name__ == "__main__":
    unittest.main()
