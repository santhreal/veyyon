"""Focused behavioral coverage for the Factory CLI Pier replay path."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from factory_session_driver import EXACT_MODEL, FactoryReplayError, _validate_manifest

DRIVER = Path(__file__).with_name("factory_session_driver.py")


class FactoryAgentTest(unittest.TestCase):
    maxDiff = None

    def _repo(self, root: Path) -> Path:
        repo = root / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
        (repo / "state.txt").write_text("initial\n")
        subprocess.run(["git", "add", "state.txt"], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-qm", "initial"], cwd=repo, check=True)
        return repo

    def _manifest(self, root: Path) -> Path:
        manifest = {
            "schema_version": 1,
            "model": EXACT_MODEL,
            "source_session_id": "real-source-session",
            "source_session_artifacts": [str(root / "source.jsonl")],
            "repository_checkpoint": str(root / "checkpoint.tar"),
            "repository_checkpoint_sha256": "a" * 64,
            "compaction_checkpoint": {
                "after_user_turn": 3,
                "source_boundary_id": "boundary-7",
                "source_threshold_tokens": 1000,
                "source_context_tokens": 1010,
            },
            "user_turns": [
                {"id": "u1", "content": "prefix one"},
                {"id": "u2", "content": "prefix two"},
                {"id": "u3", "content": "prefix three"},
            ],
            "held_out_continuation": {"id": "held", "content": "held out"},
        }
        path = root / "replay.json"
        path.write_text(json.dumps(manifest, separators=(",", ":")))
        return path

    def _fake_droid(self, root: Path) -> Path:
        binary = root / "droid"
        binary.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import json, os, pathlib, sys
                args = sys.argv[1:]
                if args == ['--version']:
                    print('0.99.0-test')
                    raise SystemExit(0)
                if '--list-tools' in args:
                    if os.environ.get('FAKE_REJECT_MODEL'):
                        print('Invalid model: google-antigravity/gemini-3.6-flash', file=sys.stderr)
                        raise SystemExit(17)
                    print('{"tools":[]}')
                    raise SystemExit(0)
                record = pathlib.Path(os.environ['FAKE_RECORD'])
                compacted = False
                turn = 0
                def emit(value):
                    print(json.dumps(value, separators=(',', ':')), flush=True)
                def response(request, result):
                    emit({'jsonrpc':'2.0','id':request['id'],'result':result})
                def note(value):
                    emit({'jsonrpc':'2.0','method':'droid.session_notification','params':{'notification':value}})
                for line in sys.stdin:
                    request = json.loads(line)
                    method = request['method']
                    with record.open('a') as output:
                        output.write(method + ':' + str(request.get('params', {}).get('text', '')) + '\\n')
                    if method == 'droid.initialize_session':
                        response(request, {'sessionId':'session-before','settings':{'modelId':request['params']['modelId']}})
                    elif method == 'droid.add_user_message':
                        turn += 1
                        response(request, {})
                        note({'type':'droid_working_state_changed','newState':'streaming_assistant_message'})
                        if request['params']['text'] == 'held out':
                            pathlib.Path('state.txt').write_text('changed by held out\\n')
                        note({'type':'session_token_usage_changed','sessionId':'session','tokenUsage':{
                            'inputTokens':turn * 10, 'outputTokens':turn * 5,
                            'cacheCreationTokens':turn, 'cacheReadTokens':turn * 2,
                            'thinkingTokens':turn * 3}})
                        note({'type':'droid_working_state_changed','newState':'idle'})
                    elif method == 'droid.get_context_stats':
                        response(request, {'used':400 if compacted else 1200,'remaining':100,'limit':1300,
                                           'accuracy':'exact','updatedAt':'now'})
                    elif method == 'droid.compact_session':
                        compacted = True
                        response(request, {'newSessionId':'session-after','removedCount':int(os.environ.get('FAKE_REMOVED','4'))})
                    elif method == 'droid.load_session':
                        response(request, {'settings':{'modelId':os.environ.get('FAKE_RESOLVED_MODEL',
                            'google-antigravity/gemini-3.6-flash')}})
                    else:
                        emit({'jsonrpc':'2.0','id':request['id'],'error':{'message':'unknown method'}})
                raise SystemExit(int(os.environ.get('FAKE_EXIT_STATUS','0')))
                """
            )
        )
        binary.chmod(0o755)
        return binary

    def _run(self, root: Path, extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        repo = self._repo(root)
        manifest = self._manifest(root)
        binary = self._fake_droid(root)
        api_key = root / "factory-api-key"
        api_key.write_text("fk-test\n")
        logs = root / "logs"
        record = root / "requests.txt"
        env = {**os.environ, "FAKE_RECORD": str(record), **(extra_env or {})}
        return subprocess.run(
            [
                sys.executable,
                str(DRIVER),
                "--binary",
                str(binary),
                "--api-key-file",
                str(api_key),
                "--manifest",
                str(manifest),
                "--repo",
                str(repo),
                "--logs",
                str(logs),
            ],
            text=True,
            capture_output=True,
            check=False,
            env=env,
            timeout=10,
        )

    def test_replays_at_native_boundary_then_continues_with_exact_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            completed = self._run(root)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            result = json.loads((root / "logs" / "factory-result.json").read_text())
            self.assertEqual(result["resolved_model"], EXACT_MODEL)
            self.assertEqual(result["factory_version"], "0.99.0-test")
            self.assertEqual(result["input_tokens"], 40)
            self.assertEqual(result["output_tokens"], 20)
            self.assertEqual(result["cache_read_tokens"], 8)
            self.assertEqual(result["cache_write_tokens"], 4)
            self.assertEqual(result["cache_tokens"], 12)
            self.assertIsNone(result["cost_usd"])
            self.assertFalse(result["provider_cost_supported"])
            self.assertIn("no price is inferred", result["provider_cost_unsupported_reason"])
            self.assertEqual(result["exit_status"], 0)
            self.assertIsNone(result["recovery_reads"])
            self.assertIsNone(result["recovery_tokens"])
            manifest_bytes = (root / "replay.json").read_bytes()
            self.assertEqual(result["replay_manifest_sha256"], hashlib.sha256(manifest_bytes).hexdigest())
            self.assertEqual(
                result["native_compaction"],
                {
                    "native": True,
                    "artifact": str(root / "logs" / "factory-compaction.json"),
                    "before_tokens": 1200,
                    "after_tokens": 400,
                },
            )
            requests = (root / "requests.txt").read_text().splitlines()
            self.assertEqual(
                requests,
                [
                    "droid.initialize_session:",
                    "droid.add_user_message:prefix one",
                    "droid.add_user_message:prefix two",
                    "droid.add_user_message:prefix three",
                    "droid.get_context_stats:",
                    "droid.compact_session:",
                    "droid.load_session:",
                    "droid.get_context_stats:",
                    "droid.add_user_message:held out",
                ],
            )
            self.assertIn("changed by held out", (root / "logs" / "factory.patch").read_text())
            self.assertTrue((root / "logs" / "factory-transcript.jsonl").is_file())

    def test_rejects_a_manifest_with_prefix_turns_after_the_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self._repo(root)
            manifest = json.loads(self._manifest(root).read_text())
            manifest["compaction_checkpoint"]["after_user_turn"] = 2
            with self.assertRaisesRegex(
                FactoryReplayError, "must equal user_turns.length"
            ):
                _validate_manifest(manifest, repo, EXACT_MODEL)

    def test_model_rejection_fails_loud_with_exact_remediation_and_status(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            completed = self._run(root, {"FAKE_REJECT_MODEL": "1"})
            self.assertEqual(completed.returncode, 17)
            self.assertIn("rejected required model " + EXACT_MODEL, completed.stderr)
            self.assertIn("settings.json", completed.stderr)
            self.assertIn("Do not substitute gemini-3-flash-preview", completed.stderr)
            self.assertIn("Invalid model", (root / "logs" / "model-preflight.txt").read_text())
            self.assertFalse((root / "requests.txt").exists())

    def test_zero_message_native_compaction_is_an_infrastructure_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            completed = self._run(root, {"FAKE_REMOVED": "0"})
            self.assertEqual(completed.returncode, 1)
            self.assertIn("removed no messages", completed.stderr)
            self.assertNotIn("held out", (root / "requests.txt").read_text())
            self.assertFalse((root / "logs" / "factory-result.json").exists())

    def test_factory_process_exit_status_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            completed = self._run(root, {"FAKE_EXIT_STATUS": "23"})
            self.assertEqual(completed.returncode, 23)
            self.assertIn("exited with status 23", completed.stderr)


if __name__ == "__main__":
    unittest.main()
