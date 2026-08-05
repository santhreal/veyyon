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

from model_catalog_bootstrap import (
    build_model_catalog_refresh_command,
    build_status_preserving_tee_command,
)
from veyyon_replay_driver import EXACT_MODEL, load_replay_manifest

from pier.agents.installed.base import BaseInstalledAgent
from pier.agents.network import allowlist_from_urls
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep

CONTAINER_ASSETS_DIR = "/opt/veyyon-assets"
MODEL_CATALOG_REFRESH_TIMEOUT_SECONDS = 120


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
        replay_path: str = "",
        **kwargs,
    ):
        self._arm_name = arm_name
        self._assets_dir = assets_dir
        self._binary_sha = binary_sha
        self._replay_path = replay_path
        super().__init__(*args, **kwargs)

    def get_version_command(self) -> str | None:
        # The binary only exists at run time (bind mount), so there is nothing
        # to verify at install time.
        return None

    def install_spec(self) -> AgentInstallSpec:
        return AgentInstallSpec(
            agent_name="veyyon",
            cache_key=f"veyyon-{self._binary_sha[:16]}-{self._arm_name}",
            steps=[InstallStep(user="agent", run="true")],
        )
    def network_allowlist(self):
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
        replay_path = Path(self._replay_path) if self._replay_path else None
        if replay_path is not None:
            if self.model_name != EXACT_MODEL:
                raise ValueError(
                    f"Veyyon replay requires exactly {EXACT_MODEL}; got {self.model_name!r}. "
                    "Aliases and fallback are not permitted."
                )
            if not replay_path.is_absolute():
                raise ValueError(
                    f"Veyyon replay manifest path must be absolute: {replay_path}"
                )
            if not replay_path.is_file():
                raise ValueError(f"Veyyon replay manifest missing on host: {replay_path}")
            replay_manifest, _, _ = load_replay_manifest(replay_path, self.model_name)
            missing_provenance = [
                value
                for value in replay_manifest["source_session_artifacts"]
                if not Path(value).is_file()
            ]
            checkpoint = Path(replay_manifest["repository_checkpoint"])
            if missing_provenance or not checkpoint.is_dir():
                details = [*(f"source artifact {value}" for value in missing_provenance)]
                if not checkpoint.is_dir():
                    details.append(f"repository checkpoint {checkpoint}")
                raise ValueError(
                    "Veyyon replay provenance missing on host: " + "; ".join(details)
                )
            replay_driver = Path(__file__).with_name("veyyon_replay_driver.py")
            if not replay_driver.is_file():
                raise ValueError(f"Veyyon replay driver missing on host: {replay_driver}")
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
        if replay_path is not None:
            await environment.upload_file(
                replay_path, f"{CONTAINER_ASSETS_DIR}/replay.json"
            )
            await environment.upload_file(
                replay_driver, f"{CONTAINER_ASSETS_DIR}/veyyon_replay_driver.py"
            )
        # An arm MAY carry a .rule.md, staged by run.ts, injected as an
        # always-apply rule.
        has_rule = (host_assets / "rules" / f"{self._arm_name}.md").is_file()
        if has_rule:
            await environment.exec(command=f"mkdir -p {CONTAINER_ASSETS_DIR}/rules", user="root")
            await environment.upload_file(
                host_assets / "rules" / f"{self._arm_name}.md",
                f"{CONTAINER_ASSETS_DIR}/rules/{self._arm_name}.md",
            )
        # An arm MAY carry a per-section prompt override, staged by run.ts as
        # sections/<arm>.json. It reaches the agent ONLY through the eval-only
        # VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS env var — never a config key — so a
        # normal run cannot see it and it cannot contaminate production behavior.
        # It swaps exactly one banner region and leaves every other section, and
        # its {{#if <setting>}} gating, byte-for-byte intact. Whole-prompt
        # replacement and --append-system-prompt are deliberately NOT wired: they
        # freeze a snapshot that stops responding to settings and can silently
        # drop a settings-gated section (the delegation-block catastrophe).
        has_sections = (host_assets / "sections" / f"{self._arm_name}.json").is_file()
        if has_sections:
            await environment.exec(command=f"mkdir -p {CONTAINER_ASSETS_DIR}/sections", user="root")
            await environment.upload_file(
                host_assets / "sections" / f"{self._arm_name}.json",
                f"{CONTAINER_ASSETS_DIR}/sections/{self._arm_name}.json",
            )
        # An arm MAY carry a per-STATEMENT override, staged by run.ts as
        # statements/<arm>.json, reaching the agent only through the eval-only
        # VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS env var. This is the vehicle for an
        # ABLATION: `{"tool-policy/delegation-gates": null}` removes exactly one
        # rule, which a section override cannot express, since TOOL POLICY is one
        # banner region and 34 rules, so no score change across it is attributable
        # to a cause. A string value rewords the rule instead of removing it.
        has_statements = (host_assets / "statements" / f"{self._arm_name}.json").is_file()
        if has_statements:
            await environment.exec(command=f"mkdir -p {CONTAINER_ASSETS_DIR}/statements", user="root")
            await environment.upload_file(
                host_assets / "statements" / f"{self._arm_name}.json",
                f"{CONTAINER_ASSETS_DIR}/statements/{self._arm_name}.json",
            )
        await environment.exec(
            command=f"chmod +x {CONTAINER_ASSETS_DIR}/vey", user="root"
        )
        rule_setup = f" && mkdir -p ~/.veyyon/rules && cp {CONTAINER_ASSETS_DIR}/rules/* ~/.veyyon/rules/" if has_rule else ""
        setup = (
            # Seed the store veyyon actually opens: the machine-wide
            # ~/.veyyon/shared-auth/agent.db (getSharedAuthDir). This used to
            # write the pre-move per-profile path and rely on the first-run
            # legacy promotion to find it, which only happens while profile
            # sharing is on and is a migration path meant to be deleted.
            "mkdir -p ~/.veyyon/shared-auth && "
            f"cp {CONTAINER_ASSETS_DIR}/auth-agent.db ~/.veyyon/shared-auth/agent.db && "
            f"cp {CONTAINER_ASSETS_DIR}/arm.yml ~/.veyyon/arm.yml{rule_setup}"
        )
        # Read the section-override JSON into the env var IN the vey process only.
        # `VAR="$(cat file)" vey ...` scopes it to that one command and captures
        # the JSON verbatim (quotes, braces) with no shell re-parsing of content.
        sections_env = (
            f'VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS="$(cat {CONTAINER_ASSETS_DIR}/sections/{self._arm_name}.json)" '
            if has_sections
            else ""
        )
        # Same scoping for the per-statement override, and for the same reason: the
        # JSON reaches the vey process verbatim, with no shell re-parsing of braces
        # or quotes, and exists for that one command only.
        statements_env = (
            f'VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS="$(cat {CONTAINER_ASSETS_DIR}/statements/{self._arm_name}.json)" '
            if has_statements
            else ""
        )
        catalog_refresh = build_model_catalog_refresh_command(
            f"{CONTAINER_ASSETS_DIR}/vey",
            self.model_name,
            "/logs/agent/model-catalog-refresh.txt",
            timeout_seconds=MODEL_CATALOG_REFRESH_TIMEOUT_SECONDS,
        )
        if replay_path is not None:
            driver_command = (
                f"{sections_env}{statements_env}python3 "
                f"{CONTAINER_ASSETS_DIR}/veyyon_replay_driver.py "
                f"--binary {CONTAINER_ASSETS_DIR}/vey "
                f"--config $HOME/.veyyon/arm.yml "
                f"--manifest {CONTAINER_ASSETS_DIR}/replay.json "
                f"--repo . --logs /logs/agent "
                f"--model {shlex.quote(EXACT_MODEL)}"
            )
            logged_agent_command = build_status_preserving_tee_command(
                driver_command,
                "/logs/agent/veyyon.txt",
                "/logs/agent/veyyon-exit-status.txt",
            )
        else:
            agent_command = (
                f"{sections_env}{statements_env}{CONTAINER_ASSETS_DIR}/vey "
                f"--model {shlex.quote(self.model_name)} "
                f"--auto-approve --config $HOME/.veyyon/arm.yml "
                f"--print {shlex.quote(instruction)} </dev/null 2>&1"
            )
            logged_agent_command = build_status_preserving_tee_command(
                agent_command,
                "/logs/agent/veyyon.txt",
            )
        command = f"{setup} && {catalog_refresh} && {logged_agent_command}"
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
        replay_result_path = self.logs_dir / "veyyon-result.json"
        if replay_result_path.is_file():
            result = json.loads(replay_result_path.read_text())

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
                    has_sigil = False
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        # Tool calls count once, from the model's own blocks;
                        # the matching toolResult is the same action again.
                        if block.get("type") == "toolCall" and isinstance(block.get("name"), str):
                            name = block["name"]
                            tool_calls[name] = tool_calls.get(name, 0) + 1
                        if not has_sigil and "\u00a7" in str(block.get("text", "")):
                            has_sigil = True
                    if has_sigil:
                        n_sigil_assistant_msgs += 1
                elif role == "toolResult":
                    if message.get("toolName") == "argot_load":
                        n_argot_loads += 1
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
