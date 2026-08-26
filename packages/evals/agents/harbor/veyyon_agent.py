"""
Veyyon agent adapter for Harbor (harbor-framework), used to run Terminal-Bench 3.0
and other Harbor evaluation suites against a locally built or staged `vey` binary.

Delivery model: veyyon is evaluated at the revision under test, so the runner stages
the compiled `vey` binary, a seeded shared-auth credential DB, and the per-arm config
overlay into an assets directory. The agent uploads them into the task container with
`environment.upload_file` during `install()` / `setup()` (or run time).
"""

from __future__ import annotations

import functools
import json
import logging
import os
import re
import shlex
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, ClassVar, Literal, Self, Sequence

CONTAINER_ASSETS_DIR = "/opt/veyyon-assets"
MODEL_CATALOG_REFRESH_TIMEOUT_SECONDS = 120

# ---------------------------------------------------------------------------
# Harbor base classes and error hierarchy
# ---------------------------------------------------------------------------
# When harbor is installed, import the real base classes. When running in a plain
# Python environment (e.g. unit tests outside the Harbor uv tool environment),
# provide compatible stubs so the module imports and functions without error.

try:
    from harbor.agents.installed.base import (  # type: ignore[import-not-found]
        AgentAuthenticationError as HarborAgentAuthenticationError,
        AgentSafetyRefusalError as HarborAgentSafetyRefusalError,
        ApiConnectionClosedError as HarborApiConnectionClosedError,
        ApiError as HarborApiError,
        ApiInternalServerError as HarborApiInternalServerError,
        ApiOverloadedError as HarborApiOverloadedError,
        ApiProviderResourceNotFoundError as HarborApiProviderResourceNotFoundError,
        ApiRateLimitError as HarborApiRateLimitError,
        ApiResponseStalledError as HarborApiResponseStalledError,
        ApiUsageLimitError as HarborApiUsageLimitError,
        BaseInstalledAgent as HarborBaseInstalledAgent,
        CliFlag as HarborCliFlag,
        ContextWindowExceededError as HarborContextWindowExceededError,
        EnvVar as HarborEnvVar,
        ErrorPattern as HarborErrorPattern,
        ModelNotFoundError as HarborModelNotFoundError,
        NetworkConnectionError as HarborNetworkConnectionError,
        NonZeroAgentExitCodeError as HarborNonZeroAgentExitCodeError,
        OutputTokenExceededError as HarborOutputTokenExceededError,
        PackageSpec as HarborPackageSpec,
        UnknownApiError as HarborUnknownApiError,
        with_prompt_template as harbor_with_prompt_template,
    )
    from harbor.environments.base import BaseEnvironment as HarborBaseEnvironment  # type: ignore[import-not-found]
    from harbor.models.agent.context import AgentContext as HarborAgentContext  # type: ignore[import-not-found]

    HAS_HARBOR = True
except ImportError:
    HAS_HARBOR = False

    # Standalone fallback definitions
    class HarborNonZeroAgentExitCodeError(RuntimeError):
        """Raised when the agent process exits with a non-zero exit code."""

    class HarborApiError(HarborNonZeroAgentExitCodeError):
        """Base class for model provider API errors detected in agent output."""

    class HarborApiRateLimitError(HarborApiError):
        pass

    class HarborApiUsageLimitError(HarborApiError):
        pass

    class HarborApiInternalServerError(HarborApiError):
        pass

    class HarborApiOverloadedError(HarborApiError):
        pass

    class HarborApiConnectionClosedError(HarborApiError):
        pass

    class HarborApiResponseStalledError(HarborApiError):
        pass

    class HarborOutputTokenExceededError(HarborApiError):
        pass

    class HarborContextWindowExceededError(HarborApiError):
        pass

    class HarborUnknownApiError(HarborApiError):
        pass

    class HarborApiProviderResourceNotFoundError(HarborApiError):
        pass

    class HarborAgentSafetyRefusalError(HarborApiError):
        pass

    class HarborAgentAuthenticationError(HarborNonZeroAgentExitCodeError):
        pass

    class HarborModelNotFoundError(HarborNonZeroAgentExitCodeError):
        pass

    class HarborNetworkConnectionError(HarborNonZeroAgentExitCodeError):
        pass

    @dataclass
    class HarborErrorPattern:
        pattern: str
        exception: type[HarborNonZeroAgentExitCodeError]

    @dataclass
    class HarborCliFlag:
        kwarg: str
        cli: str
        type: Literal["str", "int", "bool", "enum"] = "str"
        choices: list[str] | None = None
        default: Any = None
        env_fallback: str | None = None
        format: str | None = None

    @dataclass
    class HarborEnvVar:
        kwarg: str
        env: str
        type: Literal["str", "int", "bool", "enum"] = "str"
        choices: list[str] | None = None
        default: Any = None
        env_fallback: str | None = None
        bool_true: str = "true"
        bool_false: str = "false"

    @dataclass(frozen=True)
    class HarborPackageSpec:
        commands: tuple[str, ...]
        packages: dict[str, tuple[str, ...]]
        always_install: bool = False

    class HarborAgentContext:
        def __init__(
            self,
            n_input_tokens: int | None = None,
            n_cache_tokens: int | None = None,
            n_output_tokens: int | None = None,
            cost_usd: float | None = None,
            metadata: dict[str, Any] | None = None,
            rollout_details: list[Any] | None = None,
        ) -> None:
            self.n_input_tokens = n_input_tokens
            self.n_cache_tokens = n_cache_tokens
            self.n_output_tokens = n_output_tokens
            self.cost_usd = cost_usd
            self.metadata = metadata
            self.rollout_details = rollout_details

    class HarborBaseEnvironment:
        default_user: str | int | None = None

        async def exec(
            self,
            command: str,
            user: str | int | None = None,
            env: dict[str, str] | None = None,
            cwd: str | None = None,
            timeout_sec: int | float | None = None,
        ) -> Any:
            raise NotImplementedError

        async def upload_file(self, source: Path | str, destination: str) -> None:
            raise NotImplementedError

        async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
            raise NotImplementedError

    def harbor_with_prompt_template(fn: Any) -> Any:
        @functools.wraps(fn)
        async def wrapper(
            self: Any, instruction: str, *args: Any, **kwargs: Any
        ) -> None:
            instruction = self.render_instruction(instruction)
            return await fn(self, instruction, *args, **kwargs)

        return wrapper

    class HarborBaseInstalledAgent:
        CLI_FLAGS: ClassVar[list[HarborCliFlag]] = []
        ENV_VARS: ClassVar[list[HarborEnvVar]] = []
        SYSTEM_PACKAGES: ClassVar[dict[str, HarborPackageSpec]] = {}
        ERROR_PATTERNS: ClassVar[list[HarborErrorPattern]] = []

        SUPPORTS_ATIF: bool = False
        SUPPORTS_RESUME: bool = False
        SUPPORTS_LOAD_NATIVE_TRAJECTORY: bool = False
        SUPPORTS_LOAD_ATIF_TRAJECTORY: bool = False
        SUPPORTS_HANDOFF: bool = False
        SUPPORTS_CONFIG: bool = False
        SUPPORTS_WINDOWS: bool = False

        def __init__(
            self,
            logs_dir: Path | str,
            model_name: str | None = None,
            prompt_template_path: Path | str | None = None,
            version: str | None = None,
            extra_env: dict[str, str] | None = None,
            *args: Any,
            **kwargs: Any,
        ) -> None:
            self.logs_dir = Path(logs_dir)
            self.environment_logs_dir = PurePosixPath("/logs/agent")
            self.model_name = model_name
            self.logger = logging.getLogger(self.__class__.__name__)
            self._extra_env = dict(extra_env) if extra_env else {}
            self._prompt_template_path = (
                Path(prompt_template_path) if prompt_template_path else None
            )
            self._version = version
            self._compiled_error_patterns = [
                (re.compile(p.pattern, re.IGNORECASE), p.exception)
                for p in self.ERROR_PATTERNS
            ]

        @property
        def extra_env(self) -> dict[str, str]:
            return dict(self._extra_env)

        def render_instruction(self, instruction: str) -> str:
            if self._prompt_template_path and self._prompt_template_path.is_file():
                template = self._prompt_template_path.read_text(encoding="utf-8")
                return template.replace("{{instruction}}", instruction).replace(
                    "{instruction}", instruction
                )
            return instruction

        def _truncate_output(self, text: str | None, max_len: int = 1000) -> str:
            if not text:
                return "None"
            if len(text) <= max_len:
                return text
            head_len = max_len // 4
            tail_len = max_len - head_len
            omitted = len(text) - head_len - tail_len
            return f"{text[:head_len]} ... [{omitted} chars truncated] ... {text[-tail_len:]}"

        def _classify_exec_error(
            self, command: str, result: Any
        ) -> HarborNonZeroAgentExitCodeError:
            detail = (
                f"Command failed (exit {getattr(result, 'return_code', 1)}): {command}\n"
                f"stdout: {self._truncate_output(getattr(result, 'stdout', ''))}\n"
                f"stderr: {self._truncate_output(getattr(result, 'stderr', ''))}"
            )
            output = f"{getattr(result, 'stdout', '') or ''}\n{getattr(result, 'stderr', '') or ''}"
            skip_asr = (
                "model_refusal_fallback" in output
                and "model_refusal_no_fallback" not in output
            )
            last_match: (
                tuple[int, re.Pattern[str], type[HarborNonZeroAgentExitCodeError]]
                | None
            ) = None
            for compiled, exception in self._compiled_error_patterns:
                if skip_asr and issubclass(exception, HarborAgentSafetyRefusalError):
                    continue
                for match in compiled.finditer(output):
                    if last_match is None or match.end() > last_match[0]:
                        last_match = (match.end(), compiled, exception)

            if last_match is not None:
                _, compiled, exception = last_match
                return exception(detail)
            return HarborNonZeroAgentExitCodeError(detail)

        async def _exec(
            self,
            environment: Any,
            command: str,
            user: str | int | None = None,
            env: dict[str, str] | None = None,
            cwd: str | None = None,
            timeout_sec: int | float | None = None,
        ) -> Any:
            result = await environment.exec(
                command=f"set -o pipefail; {command}",
                user=user,
                env=env,
                cwd=cwd,
                timeout_sec=timeout_sec,
            )
            return_code = getattr(result, "return_code", 0)
            if return_code != 0:
                raise self._classify_exec_error(command, result)
            return result

        async def exec_as_root(
            self,
            environment: Any,
            command: str,
            env: dict[str, str] | None = None,
            cwd: str | None = None,
            timeout_sec: int | float | None = None,
        ) -> Any:
            return await self._exec(
                environment,
                command,
                user="root",
                env=env,
                cwd=cwd,
                timeout_sec=timeout_sec,
            )

        async def exec_as_agent(
            self,
            environment: Any,
            command: str,
            env: dict[str, str] | None = None,
            cwd: str | None = None,
            timeout_sec: int | float | None = None,
        ) -> Any:
            return await self._exec(
                environment,
                command,
                env=env,
                cwd=cwd,
                timeout_sec=timeout_sec,
            )

        async def setup(self, environment: Any) -> None:
            await environment.exec(
                command="[ -d /installed-agent ] || mkdir -p /installed-agent",
                user="root",
            )
            await self.install(environment)

        async def install(self, environment: Any) -> None:
            pass

        def populate_context_post_run(self, context: Any) -> None:
            pass


# Re-export types under standard names
NonZeroAgentExitCodeError = HarborNonZeroAgentExitCodeError
ApiError = HarborApiError
ApiRateLimitError = HarborApiRateLimitError
ApiUsageLimitError = HarborApiUsageLimitError
ApiInternalServerError = HarborApiInternalServerError
ApiOverloadedError = HarborApiOverloadedError
ApiConnectionClosedError = HarborApiConnectionClosedError
ApiResponseStalledError = HarborApiResponseStalledError
OutputTokenExceededError = HarborOutputTokenExceededError
ContextWindowExceededError = HarborContextWindowExceededError
UnknownApiError = HarborUnknownApiError
ApiProviderResourceNotFoundError = HarborApiProviderResourceNotFoundError
AgentSafetyRefusalError = HarborAgentSafetyRefusalError
AgentAuthenticationError = HarborAgentAuthenticationError
ModelNotFoundError = HarborModelNotFoundError
NetworkConnectionError = HarborNetworkConnectionError
ErrorPattern = HarborErrorPattern
CliFlag = HarborCliFlag
EnvVar = HarborEnvVar
PackageSpec = HarborPackageSpec
AgentContext = HarborAgentContext
BaseEnvironment = HarborBaseEnvironment
BaseInstalledAgent = HarborBaseInstalledAgent
with_prompt_template = harbor_with_prompt_template


# ---------------------------------------------------------------------------
# Arm Attachments & Helpers
# ---------------------------------------------------------------------------

import sys

_agents_dir = str(Path(__file__).resolve().parents[1])
if _agents_dir not in sys.path:
    sys.path.insert(0, _agents_dir)
from common.arm_attachments import (
    DELIVERY_ENV_JSON,
    DELIVERY_RULES_DIR,
    MANIFEST_FILE,
    SUPPORTED_DELIVERIES,
    SUPPORTED_MANIFEST_VERSION,
    ArmAttachment,
    attachment_directories,
    environment_prefix,
    missing_attachment_files,
    parse_arm_attachments,
    read_arm_attachments,
    rules_setup_command,
)

# ---------------------------------------------------------------------------
# Catalog Bootstrap & Tee Commands
# ---------------------------------------------------------------------------

_PROVIDER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
_MODEL_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+:@/-]*")


def parse_model_selector(model_name: str) -> tuple[str, str]:
    provider, separator, model_id = model_name.partition("/")
    if (
        not separator
        or _PROVIDER_RE.fullmatch(provider) is None
        or _MODEL_ID_RE.fullmatch(model_id) is None
        or any(not segment for segment in model_id.split("/"))
    ):
        raise ValueError("benchmark model must use a safe provider/model-id selector")
    return provider, model_id


def build_model_catalog_refresh_command(
    binary: str,
    model_name: str,
    log_path: str,
    timeout_seconds: int = 120,
) -> str:
    provider, _model_id = parse_model_selector(model_name)
    if not binary or not log_path or "\0" in binary or "\0" in log_path:
        raise ValueError("binary and catalog log paths must be non-empty shell data")
    if isinstance(timeout_seconds, bool) or timeout_seconds <= 0:
        raise ValueError("catalog refresh timeout must be a positive integer")

    binary_arg = shlex.quote(binary)
    provider_arg = shlex.quote(provider)
    log_arg = shlex.quote(log_path)
    timeout_arg = shlex.quote(f"{timeout_seconds}s")
    selector_json = shlex.quote(f'"selector":"{model_name}"')
    failed_message = shlex.quote(f"model catalog refresh failed for {model_name}")
    missing_message = shlex.quote(
        f"model catalog refresh did not return {model_name}"
    )
    return (
        "{ "
        f"timeout -k 5s {timeout_arg} {binary_arg} models refresh "
        f"{provider_arg} --json >{log_arg} 2>&1; "
        "veyyon_catalog_status=$?; "
        'if [ "$veyyon_catalog_status" -ne 0 ]; then '
        f"printf '%s\\n' {failed_message} >&2; cat {log_arg} >&2; "
        'exit "$veyyon_catalog_status"; '
        "fi; "
        f"if ! grep -F -- {selector_json} {log_arg} >/dev/null; then "
        f"printf '%s\\n' {missing_message} >&2; cat {log_arg} >&2; exit 1; "
        "fi; "
        "}"
    )


def build_status_preserving_tee_command(
    command: str,
    log_path: str,
    status_path_prefix: str = "/tmp/veyyon-agent-status",
) -> str:
    if not command or not log_path or not status_path_prefix:
        raise ValueError("command, log path, and status path prefix are required")
    if any("\0" in value for value in (command, log_path, status_path_prefix)):
        raise ValueError("logged command inputs cannot contain NUL bytes")

    log_arg = shlex.quote(log_path)
    status_prefix_arg = shlex.quote(status_path_prefix)
    return (
        f"veyyon_status_file={status_prefix_arg}.$$; "
        'rm -f "$veyyon_status_file"; '
        f"( {command}; printf '%s\\n' \"$?\" >\"$veyyon_status_file\" ) "
        f"| tee {log_arg}; "
        "veyyon_tee_status=$?; "
        'if [ -r "$veyyon_status_file" ]; then '
        'veyyon_command_status=$(cat "$veyyon_status_file"); '
        "else veyyon_command_status=1; fi; "
        'rm -f "$veyyon_status_file"; '
        'if [ "$veyyon_command_status" -ne 0 ]; then '
        'exit "$veyyon_command_status"; fi; '
        'exit "$veyyon_tee_status"'
    )


# ---------------------------------------------------------------------------
# VeyyonAgent Implementation
# ---------------------------------------------------------------------------


class VeyyonAgent(BaseInstalledAgent):
    """Run veyyon (compiled `vey` binary) headlessly against a Harbor task."""

    SUPPORTS_ATIF: bool = False
    SUPPORTS_CONFIG: bool = False
    SUPPORTS_WINDOWS: bool = False

    CLI_FLAGS: ClassVar[list[CliFlag]] = []
    ENV_VARS: ClassVar[list[EnvVar]] = []

    ERROR_PATTERNS: ClassVar[list[ErrorPattern]] = [
        ErrorPattern(r"rate.?limit", ApiRateLimitError),
        ErrorPattern(r"too many requests", ApiRateLimitError),
        ErrorPattern(r"\b429\b.*(?:too many requests|rate limit)", ApiRateLimitError),
        ErrorPattern(r"specified API usage limits", ApiUsageLimitError),
        ErrorPattern(r"You've hit your usage limit", ApiUsageLimitError),
        ErrorPattern(r"You have an unpaid invoice", ApiUsageLimitError),
        ErrorPattern(r"Quota exceeded", ApiUsageLimitError),
        ErrorPattern(r"insufficient_quota", ApiUsageLimitError),
        ErrorPattern(r"credit balance is too low", ApiUsageLimitError),
        ErrorPattern(r"API Error: 500 Internal server error", ApiInternalServerError),
        ErrorPattern(r"RetriableError: \[internal\] Error", ApiInternalServerError),
        ErrorPattern(r"\b500 Internal Server Error\b", ApiInternalServerError),
        ErrorPattern(r"API Error: Overloaded", ApiOverloadedError),
        ErrorPattern(r"ServiceUnavailableError", ApiOverloadedError),
        ErrorPattern(
            r"Selected model is at capacity\. Please try a different model\.",
            ApiOverloadedError,
        ),
        ErrorPattern(r"\b503 Service Unavailable\b", ApiOverloadedError),
        ErrorPattern(
            r"API Error: Connection closed mid-response",
            ApiConnectionClosedError,
        ),
        ErrorPattern(
            r"API Error: stream closed before completion",
            ApiConnectionClosedError,
        ),
        ErrorPattern(
            r"API Error: Response stalled mid-stream",
            ApiResponseStalledError,
        ),
        ErrorPattern(
            r"response exceeded .+ output token maximum",
            OutputTokenExceededError,
        ),
        ErrorPattern(
            r"max_tokens exceeded",
            OutputTokenExceededError,
        ),
        ErrorPattern(
            r"input token count exceeds the maximum number of tokens|"
            r"prompt is too long: \d+ tokens > \d+ maximum|"
            r"context_length_exceeded",
            ContextWindowExceededError,
        ),
        ErrorPattern(r"Not logged in", AgentAuthenticationError),
        ErrorPattern(r"Unauthorized", AgentAuthenticationError),
        ErrorPattern(r"\b401 Unauthorized\b", AgentAuthenticationError),
        ErrorPattern(r"Invalid API key", AgentAuthenticationError),
        ErrorPattern(r"Cannot use this model", ModelNotFoundError),
        ErrorPattern(r"The model .+ does not exist", ModelNotFoundError),
        ErrorPattern(
            r"Provider Error We.re having trouble finding the resource you requested",
            ApiProviderResourceNotFoundError,
        ),
        ErrorPattern(
            r"safety measures that flagged|Cyber Verification Program|"
            r"flagged for possible cybersecurity risk|"
            r"Trusted Access for Cyber|chatgpt\.com/cyber|"
            r"Output blocked by content filtering policy|"
            r"violate our Usage Policy|"
            r"triggered cyber-related safeguards|"
            r"model_refusal_no_fallback|"
            r"ContentFilterError|blocked by the provider.s content filter|"
            r'"reason"\s*:\s*"content-filter"',
            AgentSafetyRefusalError,
        ),
        ErrorPattern(r"API Error", UnknownApiError),
        ErrorPattern(r"SSL_ERROR_SYSCALL", NetworkConnectionError),
        ErrorPattern(r"SSL_connect", NetworkConnectionError),
        ErrorPattern(r"Could not resolve host", NetworkConnectionError),
        ErrorPattern(r"Connection refused", NetworkConnectionError),
        ErrorPattern(r"Connection timed out", NetworkConnectionError),
        ErrorPattern(r"Request timed out", NetworkConnectionError),
        ErrorPattern(r"curl: \(\d+\)", NetworkConnectionError),
    ]

    @staticmethod
    def name() -> str:
        return "veyyon"

    def __init__(
        self,
        logs_dir: Path | str,
        model_name: str | None = None,
        *args: Any,
        arm_name: str = "default",
        assets_dir: str = "",
        binary_sha: str = "nosha",
        replay_path: str = "",
        timeout_sec: int | float | None = None,
        prompt_template_path: Path | str | None = None,
        version: str | None = None,
        extra_env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> None:
        self._arm_name = arm_name
        self._assets_dir = assets_dir
        self._binary_sha = binary_sha
        self._replay_path = replay_path
        self._timeout_sec = timeout_sec
        self._installed = False

        super().__init__(
            logs_dir=Path(logs_dir),
            model_name=model_name,
            prompt_template_path=prompt_template_path,
            version=version,
            extra_env=extra_env,
            *args,
            **kwargs,
        )

    def version(self) -> str | None:
        return self._version or "local"

    def get_version_command(self) -> str | None:
        return None

    async def install(self, environment: BaseEnvironment) -> None:
        """Stage assets and configure container environment."""
        host_assets = Path(self._assets_dir)
        for rel in ("vey", "auth-agent.db", f"arms/{self._arm_name}.yml"):
            if not (host_assets / rel).is_file():
                raise ValueError(f"veyyon asset missing on host: {host_assets / rel}")

        attachments = read_arm_attachments(host_assets, self._arm_name)
        missing = missing_attachment_files(attachments, host_assets)
        if missing:
            raise ValueError(
                "veyyon arm attachment staged in the manifest but missing on host: "
                + ", ".join(f"{host_assets / rel}" for rel in missing)
            )

        replay_path = Path(self._replay_path) if self._replay_path else None
        if replay_path is not None:
            if not replay_path.is_absolute():
                raise ValueError(
                    f"Veyyon replay manifest path must be absolute: {replay_path}"
                )
            if not replay_path.is_file():
                raise ValueError(
                    f"Veyyon replay manifest missing on host: {replay_path}"
                )

        await self.exec_as_root(
            environment, command=f"mkdir -p {CONTAINER_ASSETS_DIR}"
        )
        await environment.upload_file(
            host_assets / "vey", f"{CONTAINER_ASSETS_DIR}/vey"
        )
        await environment.upload_file(
            host_assets / "auth-agent.db", f"{CONTAINER_ASSETS_DIR}/auth-agent.db"
        )
        await environment.upload_file(
            host_assets / "arms" / f"{self._arm_name}.yml",
            f"{CONTAINER_ASSETS_DIR}/arm.yml",
        )

        for directory in attachment_directories(attachments, CONTAINER_ASSETS_DIR):
            await self.exec_as_root(environment, command=f"mkdir -p {directory}")
        for attachment in attachments:
            await environment.upload_file(
                host_assets / attachment.file,
                f"{CONTAINER_ASSETS_DIR}/{attachment.file}",
            )

        if replay_path is not None:
            await environment.upload_file(
                replay_path, f"{CONTAINER_ASSETS_DIR}/replay.json"
            )

        await self.exec_as_root(
            environment, command=f"chmod +x {CONTAINER_ASSETS_DIR}/vey"
        )

        rule_setup = rules_setup_command(attachments, CONTAINER_ASSETS_DIR)
        setup_cmd = (
            "mkdir -p ~/.veyyon/shared-auth && "
            f"cp {CONTAINER_ASSETS_DIR}/auth-agent.db ~/.veyyon/shared-auth/agent.db && "
            f"cp {CONTAINER_ASSETS_DIR}/arm.yml ~/.veyyon/arm.yml{rule_setup}"
        )
        await self.exec_as_agent(environment, command=setup_cmd)
        self._installed = True

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name:
            raise ValueError("VeyyonAgent requires --model (provider/model-id)")

        if not self._installed:
            await self.install(environment)

        host_assets = Path(self._assets_dir)
        attachments = read_arm_attachments(host_assets, self._arm_name)
        attachment_env = environment_prefix(attachments, CONTAINER_ASSETS_DIR)

        catalog_refresh = build_model_catalog_refresh_command(
            f"{CONTAINER_ASSETS_DIR}/vey",
            self.model_name,
            "/logs/agent/model-catalog-refresh.txt",
            timeout_seconds=MODEL_CATALOG_REFRESH_TIMEOUT_SECONDS,
        )

        replay_path = Path(self._replay_path) if self._replay_path else None
        if replay_path is not None:
            driver_command = (
                f"{attachment_env}python3 "
                f"{CONTAINER_ASSETS_DIR}/veyyon_replay_driver.py "
                f"--binary {CONTAINER_ASSETS_DIR}/vey "
                f"--config $HOME/.veyyon/arm.yml "
                f"--manifest {CONTAINER_ASSETS_DIR}/replay.json "
                f"--repo . --logs /logs/agent "
                f"--model {shlex.quote(self.model_name)}"
            )
            logged_agent_command = build_status_preserving_tee_command(
                driver_command,
                "/logs/agent/veyyon.txt",
                "/logs/agent/veyyon-exit-status.txt",
            )
        else:
            agent_command = (
                f"{attachment_env}{CONTAINER_ASSETS_DIR}/vey "
                f"--model {shlex.quote(self.model_name)} "
                f"--auto-approve --config $HOME/.veyyon/arm.yml "
                f"--print {shlex.quote(instruction)} </dev/null 2>&1"
            )
            logged_agent_command = build_status_preserving_tee_command(
                agent_command,
                "/logs/agent/veyyon.txt",
            )

        command = f"{catalog_refresh} && {logged_agent_command}"

        try:
            await self.exec_as_agent(
                environment, command=command, timeout_sec=self._timeout_sec
            )
        finally:
            try:
                await self.exec_as_agent(
                    environment,
                    command=(
                        "mkdir -p /logs/agent/sessions && "
                        "find ~/.veyyon/profiles/default/agent/sessions -name '*.jsonl' "
                        "-exec cp {} /logs/agent/sessions/ \\; 2>/dev/null || true"
                    ),
                )
            except Exception:
                pass

            self.populate_context_post_run(context)

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Parse session outputs or replay results into AgentContext."""
        replay_result_path = self.logs_dir / "veyyon-result.json"
        if replay_result_path.is_file():
            try:
                result = json.loads(replay_result_path.read_text(encoding="utf-8"))
            except Exception:
                result = {}

            def host_artifact(value: Any) -> Any:
                prefix = "/logs/agent/"
                if isinstance(value, str) and value.startswith(prefix):
                    return str(self.logs_dir / value.removeprefix(prefix))
                return value

            input_tokens = result.get("input_tokens")
            output_tokens = result.get("output_tokens")
            cache_tokens = result.get("cache_tokens")
            if isinstance(input_tokens, int):
                context.n_input_tokens = input_tokens
            if isinstance(output_tokens, int):
                context.n_output_tokens = output_tokens
            if isinstance(cache_tokens, int):
                context.n_cache_tokens = cache_tokens
            if result.get("provider_cost_supported") is True and isinstance(
                result.get("cost_usd"), (int, float)
            ):
                context.cost_usd = float(result["cost_usd"])
            native_compaction = dict(result.get("native_compaction") or {})
            native_compaction["artifact"] = host_artifact(
                native_compaction.get("artifact")
            )
            artifacts = {
                name: host_artifact(path)
                for name, path in dict(result.get("artifacts") or {}).items()
            }
            context.metadata = {
                "system": "veyyon",
                **result,
                "native_compaction": native_compaction,
                "patch_path": host_artifact(result.get("patch_path")),
                "transcript_path": host_artifact(result.get("transcript_path")),
                "log_path": host_artifact(result.get("log_path")),
                "continuation_artifact": host_artifact(
                    result.get("continuation_artifact")
                ),
                "artifacts": artifacts,
            }
            return

        sessions_dir = self.logs_dir / "sessions"
        if not sessions_dir.is_dir():
            return

        n_input, n_output, n_cache, cost, metadata = parse_session_usage(
            sessions_dir, arm_name=self._arm_name
        )
        context.n_input_tokens = n_input
        context.n_output_tokens = n_output
        context.n_cache_tokens = n_cache
        context.cost_usd = cost
        context.metadata = metadata


def parse_session_usage(
    sessions_dir: Path, arm_name: str = "default"
) -> tuple[int, int, int, float, dict[str, Any]]:
    """Sum token and cost usage across all assistant turns in JSONL sessions."""
    n_input = n_output = n_cache = 0
    cost = 0.0
    n_argot_loads = 0
    n_sigil_assistant_msgs = 0
    tool_calls: dict[str, int] = {}

    for session_file in sorted(sessions_dir.glob("*.jsonl")):
        try:
            content = session_file.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for line in content.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = entry.get("message") or {}
            role = message.get("role")
            if role == "assistant":
                usage = message.get("usage") or {}
                n_input += usage.get("input", 0) or 0
                n_output += usage.get("output", 0) or 0
                n_cache += (usage.get("cacheRead", 0) or 0) + (
                    usage.get("cacheWrite", 0) or 0
                )
                cost += (usage.get("cost") or {}).get("total", 0.0) or 0.0
                msg_content = message.get("content") or []
                has_sigil = False
                for block in msg_content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "toolCall" and isinstance(
                        block.get("name"), str
                    ):
                        name = block["name"]
                        tool_calls[name] = tool_calls.get(name, 0) + 1
                    if not has_sigil and "\u00a7" in str(block.get("text", "")):
                        has_sigil = True
                if has_sigil:
                    n_sigil_assistant_msgs += 1
            elif role == "toolResult":
                if message.get("toolName") == "argot_load":
                    n_argot_loads += 1

    metadata = {
        "arm": arm_name,
        "argot_load_calls": n_argot_loads,
        "assistant_msgs_with_sigil": n_sigil_assistant_msgs,
        "tool_calls": tool_calls,
    }
    return n_input, n_output, n_cache, cost, metadata
