"""Oh My Pi (omp) Pier adapter for DeepSWE benchmark execution and comparisons."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import ClassVar

_agents_dir = str(Path(__file__).resolve().parents[1])
if _agents_dir not in sys.path:
    sys.path.append(_agents_dir)

from common.container_program import (
    ContainerProgram,
    execute_program_install,
    execute_program_run,
    load_program,
    populate_program_context_post_run,
)
from common.model_catalog_bootstrap import (
    build_status_preserving_tee_command,
)
from pier.agents.installed.base import BaseInstalledAgent
from pier.agents.network import allowlist_from_urls
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep


class OmpAgent(BaseInstalledAgent):
    """Run Oh My Pi (omp) CLI headlessly against a DeepSWE benchmark task."""

    SUPPORTS_ATIF: ClassVar[bool] = False

    @staticmethod
    def name() -> str:
        return "omp"

    def __init__(
        self,
        *args,
        assets_dir: str = "",
        binary_sha: str = "omp-cli-js",
        program_path: str = "",
        **kwargs,
    ):
        self._assets_dir = assets_dir
        self._binary_sha = binary_sha
        self._program_path = program_path
        self._program_cached: ContainerProgram | None = None
        super().__init__(*args, **kwargs)

    def _get_program(self) -> ContainerProgram:
        if self._program_cached is not None:
            return self._program_cached
        if self._program_path:
            p = Path(self._program_path)
        elif self._assets_dir:
            p = Path(self._assets_dir) / "program.json"
        else:
            raise ValueError(
                "OmpAgent requires program_path or assets_dir containing program.json"
            )
        if not p.is_file():
            raise ValueError(f"OmpAgent program file missing on host: {p}")
        prog = load_program(p)
        self._program_cached = prog
        return prog

    def _get_host_dir(self) -> Path:
        if self._program_path:
            return Path(self._program_path).parent
        if self._assets_dir:
            return Path(self._assets_dir)
        raise ValueError("OmpAgent requires program_path or assets_dir")

    def get_version_command(self) -> str | None:
        return None

    def install_spec(self) -> AgentInstallSpec:
        return AgentInstallSpec(
            agent_name="omp",
            cache_key=f"omp-{self._binary_sha[:16]}",
            steps=[InstallStep(user="agent", run="true")],
        )

    def network_allowlist(self):
        program = self._get_program()
        return allowlist_from_urls(
            [],
            default_domains=program.allowed_domains,
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        program = self._get_program()
        instruction = self.render_instruction(instruction)
        host_dir = self._get_host_dir()
        await execute_program_install(self, environment, program, host_dir)
        await execute_program_run(
            agent=self,
            environment=environment,
            program=program,
            instruction=instruction,
            model_name=self.model_name,
            status_preserving_tee=build_status_preserving_tee_command,
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        program = self._get_program()
        populate_program_context_post_run(self.logs_dir, program, context)
