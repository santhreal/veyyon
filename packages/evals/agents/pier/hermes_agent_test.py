"""Behavioral tests for the Hermes native replay driver."""

from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from hermes_replay_driver import EXACT_MODEL, ReplayFailure, load_replay_manifest, run_replay


FAKE_HERMES = r'''#!/usr/bin/env python3
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

args = sys.argv[1:]
home = Path(os.environ.get("HERMES_HOME", "."))
home.mkdir(parents=True, exist_ok=True)
with (home / "invocations.jsonl").open("a", encoding="utf-8") as log:
    log.write(json.dumps(args) + "\n")

if args == ["--version"]:
    print("Hermes Agent 0.20.0")
    raise SystemExit(0)
if args == ["chat", "--help"]:
    if os.environ.get("FAKE_UNSUPPORTED") == "1":
        print("--provider --model --resume --query providers: gemini openrouter")
    else:
        print("--provider --model --resume --query providers: google-antigravity")
    raise SystemExit(0)
if not args or args[0] != "chat":
    print("unsupported fake command", file=sys.stderr)
    raise SystemExit(2)
if os.environ.get("FAKE_CHAT_FAILURE") == "1":
    print("simulated provider authentication failure", file=sys.stderr)
    raise SystemExit(41)

def value(flag):
    return args[args.index(flag) + 1]

source = value("--source")
model = value("--model")
provider = value("--provider")
query = value("--query")
session_id = value("--resume") if "--resume" in args else "native-session"
db = sqlite3.connect(home / "state.db")
db.executescript("""
CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY, source TEXT, parent_session_id TEXT, started_at REAL,
 input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
 cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
 api_call_count INTEGER DEFAULT 0, model TEXT, billing_provider TEXT,
 actual_cost_usd REAL, estimated_cost_usd REAL
);
CREATE TABLE IF NOT EXISTS messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
 active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0, token_count INTEGER
);
CREATE TABLE IF NOT EXISTS session_model_usage (
 session_id TEXT, model TEXT, billing_provider TEXT, task TEXT,
 api_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0,
 output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
 cache_write_tokens INTEGER DEFAULT 0,
 PRIMARY KEY(session_id, model, billing_provider, task)
);
""")
db.execute(
 "INSERT OR IGNORE INTO sessions(id,source,parent_session_id,started_at,model,billing_provider,actual_cost_usd,estimated_cost_usd) VALUES(?,?,?,?,?,?,0,0)",
 (session_id, source, None, time.time(), model, provider),
)
config = (home / "config.yaml").read_text(encoding="utf-8")
if "enabled: true" in config:
    db.execute("UPDATE messages SET active=0, compacted=1 WHERE session_id=? AND active=1", (session_id,))
    db.execute(
      "INSERT INTO messages(session_id,role,content,active,compacted,token_count) VALUES(?,?,?,1,1,12)",
      (session_id, "system", "native compression summary"),
    )
db.execute(
 "INSERT INTO messages(session_id,role,content,active,compacted,token_count) VALUES(?,?,?,1,0,25)",
 (session_id, "user", query),
)
db.execute(
 "INSERT INTO messages(session_id,role,content,active,compacted,token_count) VALUES(?,?,?,1,0,10)",
 (session_id, "assistant", "answer:" + query),
)
db.execute(
 "UPDATE sessions SET input_tokens=input_tokens+100,output_tokens=output_tokens+20,cache_read_tokens=cache_read_tokens+10,cache_write_tokens=cache_write_tokens+2,api_call_count=api_call_count+1,actual_cost_usd=actual_cost_usd+0.01,estimated_cost_usd=estimated_cost_usd+0.012 WHERE id=?",
 (session_id,),
)
db.execute(
 "INSERT INTO session_model_usage(session_id,model,billing_provider,task,api_call_count,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens) VALUES(?,?,?,'',1,100,20,10,2) ON CONFLICT(session_id,model,billing_provider,task) DO UPDATE SET api_call_count=api_call_count+1,input_tokens=input_tokens+100,output_tokens=output_tokens+20,cache_read_tokens=cache_read_tokens+10,cache_write_tokens=cache_write_tokens+2",
 (session_id, model, provider),
)
db.commit()
db.close()
(Path.cwd() / "agent-change.txt").write_text("changed by fake Hermes\n", encoding="utf-8")
print("answer:" + query)
'''


class HermesReplayDriverTest(unittest.TestCase):
    def _repo(self, root: Path) -> Path:
        repo = root / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        (repo / "base.txt").write_text("base\n", encoding="utf-8")
        subprocess.run(["git", "add", "base.txt"], cwd=repo, check=True)
        subprocess.run(
            [
                "git",
                "-c",
                "user.name=Hermes Test",
                "-c",
                "user.email=hermes@example.invalid",
                "commit",
                "-qm",
                "base",
            ],
            cwd=repo,
            check=True,
        )
        return repo

    def _manifest(self, root: Path) -> Path:
        value = {
            "schema_version": 1,
            "model": EXACT_MODEL,
            "source_session_id": "source-session-123",
            "source_session_artifacts": ["/evidence/source-session.jsonl"],
            "repository_checkpoint": "/checkpoints/repository.tar.zst",
            "repository_checkpoint_sha256": "a" * 64,
            "compaction_checkpoint": {
                "after_user_turn": 2,
                "source_boundary_id": "boundary-9",
                "source_threshold_tokens": 1000,
                "source_context_tokens": 1100,
            },
            "user_turns": [
                {"id": "turn-1", "content": "Inspect the repository."},
                {"id": "turn-2", "content": "Implement the requested change."},
            ],
            "held_out_continuation": {
                "id": "held-out-1",
                "content": "Verify the implementation and fix any defects.",
            },
        }
        path = root / "replay.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def _fake(self, root: Path) -> Path:
        path = root / "hermes"
        path.write_text(FAKE_HERMES, encoding="utf-8")
        path.chmod(0o755)
        return path

    def test_replays_user_turns_resumes_native_session_and_continues_after_compaction(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self._repo(root)
            replay = self._manifest(root)
            fake = self._fake(root)
            auth = root / "auth.env"
            auth.write_text("GOOGLE_APPLICATION_CREDENTIALS=/credential.json\n", encoding="utf-8")
            logs = root / "logs"

            result = run_replay(
                hermes=fake,
                auth_path=auth,
                replay_path=replay,
                cwd=repo,
                logs_dir=logs,
                timeout_seconds=10,
            )

            self.assertTrue(result["completed"])
            self.assertEqual(result["resolved_model"], EXACT_MODEL)
            self.assertEqual(result["resolved_provider"], "google-antigravity")
            self.assertEqual(result["input_tokens"], 300)
            self.assertEqual(result["output_tokens"], 60)
            self.assertEqual(result["cache_read_tokens"], 30)
            self.assertEqual(result["cache_write_tokens"], 6)
            self.assertAlmostEqual(result["provider_cost_usd"], 0.03)
            self.assertTrue(result["provider_cost_supported"])
            self.assertTrue(result["compaction_evidence"]["crossed"])
            self.assertTrue(result["native_compaction"]["native"])
            self.assertEqual(result["native_compaction"]["artifact"], result["transcript_path"])
            for artifact_key in (
                "patch_path",
                "transcript_path",
                "log_path",
                "continuation_artifact",
            ):
                self.assertTrue(result[artifact_key])
                self.assertTrue(Path(result[artifact_key]).is_file())
            self.assertIsNone(result["qualitative_score"])
            self.assertIsNone(result["recovery_reads"])
            self.assertIsNone(result["recovery_tokens"])
            self.assertEqual(result["repository_checkpoint_sha256"], "a" * 64)
            self.assertEqual(
                result["replay_manifest_sha256"], hashlib.sha256(replay.read_bytes()).hexdigest()
            )
            invocations = [
                json.loads(line)
                for line in (logs / "hermes-home" / "invocations.jsonl").read_text().splitlines()
            ]
            chats = [args for args in invocations if args and args[0] == "chat" and "--query" in args]
            self.assertEqual(len(chats), 3)
            self.assertNotIn("--resume", chats[0])
            self.assertEqual(chats[1][chats[1].index("--resume") + 1], "native-session")
            self.assertEqual(chats[2][chats[2].index("--resume") + 1], "native-session")
            self.assertEqual(
                [args[args.index("--query") + 1] for args in chats],
                [
                    "Inspect the repository.",
                    "Implement the requested change.",
                    "Verify the implementation and fix any defects.",
                ],
            )
            for args in chats:
                self.assertEqual(args[args.index("--provider") + 1], "google-antigravity")
                self.assertEqual(args[args.index("--model") + 1], EXACT_MODEL)
            self.assertIn("agent-change.txt", (logs / "final.patch").read_text())
            self.assertIn("native compression summary", (logs / "transcript.jsonl").read_text())

    def test_missing_exact_provider_capability_fails_before_any_model_turn(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self._repo(root)
            replay = self._manifest(root)
            fake = self._fake(root)
            auth = root / "auth.env"
            auth.write_text("credential=present\n", encoding="utf-8")
            logs = root / "logs"
            old = __import__("os").environ.get("FAKE_UNSUPPORTED")
            __import__("os").environ["FAKE_UNSUPPORTED"] = "1"
            try:
                with self.assertRaisesRegex(ReplayFailure, "cannot prove the exact model/provider"):
                    run_replay(
                        hermes=fake,
                        auth_path=auth,
                        replay_path=replay,
                        cwd=repo,
                        logs_dir=logs,
                        timeout_seconds=10,
                    )
            finally:
                if old is None:
                    __import__("os").environ.pop("FAKE_UNSUPPORTED", None)
                else:
                    __import__("os").environ["FAKE_UNSUPPORTED"] = old
            failure = json.loads((logs / "hermes-result.json").read_text())
            self.assertTrue(failure["failed"])
            invocations = [json.loads(line) for line in (logs / "hermes-home" / "invocations.jsonl").read_text().splitlines()]
            self.assertFalse(any("--query" in args for args in invocations))

    def test_model_auth_failure_is_preserved_with_phase_log_and_failure_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self._repo(root)
            replay = self._manifest(root)
            fake = self._fake(root)
            auth = root / "auth.env"
            auth.write_text("credential=invalid\n", encoding="utf-8")
            logs = root / "logs"
            old = __import__("os").environ.get("FAKE_CHAT_FAILURE")
            __import__("os").environ["FAKE_CHAT_FAILURE"] = "1"
            try:
                with self.assertRaisesRegex(ReplayFailure, "exit 41"):
                    run_replay(
                        hermes=fake,
                        auth_path=auth,
                        replay_path=replay,
                        cwd=repo,
                        logs_dir=logs,
                        timeout_seconds=10,
                    )
            finally:
                if old is None:
                    __import__("os").environ.pop("FAKE_CHAT_FAILURE", None)
                else:
                    __import__("os").environ["FAKE_CHAT_FAILURE"] = old
            self.assertIn("authentication failure", (logs / "replay-0001.txt").read_text())
            failure = json.loads((logs / "hermes-result.json").read_text())
            self.assertEqual(failure["error_type"], "ReplayFailure")
            self.assertIn("exit 41", failure["error"])

    def test_manifest_rejects_transcript_rows_and_unknown_keys(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            replay = self._manifest(root)
            value = json.loads(replay.read_text())
            value["user_turns"][0]["role"] = "assistant"
            replay.write_text(json.dumps(value))
            with self.assertRaisesRegex(ReplayFailure, "exactly id and content"):
                load_replay_manifest(replay)


if __name__ == "__main__":
    unittest.main()
