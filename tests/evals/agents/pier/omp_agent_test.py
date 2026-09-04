"""Focused behavioral coverage for the Oh My Pi (omp) Pier adapter."""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock


class _FakeInstalledAgent:
    def __init__(self, *args, **kwargs):
        self.model_name = kwargs.pop("model_name", None)
        if args:
            self.logs_dir = Path(args[0])
        else:
            self.logs_dir = Path(kwargs.pop("logs_dir", "/logs/agent"))
        self.commands: list[str] = []

    def render_instruction(self, text: str) -> str:
        return text

    async def exec_as_agent(self, environment, command: str, **kwargs) -> None:
        self.commands.append(command)
        if hasattr(environment, "exec") and callable(environment.exec):
            await environment.exec(command=command, **kwargs)


class _Spec:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


def _sample_omp_program() -> dict:
    return {
        "version": 1,
        "harness": "omp",
        "containerDir": "/opt/omp-assets",
        "assets": [
            {"file": "omp", "dest": "/opt/omp-assets/omp", "mode": "0755"},
            {"file": "omp.env", "dest": "/opt/omp-assets/omp.env", "mode": "0600"},
            {"file": "models.yml", "dest": "/opt/omp-assets/models.yml", "optional": True},
        ],
        "setup": [
            "mkdir -p ~/.omp/agent",
            "if [ -f /opt/omp-assets/models.yml ]; then cp /opt/omp-assets/models.yml ~/.omp/agent/models.yml; fi",
        ],
        "command": "{{assets}}/omp --model {{model}} --auto-approve --print --mode json --session-dir {{assets}}/sessions {{instruction}}",
        "envFile": "/opt/omp-assets/omp.env",
        "logPath": "/logs/agent/omp.txt",
        "sessions": {"sources": ["/opt/omp-assets/sessions"], "pattern": "*.jsonl"},
        "allowedDomains": [
            ".opencode.ai",
            ".models.dev",
            ".anthropic.com",
            ".openai.com",
            ".openrouter.ai",
            ".googleapis.com",
            ".google.com",
        ],
        "usage": "omp",
    }


def _install_mock_pier() -> None:
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
        "common.model_catalog_bootstrap": types.ModuleType("common.model_catalog_bootstrap"),
    }
    modules["pier.agents.installed.base"].BaseInstalledAgent = _FakeInstalledAgent
    modules["pier.agents.network"].allowlist_from_urls = lambda urls, default_domains=None: SimpleNamespace(
        allowed_domains=default_domains or []
    )
    modules["pier.environments.base"].BaseEnvironment = object
    modules["pier.models.agent.context"].AgentContext = object
    modules["pier.models.agent.install"].AgentInstallSpec = _Spec
    modules["pier.models.agent.install"].InstallStep = _Spec
    modules["common.model_catalog_bootstrap"].build_status_preserving_tee_command = lambda cmd, log_path, **kw: cmd
    for name, module in modules.items():
        sys.modules[name] = module
    sys.modules.pop("omp_agent", None)


class OmpAgentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _install_mock_pier()
        cls.module = importlib.import_module("omp_agent")

    def test_install_spec_and_naming(self) -> None:
        OmpAgent = self.module.OmpAgent
        agent = OmpAgent(assets_dir="/tmp/test", binary_sha="0123456789abcdef0123")
        self.assertEqual(OmpAgent.name(), "omp")
        self.assertIsNone(agent.get_version_command())
        spec = agent.install_spec()
        self.assertEqual(spec.agent_name, "omp")
        self.assertEqual(spec.cache_key, "omp-0123456789abcdef")

    def test_network_allowlist_comes_from_program_and_includes_opencode(self) -> None:
        OmpAgent = self.module.OmpAgent
        with tempfile.TemporaryDirectory() as tmpdir:
            host_dir = Path(tmpdir)
            (host_dir / "program.json").write_text(json.dumps(_sample_omp_program()), encoding="utf-8")
            agent = OmpAgent(assets_dir=str(host_dir))
            allowlist = agent.network_allowlist()
            self.assertTrue(any(".opencode.ai" in domain for domain in allowlist.allowed_domains))

    def test_run_refuses_when_required_asset_missing_and_names_path(self) -> None:
        OmpAgent = self.module.OmpAgent
        with tempfile.TemporaryDirectory() as tmpdir:
            host_dir = Path(tmpdir)
            (host_dir / "program.json").write_text(json.dumps(_sample_omp_program()), encoding="utf-8")
            # Only create omp.env, missing 'omp'
            (host_dir / "omp.env").write_text("KEY=123", encoding="utf-8")
            expected_missing = str((host_dir / "omp").resolve())

            agent = OmpAgent(assets_dir=str(host_dir), model_name="anthropic/claude-3-5-sonnet")
            env = MagicMock()
            env.exec = AsyncMock()
            env.upload_file = AsyncMock()
            context = SimpleNamespace()

            with self.assertRaises(ValueError) as ctx:
                asyncio.run(agent.run("do task", env, context))
            self.assertIn(expected_missing, str(ctx.exception))

    def test_rendered_command_contains_staged_binary_mode_json_auto_approve_quoted_model_no_api_key(self) -> None:
        OmpAgent = self.module.OmpAgent
        with tempfile.TemporaryDirectory() as tmpdir:
            host_dir = Path(tmpdir)
            (host_dir / "program.json").write_text(json.dumps(_sample_omp_program()), encoding="utf-8")
            (host_dir / "omp").write_text("#!/bin/sh\n", encoding="utf-8")
            (host_dir / "omp.env").write_text("SECRET_API_KEY=xyz\n", encoding="utf-8")

            agent = OmpAgent(assets_dir=str(host_dir), model_name="anthropic/claude-3-5-sonnet")
            env = MagicMock()
            exec_calls: list[str] = []

            async def fake_exec(command="", **kwargs):
                exec_calls.append(command)
                return MagicMock(return_code=0)

            env.exec = AsyncMock(side_effect=fake_exec)
            env.upload_file = AsyncMock()
            context = SimpleNamespace()

            asyncio.run(agent.run("do task", env, context))

            run_cmds = [cmd for cmd in exec_calls if "/opt/omp-assets/omp" in cmd and "--mode json" in cmd]
            self.assertTrue(len(run_cmds) >= 1)
            target_cmd = run_cmds[0]
            self.assertIn("/opt/omp-assets/omp", target_cmd)
            self.assertIn("--mode json", target_cmd)
            self.assertIn("--auto-approve", target_cmd)
            self.assertIn("anthropic/claude-3-5-sonnet", target_cmd)
            self.assertNotIn("SECRET_API_KEY", target_cmd)
            self.assertNotIn("xyz", target_cmd)

    def test_populate_context_post_run_aggregates_session_metrics(self) -> None:
        OmpAgent = self.module.OmpAgent
        with tempfile.TemporaryDirectory() as temp_dir:
            logs_dir = Path(temp_dir)
            (logs_dir / "program.json").write_text(json.dumps(_sample_omp_program()), encoding="utf-8")
            sessions_dir = logs_dir / "sessions"
            sessions_dir.mkdir(parents=True)

            session_data = [
                {
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "usage": {"input": 100, "output": 50, "cacheRead": 20, "cacheWrite": 10, "cost": {"total": 0.05}},
                        "content": [
                            {"type": "toolCall", "name": "read"},
                            {"type": "toolCall", "name": "bash"},
                        ],
                    },
                },
                {
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "usage": {"input": 80, "output": 40, "cacheRead": 10, "cacheWrite": 0, "cost": {"total": 0.03}},
                        "content": [
                            {"type": "toolCall", "name": "read"},
                            {"type": "toolCall", "name": "edit"},
                        ],
                    },
                },
            ]

            session_file = sessions_dir / "test_session.jsonl"
            with session_file.open("w", encoding="utf-8") as f:
                for entry in session_data:
                    f.write(json.dumps(entry) + "\n")

            agent = OmpAgent(assets_dir=temp_dir, logs_dir=logs_dir)
            context = SimpleNamespace()

            agent.populate_context_post_run(context)

            self.assertEqual(context.n_input_tokens, 180)
            self.assertEqual(context.n_output_tokens, 90)
            self.assertEqual(context.n_cache_tokens, 40)
            self.assertAlmostEqual(context.cost_usd, 0.08)
            self.assertEqual(context.metadata["system"], "omp")
            self.assertEqual(context.metadata["tool_calls"], {"read": 2, "bash": 1, "edit": 1})

    def test_pier_and_harbor_produce_identical_agent_command_and_upload_plan(self) -> None:
        from common.container_program import agent_command, load_program, uploads

        with tempfile.TemporaryDirectory() as tmpdir:
            host_dir = Path(tmpdir)
            p_file = host_dir / "program.json"
            p_file.write_text(json.dumps(_sample_omp_program()), encoding="utf-8")
            (host_dir / "omp").write_text("#!/bin/sh\n", encoding="utf-8")
            (host_dir / "omp.env").write_text("API_KEY=123\n", encoding="utf-8")

            prog = load_program(p_file)
            instruction = 'Run benchmark test with "quotes"'
            model = "anthropic/claude-3-5-sonnet"

            cmd = agent_command(prog, instruction=instruction, model=model)
            ups = uploads(prog, host_dir)

            # Both Pier and Harbor shims derive their execution and uploads via the same shared functions
            self.assertEqual(
                cmd,
                agent_command(prog, instruction=instruction, model=model),
            )
            self.assertEqual(
                ups,
                (
                    ((host_dir / "omp").resolve(), "/opt/omp-assets/omp", 0o755),
                    ((host_dir / "omp.env").resolve(), "/opt/omp-assets/omp.env", 0o600),
                ),
            )


if __name__ == "__main__":
    unittest.main()
