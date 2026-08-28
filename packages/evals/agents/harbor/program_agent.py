"""Generic Harbor agent adapter for harnesses driven by a declarative container program."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, ClassVar

# Add the agents directory to sys.path to reach `common` and `harbor_api`.
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
from common.model_catalog_bootstrap import build_status_preserving_tee_command
from harbor_api import (
    AgentContext,
    BaseEnvironment,
    BaseInstalledAgent,
    ErrorPattern,
    PROVIDER_ERROR_PATTERNS,
    allowlist_from_urls,
    with_prompt_template,
)


_ENV_PROGRAM_VAR = "VEYYON_BENCH_AGENT_PROGRAM"


def _read_program_from_env(require: bool = True) -> ContainerProgram | None:
    path_str = os.environ.get(_ENV_PROGRAM_VAR)
    if not path_str:
        if require:
            raise ValueError(
                f"{_ENV_PROGRAM_VAR} environment variable is not set"
            )
        return None
    p = Path(path_str)
    if not p.is_file():
        raise ValueError(
            f"{_ENV_PROGRAM_VAR} points to a file that does not exist: {path_str}"
        )
    return load_program(p)


class ProgramAgent(BaseInstalledAgent):
    """Generic Harbor agent adapter executing any harness declaring a program.json."""

    SUPPORTS_ATIF: bool = False
    SUPPORTS_CONFIG: bool = False
    SUPPORTS_WINDOWS: bool = False

    ERROR_PATTERNS: ClassVar[list[ErrorPattern]] = list(PROVIDER_ERROR_PATTERNS)

    @staticmethod
    def name() -> str:
        prog = _read_program_from_env(require=False)
        if prog is not None:
            return prog.harness
        return "program"

    def __init__(
        self,
        logs_dir: Path | str,
        model_name: str | None = None,
        program_path: str = "",
        *args: Any,
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir, model_name=model_name, *args, **kwargs)
        self._program_path = program_path
        self._program_cached: ContainerProgram | None = None
        self._installed = False

    def _get_program(self) -> ContainerProgram:
        if self._program_cached is not None:
            return self._program_cached
        if self._program_path:
            p = Path(self._program_path)
            if not p.is_file():
                raise ValueError(
                    f"{_ENV_PROGRAM_VAR} program path does not exist on host: {self._program_path}"
                )
            prog = load_program(p)
        else:
            prog_opt = _read_program_from_env(require=True)
            assert prog_opt is not None
            prog = prog_opt
        self._program_cached = prog
        return prog

    def _get_host_dir(self) -> Path:
        if self._program_path:
            return Path(self._program_path).parent
        env_val = os.environ.get(_ENV_PROGRAM_VAR)
        if env_val:
            return Path(env_val).parent
        raise ValueError(f"{_ENV_PROGRAM_VAR} environment variable is not set")

    def network_allowlist(self) -> Any:
        program = self._get_program()
        return allowlist_from_urls([], default_domains=program.allowed_domains)

    async def install(self, environment: BaseEnvironment) -> None:
        program = self._get_program()
        host_dir = self._get_host_dir()
        await execute_program_install(self, environment, program, host_dir)
        self._installed = True

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        program = self._get_program()
        if not self.model_name:
            raise ValueError(
                f"{program.harness} agent requires --model (provider/model-id)"
            )
        if not self._installed:
            await self.install(environment)

        await execute_program_run(
            agent=self,
            environment=environment,
            program=program,
            instruction=instruction,
            model_name=self.model_name,
            timeout_sec=getattr(self, "_timeout_sec", None),
            status_preserving_tee=build_status_preserving_tee_command,
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        program = self._get_program()
        populate_program_context_post_run(self.logs_dir, program, context)
