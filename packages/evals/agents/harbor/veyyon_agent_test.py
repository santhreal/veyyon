"""
Unit test suite for VeyyonAgent Harbor adapter.

Defends the observable contracts:
- Staged asset verification & upload lifecycle
- Correct ordered command execution for setup, priming, and agent invocation
- Timeout forwarding and timeout failure classification
- Token usage, cache token, and cost extraction into AgentContext
- Runtime enumeration of VeyyonAgent.ERROR_PATTERNS ensuring every declared pattern
  maps to its typed ApiError/NonZeroAgentExitCodeError exception.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from veyyon_agent import (
    AgentAuthenticationError,
    AgentContext,
    AgentSafetyRefusalError,
    ApiConnectionClosedError,
    ApiError,
    ApiInternalServerError,
    ApiOverloadedError,
    ApiProviderResourceNotFoundError,
    ApiRateLimitError,
    ApiResponseStalledError,
    ApiUsageLimitError,
    ArmAttachment,
    BaseEnvironment,
    ContextWindowExceededError,
    ModelNotFoundError,
    NetworkConnectionError,
    NonZeroAgentExitCodeError,
    OutputTokenExceededError,
    UnknownApiError,
    VeyyonAgent,
    attachment_directories,
    build_model_catalog_refresh_command,
    build_status_preserving_tee_command,
    environment_prefix,
    missing_attachment_files,
    parse_arm_attachments,
    parse_model_selector,
    parse_session_usage,
    rules_setup_command,
)


@dataclass
class ExecCall:
    command: str
    user: str | int | None = None
    env: dict[str, str] | None = None
    cwd: str | None = None
    timeout_sec: int | float | None = None


@dataclass
class ExecResult:
    return_code: int = 0
    stdout: str = ""
    stderr: str = ""

class FakeEnvironment(BaseEnvironment):
    """Stub environment for Harbor agent testing without Docker or network."""

    def __init__(self) -> None:
        self.exec_calls: list[ExecCall] = []
        self.uploaded_files: list[tuple[Path, str]] = []
        self.uploaded_dirs: list[tuple[Path, str]] = []
        self.downloaded_files: list[tuple[str, Path]] = []
        self.downloaded_dirs: list[tuple[str, Path]] = []
        self.exec_handler: Any = None
        self.default_user: str | int | None = "agent"

    @classmethod
    def type(cls) -> str:
        return "fake"

    def _validate_definition(self) -> None:
        pass

    async def start(self, force_build: bool = False) -> None:
        pass

    async def stop(self, delete: bool = True) -> None:
        pass

    async def exec(
        self,
        command: str,
        user: str | int | None = None,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | float | None = None,
    ) -> ExecResult:
        call = ExecCall(
            command=command,
            user=user,
            env=env,
            cwd=cwd,
            timeout_sec=timeout_sec,
        )
        self.exec_calls.append(call)
        if self.exec_handler:
            return await self.exec_handler(call)
        return ExecResult(return_code=0, stdout="", stderr="")

    async def upload_file(self, source: Path | str, destination: str) -> None:
        self.uploaded_files.append((Path(source), str(destination)))

    async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
        self.uploaded_dirs.append((Path(source_dir), str(target_dir)))

    async def download_file(self, source: str, destination: Path | str) -> None:
        self.downloaded_files.append((source, Path(destination)))

    async def download_dir(self, source_dir: str, target_dir: Path | str) -> None:
        self.downloaded_dirs.append((source_dir, Path(target_dir)))

class VeyyonAgentContractTest(unittest.IsolatedAsyncioTestCase):
    maxDiff = None

    def setUp(self) -> None:
        self.temp_dir = tempfile.mkdtemp(prefix="harbor-veyyon-test-")
        self.logs_dir = Path(self.temp_dir) / "logs"
        self.assets_dir = Path(self.temp_dir) / "assets"
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        self.assets_dir.mkdir(parents=True, exist_ok=True)

        # Stage minimal valid assets
        (self.assets_dir / "vey").write_text("#!/bin/sh\necho vey\n", encoding="utf-8")
        (self.assets_dir / "auth-agent.db").write_text("sqlite-db-mock", encoding="utf-8")
        arms_dir = self.assets_dir / "arms"
        arms_dir.mkdir(parents=True, exist_ok=True)
        (arms_dir / "default.yml").write_text("settings:\n  test: true\n", encoding="utf-8")
        (self.assets_dir / "attachments.json").write_text(
            json.dumps({"version": 1, "arms": {"default": []}}),
            encoding="utf-8",
        )
        self.env = FakeEnvironment()

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    async def test_identity_and_version(self) -> None:
        agent = VeyyonAgent(
            logs_dir=self.logs_dir,
            model_name="anthropic/claude-3-7-sonnet",
            assets_dir=str(self.assets_dir),
            arm_name="default",
            version="1.4.0",
        )
        self.assertEqual(agent.name(), "veyyon")
        self.assertEqual(agent.version(), "1.4.0")
        self.assertIsNone(agent.get_version_command())
        self.assertFalse(agent.SUPPORTS_ATIF)

    async def test_install_stages_assets_in_order(self) -> None:
        agent = VeyyonAgent(
            logs_dir=self.logs_dir,
            model_name="anthropic/claude-3-7-sonnet",
            assets_dir=str(self.assets_dir),
            arm_name="default",
        )

        await agent.install(self.env)

        # Verify uploaded files
        uploaded_destinations = [dst for _, dst in self.env.uploaded_files]
        self.assertIn("/opt/veyyon-assets/vey", uploaded_destinations)
        self.assertIn("/opt/veyyon-assets/auth-agent.db", uploaded_destinations)
        self.assertIn("/opt/veyyon-assets/arm.yml", uploaded_destinations)

        # Verify command sequence
        commands = [call.command for call in self.env.exec_calls]
        self.assertTrue(any("mkdir -p /opt/veyyon-assets" in cmd for cmd in commands))
        self.assertTrue(any("chmod +x /opt/veyyon-assets/vey" in cmd for cmd in commands))
        self.assertTrue(
            any(
                "mkdir -p ~/.veyyon/shared-auth" in cmd
                and "cp /opt/veyyon-assets/auth-agent.db ~/.veyyon/shared-auth/agent.db" in cmd
                and "cp /opt/veyyon-assets/arm.yml ~/.veyyon/arm.yml" in cmd
                for cmd in commands
            )
        )

    async def test_install_missing_required_asset_fails_before_exec(self) -> None:
        # Delete the binary
        (self.assets_dir / "vey").unlink()

        agent = VeyyonAgent(
            logs_dir=self.logs_dir,
            model_name="anthropic/claude-3-7-sonnet",
            assets_dir=str(self.assets_dir),
            arm_name="default",
        )

        with self.assertRaises(ValueError) as ctx:
            await agent.install(self.env)
        self.assertIn("veyyon asset missing on host", str(ctx.exception))
        self.assertEqual(len(self.env.exec_calls), 0)

    async def test_run_requires_model(self) -> None:
        agent = VeyyonAgent(
            logs_dir=self.logs_dir,
            model_name=None,
            assets_dir=str(self.assets_dir),
        )
        context = AgentContext()
        with self.assertRaises(ValueError) as ctx:
            await agent.run("fix bug", self.env, context)
        self.assertIn("requires --model", str(ctx.exception))

    async def test_run_executes_priming_and_logged_invocation(self) -> None:
        agent = VeyyonAgent(
            logs_dir=self.logs_dir,
            model_name="anthropic/claude-3-7-sonnet-20250219",
            assets_dir=str(self.assets_dir),
            arm_name="default",
            timeout_sec=300,
        )
        context = AgentContext()

        # Mock sessions directory on host to test post-run sync
        sessions_dir = self.logs_dir / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        session_file = sessions_dir / "session-1.jsonl"
        session_data = [
            {
                "message": {
                    "role": "assistant",
                    "usage": {
                        "input": 1200,
                        "output": 350,
                        "cacheRead": 500,
                        "cacheWrite": 100,
                        "cost": {"total": 0.045},
                    },
                    "content": [
                        {"type": "toolCall", "name": "edit", "arguments": {}},
                        {"type": "text", "text": "Analyzing §123"},
                    ],
                }
            },
            {
                "message": {
                    "role": "toolResult",
                    "toolName": "argot_load",
                    "content": "loaded",
                }
            },
        ]
        session_file.write_text(
            "\n".join(json.dumps(entry) for entry in session_data), encoding="utf-8"
        )

        await agent.run("Solve the problem", self.env, context)

        # Check that veyyon command was invoked with required flags
        agent_execs = [
            call for call in self.env.exec_calls if "/opt/veyyon-assets/vey" in call.command
        ]
        self.assertTrue(len(agent_execs) >= 1)
        run_call = agent_execs[-1]
        self.assertIn("models refresh anthropic", run_call.command)
        self.assertIn("--model anthropic/claude-3-7-sonnet-20250219", run_call.command)
        self.assertIn("--auto-approve", run_call.command)
        self.assertIn("--config $HOME/.veyyon/arm.yml", run_call.command)
        self.assertIn("--print 'Solve the problem'", run_call.command)
        self.assertIn("/logs/agent/veyyon.txt", run_call.command)
        self.assertEqual(run_call.timeout_sec, 300)

        # Verify usage in context
        self.assertEqual(context.n_input_tokens, 1200)
        self.assertEqual(context.n_output_tokens, 350)
        self.assertEqual(context.n_cache_tokens, 600)  # 500 + 100
        self.assertAlmostEqual(context.cost_usd or 0.0, 0.045)
        self.assertIsNotNone(context.metadata)
        assert context.metadata is not None
        self.assertEqual(context.metadata.get("arm"), "default")
        self.assertEqual(context.metadata.get("argot_load_calls"), 1)
        self.assertEqual(context.metadata.get("assistant_msgs_with_sigil"), 1)
        self.assertEqual(context.metadata.get("tool_calls"), {"edit": 1})

    async def test_run_with_attachments_env_json_and_rules_dir(self) -> None:
        # Create attachments manifest and files
        prompts_dir = self.assets_dir / "prompts"
        rules_dir = self.assets_dir / "rules"
        prompts_dir.mkdir(parents=True, exist_ok=True)
        rules_dir.mkdir(parents=True, exist_ok=True)
        (prompts_dir / "custom.json").write_text('{"sys": "test"}', encoding="utf-8")
        (rules_dir / "guidelines.md").write_text("# Rules\nBe precise.", encoding="utf-8")

        manifest = {
            "version": 1,
            "arms": {
                "variant_arm": [
                    {
                        "kind": "prompts",
                        "file": "prompts/custom.json",
                        "delivery": "env-json",
                        "envVar": "VEYYON_EVAL_PROMPTS",
                    },
                    {
                        "kind": "rule",
                        "file": "rules/guidelines.md",
                        "delivery": "rules-dir",
                    },
                ]
            },
        }
        (self.assets_dir / "attachments.json").write_text(
            json.dumps(manifest), encoding="utf-8"
        )
        (self.assets_dir / "arms" / "variant_arm.yml").write_text(
            "arm: variant_arm\n", encoding="utf-8"
        )

        agent = VeyyonAgent(
            logs_dir=self.logs_dir,
            model_name="openai/gpt-4o",
            assets_dir=str(self.assets_dir),
            arm_name="variant_arm",
        )
        context = AgentContext()
        await agent.run("Perform task", self.env, context)

        # Verify uploads for attachments
        uploaded_destinations = [dst for _, dst in self.env.uploaded_files]
        self.assertIn("/opt/veyyon-assets/prompts/custom.json", uploaded_destinations)
        self.assertIn("/opt/veyyon-assets/rules/guidelines.md", uploaded_destinations)

        # Verify environment variable injection in the run command
        run_calls = [
            call for call in self.env.exec_calls if "VEYYON_EVAL_PROMPTS" in call.command
        ]
        self.assertTrue(len(run_calls) >= 1)
        self.assertIn(
            'VEYYON_EVAL_PROMPTS="$(cat /opt/veyyon-assets/prompts/custom.json)"',
            run_calls[0].command,
        )

        # Verify rules copy command in install setup
        setup_calls = [
            call for call in self.env.exec_calls if "~/.veyyon/rules" in call.command
        ]
        self.assertTrue(len(setup_calls) >= 1)
        self.assertIn(
            "cp /opt/veyyon-assets/rules/guidelines.md ~/.veyyon/rules/",
            setup_calls[0].command,
        )

    async def test_prompt_template_rendering(self) -> None:
        template_file = Path(self.temp_dir) / "template.md"
        template_file.write_text("PREFIX {{instruction}} SUFFIX", encoding="utf-8")

        agent = VeyyonAgent(
            logs_dir=self.logs_dir,
            model_name="anthropic/claude-3-7-sonnet",
            assets_dir=str(self.assets_dir),
            prompt_template_path=template_file,
        )
        context = AgentContext()
        await agent.run("raw instruction", self.env, context)

        run_calls = [
            call for call in self.env.exec_calls if "--print" in call.command
        ]
        self.assertTrue(len(run_calls) >= 1)
        self.assertIn("--print 'PREFIX raw instruction SUFFIX'", run_calls[0].command)

    async def test_replay_result_parsing(self) -> None:
        replay_result = {
            "input_tokens": 5000,
            "output_tokens": 1200,
            "cache_tokens": 800,
            "provider_cost_supported": True,
            "cost_usd": 0.082,
            "patch_path": "/logs/agent/patch.diff",
            "transcript_path": "/logs/agent/transcript.md",
            "log_path": "/logs/agent/veyyon.txt",
            "native_compaction": {"artifact": "/logs/agent/compaction.json"},
        }
        (self.logs_dir / "veyyon-result.json").write_text(
            json.dumps(replay_result), encoding="utf-8"
        )

        agent = VeyyonAgent(
            logs_dir=self.logs_dir,
            model_name="anthropic/claude-3-7-sonnet",
            assets_dir=str(self.assets_dir),
        )
        context = AgentContext()
        agent.populate_context_post_run(context)

        self.assertEqual(context.n_input_tokens, 5000)
        self.assertEqual(context.n_output_tokens, 1200)
        self.assertEqual(context.n_cache_tokens, 800)
        self.assertAlmostEqual(context.cost_usd or 0.0, 0.082)
        assert context.metadata is not None
        self.assertEqual(context.metadata.get("system"), "veyyon")
        self.assertEqual(
            context.metadata.get("patch_path"), str(self.logs_dir / "patch.diff")
        )

    async def test_command_timeout_is_propagated(self) -> None:
        async def timeout_handler(call: ExecCall) -> ExecResult:
            if "/opt/veyyon-assets/vey" in call.command:
                raise asyncio.TimeoutError("Execution timed out after 30 seconds")
            return ExecResult(return_code=0)

        self.env.exec_handler = timeout_handler
        agent = VeyyonAgent(
            logs_dir=self.logs_dir,
            model_name="anthropic/claude-3-7-sonnet",
            assets_dir=str(self.assets_dir),
            timeout_sec=30,
        )
        context = AgentContext()
        with self.assertRaises(asyncio.TimeoutError):
            await agent.run("Slow task", self.env, context)


class ErrorPatternCoverageTest(unittest.TestCase):
    """
    Exhaustively verifies every pattern in VeyyonAgent.ERROR_PATTERNS dynamically.
    Ensures that adding an ErrorPattern without a test case fails this test suite.
    """

    # Map of expected exception class to a sample stdout/stderr string that triggers it
    SAMPLE_FAILURES: ClassVar[dict[type[NonZeroAgentExitCodeError], list[str]]] = {
        ApiRateLimitError: [
            "Error: 429 Too Many Requests: Rate limit reached",
            "Provider reports: rate-limit triggered on prompt tokens",
            "HTTP 429: too many requests for current tier",
        ],
        ApiUsageLimitError: [
            "Your request exceeded specified API usage limits for this organization",
            "Error: You've hit your usage limit. Upgrade your plan.",
            "Account suspended: You have an unpaid invoice on file",
            "Error: Quota exceeded for model queries",
            "OpenAI error: insufficient_quota",
            "Anthropic error: credit balance is too low",
        ],
        ApiInternalServerError: [
            "API Error: 500 Internal server error from provider gateway",
            "RetriableError: [internal] Error during inference stream",
            "HTTP/1.1 500 Internal Server Error",
        ],
        ApiOverloadedError: [
            "API Error: Overloaded backend servers",
            "ServiceUnavailableError: cluster at maximum capacity",
            "Selected model is at capacity. Please try a different model.",
            "HTTP 503 Service Unavailable",
        ],
        ApiConnectionClosedError: [
            "API Error: Connection closed mid-response while streaming tokens",
            "API Error: stream closed before completion from server",
        ],
        ApiResponseStalledError: [
            "API Error: Response stalled mid-stream after 60s idle",
        ],
        OutputTokenExceededError: [
            "Error: response exceeded 8192 output token maximum",
            "Stop reason: max_tokens exceeded",
        ],
        ContextWindowExceededError: [
            "Error: input token count exceeds the maximum number of tokens allowed",
            "InvalidRequestError: prompt is too long: 215000 tokens > 200000 maximum",
            "context_length_exceeded for model",
        ],
        AgentAuthenticationError: [
            "Error: Not logged in. Run 'vey auth login' to authenticate.",
            "HTTP 401: Unauthorized access to provider",
            "401 Unauthorized",
            "Invalid API key provided",
        ],
        ModelNotFoundError: [
            "Cannot use this model: provider/unknown-model-id",
            "The model 'gpt-5-preview' does not exist",
        ],
        ApiProviderResourceNotFoundError: [
            "Provider Error We're having trouble finding the resource you requested",
        ],
        AgentSafetyRefusalError: [
            "Request blocked by safety measures that flagged harmful prompt",
            "Refusal: Cyber Verification Program safeguard triggered",
            "Content flagged for possible cybersecurity risk",
            "Trusted Access for Cyber required to run this command",
            "chatgpt.com/cyber",
            "Output blocked by content filtering policy",
            "Prompt appears to violate our Usage Policy",
            "triggered cyber-related safeguards in model policy",
            "model_refusal_no_fallback",
            "ContentFilterError: generation stopped",
            '{"reason": "content-filter"}',
        ],
        UnknownApiError: [
            "Generic API Error occurred during completion",
        ],
        NetworkConnectionError: [
            "SSL_ERROR_SYSCALL in connection to api.anthropic.com",
            "SSL_connect error: certificate verify failed",
            "curl: (6) Could not resolve host: api.openai.com",
            "curl: (7) Connection refused",
            "Connection timed out after 30000 milliseconds",
            "Request timed out contacting upstream gateway",
            "curl: (28) Operation timeout",
        ],
    }

    def setUp(self) -> None:
        self.temp_dir = tempfile.mkdtemp()
        self.agent = VeyyonAgent(
            logs_dir=Path(self.temp_dir),
            model_name="anthropic/claude-3-7-sonnet",
            assets_dir=self.temp_dir,
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_all_declared_error_patterns_are_covered_in_test_matrix(self) -> None:
        """
        Enumerate all unique exception types in VeyyonAgent.ERROR_PATTERNS at run time.
        Fails if any declared exception class lacks a sample in SAMPLE_FAILURES.
        """
        declared_exception_types = {
            pattern.exception for pattern in VeyyonAgent.ERROR_PATTERNS
        }
        untested_types = declared_exception_types - set(self.SAMPLE_FAILURES.keys())
        self.assertEqual(
            untested_types,
            set(),
            f"The following ErrorPattern exception types lack test cases: {untested_types}",
        )

    def test_each_pattern_matches_expected_exception(self) -> None:
        """
        Drive _classify_exec_error with each sample failure text and assert
        the exact classified exception type.
        """
        for exc_type, samples in self.SAMPLE_FAILURES.items():
            for sample in samples:
                with self.subTest(exception=exc_type.__name__, sample=sample):
                    result = ExecResult(return_code=1, stdout=sample, stderr="")
                    classified = self.agent._classify_exec_error(
                        "vey run --model ...", result
                    )
                    self.assertIsInstance(
                        classified,
                        exc_type,
                        f"Sample {sample!r} was classified as {type(classified).__name__}, expected {exc_type.__name__}",
                    )

    def test_unmatched_failure_falls_back_to_generic_exit_code_error(self) -> None:
        result = ExecResult(
            return_code=42,
            stdout="Syntax error in some user script",
            stderr="line 10: unexpected token",
        )
        classified = self.agent._classify_exec_error("vey run", result)
        self.assertIs(type(classified), NonZeroAgentExitCodeError)
        self.assertIn("exit 42", str(classified))


class ManifestAndHelperFunctionsTest(unittest.TestCase):
    maxDiff = None

    def test_parse_model_selector(self) -> None:
        self.assertEqual(
            parse_model_selector("anthropic/claude-3-7-sonnet"),
            ("anthropic", "claude-3-7-sonnet"),
        )
        self.assertEqual(
            parse_model_selector("openrouter/meta-llama/llama-3-70b-instruct"),
            ("openrouter", "meta-llama/llama-3-70b-instruct"),
        )
        with self.assertRaises(ValueError):
            parse_model_selector("bare-model-without-provider")
        with self.assertRaises(ValueError):
            parse_model_selector("invalid provider/model")

    def test_arm_attachments_manifest_validation(self) -> None:
        manifest_text = json.dumps(
            {
                "version": 1,
                "arms": {
                    "arm_a": [
                        {
                            "kind": "prompts",
                            "file": "prompts/p.json",
                            "delivery": "env-json",
                            "envVar": "CUSTOM_PROMPT",
                        }
                    ]
                },
            }
        )
        attachments = parse_arm_attachments(manifest_text, "arm_a")
        self.assertEqual(len(attachments), 1)
        self.assertEqual(attachments[0].kind, "prompts")
        self.assertEqual(attachments[0].file, "prompts/p.json")
        self.assertEqual(attachments[0].delivery, "env-json")
        self.assertEqual(attachments[0].env_var, "CUSTOM_PROMPT")

        # Unsupported manifest version
        bad_version = json.dumps({"version": 2, "arms": {}})
        with self.assertRaises(ValueError):
            parse_arm_attachments(bad_version, "arm_a")

        # Escape path
        escaping_path = json.dumps(
            {
                "version": 1,
                "arms": {
                    "arm_a": [
                        {
                            "kind": "prompts",
                            "file": "../escape.json",
                            "delivery": "env-json",
                            "envVar": "VAR",
                        }
                    ]
                },
            }
        )
        with self.assertRaises(ValueError):
            parse_arm_attachments(escaping_path, "arm_a")

        # Missing arm raises ValueError (fail-closed)
        missing_arm_manifest = json.dumps(
            {
                "version": 1,
                "arms": {"arm_a": []},
            }
        )
        with self.assertRaises(ValueError) as ctx:
            parse_arm_attachments(missing_arm_manifest, "arm_b")
        self.assertIn("does not name arm 'arm_b'", str(ctx.exception))
    def test_model_catalog_refresh_command_construction(self) -> None:
        cmd = build_model_catalog_refresh_command(
            binary="/opt/veyyon-assets/vey",
            model_name="anthropic/claude-3-7-sonnet",
            log_path="/logs/agent/catalog.log",
            timeout_seconds=60,
        )
        self.assertIn("timeout -k 5s 60s /opt/veyyon-assets/vey models refresh anthropic", cmd)
        self.assertIn("grep -F -- '\"selector\":\"anthropic/claude-3-7-sonnet\"'", cmd)

    def test_status_preserving_tee_command_construction(self) -> None:
        cmd = build_status_preserving_tee_command(
            command="echo hello",
            log_path="/logs/agent/output.log",
        )
        self.assertIn("( echo hello; printf '%s\\n' \"$?\" >\"$veyyon_status_file\" )", cmd)
        self.assertIn("| tee /logs/agent/output.log", cmd)


if __name__ == "__main__":
    unittest.main()
