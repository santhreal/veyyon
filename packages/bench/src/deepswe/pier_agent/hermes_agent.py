"""Hermes Agent adapter for native replay/compaction comparisons in Pier."""

from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any

from hermes_replay_driver import EXACT_MODEL, load_replay_manifest
from pier.agents.installed.base import BaseInstalledAgent
from pier.agents.network import allowlist_from_urls
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep

HERMES_VERSION = "0.20.0"
HERMES_COMMIT = "91937a6dc3ffbbe2f3be91a500f0ecf962c4cf53"
CONTAINER_ASSETS_DIR = "/opt/hermes-bench"
CONTAINER_HERMES = "/home/agent/.local/bin/hermes"
CONTAINER_LOGS_DIR = "/logs/agent"


class HermesAgent(BaseInstalledAgent):
    """Replay user turns through Hermes's real loop, resume, and compact natively."""

    SUPPORTS_ATIF: bool = False

    @staticmethod
    def name() -> str:
        return "hermes"

    def __init__(
        self,
        *args,
        replay_path: str = "",
        auth_path: str = "",
        turn_timeout_seconds: int = 1800,
        **kwargs,
    ):
        self._replay_path = replay_path
        self._auth_path = auth_path
        if (
            not isinstance(turn_timeout_seconds, int)
            or isinstance(turn_timeout_seconds, bool)
            or turn_timeout_seconds <= 0
        ):
            raise ValueError("turn_timeout_seconds must be a positive integer")
        self._turn_timeout_seconds = turn_timeout_seconds
        super().__init__(*args, **kwargs)

    def get_version_command(self) -> str | None:
        return f"{CONTAINER_HERMES} --version"

    def install_spec(self) -> AgentInstallSpec:
        version = self._version or HERMES_VERSION
        if version != HERMES_VERSION:
            raise ValueError(
                f"Hermes comparison is pinned to {HERMES_VERSION}; got {version!r}"
            )
        return AgentInstallSpec(
            agent_name=self.name(),
            version=version,
            cache_key=f"hermes-agent-{HERMES_COMMIT[:16]}",
            steps=[
                InstallStep(
                    user="root",
                    env={"DEBIAN_FRONTEND": "noninteractive"},
                    run=(
                        "apt-get update && "
                        "apt-get install -y --no-install-recommends ca-certificates curl git"
                    ),
                ),
                InstallStep(
                    user="agent",
                    run=(
                        "curl -fsSL https://hermes-agent.nousresearch.com/install.sh "
                        "-o /tmp/hermes-install.sh && "
                        "bash /tmp/hermes-install.sh --skip-setup --skip-browser "
                        "--no-skills --non-interactive "
                        f"--commit {HERMES_COMMIT} --force-commit && "
                        f"{CONTAINER_HERMES} --version"
                    ),
                ),
            ],
            verification_command=self.get_version_command(),
        )

    def network_allowlist(self):
        return allowlist_from_urls(
            [],
            default_domains=[
                ".github.com",
                ".githubusercontent.com",
                ".astral.sh",
                ".pythonhosted.org",
                "pypi.org",
                ".npmjs.org",
                ".nodejs.org",
                "hermes-agent.nousresearch.com",
                ".googleapis.com",
                ".google.com",
            ],
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # The held-out continuation is carried by the immutable replay artifact.
        # Refuse a divergent Pier instruction rather than silently comparing a
        # different continuation across systems.
        if self.model_name != EXACT_MODEL:
            raise ValueError(f"HermesAgent requires the exact model {EXACT_MODEL!r}")
        replay_path = Path(self._replay_path)
        auth_path = Path(self._auth_path)
        if not replay_path.is_file():
            raise ValueError(f"Hermes replay artifact missing on host: {replay_path}")
        if not auth_path.is_file() or auth_path.stat().st_size == 0:
            raise ValueError(f"Hermes auth path missing or empty on host: {auth_path}")
        manifest = load_replay_manifest(replay_path)
        rendered_instruction = self.render_instruction(instruction).strip()
        held_out = manifest["held_out_continuation"]["content"].strip()
        if rendered_instruction != held_out and instruction.strip() != held_out:
            raise ValueError(
                "Pier instruction does not match replay held_out_continuation; "
                "refusing a non-identical continuation"
            )

        driver_path = Path(__file__).with_name("hermes_replay_driver.py")
        if not driver_path.is_file():
            raise ValueError(f"Hermes replay driver missing on host: {driver_path}")
        await environment.exec(command=f"mkdir -p {CONTAINER_ASSETS_DIR}", user="root")
        await environment.upload_file(replay_path, f"{CONTAINER_ASSETS_DIR}/replay.json")
        await environment.upload_file(auth_path, f"{CONTAINER_ASSETS_DIR}/auth.env")
        await environment.upload_file(driver_path, f"{CONTAINER_ASSETS_DIR}/hermes_replay_driver.py")
        await environment.exec(
            command=(
                f"chown -R agent:agent {CONTAINER_ASSETS_DIR} && "
                f"chmod 600 {CONTAINER_ASSETS_DIR}/auth.env"
            ),
            user="root",
        )

        command = " ".join(
            [
                "python3",
                shlex.quote(f"{CONTAINER_ASSETS_DIR}/hermes_replay_driver.py"),
                "--hermes",
                shlex.quote(CONTAINER_HERMES),
                "--auth",
                shlex.quote(f"{CONTAINER_ASSETS_DIR}/auth.env"),
                "--replay",
                shlex.quote(f"{CONTAINER_ASSETS_DIR}/replay.json"),
                "--cwd",
                shlex.quote("."),
                "--logs",
                shlex.quote(CONTAINER_LOGS_DIR),
                "--timeout-seconds",
                str(self._turn_timeout_seconds),
            ]
        )
        await self.exec_as_agent(environment, command=command)

    def populate_context_post_run(self, context: AgentContext) -> None:
        result_path = self.logs_dir / "hermes-result.json"
        if not result_path.is_file():
            context.metadata = {
                "resolved_model": None,
                "provider_cost_supported": False,
                "failure": "missing hermes-result.json",
            }
            return
        try:
            result: dict[str, Any] = json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            context.metadata = {
                "resolved_model": None,
                "provider_cost_supported": False,
                "failure": f"invalid hermes-result.json: {exc}",
            }
            return

        context.n_input_tokens = int(result.get("input_tokens") or 0)
        context.n_output_tokens = int(result.get("output_tokens") or 0)
        context.n_cache_tokens = int(result.get("cache_read_tokens") or 0) + int(
            result.get("cache_write_tokens") or 0
        )
        context.cost_usd = float(result.get("provider_cost_usd") or 0.0)
        artifacts = dict(result.get("artifacts") or {})
        for name, container_path in list(artifacts.items()):
            if isinstance(container_path, str) and container_path.startswith(CONTAINER_LOGS_DIR + "/"):
                artifacts[name] = str(self.logs_dir / container_path.removeprefix(CONTAINER_LOGS_DIR + "/"))
        def host_artifact(value: Any) -> Any:
            if isinstance(value, str) and value.startswith(CONTAINER_LOGS_DIR + "/"):
                return str(self.logs_dir / value.removeprefix(CONTAINER_LOGS_DIR + "/"))
            return value

        native_compaction = dict(result.get("native_compaction") or {})
        native_compaction["artifact"] = host_artifact(native_compaction.get("artifact"))
        context.metadata = {
            "completed": bool(result.get("completed")),
            "failed": bool(result.get("failed")),
            "error": result.get("error"),
            "hermes_version": result.get("hermes_version"),
            "resolved_model": result.get("resolved_model"),
            "resolved_provider": result.get("resolved_provider"),
            "provider_cost_supported": bool(result.get("provider_cost_supported")),
            "provider_cost_usd": result.get("provider_cost_usd"),
            "estimated_cost_usd": result.get("estimated_cost_usd"),
            "cache_read_tokens": int(result.get("cache_read_tokens") or 0),
            "cache_write_tokens": int(result.get("cache_write_tokens") or 0),
            "api_calls": int(result.get("api_calls") or 0),
            "wall_time_seconds": result.get("wall_time_seconds"),
            "source_session_id": result.get("source_session_id"),
            "source_session_artifacts": result.get("source_session_artifacts"),
            "repository_checkpoint": result.get("repository_checkpoint"),
            "repository_checkpoint_sha256": result.get("repository_checkpoint_sha256"),
            "replay_manifest_sha256": result.get("replay_manifest_sha256"),
            "compaction_checkpoint": result.get("compaction_checkpoint"),
            "replayed_user_turn_ids": result.get("replayed_user_turn_ids"),
            "held_out_continuation_id": result.get("held_out_continuation_id"),
            "compaction_evidence": result.get("compaction_evidence"),
            "native_compaction": native_compaction,
            "patch_path": host_artifact(result.get("patch_path")),
            "transcript_path": host_artifact(result.get("transcript_path")),
            "log_path": host_artifact(result.get("log_path")),
            "continuation_artifact": host_artifact(result.get("continuation_artifact")),
            "qualitative_score": result.get("qualitative_score"),
            "recovery_reads": result.get("recovery_reads"),
            "recovery_tokens": result.get("recovery_tokens"),
            "phase_timings": result.get("phase_timings"),
            "artifacts": artifacts,
        }
