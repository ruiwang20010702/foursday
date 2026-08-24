import json
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

from foursday_work_twin import _enrich_work_context, _on_pre_llm_call


class FoursdayWorkTwinHookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve(strict=True)
        self.path = self.root / "contexts.json"
        self.token = "fctx_" + ("a" * 64)
        self.path.write_text(json.dumps({
            "schemaVersion": 1,
            "contexts": {
                self.token: {
                    "projectId": "project",
                    "workspace": str(self.root),
                    "projectContext": "project",
                    "memoryContext": "",
                    "sourcePrincipalHandle": "b" * 64,
                    "sourceSessionHash": "c" * 64,
                    "sourceScope": "direct",
                    "ownerRevision": 0,
                    "sendGeneration": 0,
                    "expiresAt": 2_000,
                }
            },
        }) + "\n", encoding="utf-8")
        os.chmod(self.root, 0o700)
        os.chmod(self.path, 0o600)

    def tearDown(self):
        self.temp.cleanup()

    def test_pre_llm_hook_adds_only_hashed_session_identity(self):
        with patch.dict(os.environ, {"FOURSDAY_WORK_CONTEXT_FILE": str(self.path)}), patch(
            "agent.runtime_cwd.set_session_cwd"
        ) as set_session_cwd:
            changed = _enrich_work_context(
                user_message=f"work\n\n<!-- foursday-context:{self.token} -->",
                session_id="hermes-session-1",
                turn_id="turn-1",
                sender_id="trusted-user",
                platform="dws_personal",
                now=1_000,
            )
        self.assertTrue(changed)
        set_session_cwd.assert_called_once_with(str(self.root))
        context = json.loads(self.path.read_text(encoding="utf-8"))["contexts"][self.token]
        self.assertRegex(context["hermesSessionHash"], r"^[a-f0-9]{64}$")
        self.assertRegex(context["hermesTurnHash"], r"^[a-f0-9]{64}$")
        self.assertRegex(context["sourcePrincipalHash"], r"^[a-f0-9]{64}$")
        self.assertEqual(context["platform"], "dws_personal")
        serialized = self.path.read_text(encoding="utf-8")
        self.assertNotIn("hermes-session-1", serialized)
        self.assertNotIn("trusted-user", serialized)
        self.assertEqual(oct(self.path.stat().st_mode & 0o777), "0o600")

    def test_unrelated_messages_are_zero_write(self):
        before = self.path.read_bytes()
        with patch.dict(os.environ, {"FOURSDAY_WORK_CONTEXT_FILE": str(self.path)}):
            changed = _enrich_work_context(
                user_message="ordinary",
                session_id="session",
                turn_id="turn",
                sender_id="user",
                platform="dws_personal",
                now=1_000,
            )
        self.assertFalse(changed)
        self.assertEqual(self.path.read_bytes(), before)

    def test_expired_context_fails_closed(self):
        with patch.dict(os.environ, {"FOURSDAY_WORK_CONTEXT_FILE": str(self.path)}):
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                _enrich_work_context(
                    user_message=f"<!-- foursday-context:{self.token} -->",
                    session_id="session",
                    turn_id="turn",
                    sender_id="user",
                    platform="dws_personal",
                    now=2_001,
                )

    def test_cron_hook_creates_fresh_bounded_context_for_exact_registered_project(self):
        registry = self.root / "projects.json"
        registry.write_text(json.dumps({
            "schemaVersion": 1,
            "projects": [{
                "id": "project",
                "name": "Project",
                "aliases": ["P"],
                "root": str(self.root),
                "gbrainSlugs": ["projects/project"],
                "runInstructions": "Read current files.",
            }],
        }) + "\n", encoding="utf-8")
        os.chmod(registry, 0o600)
        self.path.unlink()
        with patch.dict(os.environ, {
            "FOURSDAY_WORK_CONTEXT_FILE": str(self.path),
            "FOURSDAY_PROJECT_REGISTRY": str(registry),
        }), patch("agent.runtime_cwd.set_session_cwd") as set_session_cwd:
            result = _on_pre_llm_call(
                user_message="Check the project.\n\n<!-- foursday-schedule:project -->",
                session_id="cron-session",
                turn_id="cron-turn",
                sender_id="",
                platform="cron",
            )
        self.assertRegex(result["context"], r"<!-- foursday-context:fctx_[a-f0-9]{64} -->")
        set_session_cwd.assert_called_once_with(str(self.root))
        token = re.search(r"(fctx_[a-f0-9]{64})", result["context"]).group(1)
        context = json.loads(self.path.read_text(encoding="utf-8"))["contexts"][token]
        self.assertEqual(context["projectId"], "project")
        self.assertEqual(context["workspace"], str(self.root))
        self.assertEqual(context["platform"], "cron")
        self.assertNotIn("cron-session", self.path.read_text(encoding="utf-8"))
        self.assertEqual(oct(self.path.stat().st_mode & 0o777), "0o600")

    def test_schedule_marker_from_non_cron_platform_fails_closed(self):
        with patch.dict(os.environ, {
            "FOURSDAY_WORK_CONTEXT_FILE": str(self.path),
            "FOURSDAY_PROJECT_REGISTRY": str(self.path),
        }):
            with self.assertRaisesRegex(RuntimeError, "restricted to Hermes cron"):
                _on_pre_llm_call(
                    user_message="<!-- foursday-schedule:project -->",
                    session_id="session",
                    turn_id="turn",
                    sender_id="user",
                    platform="dws_personal",
                )

    def test_multiple_schedule_markers_fail_closed(self):
        with self.assertRaisesRegex(RuntimeError, "ambiguous"):
            from foursday_work_twin import _scheduled_work_context
            _scheduled_work_context(
                user_message=(
                    "<!-- foursday-schedule:project -->\n"
                    "<!-- foursday-schedule:other -->"
                ),
                session_id="session",
                turn_id="turn",
                platform="cron",
            )


if __name__ == "__main__":
    unittest.main()
