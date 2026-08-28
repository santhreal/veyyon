"""Build the model-catalog priming and status-preserving tee commands for containers.

Shared by every container agent under either framework: a benchmark that logs an agent run
and proves the model exists before spending on it does so through these two builders.
"""

from __future__ import annotations

import re
import shlex


_PROVIDER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
_MODEL_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+:@/-]*")


def parse_model_selector(model_name: str) -> tuple[str, str]:
    provider, separator, model_id = model_name.partition("/")
    if (
        not separator
        or _PROVIDER_RE.fullmatch(provider) is None
        or _MODEL_ID_RE.fullmatch(model_id) is None
        or any(not segment for segment in model_id.split("/"))
    ):
        raise ValueError(
            "benchmark model must use a safe provider/model-id selector"
        )
    return provider, model_id


def build_model_catalog_refresh_command(
    binary: str,
    model_name: str,
    log_path: str,
    timeout_seconds: int = 120,
) -> str:
    """Refresh and prove the exact dynamic selector exists before the paid run."""
    provider, _model_id = parse_model_selector(model_name)
    if not binary or not log_path or "\0" in binary or "\0" in log_path:
        raise ValueError("binary and catalog log paths must be non-empty shell data")
    if isinstance(timeout_seconds, bool) or timeout_seconds <= 0:
        raise ValueError("catalog refresh timeout must be a positive integer")

    binary_arg = shlex.quote(binary)
    provider_arg = shlex.quote(provider)
    log_arg = shlex.quote(log_path)
    timeout_arg = shlex.quote(f"{timeout_seconds}s")
    selector_json = shlex.quote(f'"selector":"{model_name}"')
    failed_message = shlex.quote(
        f"model catalog refresh failed for {model_name}"
    )
    missing_message = shlex.quote(
        f"model catalog refresh did not return {model_name}"
    )
    return (
        "{ "
        f"timeout -k 5s {timeout_arg} {binary_arg} models refresh "
        f"{provider_arg} --json >{log_arg} 2>&1; "
        "veyyon_catalog_status=$?; "
        'if [ "$veyyon_catalog_status" -ne 0 ]; then '
        f"printf '%s\\n' {failed_message} >&2; cat {log_arg} >&2; "
        'exit "$veyyon_catalog_status"; '
        "fi; "
        f"if ! grep -F -- {selector_json} {log_arg} >/dev/null; then "
        f"printf '%s\\n' {missing_message} >&2; cat {log_arg} >&2; exit 1; "
        "fi; "
        "}"
    )


def build_workspace_probe_command(
    binary: str,
    workspace: str,
    log_path: str,
    timeout_seconds: int = 60,
) -> str:
    """Prove the binary can read the workspace before the agent phase spends on it.

    `<binary> grep` is the standalone native text-search probe, so this one
    command answers both questions a trial silently failed on: whether the
    native addon loads in THIS container, and whether the working directory
    holds any file to work on. A binary built against a newer glibc than the
    task image ships loads no addon, and a directory scan that cannot run used
    to be reported to the agent as an empty workspace; a trial then spent its
    whole bound searching for the repository it was standing in and committed
    nothing. Both now fail here, in a second, naming the cause.
    """
    if not binary or not workspace or not log_path:
        raise ValueError("binary, workspace, and probe log paths are required")
    if any("\0" in value for value in (binary, workspace, log_path)):
        raise ValueError("workspace probe inputs cannot contain NUL bytes")
    if isinstance(timeout_seconds, bool) or timeout_seconds <= 0:
        raise ValueError("workspace probe timeout must be a positive integer")

    binary_arg = shlex.quote(binary)
    workspace_arg = shlex.quote(workspace)
    log_arg = shlex.quote(log_path)
    timeout_arg = shlex.quote(f"{timeout_seconds}s")
    # A pattern no source tree contains: the match count is irrelevant, the
    # file count is the answer, and a hit would only add output.
    pattern_arg = shlex.quote("veyyon-workspace-probe-no-match")
    failed_message = shlex.quote(
        f"veyyon cannot read the workspace at {workspace}: the native text search probe failed"
    )
    empty_message = shlex.quote(
        f"veyyon searched no file under {workspace}: the agent has no workspace to work on"
    )
    return (
        "{ "
        f"NO_COLOR=1 FORCE_COLOR=0 timeout -k 5s {timeout_arg} {binary_arg} grep "
        f"-c --no-gitignore -- {pattern_arg} {workspace_arg} >{log_arg} 2>&1; "
        "veyyon_probe_status=$?; "
        'if [ "$veyyon_probe_status" -ne 0 ]; then '
        f"printf '%s\\n' {failed_message} >&2; cat {log_arg} >&2; "
        'exit "$veyyon_probe_status"; '
        "fi; "
        f"if ! grep -E -- 'Files searched: [1-9]' {log_arg} >/dev/null; then "
        f"printf '%s\\n' {empty_message} >&2; cat {log_arg} >&2; exit 1; "
        "fi; "
        "}"
    )


def build_status_preserving_tee_command(
    command: str,
    log_path: str,
    status_path_prefix: str = "/tmp/veyyon-agent-status",
) -> str:
    """Stream through tee while returning the wrapped command's POSIX status."""
    if not command or not log_path or not status_path_prefix:
        raise ValueError("command, log path, and status path prefix are required")
    if any("\0" in value for value in (command, log_path, status_path_prefix)):
        raise ValueError("logged command inputs cannot contain NUL bytes")

    log_arg = shlex.quote(log_path)
    status_prefix_arg = shlex.quote(status_path_prefix)
    return (
        f"veyyon_status_file={status_prefix_arg}.$$; "
        'rm -f "$veyyon_status_file"; '
        f"( {command}; printf '%s\\n' \"$?\" >\"$veyyon_status_file\" ) "
        f"| tee {log_arg}; "
        "veyyon_tee_status=$?; "
        'if [ -r "$veyyon_status_file" ]; then '
        'veyyon_command_status=$(cat "$veyyon_status_file"); '
        "else veyyon_command_status=1; fi; "
        'rm -f "$veyyon_status_file"; '
        'if [ "$veyyon_command_status" -ne 0 ]; then '
        'exit "$veyyon_command_status"; fi; '
        'exit "$veyyon_tee_status"'
    )
