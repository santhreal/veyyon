"""Factory CLI Pier adapter for compaction-boundary replay comparisons."""

from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import ClassVar

from factory_session_driver import EXACT_MODEL
from model_catalog_bootstrap import build_status_preserving_tee_command
from pier.agents.installed.base import BaseInstalledAgent
from pier.agents.network import allowlist_from_urls
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep

CONTAINER_ASSETS_DIR = "/opt/factory-assets"


class FactoryAgent(BaseInstalledAgent):
    """Replay corpus inputs through one real Factory session and native compaction."""

    SUPPORTS_ATIF: ClassVar[bool] = False

    @staticmethod
    def name() -> str:
        return "factory"

    def __init__(
        self,
        *args,
        assets_dir: str = "",
        replay_path: str = "",
        binary_sha: str = "nosha",
        **kwargs,
    ) -> None:
        self._assets_dir = assets_dir
        self._replay_path = replay_path
        self._binary_sha = binary_sha
        super().__init__(*args, **kwargs)

    def get_version_command(self) -> str | None:
        return None

    def install_spec(self) -> AgentInstallSpec:
        return AgentInstallSpec(
            agent_name="factory",
            cache_key=f"factory-upload-{self._binary_sha[:16]}",
            steps=[InstallStep(user="agent", run="true")],
        )

    def network_allowlist(self):
        return allowlist_from_urls(
            [],
            default_domains=[
                ".factory.ai",
                ".googleapis.com",
                ".google.com",
            ],
        )

    def _host_assets(self) -> tuple[Path, Path, Path, Path | None]:
        assets = Path(self._assets_dir)
        binary = assets / "droid"
        api_key = assets / "factory-api-key"
        replay = Path(self._replay_path)
        missing: list[str] = []
        if not binary.is_file():
            missing.append(
                f"Factory executable {binary} (install with `curl -fsSL "
                "https://app.factory.ai/cli | sh`, then stage the resolved droid binary)"
            )
        if not api_key.is_file() or not api_key.read_text().strip():
            missing.append(
                f"non-empty Factory API key file {api_key} (create one at "
                "https://app.factory.ai/settings/api-keys)"
            )
        if not replay.is_file():
            missing.append(f"shared replay manifest {replay}")
        if missing:
            raise ValueError("Factory preflight failed; missing " + "; ".join(missing))
        settings = assets / "settings.json"
        return binary, api_key, replay, settings if settings.is_file() else None

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del instruction  # held-out bytes come from the shared replay manifest.
        if self.model_name != EXACT_MODEL:
            raise ValueError(
                f"FactoryAgent requires exactly {EXACT_MODEL}; got {self.model_name!r}. "
                "No Factory alias or fallback is permitted."
            )
        binary, api_key, replay, settings = self._host_assets()
        driver = Path(__file__).with_name("factory_session_driver.py")
        await environment.exec(command=f"mkdir -p {CONTAINER_ASSETS_DIR}", user="root")
        for source, destination in (
            (binary, "droid"),
            (api_key, "factory-api-key"),
            (replay, "replay.json"),
            (driver, "factory_session_driver.py"),
        ):
            await environment.upload_file(source, f"{CONTAINER_ASSETS_DIR}/{destination}")
        await environment.exec(
            command=f"chmod 700 {CONTAINER_ASSETS_DIR}/droid", user="root"
        )
        setup = ""
        if settings is not None:
            await environment.upload_file(settings, f"{CONTAINER_ASSETS_DIR}/settings.json")
            setup = (
                "mkdir -p $HOME/.factory && "
                f"cp {CONTAINER_ASSETS_DIR}/settings.json $HOME/.factory/settings.json && "
            )
        driver_command = (
            f"{setup}python3 {CONTAINER_ASSETS_DIR}/factory_session_driver.py "
            f"--binary {CONTAINER_ASSETS_DIR}/droid "
            f"--api-key-file {CONTAINER_ASSETS_DIR}/factory-api-key "
            f"--manifest {CONTAINER_ASSETS_DIR}/replay.json "
            "--repo . --logs /logs/agent "
            f"--model {shlex.quote(EXACT_MODEL)}"
        )
        command = build_status_preserving_tee_command(
            driver_command,
            "/logs/agent/factory.txt",
            "/logs/agent/factory-exit-status.txt",
        )
        await self.exec_as_agent(environment, command=command)

    def populate_context_post_run(self, context: AgentContext) -> None:
        result_path = self.logs_dir / "factory-result.json"
        if not result_path.is_file():
            return
        result = json.loads(result_path.read_text())
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
        native_compaction = result.get("native_compaction")
        if isinstance(native_compaction, dict):
            native_compaction = {
                **native_compaction,
                "artifact": str(self.logs_dir / "factory-compaction.json"),
            }
        context.metadata = {
            "system": "factory",
            **result,
            "native_compaction": native_compaction,
            "transcript_path": str(self.logs_dir / "factory-transcript.jsonl"),
            "patch_path": str(self.logs_dir / "factory.patch"),
            "log_path": str(self.logs_dir / "factory.txt"),
            "continuation_artifact": str(
                self.logs_dir / "factory-continuation.jsonl"
            ),
        }
