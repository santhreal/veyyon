"""Declarative container program parser and command builder."""

from __future__ import annotations

import json
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from common.session_usage import SUPPORTED_USAGE_DIALECTS, aggregate_usage


CONTAINER_PROGRAM_VERSION: int = 1
PROGRAM_FILE: str = "program.json"

_HARNESS_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_ALLOWED_COMMAND_PLACEHOLDERS = frozenset({"instruction", "model", "assets"})


@dataclass(frozen=True)
class ProgramAsset:
    file: str
    dest: str
    mode: str | None = None
    optional: bool = False


@dataclass(frozen=True)
class SessionSpec:
    sources: tuple[str, ...]
    pattern: str


@dataclass(frozen=True)
class ContainerProgram:
    harness: str
    container_dir: str
    assets: tuple[ProgramAsset, ...]
    setup: tuple[str, ...]
    command: str
    log_path: str
    env_file: str | None
    sessions: SessionSpec
    allowed_domains: tuple[str, ...]
    usage: str


def _validate_absolute_posix_path(val: Any, field_name: str) -> str:
    if not isinstance(val, str) or not val.startswith("/") or "\0" in val or any(c.isspace() for c in val):
        raise ValueError(
            f"Invalid {field_name}: {val!r}; expected absolute POSIX path with no NUL bytes or whitespace"
        )
    return val


def parse_program(text: str, source: str = "<string>") -> ContainerProgram:
    """Parse and validate a declarative container program JSON string."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in program from {source}: {exc}") from exc

    if not isinstance(data, dict):
        raise ValueError(f"Program from {source} must be a JSON object; got {type(data).__name__}")

    version = data.get("version")
    if version != CONTAINER_PROGRAM_VERSION:
        raise ValueError(
            f"Unsupported program version {version!r}; expected {CONTAINER_PROGRAM_VERSION}"
        )

    harness = data.get("harness")
    if not isinstance(harness, str) or not _HARNESS_RE.fullmatch(harness):
        raise ValueError(
            f"Invalid harness name: {harness!r}; expected non-empty identifier matching [a-z0-9][a-z0-9_-]*"
        )

    container_dir = _validate_absolute_posix_path(data.get("containerDir"), "containerDir")
    log_path = _validate_absolute_posix_path(data.get("logPath"), "logPath")

    raw_env_file = data.get("envFile")
    env_file: str | None = None
    if raw_env_file is not None:
        env_file = _validate_absolute_posix_path(raw_env_file, "envFile")

    raw_assets = data.get("assets")
    if not isinstance(raw_assets, list):
        raise ValueError(f"Invalid assets: {raw_assets!r}; expected a list")

    assets_list: list[ProgramAsset] = []
    for idx, raw_asset in enumerate(raw_assets):
        if not isinstance(raw_asset, dict):
            raise ValueError(f"Invalid asset at index {idx}: {raw_asset!r}; expected an object")

        file_val = raw_asset.get("file")
        if (
            not isinstance(file_val, str)
            or not file_val
            or file_val.startswith("/")
            or "\0" in file_val
            or any(c.isspace() for c in file_val)
            or any(part == ".." for part in file_val.split("/"))
        ):
            raise ValueError(
                f"Invalid asset file: {file_val!r}; expected relative path with no '..' segments, NUL bytes, or whitespace"
            )

        dest_val = _validate_absolute_posix_path(
            raw_asset.get("dest"), f"assets[{idx}].dest"
        )

        mode_val = raw_asset.get("mode")
        if mode_val is not None:
            if not isinstance(mode_val, str) or not mode_val:
                raise ValueError(
                    f"Invalid asset mode: {mode_val!r}; expected octal string"
                )
            try:
                int(mode_val, 8)
            except ValueError:
                raise ValueError(
                    f"Invalid asset mode: {mode_val!r}; expected valid octal string"
                )

        optional_val = raw_asset.get("optional", False)
        if not isinstance(optional_val, bool):
            raise ValueError(
                f"Invalid asset optional flag: {optional_val!r}; expected boolean"
            )

        assets_list.append(
            ProgramAsset(
                file=file_val,
                dest=dest_val,
                mode=mode_val,
                optional=optional_val,
            )
        )

    raw_setup = data.get("setup", [])
    if not isinstance(raw_setup, list) or any(not isinstance(s, str) for s in raw_setup):
        raise ValueError(f"Invalid setup: {raw_setup!r}; expected list of shell command strings")
    setup_tuple = tuple(raw_setup)

    command = data.get("command")
    if not isinstance(command, str) or not command:
        raise ValueError(f"Invalid command: {command!r}; expected non-empty string")

    placeholders = re.findall(r"\{\{([^}]+)\}\}", command)
    for placeholder in placeholders:
        if placeholder not in _ALLOWED_COMMAND_PLACEHOLDERS:
            raise ValueError(
                f"Unknown placeholder '{{{{{placeholder}}}}}' in command; "
                f"allowed placeholders are: {', '.join(sorted(_ALLOWED_COMMAND_PLACEHOLDERS))}"
            )

    raw_sessions = data.get("sessions")
    if not isinstance(raw_sessions, dict):
        raise ValueError(f"Invalid sessions: {raw_sessions!r}; expected an object")

    raw_sources = raw_sessions.get("sources")
    if not isinstance(raw_sources, list) or not raw_sources:
        raise ValueError(f"Invalid sessions.sources: {raw_sources!r}; expected non-empty list of absolute paths")
    sources_tuple = tuple(
        _validate_absolute_posix_path(src, f"sessions.sources[{i}]")
        for i, src in enumerate(raw_sources)
    )

    pattern = raw_sessions.get("pattern")
    if (
        not isinstance(pattern, str)
        or not pattern
        or "/" in pattern
        or "\0" in pattern
    ):
        raise ValueError(
            f"Invalid sessions.pattern: {pattern!r}; expected filename glob without '/' or NUL bytes"
        )
    sessions_spec = SessionSpec(sources=sources_tuple, pattern=pattern)

    raw_domains = data.get("allowedDomains", [])
    if not isinstance(raw_domains, list) or any(not isinstance(d, str) for d in raw_domains):
        raise ValueError(f"Invalid allowedDomains: {raw_domains!r}; expected list of domain strings")
    allowed_domains_tuple = tuple(raw_domains)

    usage = data.get("usage")
    if usage not in SUPPORTED_USAGE_DIALECTS:
        supported = ", ".join(repr(d) for d in SUPPORTED_USAGE_DIALECTS)
        raise ValueError(
            f"Unsupported usage dialect {usage!r}; expected one of: {supported}"
        )

    return ContainerProgram(
        harness=harness,
        container_dir=container_dir,
        assets=tuple(assets_list),
        setup=setup_tuple,
        command=command,
        log_path=log_path,
        env_file=env_file,
        sessions=sessions_spec,
        allowed_domains=allowed_domains_tuple,
        usage=usage,
    )


def load_program(path: str | Path) -> ContainerProgram:
    """Read and validate a ContainerProgram from disk."""
    p = Path(path).resolve()
    if not p.is_file():
        raise ValueError(f"Program file not found on host: {p}")
    try:
        text = p.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"Failed reading program file {p}: {exc}") from exc
    return parse_program(text, str(p))


def missing_assets(program: ContainerProgram, host_dir: str | Path) -> tuple[str, ...]:
    """Return absolute host paths of required assets that are missing on host."""
    host = Path(host_dir).resolve()
    missing: list[str] = []
    for asset in program.assets:
        if not asset.optional:
            target = host / asset.file
            if not target.is_file():
                missing.append(str(target.resolve()))
    return tuple(missing)


def uploads(
    program: ContainerProgram, host_dir: str | Path
) -> tuple[tuple[Path, str, int | None], ...]:
    """Return upload tuples (host_path, container_dest, mode) in declaration order.

    Skips absent optional assets; raises ValueError if a required asset is absent.
    """
    host = Path(host_dir).resolve()
    result: list[tuple[Path, str, int | None]] = []
    for asset in program.assets:
        target = host / asset.file
        if not target.is_file():
            if asset.optional:
                continue
            raise ValueError(
                f"Required program asset missing on host: {target.resolve()}"
            )
        mode_int = int(asset.mode, 8) if asset.mode is not None else None
        result.append((target, asset.dest, mode_int))
    return tuple(result)


def setup_command(program: ContainerProgram) -> str:
    """Generate shell command string for container setup."""
    parts = [f"mkdir -p {shlex.quote(program.container_dir)}"]
    for asset in program.assets:
        if asset.mode is not None:
            parts.append(f"chmod {asset.mode} {shlex.quote(asset.dest)}")
    for line in program.setup:
        trimmed = line.strip()
        if trimmed:
            parts.append(trimmed)
    return " && ".join(parts)


def agent_command(program: ContainerProgram, instruction: str, model: str) -> str:
    """Render agent invocation command with placeholders and optional envFile prefix."""
    placeholders = re.findall(r"\{\{([^}]+)\}\}", program.command)
    for placeholder in placeholders:
        if placeholder not in _ALLOWED_COMMAND_PLACEHOLDERS:
            raise ValueError(
                f"Unknown placeholder '{{{{{placeholder}}}}}' in command"
            )

    cmd = program.command
    cmd = cmd.replace("{{assets}}", program.container_dir)
    cmd = cmd.replace("{{model}}", shlex.quote(model))
    cmd = cmd.replace("{{instruction}}", shlex.quote(instruction))

    if program.env_file:
        cmd = f"set -a && . {shlex.quote(program.env_file)} && set +a && {cmd}"
    return cmd


def session_collect_command(
    program: ContainerProgram, logs_dir: str = "/logs/agent"
) -> str:
    """Generate shell command to collect session logs into <logs_dir>/sessions."""
    target_dir = f"{logs_dir.rstrip('/')}/sessions"
    parts = [f"mkdir -p {shlex.quote(target_dir)}"]
    for source in program.sessions.sources:
        parts.append(
            f"find {shlex.quote(source)} -name {shlex.quote(program.sessions.pattern)} "
            f"-exec cp {{}} {shlex.quote(target_dir)}/ \\; 2>/dev/null || true"
        )
    return " && ".join(parts)


async def execute_program_install(
    agent: Any,
    environment: Any,
    program: ContainerProgram,
    host_dir: str | Path,
) -> None:
    """Stage assets and run setup for a container program."""
    missing = missing_assets(program, host_dir)
    if missing:
        raise ValueError(
            f"Required program asset missing on host: {', '.join(missing)}"
        )

    exec_root = getattr(agent, "exec_as_root", None)

    async def _exec_root(cmd: str) -> Any:
        if callable(exec_root):
            return await exec_root(environment, command=cmd)
        return await environment.exec(command=cmd, user="root")

    exec_agent = getattr(agent, "exec_as_agent", None)

    async def _exec_agent(cmd: str) -> Any:
        if callable(exec_agent):
            return await exec_agent(environment, command=cmd)
        return await environment.exec(command=cmd)

    await _exec_root(f"mkdir -p {shlex.quote(program.container_dir)}")

    for host_path, dest, _ in uploads(program, host_dir):
        await environment.upload_file(host_path, dest)

    chmod_cmds = [
        f"chmod {asset.mode} {shlex.quote(asset.dest)}"
        for asset in program.assets
        if asset.mode is not None
    ]
    if chmod_cmds:
        await _exec_root(" && ".join(chmod_cmds))

    setup_lines = [s.strip() for s in program.setup if s.strip()]
    if setup_lines:
        await _exec_agent(" && ".join(setup_lines))


async def execute_program_run(
    agent: Any,
    environment: Any,
    program: ContainerProgram,
    instruction: str,
    model_name: str | None,
    timeout_sec: int | float | None = None,
    status_preserving_tee: Any = None,
) -> None:
    """Execute container program run command and collect session logs."""
    if not model_name:
        raise ValueError(f"{agent.name()} requires --model (provider/model-id)")

    exec_agent = getattr(agent, "exec_as_agent", None)

    async def _exec_agent(cmd: str, **kwargs: Any) -> Any:
        if callable(exec_agent):
            return await exec_agent(environment, command=cmd, **kwargs)
        return await environment.exec(command=cmd, **kwargs)

    raw_command = agent_command(program, instruction=instruction, model=model_name)
    if status_preserving_tee is not None:
        logged_command = status_preserving_tee(raw_command, program.log_path)
    else:
        logged_command = raw_command

    try:
        await _exec_agent(logged_command, timeout_sec=timeout_sec)
    finally:
        try:
            collect_cmd = session_collect_command(program, "/logs/agent")
            await _exec_agent(collect_cmd)
        except Exception:
            pass


def populate_program_context_post_run(
    logs_dir: Path,
    program: ContainerProgram,
    context: Any,
) -> None:
    """Extract session usage and tool call metadata into context."""
    sessions_dir = logs_dir / "sessions"
    usage = aggregate_usage(sessions_dir, program.usage)
    context.n_input_tokens = usage.input_tokens
    context.n_output_tokens = usage.output_tokens
    context.n_cache_tokens = usage.cache_tokens
    context.cost_usd = usage.cost_usd
    log_name = Path(program.log_path).name
    context.metadata = {
        "system": program.harness,
        "tool_calls": usage.tool_calls,
        "log_path": str(logs_dir / log_name),
    }
