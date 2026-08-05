"""Focused behavioral coverage for Veyyon's real-session replay adapter."""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import types
import unittest
from pathlib import Path
from types import SimpleNamespace

from veyyon_replay_driver import EXACT_MODEL

DRIVER = Path(__file__).with_name("veyyon_replay_driver.py")


class VeyyonReplayDriverTest(unittest.TestCase):
    maxDiff = None

    def _repo(self, root: Path) -> Path:
        repo = root / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"], cwd=repo, check=True
        )
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
        (repo / "state.txt").write_text("initial\n", encoding="utf-8")
        subprocess.run(["git", "add", "state.txt"], cwd=repo, check=True)
        subprocess.run(["git", "commit", "-qm", "initial"], cwd=repo, check=True)
        return repo

    def _manifest(self, root: Path) -> Path:
        source = root / "source.jsonl"
        source.write_text("{}\n", encoding="utf-8")
        checkpoint = root / "checkpoint"
        checkpoint.mkdir()
        manifest = {
            "schema_version": 1,
            "model": EXACT_MODEL,
            "source_session_id": "real-source-session",
            "source_session_artifacts": [str(source)],
            "repository_checkpoint": str(checkpoint),
            "repository_checkpoint_sha256": "a" * 64,
            "compaction_checkpoint": {
                "after_user_turn": 3,
                "source_boundary_id": "boundary-7",
                "source_threshold_tokens": 100,
                "source_context_tokens": 150,
            },
            "user_turns": [
                {"id": "u1", "content": "prefix one"},
                {"id": "u2", "content": "prefix two"},
                {"id": "u3", "content": "prefix three"},
            ],
            "held_out_continuation": {"id": "held", "content": "held out"},
        }
        path = root / "replay.json"
        path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
        return path

    def _fake_vey(self, root: Path) -> Path:
        binary = root / "vey"
        binary.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import json, os, pathlib, sys

                args = sys.argv[1:]
                if args == ['--version']:
                    print('veyyon 9.9.9-test')
                    raise SystemExit(int(os.environ.get('FAKE_VERSION_STATUS', '0')))
                record = pathlib.Path(os.environ['FAKE_RECORD'])
                with record.open('a', encoding='utf-8') as output:
                    output.write(json.dumps(args, separators=(',', ':')) + '\\n')
                session_dir = pathlib.Path(args[args.index('--session-dir') + 1])
                session_dir.mkdir(parents=True, exist_ok=True)
                messages = args[args.index('--') + 1:]
                resume = '--resume' in args
                model = args[args.index('--model') + 1]
                session = pathlib.Path(args[args.index('--resume') + 1]) if resume else session_dir / 'main.jsonl'

                def append(entry):
                    with session.open('a', encoding='utf-8') as output:
                        output.write(json.dumps(entry, separators=(',', ':')) + '\\n')

                def usage(continuation=False):
                    zero = os.environ.get('FAKE_ZERO_TOKENS') == '1'
                    return {
                        'input': 0 if zero else (30 if continuation else 10),
                        'output': 0 if zero else (8 if continuation else 4),
                        'cacheRead': 5 if continuation else 2,
                        'cacheWrite': 1,
                        'cost': {'total': 0.01},
                    }

                if not resume:
                    append({'type':'session','version':3,'id':'same-session','timestamp':'now','cwd':str(pathlib.Path.cwd())})
                    for index, message in enumerate(messages):
                        if message == '/compact summary':
                            if os.environ.get('FAKE_MISSING_COMPACTION') != '1':
                                append({
                                    'type':'compaction','id':'compact-native','parentId':f'a{index}',
                                    'timestamp':'now','summary':'native summary','shortSummary':'native',
                                    'firstKeptEntryId':'u2','tokensBefore':int(os.environ.get('FAKE_BEFORE_TOKENS','150')),
                                    'details':{'readFiles':[],'modifiedFiles':[]},
                                })
                            print(json.dumps({'type':'command_output','text':'Compacted'}))
                            continue
                        append({'type':'message','id':f'u{index}','parentId':None,'timestamp':'now',
                                'message':{'role':'user','content':[{'type':'text','text':message}],
                                           'attribution':'user','timestamp':index}})
                        append({'type':'message','id':f'a{index}','parentId':f'u{index}','timestamp':'now',
                                'message':{'role':'assistant','content':[{'type':'text','text':f'answer {index}'}],
                                           'provider':'google-antigravity','model':'gemini-3.6-flash',
                                           'usage':usage(),'stopReason':'stop','timestamp':index}})
                        print(json.dumps({'type':'message_end','turn':index}))
                    raise SystemExit(int(os.environ.get('FAKE_PREFIX_STATUS','0')))

                for index, message in enumerate(messages):
                    append({'type':'message','id':f'held-u{index}','parentId':'compact-native','timestamp':'now',
                            'message':{'role':'user','content':[{'type':'text','text':message}],
                                       'attribution':'user','timestamp':10 + index}})
                    drift = os.environ.get('FAKE_MODEL_DRIFT') == '1'
                    append({'type':'message','id':f'held-a{index}','parentId':f'held-u{index}','timestamp':'now',
                            'message':{'role':'assistant','content':[{'type':'text','text':'continued'}],
                                       'provider':'google-antigravity',
                                       'model':'gemini-3-flash-preview' if drift else 'gemini-3.6-flash',
                                       'usage':usage(True),'stopReason':'stop','timestamp':11 + index}})
                    pathlib.Path('state.txt').write_text('changed by held out\\n', encoding='utf-8')
                    print(json.dumps({'type':'message_end','turn':'held'}))
                raise SystemExit(int(os.environ.get('FAKE_CONTINUATION_STATUS','0')))
                """
            ),
            encoding="utf-8",
        )
        binary.chmod(0o755)
        return binary

    def _run(
        self, root: Path, extra_env: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        repo = self._repo(root)
        manifest = self._manifest(root)
        binary = self._fake_vey(root)
        config = root / "arm.yml"
        config.write_text("{}\n", encoding="utf-8")
        logs = root / "logs"
        record = root / "commands.jsonl"
        env = {**os.environ, "FAKE_RECORD": str(record), **(extra_env or {})}
        return subprocess.run(
            [
                sys.executable,
                str(DRIVER),
                "--binary",
                str(binary),
                "--config",
                str(config),
                "--manifest",
                str(manifest),
                "--repo",
                str(repo),
                "--logs",
                str(logs),
                "--model",
                EXACT_MODEL,
                "--turn-timeout-seconds",
                "5",
            ],
            text=True,
            capture_output=True,
            check=False,
            env=env,
            timeout=10,
        )

    def test_same_session_native_boundary_metrics_provenance_and_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            completed = self._run(root)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            result = json.loads((root / "logs" / "veyyon-result.json").read_text())
            self.assertEqual(result["resolved_model"], EXACT_MODEL)
            self.assertEqual(result["initial_session_id"], "same-session")
            self.assertEqual(result["replayed_user_turn_ids"], ["u1", "u2", "u3"])
            self.assertEqual(result["held_out_continuation_id"], "held")
            self.assertEqual(result["input_tokens"], 60)
            self.assertEqual(result["output_tokens"], 20)
            self.assertEqual(result["cache_read_tokens"], 11)
            self.assertEqual(result["cache_write_tokens"], 4)
            self.assertEqual(result["cache_tokens"], 15)
            self.assertAlmostEqual(result["cost_usd"], 0.04)
            self.assertTrue(result["provider_cost_supported"])
            self.assertEqual(result["exit_status"], 0)
            self.assertIsNone(result["recovery_reads"])
            self.assertIsNone(result["recovery_tokens"])
            self.assertFalse(result["recovery_attribution_supported"])
            manifest_bytes = (root / "replay.json").read_bytes()
            self.assertEqual(
                result["replay_manifest_sha256"], hashlib.sha256(manifest_bytes).hexdigest()
            )
            native = result["native_compaction"]
            self.assertTrue(native["native"])
            self.assertEqual(native["entry_id"], "compact-native")
            self.assertEqual(native["before_tokens"], 150)
            self.assertEqual(native["after_tokens"], 36)
            self.assertTrue(Path(native["artifact"]).is_file())
            evidence = json.loads(Path(native["artifact"]).read_text())
            self.assertEqual(evidence["entry"]["type"], "compaction")
            self.assertEqual(evidence["method"], "/compact summary")
            for name in (
                "result",
                "native_compaction",
                "transcript",
                "continuation",
                "print_events",
                "patch",
                "sessions",
                "log",
            ):
                self.assertIn(name, result["artifacts"])
            self.assertIn("changed by held out", Path(result["patch_path"]).read_text())
            continuation_lines = Path(result["continuation_artifact"]).read_text().splitlines()
            self.assertEqual(len(continuation_lines), 2)
            commands = [json.loads(line) for line in (root / "commands.jsonl").read_text().splitlines()]
            self.assertEqual(len(commands), 2)
            self.assertEqual(
                commands[0][commands[0].index("--") + 1 :],
                ["prefix one", "prefix two", "prefix three", "/compact summary"],
            )
            resumed_path = commands[1][commands[1].index("--resume") + 1]
            self.assertEqual(resumed_path, str(root / "logs" / "veyyon-sessions" / "main.jsonl"))
            self.assertEqual(commands[1][commands[1].index("--") + 1 :], ["held out"])
            for command in commands:
                self.assertEqual(command[command.index("--model") + 1], EXACT_MODEL)
                self.assertEqual(command[command.index("--compaction-model") + 1], EXACT_MODEL)
                self.assertEqual(command[command.index("--subagent-model") + 1], EXACT_MODEL)

    def test_model_drift_fails_loud(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            completed = self._run(Path(temporary), {"FAKE_MODEL_DRIFT": "1"})
            self.assertEqual(completed.returncode, 1)
            self.assertIn("persisted resolved model", completed.stderr)
            self.assertIn("gemini-3-flash-preview", completed.stderr)

    def test_zero_tokens_fail_loud(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            completed = self._run(Path(temporary), {"FAKE_ZERO_TOKENS": "1"})
            self.assertEqual(completed.returncode, 1)
            self.assertIn("zero input/output tokens", completed.stderr)

    def test_missing_native_compaction_fails_before_continuation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            completed = self._run(root, {"FAKE_MISSING_COMPACTION": "1"})
            self.assertEqual(completed.returncode, 1)
            self.assertIn("exactly one new native compaction", completed.stderr)
            commands = (root / "commands.jsonl").read_text().splitlines()
            self.assertEqual(len(commands), 1)

    def test_original_process_exit_status_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            completed = self._run(
                Path(temporary), {"FAKE_CONTINUATION_STATUS": "23"}
            )
            self.assertEqual(completed.returncode, 23)
            self.assertIn("exited with status 23", completed.stderr)

    def test_manifest_model_alias_is_rejected_before_process_launch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = self._repo(root)
            manifest = self._manifest(root)
            value = json.loads(manifest.read_text())
            value["model"] = "google-antigravity/gemini-3-flash-preview"
            manifest.write_text(json.dumps(value), encoding="utf-8")
            binary = self._fake_vey(root)
            config = root / "arm.yml"
            config.write_text("{}\n", encoding="utf-8")
            completed = subprocess.run(
                [
                    sys.executable,
                    str(DRIVER),
                    "--binary",
                    str(binary),
                    "--config",
                    str(config),
                    "--manifest",
                    str(manifest),
                    "--repo",
                    str(repo),
                    "--logs",
                    str(root / "logs"),
                    "--model",
                    EXACT_MODEL,
                ],
                text=True,
                capture_output=True,
                check=False,
                env={**os.environ, "FAKE_RECORD": str(root / "commands.jsonl")},
            )
            self.assertEqual(completed.returncode, 1)
            self.assertIn("exactly " + EXACT_MODEL, completed.stderr)
            self.assertFalse((root / "commands.jsonl").exists())


class _FakeInstalledAgent:
    def __init__(self, *args, **kwargs) -> None:
        self.model_name = kwargs.pop("model_name", None)
        self.logs_dir = Path(kwargs.pop("logs_dir", "."))
        self.commands: list[str] = []

    def render_instruction(self, instruction: str) -> str:
        return instruction

    async def exec_as_agent(self, environment, command: str) -> None:
        self.commands.append(command)


class _Spec:
    def __init__(self, **kwargs) -> None:
        self.__dict__.update(kwargs)


class _Environment:
    def __init__(self) -> None:
        self.uploads: list[tuple[Path, str]] = []
        self.commands: list[tuple[str, str]] = []

    async def exec(self, command: str, user: str) -> None:
        self.commands.append((command, user))

    async def upload_file(self, source: Path, destination: str) -> None:
        self.uploads.append((Path(source), destination))


def _load_agent_module():
    modules = {
        "pier": types.ModuleType("pier"),
        "pier.agents": types.ModuleType("pier.agents"),
        "pier.agents.installed": types.ModuleType("pier.agents.installed"),
        "pier.agents.installed.base": types.ModuleType("pier.agents.installed.base"),
        "pier.agents.network": types.ModuleType("pier.agents.network"),
        "pier.environments": types.ModuleType("pier.environments"),
        "pier.environments.base": types.ModuleType("pier.environments.base"),
        "pier.models": types.ModuleType("pier.models"),
        "pier.models.agent": types.ModuleType("pier.models.agent"),
        "pier.models.agent.context": types.ModuleType("pier.models.agent.context"),
        "pier.models.agent.install": types.ModuleType("pier.models.agent.install"),
    }
    modules["pier.agents.installed.base"].BaseInstalledAgent = _FakeInstalledAgent
    modules["pier.agents.network"].allowlist_from_urls = lambda *args, **kwargs: (args, kwargs)
    modules["pier.environments.base"].BaseEnvironment = object
    modules["pier.models.agent.context"].AgentContext = object
    modules["pier.models.agent.install"].AgentInstallSpec = _Spec
    modules["pier.models.agent.install"].InstallStep = _Spec
    for name, module in modules.items():
        sys.modules[name] = module
    sys.modules.pop("veyyon_agent", None)
    return importlib.import_module("veyyon_agent")


class VeyyonAgentReplayModeTest(unittest.TestCase):
    def _assets_and_manifest(self, root: Path) -> tuple[Path, Path]:
        assets = root / "assets"
        (assets / "arms").mkdir(parents=True)
        (assets / "vey").write_text("binary", encoding="utf-8")
        (assets / "auth-agent.db").write_text("auth", encoding="utf-8")
        (assets / "arms" / "default.yml").write_text("{}\n", encoding="utf-8")
        source = root / "source.jsonl"
        source.write_text("{}\n", encoding="utf-8")
        checkpoint = root / "checkpoint"
        checkpoint.mkdir()
        manifest = root / "replay.json"
        manifest.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "model": EXACT_MODEL,
                    "source_session_id": "source",
                    "source_session_artifacts": [str(source)],
                    "repository_checkpoint": str(checkpoint),
                    "repository_checkpoint_sha256": "b" * 64,
                    "compaction_checkpoint": {
                        "after_user_turn": 1,
                        "source_boundary_id": "boundary",
                        "source_threshold_tokens": 10,
                        "source_context_tokens": 11,
                    },
                    "user_turns": [{"id": "u1", "content": "prefix"}],
                    "held_out_continuation": {"id": "held", "content": "continue"},
                }
            ),
            encoding="utf-8",
        )
        return assets, manifest

    def test_replay_kwarg_preflights_and_uploads_exact_manifest_and_driver(self) -> None:
        module = _load_agent_module()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            assets, manifest = self._assets_and_manifest(root)
            environment = _Environment()
            agent = module.VeyyonAgent(
                assets_dir=str(assets),
                replay_path=str(manifest),
                model_name=EXACT_MODEL,
            )
            asyncio.run(agent.run("ignored Pier instruction", environment, SimpleNamespace()))
            destinations = [destination for _, destination in environment.uploads]
            self.assertIn("/opt/veyyon-assets/replay.json", destinations)
            self.assertIn("/opt/veyyon-assets/veyyon_replay_driver.py", destinations)
            uploaded_manifest = next(
                source
                for source, destination in environment.uploads
                if destination == "/opt/veyyon-assets/replay.json"
            )
            self.assertEqual(
                hashlib.sha256(uploaded_manifest.read_bytes()).hexdigest(),
                hashlib.sha256(manifest.read_bytes()).hexdigest(),
            )
            replay_command = agent.commands[0]
            self.assertIn("veyyon_replay_driver.py", replay_command)
            self.assertIn("--manifest /opt/veyyon-assets/replay.json", replay_command)
            self.assertIn("model-catalog-refresh.txt", replay_command)
            self.assertIn(EXACT_MODEL, replay_command)

    def test_replay_preflight_rejects_model_drift_before_upload(self) -> None:
        module = _load_agent_module()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            assets, manifest = self._assets_and_manifest(root)
            environment = _Environment()
            agent = module.VeyyonAgent(
                assets_dir=str(assets),
                replay_path=str(manifest),
                model_name="google-antigravity/gemini-3-flash-preview",
            )
            with self.assertRaisesRegex(ValueError, "requires exactly"):
                asyncio.run(agent.run("ignored", environment, SimpleNamespace()))
            self.assertEqual(environment.uploads, [])

    def test_replay_result_populates_host_artifact_metadata(self) -> None:
        module = _load_agent_module()
        with tempfile.TemporaryDirectory() as temporary:
            logs = Path(temporary)
            result = {
                "input_tokens": 12,
                "output_tokens": 4,
                "cache_tokens": 3,
                "cost_usd": 0.25,
                "provider_cost_supported": True,
                "resolved_model": EXACT_MODEL,
                "native_compaction": {
                    "native": True,
                    "artifact": "/logs/agent/veyyon-compaction.json",
                    "before_tokens": 100,
                    "after_tokens": 30,
                },
                "patch_path": "/logs/agent/veyyon.patch",
                "transcript_path": "/logs/agent/veyyon-transcript.jsonl",
                "log_path": "/logs/agent/veyyon.txt",
                "continuation_artifact": "/logs/agent/veyyon-continuation.jsonl",
                "artifacts": {"result": "/logs/agent/veyyon-result.json"},
            }
            (logs / "veyyon-result.json").write_text(json.dumps(result), encoding="utf-8")
            agent = module.VeyyonAgent(logs_dir=logs, model_name=EXACT_MODEL)
            context = SimpleNamespace()
            agent.populate_context_post_run(context)
            self.assertEqual(context.n_input_tokens, 12)
            self.assertEqual(context.n_output_tokens, 4)
            self.assertEqual(context.n_cache_tokens, 3)
            self.assertEqual(context.cost_usd, 0.25)
            self.assertEqual(context.metadata["system"], "veyyon")
            self.assertEqual(
                context.metadata["native_compaction"]["artifact"],
                str(logs / "veyyon-compaction.json"),
            )
            self.assertEqual(
                context.metadata["continuation_artifact"],
                str(logs / "veyyon-continuation.jsonl"),
            )
            self.assertEqual(
                context.metadata["artifacts"]["result"],
                str(logs / "veyyon-result.json"),
            )


if __name__ == "__main__":
    unittest.main()
