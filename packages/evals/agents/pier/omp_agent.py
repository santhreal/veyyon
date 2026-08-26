"""Oh My Pi (omp) Pier adapter for DeepSWE benchmark execution and comparisons."""

from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import ClassVar

from model_catalog_bootstrap import (
    build_status_preserving_tee_command,
)
from pier.agents.installed.base import BaseInstalledAgent
from pier.agents.network import allowlist_from_urls
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep


CONTAINER_ASSETS_DIR = "/opt/omp-assets"

class OmpAgent(BaseInstalledAgent):
    """Run Oh My Pi (omp) CLI headlessly against a DeepSWE benchmark task."""

    SUPPORTS_ATIF: ClassVar[bool] = False

    @staticmethod
    def name() -> str:
        return "omp"

    def __init__(self, *args, assets_dir: str = "", binary_sha: str = "omp-cli-js", **kwargs):
        self._assets_dir = assets_dir
        self._binary_sha = binary_sha
        super().__init__(*args, **kwargs)

    def get_version_command(self) -> str | None:
        return None

    def install_spec(self) -> AgentInstallSpec:
        return AgentInstallSpec(
            agent_name="omp",
            cache_key=f"omp-{self._binary_sha[:16]}",
            steps=[InstallStep(user="agent", run="true")],
        )

    def network_allowlist(self):
        return allowlist_from_urls(
            [],
            default_domains=[
                ".googleapis.com",
                ".google.com",
                ".anthropic.com",
                ".openai.com",
                ".openrouter.ai",
                ".opencode.ai",
                ".models.dev",
            ],
        )

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        del context
        if not self.model_name:
            raise ValueError("OmpAgent requires --model (provider/model-id)")
        instruction = self.render_instruction(instruction)
        host_assets = Path(self._assets_dir)
        for rel in ("bun", "cli.js", "opencode-key", "omp-node-modules.tar.gz"):
            if not (host_assets / rel).is_file():
                raise ValueError(f"omp asset missing on host: {host_assets / rel}")
        await environment.exec(command=f"mkdir -p {CONTAINER_ASSETS_DIR}", user="root")
        await environment.upload_file(host_assets / "bun", f"{CONTAINER_ASSETS_DIR}/bun")
        await environment.upload_file(host_assets / "cli.js", f"{CONTAINER_ASSETS_DIR}/cli.js")
        await environment.upload_file(host_assets / "opencode-key", f"{CONTAINER_ASSETS_DIR}/opencode-key")
        await environment.upload_file(host_assets / "omp-node-modules.tar.gz", f"{CONTAINER_ASSETS_DIR}/omp-node-modules.tar.gz")
        await environment.exec(
            command=(
                f"chmod +x {CONTAINER_ASSETS_DIR}/bun {CONTAINER_ASSETS_DIR}/cli.js && "
                f"chmod 600 {CONTAINER_ASSETS_DIR}/opencode-key && "
                f"tar -xzf {CONTAINER_ASSETS_DIR}/omp-node-modules.tar.gz -C {CONTAINER_ASSETS_DIR}"
            ),
            user="root",
        )
        # A models.yml defining the model statically is staged by the omp
        # adapter's stageAssets (using the veyvon binary's models.dev overlay
        # to fetch full metadata). Place it at ~/.omp/agent/models.yml so the
        # omp binary loads the model into its static catalog at startup,
        # bypassing the background-discovery race that loses dynamically-
        # discovered models when --model is explicit.
        models_yml = host_assets / "omp-models.yml"
        setup_models_yml = ""
        if models_yml.is_file():
            await environment.upload_file(
                str(models_yml),
                f"{CONTAINER_ASSETS_DIR}/omp-models.yml",
            )
            setup_models_yml = (
                "mkdir -p ~/.omp/agent && "
                f"cp {CONTAINER_ASSETS_DIR}/omp-models.yml ~/.omp/agent/models.yml && "
            )
        # --mode json streams NDJSON events (thinking deltas, tool calls, text)
        # live to stdout instead of buffering the final result until exit.
        # This gives real-time observability in omp.txt during long trials.
        agent_command = (
            f"{setup_models_yml}"
            f"export OPENCODE_API_KEY=$(cat {CONTAINER_ASSETS_DIR}/opencode-key) && "
            f"{CONTAINER_ASSETS_DIR}/bun {CONTAINER_ASSETS_DIR}/cli.js "
            f"--model {shlex.quote(self.model_name)} "
            f"--auto-approve --print --mode json {shlex.quote(instruction)} </dev/null 2>&1"
        )
        logged = build_status_preserving_tee_command(agent_command, "/logs/agent/omp.txt")
        command = logged
        try:
            await self.exec_as_agent(environment, command=command)
        finally:
            try:
                await self.exec_as_agent(
                    environment,
                    command=(
                        "mkdir -p /logs/agent/sessions && "
                        "find ~/.omp ~/.omp/agent -name '*.jsonl' "
                        "-exec cp {} /logs/agent/sessions/ \\; 2>/dev/null || true"
                    ),
                )
            except Exception:
                pass

    def populate_context_post_run(self, context: AgentContext) -> None:
        sessions_dir = self.logs_dir / "sessions"
        if not sessions_dir.is_dir():
            return
        n_input = n_output = n_cache = 0
        cost = 0.0
        tool_calls: dict[str, int] = {}
        for session_file in sessions_dir.glob("*.jsonl"):
            for line in session_file.read_text(errors="ignore").splitlines():
                if not line.strip():
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
                    content = message.get("content") or []
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        if block.get("type") == "toolCall" and isinstance(block.get("name"), str):
                            name = block["name"]
                            tool_calls[name] = tool_calls.get(name, 0) + 1
        context.n_input_tokens = n_input
        context.n_output_tokens = n_output
        context.n_cache_tokens = n_cache
        context.cost_usd = cost
        context.metadata = {
            "system": "omp",
            "tool_calls": tool_calls,
            "log_path": str(self.logs_dir / "omp.txt"),
        }
