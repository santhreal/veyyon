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
import shlex
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, ClassVar, Literal, Self, Sequence

CONTAINER_ASSETS_DIR = "/opt/veyyon-assets"
MODEL_CATALOG_REFRESH_TIMEOUT_SECONDS = 120
WORKSPACE_PROBE_TIMEOUT_SECONDS = 60

# ---------------------------------------------------------------------------
# Harbor base classes and error hierarchy (shared via harbor_api)
# ---------------------------------------------------------------------------

from harbor_api import (
    HAS_HARBOR,
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
    BaseEnvironment,
    BaseInstalledAgent,
    CliFlag,
    ContextWindowExceededError,
    EnvVar,
    ErrorPattern,
    ModelNotFoundError,
    NetworkConnectionError,
    NonZeroAgentExitCodeError,
    OutputTokenExceededError,
    PackageSpec,
    UnknownApiError,
    with_prompt_template,
    PROVIDER_ERROR_PATTERNS,
)

# ---------------------------------------------------------------------------
# Arm Attachments & Helpers
# ---------------------------------------------------------------------------

import sys

# The attachment reader is shared with the Pier agent, so it is a package under the agents
# root. That root is appended rather than prepended: `harbor` names both the installed SDK
# imported above and the directory this module is in, so a prepended root would resolve the
# SDK to this directory for any import that runs after this point.
_agents_dir = str(Path(__file__).resolve().parents[1])
if _agents_dir not in sys.path:
    sys.path.append(_agents_dir)
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

from common.model_catalog_bootstrap import (
    build_model_catalog_refresh_command,
    build_status_preserving_tee_command,
    build_workspace_probe_command,
    parse_model_selector,
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

    ERROR_PATTERNS: ClassVar[list[ErrorPattern]] = list(PROVIDER_ERROR_PATTERNS)

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

        workspace_probe = build_workspace_probe_command(
            f"{CONTAINER_ASSETS_DIR}/vey",
            ".",
            "/logs/agent/workspace-probe.txt",
            timeout_seconds=WORKSPACE_PROBE_TIMEOUT_SECONDS,
        )
        command = f"{catalog_refresh} && {workspace_probe} && {logged_agent_command}"

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
