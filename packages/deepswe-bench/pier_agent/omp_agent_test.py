"""Focused behavioral coverage for the Oh My Pi (omp) Pier adapter."""

from __future__ import annotations

import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace


class _FakeInstalledAgent:
    def __init__(self, *args, model_name: str | None = None, logs_dir: Path | None = None, **kwargs):
        self.model_name = model_name
        self.logs_dir = logs_dir or Path("/logs/agent")

    def render_instruction(self, text: str) -> str:
        return text


class _Spec:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


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
    }
    modules["pier.agents.installed.base"].BaseInstalledAgent = _FakeInstalledAgent
    modules["pier.agents.network"].allowlist_from_urls = lambda urls, default_domains=None: SimpleNamespace(
        allowed_domains=default_domains or []
    )
    modules["pier.environments.base"].BaseEnvironment = object
    modules["pier.models.agent.context"].AgentContext = object
    modules["pier.models.agent.install"].AgentInstallSpec = _Spec
    modules["pier.models.agent.install"].InstallStep = _Spec
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

    def test_network_allowlist_includes_opencode(self) -> None:
        OmpAgent = self.module.OmpAgent
        agent = OmpAgent(assets_dir="/tmp/test")
        allowlist = agent.network_allowlist()
        self.assertTrue(any(".opencode.ai" in domain for domain in allowlist.allowed_domains))

    def test_populate_context_post_run_aggregates_session_metrics(self) -> None:
        OmpAgent = self.module.OmpAgent
        with tempfile.TemporaryDirectory() as temp_dir:
            logs_dir = Path(temp_dir)
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


if __name__ == "__main__":
    unittest.main()
