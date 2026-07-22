"""
Veyyon agent for Pier (datacurve-pier), used to run DeepSWE tasks against a
locally built veyyon binary.

Delivery model: veyyon is not published at the revision under test, so the
runner (run.ts) stages the compiled `vey` binary, a seeded shared-auth
credential DB, and the per-arm config overlay into an assets directory, and
the agent uploads them into the task container with `environment.upload_file`
at run time. (A bind mount would replace Pier's default log mounts and lose
the /logs/agent bind; install steps run at image build time where neither the
mount nor the host network is reachable, so everything happens in run().)
"""

from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any, ClassVar

from pier.agents.installed.base import BaseInstalledAgent
from pier.agents.network import allowlist_from_urls
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep

CONTAINER_ASSETS_DIR = "/opt/veyyon-assets"


class VeyyonAgent(BaseInstalledAgent):
    """Run veyyon (compiled `vey` binary) headlessly against a Harbor task."""

    SUPPORTS_ATIF: bool = False

    # Extra kwargs (arrive via the job config's agent.kwargs):
    #   arm_name   - config arm label; picks <assets_dir>/arms/<name>.yml and
    #                joins the install cache key.
    #   assets_dir - HOST path holding vey, auth-agent.db, arms/ (staged by
    #                run.ts); uploaded into the container at run time.
    #   binary_sha - sha256 of the staged binary, for install cache busting.

    @staticmethod
    def name() -> str:
        return "veyyon"

    def __init__(
        self,
        *args,
        arm_name: str = "default",
        assets_dir: str = "",
        binary_sha: str = "nosha",
        **kwargs,
    ):
        self._arm_name = arm_name
        self._assets_dir = assets_dir
        self._binary_sha = binary_sha
        super().__init__(*args, **kwargs)

    def get_version_command(self) -> str | None:
        # The binary only exists at run time (bind mount), so there is nothing
        # to verify at install time.
        return None

    def install_spec(self) -> AgentInstallSpec:
        # Nothing to install at build time: the binary is uploaded at run
        # time (no mounts exist while the image is being built).
        return AgentInstallSpec(
            agent_name=self.name(),
            version=self._version,
            cache_key=f"veyyon-{self._binary_sha[:16]}-{self._arm_name}",
            steps=[InstallStep(user="agent", run="true")],
            verification_command=None,
        )

    def network_allowlist(self):
        # Allow Google OAuth/CloudCode, Anthropic, OpenAI, and OpenRouter endpoints
        return allowlist_from_urls(
            [], default_domains=[
                ".googleapis.com", ".google.com",
                ".anthropic.com", ".openai.com", ".openrouter.ai"
            ]
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name:
            raise ValueError("VeyyonAgent requires --model (provider/model-id)")
        instruction = self.render_instruction(instruction)
        host_assets = Path(self._assets_dir)
        for rel in ("vey", "auth-agent.db", f"arms/{self._arm_name}.yml"):
            if not (host_assets / rel).is_file():
                raise ValueError(f"veyyon asset missing on host: {host_assets / rel}")
        await environment.exec(command=f"mkdir -p {CONTAINER_ASSETS_DIR}", user="root")
        await environment.upload_file(host_assets / "vey", f"{CONTAINER_ASSETS_DIR}/vey")
        await environment.upload_file(
            host_assets / "auth-agent.db", f"{CONTAINER_ASSETS_DIR}/auth-agent.db"
        )
        await environment.upload_file(
            host_assets / "arms" / f"{self._arm_name}.yml",
            f"{CONTAINER_ASSETS_DIR}/arm.yml",
        )
        has_custom_prompt = (host_assets / "arms" / f"{self._arm_name}.prompt.md").is_file()
        if has_custom_prompt:
            await environment.upload_file(
                host_assets / "arms" / f"{self._arm_name}.prompt.md",
                f"{CONTAINER_ASSETS_DIR}/prompt.md",
            )
        await environment.exec(
            command=f"chmod +x {CONTAINER_ASSETS_DIR}/vey", user="root"
        )
        setup = (
            "mkdir -p ~/.veyyon/profiles/default/shared-auth && "
            f"cp {CONTAINER_ASSETS_DIR}/auth-agent.db ~/.veyyon/profiles/default/shared-auth/agent.db && "
            f"cp {CONTAINER_ASSETS_DIR}/arm.yml ~/.veyyon/arm.yml"
        )
        prompt_flag = f" --system-prompt {CONTAINER_ASSETS_DIR}/prompt.md" if has_custom_prompt else ""
        command = (
            f"{setup} && "
            f"{CONTAINER_ASSETS_DIR}/vey --model {shlex.quote(self.model_name)} "
            f"--auto-approve --config $HOME/.veyyon/arm.yml{prompt_flag} "
            f"--print {shlex.quote(instruction)} "
            "2>&1 </dev/null | stdbuf -oL tee /logs/agent/veyyon.txt"
        )
        try:
            await self.exec_as_agent(environment, command=command)
        finally:
            # Best-effort session capture for usage accounting; the agent's own
            # result must not fail because a copy did.
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

    def populate_context_post_run(self, context: AgentContext) -> None:
        sessions_dir = self.logs_dir / "sessions"
        if not sessions_dir.is_dir():
            return
        # Every session file counts: the main loop AND any subagent sessions
        # (named files). Summing only the newest would undercount runs that
        # delegate implementation work.
        n_input = n_output = n_cache = 0
        cost = 0.0
        n_argot_loads = 0
        n_sigil_assistant_msgs = 0
        tool_calls: dict[str, int] = {}
        for session_file in sessions_dir.glob("*.jsonl"):
            for line in session_file.read_text(errors="ignore").splitlines():
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
                        if isinstance(block, dict):
                            if "\u00a7" in str(block.get("text", "")):
                                n_sigil_assistant_msgs += 1
                                break
                            if block.get("type") == "toolCall" and isinstance(block.get("name"), str):
                                name = block["name"]
                                tool_calls[name] = tool_calls.get(name, 0) + 1
                elif role == "toolResult":
                    t_name = message.get("toolName")
                    if t_name == "argot_load":
                        n_argot_loads += 1
                    if isinstance(t_name, str):
                        tool_calls[t_name] = tool_calls.get(t_name, 0) + 1
        context.n_input_tokens = n_input
        context.n_output_tokens = n_output
        context.n_cache_tokens = n_cache
        context.cost_usd = cost
        context.metadata = {
            "arm": self._arm_name,
            "argot_load_calls": n_argot_loads,
            "assistant_msgs_with_sigil": n_sigil_assistant_msgs,
            "tool_calls": tool_calls,
        }
