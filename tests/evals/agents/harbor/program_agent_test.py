"""Behavioral unit tests for the generic Harbor ProgramAgent adapter."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

from common.container_program import agent_command, uploads
from harbor_api import (
    AgentContext,
    BaseEnvironment,
    PROVIDER_ERROR_PATTERNS,
)
from program_agent import ProgramAgent, _ENV_PROGRAM_VAR


def _sample_program_dict(harness: str = "omp") -> dict:
    return {
        "version": 1,
        "harness": harness,
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
        "allowedDomains": [".opencode.ai", ".models.dev", ".anthropic.com"],
        "usage": "omp",
    }


class ProgramAgentTest(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_env = os.environ.get(_ENV_PROGRAM_VAR)

    def tearDown(self) -> None:
        if self._orig_env is not None:
            os.environ[_ENV_PROGRAM_VAR] = self._orig_env
        else:
            os.environ.pop(_ENV_PROGRAM_VAR, None)

    def test_name_reflects_program_harness_when_env_set_and_falls_back_to_program_when_unset(self) -> None:
        # When unset:
        os.environ.pop(_ENV_PROGRAM_VAR, None)
        self.assertEqual(ProgramAgent.name(), "program")

        # When set to valid program:
        with tempfile.TemporaryDirectory() as tmpdir:
            p_file = Path(tmpdir) / "program.json"
            p_file.write_text(json.dumps(_sample_program_dict("custom-harness")), encoding="utf-8")
            os.environ[_ENV_PROGRAM_VAR] = str(p_file)
            self.assertEqual(ProgramAgent.name(), "custom-harness")

    def test_agent_refuses_when_env_var_points_to_missing_file_naming_the_variable(self) -> None:
        bad_path = "/nonexistent/path/to/program.json"
        os.environ[_ENV_PROGRAM_VAR] = bad_path
        agent = ProgramAgent(logs_dir="/logs/agent", model_name="anthropic/claude-3-5-sonnet")
        with self.assertRaises(ValueError) as ctx:
            agent._get_program()
        self.assertIn(_ENV_PROGRAM_VAR, str(ctx.exception))

    def test_error_pattern_table_matches_shared_provider_error_patterns(self) -> None:
        self.assertEqual(ProgramAgent.ERROR_PATTERNS, list(PROVIDER_ERROR_PATTERNS))

    def test_rendered_run_command_is_teed_to_program_log_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            host_dir = Path(tmpdir)
            p_file = host_dir / "program.json"
            (host_dir / "omp").write_text("#!/bin/sh\n", encoding="utf-8")
            (host_dir / "omp.env").write_text("API_KEY=xyz\n", encoding="utf-8")
            p_file.write_text(json.dumps(_sample_program_dict("omp")), encoding="utf-8")
            os.environ[_ENV_PROGRAM_VAR] = str(p_file)

            agent = ProgramAgent(logs_dir=host_dir, model_name="anthropic/claude-3-5-sonnet")
            env = MagicMock(spec=BaseEnvironment)
            env.exec = AsyncMock(return_value=MagicMock(return_code=0, stdout="", stderr=""))
            env.upload_file = AsyncMock()

            context = AgentContext()

            # Run agent
            import asyncio
            asyncio.run(agent.run("Fix the issue", env, context))

            # Verify exec calls: root mkdir, chmod, agent setup, agent run with tee to /logs/agent/omp.txt
            exec_calls = [call.kwargs.get("command") or (call.args[0] if call.args else "") for call in env.exec.call_args_list]
            run_cmd = [cmd for cmd in exec_calls if "/opt/omp-assets/omp --model" in cmd]
            self.assertTrue(len(run_cmd) >= 1)
            self.assertIn("tee /logs/agent/omp.txt", run_cmd[0])

    def test_pier_and_harbor_produce_identical_agent_command_and_upload_plan(self) -> None:
        from common.container_program import agent_command, load_program, uploads

        with tempfile.TemporaryDirectory() as tmpdir:
            host_dir = Path(tmpdir)
            p_file = host_dir / "program.json"
            p_file.write_text(json.dumps(_sample_program_dict("omp")), encoding="utf-8")
            (host_dir / "omp").write_text("#!/bin/sh\n", encoding="utf-8")
            (host_dir / "omp.env").write_text("API_KEY=123\n", encoding="utf-8")

            prog = load_program(p_file)
            instruction = 'Run benchmark test with "quotes"'
            model = "anthropic/claude-3-5-sonnet"

            cmd = agent_command(prog, instruction=instruction, model=model)
            ups = uploads(prog, host_dir)

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
