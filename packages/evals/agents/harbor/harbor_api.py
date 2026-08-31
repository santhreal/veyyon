"""Shared Harbor framework imports, stubs, and provider error classification patterns."""

from __future__ import annotations

import functools
import logging
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, ClassVar, Literal


# ---------------------------------------------------------------------------
# Harbor base classes and error hierarchy
# ---------------------------------------------------------------------------
# When harbor is installed, import the real base classes. When running in a plain
# Python environment (e.g. unit tests outside the Harbor uv tool environment),
# provide compatible stubs so the modules import and function without error.

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

try:
    from harbor.agents.network import allowlist_from_urls  # type: ignore[import-not-found]
except ImportError:
    from types import SimpleNamespace

    def allowlist_from_urls(  # type: ignore[misc]
        values: Any = (), *, default_domains: Any = ()
    ) -> Any:
        return SimpleNamespace(allowed_domains=list(default_domains or []))


# ---------------------------------------------------------------------------
# Shared Provider Error Patterns
# ---------------------------------------------------------------------------

PROVIDER_ERROR_PATTERNS: tuple[ErrorPattern, ...] = (
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
)
