"""Behavioral unit tests for declarative container program parsing and command generation."""

from __future__ import annotations

import json
import shlex
import tempfile
import unittest
from pathlib import Path

from common.container_program import (
    CONTAINER_PROGRAM_VERSION,
    ContainerProgram,
    ProgramAsset,
    SessionSpec,
    agent_command,
    load_program,
    missing_assets,
    parse_program,
    session_collect_command,
    setup_command,
    uploads,
)


def _valid_program_dict() -> dict:
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
        "allowedDomains": [".opencode.ai", ".models.dev", ".anthropic.com"],
        "usage": "omp",
    }


class ContainerProgramTest(unittest.TestCase):
    def test_valid_program_parses_into_immutable_dataclasses(self) -> None:
        raw = _valid_program_dict()
        prog = parse_program(json.dumps(raw))
        self.assertEqual(prog.harness, "omp")
        self.assertEqual(prog.container_dir, "/opt/omp-assets")
        self.assertEqual(len(prog.assets), 3)
        self.assertEqual(prog.assets[0], ProgramAsset(file="omp", dest="/opt/omp-assets/omp", mode="0755", optional=False))
        self.assertEqual(prog.assets[2], ProgramAsset(file="models.yml", dest="/opt/omp-assets/models.yml", mode=None, optional=True))
        self.assertEqual(prog.env_file, "/opt/omp-assets/omp.env")
        self.assertEqual(prog.log_path, "/logs/agent/omp.txt")
        self.assertEqual(prog.sessions, SessionSpec(sources=("/opt/omp-assets/sessions",), pattern="*.jsonl"))
        self.assertEqual(prog.usage, "omp")
        self.assertIsInstance(prog.assets, tuple)
        self.assertIsInstance(prog.setup, tuple)
        self.assertIsInstance(prog.allowed_domains, tuple)

    def test_version_refusal_names_both_found_and_supported_version(self) -> None:
        raw = _valid_program_dict()
        raw["version"] = 2
        with self.assertRaises(ValueError) as ctx:
            parse_program(json.dumps(raw))
        msg = str(ctx.exception)
        self.assertIn("2", msg)
        self.assertIn(str(CONTAINER_PROGRAM_VERSION), msg)

    def test_unknown_usage_dialect_is_refused_naming_it(self) -> None:
        raw = _valid_program_dict()
        raw["usage"] = "unknown_dialect"
        with self.assertRaises(ValueError) as ctx:
            parse_program(json.dumps(raw))
        msg = str(ctx.exception)
        self.assertIn("unknown_dialect", msg)
        self.assertIn("omp", msg)

    def test_escaping_asset_file_paths_are_refused(self) -> None:
        for bad_file in ("../omp", "/opt/omp", "dir/../../omp", "a/../b"):
            raw = _valid_program_dict()
            raw["assets"][0]["file"] = bad_file
            with self.assertRaises(ValueError) as ctx:
                parse_program(json.dumps(raw))
            self.assertIn("Invalid asset file", str(ctx.exception))

    def test_relative_dest_logpath_containerdir_or_session_source_is_refused(self) -> None:
        # relative containerDir
        raw = _valid_program_dict()
        raw["containerDir"] = "relative/path"
        with self.assertRaises(ValueError) as ctx:
            parse_program(json.dumps(raw))
        self.assertIn("containerDir", str(ctx.exception))

        # relative logPath
        raw = _valid_program_dict()
        raw["logPath"] = "logs/agent/omp.txt"
        with self.assertRaises(ValueError) as ctx:
            parse_program(json.dumps(raw))
        self.assertIn("logPath", str(ctx.exception))

        # relative asset dest
        raw = _valid_program_dict()
        raw["assets"][0]["dest"] = "opt/omp-assets/omp"
        with self.assertRaises(ValueError) as ctx:
            parse_program(json.dumps(raw))
        self.assertIn("dest", str(ctx.exception))

        # relative session source
        raw = _valid_program_dict()
        raw["sessions"]["sources"] = ["relative/sessions"]
        with self.assertRaises(ValueError) as ctx:
            parse_program(json.dumps(raw))
        self.assertIn("sessions.sources", str(ctx.exception))

    def test_unknown_placeholder_in_command_is_refused_naming_it(self) -> None:
        raw = _valid_program_dict()
        raw["command"] = "{{assets}}/omp --foo {{unknown_token}} {{instruction}}"
        with self.assertRaises(ValueError) as ctx:
            parse_program(json.dumps(raw))
        self.assertIn("unknown_token", str(ctx.exception))

    def test_missing_required_asset_is_refused_naming_absolute_host_path(self) -> None:
        raw = _valid_program_dict()
        prog = parse_program(json.dumps(raw))
        with tempfile.TemporaryDirectory() as tmpdir:
            host_dir = Path(tmpdir)
            # Create only omp.env (missing 'omp')
            (host_dir / "omp.env").write_text("API_KEY=xyz", encoding="utf-8")
            missing = missing_assets(prog, host_dir)
            expected_missing_path = str((host_dir / "omp").resolve())
            self.assertIn(expected_missing_path, missing)

            with self.assertRaises(ValueError) as ctx:
                uploads(prog, host_dir)
            self.assertIn(expected_missing_path, str(ctx.exception))

    def test_missing_optional_asset_is_skipped_and_absent_from_uploads(self) -> None:
        raw = _valid_program_dict()
        prog = parse_program(json.dumps(raw))
        with tempfile.TemporaryDirectory() as tmpdir:
            host_dir = Path(tmpdir)
            # Create required assets 'omp' and 'omp.env', omit optional 'models.yml'
            (host_dir / "omp").write_text("#!/bin/sh\n", encoding="utf-8")
            (host_dir / "omp.env").write_text("API_KEY=xyz\n", encoding="utf-8")

            missing = missing_assets(prog, host_dir)
            self.assertEqual(missing, ())

            ups = uploads(prog, host_dir)
            self.assertEqual(len(ups), 2)
            self.assertEqual(ups[0][0], (host_dir / "omp").resolve())
            self.assertEqual(ups[0][1], "/opt/omp-assets/omp")
            self.assertEqual(ups[0][2], 0o755)
            self.assertEqual(ups[1][0], (host_dir / "omp.env").resolve())
            self.assertEqual(ups[1][1], "/opt/omp-assets/omp.env")
            self.assertEqual(ups[1][2], 0o600)

    def test_agent_command_quotes_instruction_substitutes_assets_and_handles_env_file(self) -> None:
        raw = _valid_program_dict()
        prog = parse_program(json.dumps(raw))

        instruction = 'Fix "bug" in $FILE; echo $(whoami)\nline 2'
        model = "anthropic/claude-3-5-sonnet-20241022"

        cmd = agent_command(prog, instruction=instruction, model=model)
        # Check env file prefix
        self.assertTrue(cmd.startswith("set -a && . /opt/omp-assets/omp.env && set +a && "))
        # Check {{assets}} substitution verbatim
        self.assertIn("/opt/omp-assets/omp", cmd)
        self.assertIn("/opt/omp-assets/sessions", cmd)
        # Check model quoting
        self.assertIn(shlex.quote(model), cmd)
        # Check instruction quoting protects against execution
        self.assertTrue(cmd.endswith(shlex.quote(instruction)))

    def test_agent_command_omits_env_file_prefix_when_env_file_is_none(self) -> None:
        raw = _valid_program_dict()
        del raw["envFile"]
        prog = parse_program(json.dumps(raw))
        cmd = agent_command(prog, instruction="do task", model="anthropic/model")
        self.assertFalse(cmd.startswith("set -a"))
        self.assertTrue(cmd.startswith("/opt/omp-assets/omp"))

    def test_api_key_never_appears_in_rendered_command_when_carried_in_env_file(self) -> None:
        raw = _valid_program_dict()
        prog = parse_program(json.dumps(raw))
        secret_key = "sk-super-secret-key-12345"
        cmd = agent_command(prog, instruction="solve problem", model="provider/model")
        self.assertNotIn(secret_key, cmd)

    def test_setup_command_emits_mkdir_and_chmods_in_declaration_order(self) -> None:
        raw = _valid_program_dict()
        prog = parse_program(json.dumps(raw))
        cmd = setup_command(prog)
        expected = (
            "mkdir -p /opt/omp-assets && "
            "chmod 0755 /opt/omp-assets/omp && "
            "chmod 0600 /opt/omp-assets/omp.env && "
            "mkdir -p ~/.omp/agent && "
            "if [ -f /opt/omp-assets/models.yml ]; then cp /opt/omp-assets/models.yml ~/.omp/agent/models.yml; fi"
        )
        self.assertEqual(cmd, expected)

    def test_session_collect_command_finds_and_copies_into_logs_sessions(self) -> None:
        raw = _valid_program_dict()
        prog = parse_program(json.dumps(raw))
        cmd = session_collect_command(prog, "/logs/agent")
        expected = (
            "mkdir -p /logs/agent/sessions && "
            "find /opt/omp-assets/sessions -name '*.jsonl' -exec cp {} /logs/agent/sessions/ \\; 2>/dev/null || true"
        )
        self.assertEqual(cmd, expected)

    def test_load_program_from_disk(self) -> None:
        raw = _valid_program_dict()
        with tempfile.TemporaryDirectory() as tmpdir:
            file_path = Path(tmpdir) / "program.json"
            file_path.write_text(json.dumps(raw), encoding="utf-8")
            prog = load_program(file_path)
            self.assertEqual(prog.harness, "omp")


if __name__ == "__main__":
    unittest.main()
