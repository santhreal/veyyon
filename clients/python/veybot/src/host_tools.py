"""Host tools exposed to the agent through `veyyon_rpc.host_tool`.

The agent uses these for any side effect that touches GitHub, the
reproduction transcript store, or the orchestrator's bookkeeping.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shlex
import subprocess
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, NoReturn

from veyyon_rpc import HostTool, HostToolContext, RpcCommandError, host_tool

from veybot import persona
from veybot.config import Settings
from veybot.db import Database, IssueState, issue_key
from veybot.git_ops import GitCommandError, HeadDriftError
from veybot.github_backend import GitHubBackend
from veybot.github_client import GitHubError, IssueInfo, PullRequestFileInfo, RepoInfo
from veybot.sandbox import (
    GitTransport,
    Workspace,
    _prepare_slot_runtime_env,
    _safe_directory_env,
    _share_git_metadata_with_slots,
    _slot_permissions_active,
    _slot_subprocess_kwargs,
    rename_workspace_branch,
    validate_branch_slug,
    workspace_key,
)

log = logging.getLogger(__name__)


def _configured(bindings: ToolBindings, field: str) -> str:
    settings = getattr(bindings, "settings", None)
    if settings is not None:
        return str(getattr(settings, field))
    return str(Settings.model_fields[field].default)


def _configured_argv(bindings: ToolBindings, field: str) -> tuple[str, ...]:
    return tuple(shlex.split(_configured(bindings, field)))


def _project_matches(bindings: ToolBindings) -> bool:
    markers = [m.strip() for m in _configured(bindings, "project_markers_raw").split(",") if m.strip()]
    repo_dir = bindings.workspace.repo_dir
    return all((repo_dir / marker).is_file() for marker in markers)


def _named_manifest_script(argv: tuple[str, ...]) -> str | None:
    if len(argv) >= 3 and argv[1] == "run":
        return argv[2]
    if len(argv) == 2 and argv[0] == "bun":
        return argv[1]
    return None


def _publish_step_argv(bindings: ToolBindings, field: str) -> tuple[str, ...]:
    argv = _configured_argv(bindings, field)
    if not argv:
        return ()
    script = _named_manifest_script(argv)
    if script is not None and not _has_manifest_script(bindings.workspace.repo_dir, script):
        return ()
    return argv


_BOOTSTRAP_TIMEOUT_FIELD = "workspace_bootstrap_timeout_seconds"
_REPO_COMMAND_SCRUBBED_ENV_KEYS: tuple[str, ...] = (
    "GITHUB_TOKEN",
    "GITHUB_WEBHOOK_SECRET",
    "VEYBOT_REPLAY_TOKEN",
    "VEYBOT_GH_PROXY_HMAC_KEY",
)
_NEEDS_INFO_LABEL = "needs-info"
_AGENT_HOME = Path("/srv/agent-home")
_PRE_PR_FIX_TIMEOUT_SECONDS = 600.0
_PRE_PR_CHECK_TIMEOUT_SECONDS = 600.0
_PRE_PR_CHECK_MAX_OUTPUT = 12_000


@dataclass(slots=True)
class AbortController:
    """Mutable handoff between the `abort_task` host tool and the worker."""

    triggered: bool = False
    reason: str = ""
    stop: Callable[[], None] | None = None

    def signal(self, reason: str) -> None:
        if self.triggered:
            return
        self.triggered = True
        self.reason = reason
        if self.stop is not None:
            self.stop()


@dataclass(slots=True, frozen=True)
class ToolBindings:
    """Per-task closure that the host tools capture."""

    db: Database
    github: GitHubBackend
    git_transport: GitTransport
    repo: RepoInfo
    issue: IssueInfo
    workspace: Workspace
    loop: asyncio.AbstractEventLoop
    author_name: str
    author_email: str
    settings: Settings | None = None
    inbound_thread_number: int | None = None
    inbound_is_pr: bool = False
    review_mode: bool = False
    impl_authorized: bool = False
    slot_uid: int | None = None
    abort: AbortController | None = None

    @property
    def issue_key(self) -> str:
        return issue_key(self.issue.repo, self.issue.number)

    @property
    def default_comment_number(self) -> int:
        return self.inbound_thread_number if self.inbound_thread_number is not None else self.issue.number


def _run_coro(loop: asyncio.AbstractEventLoop, coro: Any) -> Any:
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    return future.result()


def _issue_needs_info(bindings: ToolBindings) -> bool:
    row = bindings.db.get_issue(bindings.issue_key)
    return row is not None and row.state == "needs_info"


def _optional_label_error(exc: Exception) -> str:
    return f"{type(exc).__name__}: {exc}"


def _remove_needs_info_label(bindings: ToolBindings) -> bool:
    try:
        _run_coro(
            bindings.loop,
            bindings.github.remove_issue_label(bindings.repo.full_name, bindings.issue.number, _NEEDS_INFO_LABEL),
        )
    except GitHubError as exc:
        if exc.status == 404:
            return True
        log.warning("needs-info label cleanup failed", extra={"issue": bindings.issue_key, "err": str(exc)})
        return False
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "needs-info label cleanup failed",
            extra={"issue": bindings.issue_key, "err": _optional_label_error(exc)},
        )
        return False
    return True


def _advance_needs_info(bindings: ToolBindings, state: IssueState) -> bool:
    if not _issue_needs_info(bindings):
        return False
    label_cleared = _remove_needs_info_label(bindings)
    bindings.db.set_issue_state(bindings.issue_key, state)
    return label_cleared


def _audit(
    bindings: ToolBindings, name: str, args: Mapping[str, Any], result: Any | None = None, error: str | None = None
) -> None:
    bindings.db.log_tool_call(
        issue_key=bindings.issue_key,
        tool=name,
        args=args,
        result=result if isinstance(result, Mapping) else ({"value": result} if result is not None else None),
        error=error,
    )


def _raise_command(message: str) -> NoReturn:
    raise RpcCommandError(message, error={"message": message})


def _audit_command_error(bindings: ToolBindings, name: str, args: Mapping[str, Any], message: str) -> NoReturn:
    _audit(bindings, name, args, error=message)
    _raise_command(message)


def _git_identity_env(author_name: str, author_email: str) -> dict[str, str]:
    return {
        "GIT_AUTHOR_NAME": author_name,
        "GIT_AUTHOR_EMAIL": author_email,
        "GIT_COMMITTER_NAME": author_name,
        "GIT_COMMITTER_EMAIL": author_email,
    }


def _repo_command_env(bindings: ToolBindings) -> dict[str, str]:
    env = os.environ.copy()
    for key in _REPO_COMMAND_SCRUBBED_ENV_KEYS:
        env[key] = ""
    if _AGENT_HOME.is_dir():
        env["HOME"] = str(_AGENT_HOME)
    env.update(_prepare_slot_runtime_env(bindings.workspace, bindings.slot_uid))
    env.update(_safe_directory_env(bindings.workspace.repo_dir))
    env.update(_git_identity_env(bindings.author_name, bindings.author_email))
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def _run_repo_command(
    bindings: ToolBindings,
    cmd: list[str] | tuple[str, ...],
    *,
    timeout: float | None = None,
    extra_env: Mapping[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    env = _repo_command_env(bindings)
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        list(cmd),
        cwd=str(bindings.workspace.repo_dir),
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        **_slot_subprocess_kwargs(bindings.slot_uid),
    )


def _has_manifest_script(repo_dir: Path, name: str) -> bool:
    package_json = repo_dir / "package.json"
    if not package_json.is_file():
        return False
    try:
        package = json.loads(package_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return True
    if not isinstance(package, Mapping):
        return True
    scripts = package.get("scripts")
    return isinstance(scripts, Mapping) and isinstance(scripts.get(name), str)


def _format_process_output(stdout: Any, stderr: Any) -> str:
    parts: list[str] = []
    for stream in (stdout, stderr):
        if isinstance(stream, bytes):
            text = stream.decode(errors="replace")
        elif isinstance(stream, str):
            text = stream
        elif stream is None:
            continue
        else:
            text = str(stream)
        text = text.strip()
        if text:
            parts.append(text)
    output = "\n".join(parts)
    if not output:
        return "(no output)"
    if len(output) <= _PRE_PR_CHECK_MAX_OUTPUT:
        return output
    return (
        f"... output truncated to last {_PRE_PR_CHECK_MAX_OUTPUT} characters ...\n{output[-_PRE_PR_CHECK_MAX_OUTPUT:]}"
    )


def ensure_workspace_dependencies(bindings: ToolBindings) -> None:
    if not _project_matches(bindings):
        return
    argv = _configured_argv(bindings, "workspace_bootstrap_command")
    if not argv:
        return
    timeout = float(_configured(bindings, _BOOTSTRAP_TIMEOUT_FIELD))
    label = argv[0]
    try:
        proc = _run_repo_command(bindings, argv, timeout=timeout)
    except FileNotFoundError:
        log.warning(
            "bootstrap skipped: command not on PATH",
            extra={"issue": bindings.issue_key, "command": label},
        )
        return
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning(
            "bootstrap failed",
            extra={"issue": bindings.issue_key, "command": label, "err": str(exc)},
        )
        return
    if proc.returncode != 0:
        log.warning(
            "bootstrap nonzero exit",
            extra={
                "issue": bindings.issue_key,
                "command": label,
                "code": proc.returncode,
                "output": _format_process_output(proc.stdout, proc.stderr),
            },
        )
        return
    log.info("bootstrap ok", extra={"issue": bindings.issue_key, "command": label})


def _run_pre_publish_fix(
    bindings: ToolBindings,
    args: Mapping[str, Any],
    *,
    tool_name: str,
    stage: str,
    skip_checks: bool = False,
) -> None:
    argv = _publish_step_argv(bindings, "pre_pr_fix_command")
    if not argv:
        return
    label = shlex.join(argv)
    pre_status = _run_repo_command(bindings, ["git", "status", "--porcelain", "--untracked-files=normal"])
    if pre_status.stdout.strip():
        dirty = "\n  ".join(pre_status.stdout.strip().splitlines())
        msg = (
            f"refusing to {stage}: dirty worktree before `{label}`.\n  "
            f"{dirty}\n"
            "Commit (or `git stash`) every change before invoking the formatter — "
            "anything left uncommitted would be amended into your HEAD commit "
            "and silently land in the PR."
        )
        _audit_command_error(bindings, tool_name, args, msg)
    if skip_checks:
        _audit(
            bindings,
            tool_name,
            args,
            result={"skipped": "pre_pr_fix", "reason": "skip_checks=true"},
        )
        return
    try:
        proc = _run_repo_command(bindings, argv, timeout=_PRE_PR_FIX_TIMEOUT_SECONDS)
    except FileNotFoundError:
        msg = f"refusing to {stage}: `{label}` is required before {stage}, but `{argv[0]}` is not on PATH."
        _audit_command_error(bindings, tool_name, args, msg)
    except subprocess.TimeoutExpired as exc:
        output = _format_process_output(exc.stdout, exc.stderr)
        msg = (
            f"refusing to {stage}: `{label}` timed out before {stage}.\n"
            f"{output}\n\n"
            f"Investigate the hang, rerun the formatter, commit any resulting changes, "
            f"and retry."
        )
        _audit_command_error(bindings, tool_name, args, msg)
    if proc.returncode != 0:
        output = _format_process_output(proc.stdout, proc.stderr)
        msg = (
            f"refusing to {stage}: `{label}` failed before {stage} (exit {proc.returncode}).\n"
            f"{output}\n\n"
            f"Resolve the formatter failure, rerun `{label}` successfully, commit any "
            f"resulting changes, and retry."
        )
        _audit_command_error(bindings, tool_name, args, msg)

    status = _run_repo_command(bindings, ["git", "status", "--porcelain", "--untracked-files=normal"])
    if not status.stdout.strip():
        return

    base = bindings.repo.default_branch
    ahead = _run_repo_command(bindings, ["git", "rev-list", "-n", "1", f"origin/{base}..HEAD"])
    if ahead.returncode != 0 or not ahead.stdout.strip():
        msg = (
            f"refusing to {stage}: `{label}` changed files, but there is no commit of "
            f"yours to fold them into — the checkout matches `origin/{base}`, so the "
            f"formatter drift pre-exists on `{base}`. Inspect with `git status` / `git diff`; "
            "either commit the formatter output yourself or discard it "
            "(`git checkout -- . && git clean -fd`) and retry with `skip_checks=true`, "
            "documenting the bypass."
        )
        _audit_command_error(bindings, tool_name, args, msg)
    head_identity = _run_repo_command(bindings, ["git", "log", "-1", "--format=%an%x1f%ae", "HEAD"])
    if head_identity.returncode != 0 or head_identity.stdout.strip("\n").split("\x1f") != [
        bindings.author_name,
        bindings.author_email,
    ]:
        author = head_identity.stdout.strip("\n").replace("\x1f", " <") + ">"
        msg = (
            f"refusing to {stage}: `{label}` changed files, but HEAD is authored by "
            f"{author} — refusing to fold the formatter diff into a foreign commit. "
            "Fix the identity first (`git commit --amend --reset-author --no-edit`) and retry."
        )
        _audit_command_error(bindings, tool_name, args, msg)

    add = _run_repo_command(bindings, ["git", "add", "-A"])
    if add.returncode != 0:
        err = (add.stderr or add.stdout).strip()
        msg = f"refusing to {stage}: `git add -A` failed after `{label}`: {err}"
        _audit_command_error(bindings, tool_name, args, msg)
    commit = _run_repo_command(bindings, ["git", "commit", "--amend", "--no-edit"])
    if commit.returncode != 0:
        err = (commit.stderr or commit.stdout).strip()
        msg = f"refusing to {stage}: failed to amend `{label}` changes into HEAD: {err}"
        _audit_command_error(bindings, tool_name, args, msg)


def _run_pre_publish_check(
    bindings: ToolBindings,
    args: Mapping[str, Any],
    *,
    tool_name: str,
    stage: str,
    skip_checks: bool = False,
) -> None:
    if skip_checks:
        _audit(
            bindings,
            tool_name,
            args,
            result={"skipped": "pre_pr_check", "reason": "skip_checks=true"},
        )
        return
    argv = _publish_step_argv(bindings, "pre_pr_check_command")
    if not argv:
        return
    label = shlex.join(argv)
    try:
        proc = _run_repo_command(bindings, argv, timeout=_PRE_PR_CHECK_TIMEOUT_SECONDS)
    except FileNotFoundError:
        msg = f"refusing to {stage}: `{label}` is required before {stage}, but `{argv[0]}` is not on PATH."
        _audit_command_error(bindings, tool_name, args, msg)
    except subprocess.TimeoutExpired as exc:
        output = _format_process_output(exc.stdout, exc.stderr)
        msg = (
            f"refusing to {stage}: `{label}` timed out before {stage}.\n"
            f"{output}\n\n"
            f"Fix the check hang/failure, rerun `{label}`, commit any resulting changes, "
            f"and retry."
        )
        _audit_command_error(bindings, tool_name, args, msg)
    if proc.returncode != 0:
        output = _format_process_output(proc.stdout, proc.stderr)
        msg = (
            f"refusing to {stage}: `{label}` failed before {stage} (exit {proc.returncode}).\n"
            f"{output}\n\n"
            f"Fix the reported failures, rerun `{label}` successfully, commit any resulting changes, "
            f"and retry."
        )
        _audit_command_error(bindings, tool_name, args, msg)


_AUTOCLOSE_INELIGIBLE_STATES: frozenset[str] = frozenset({"closed", "merged", "needs_info", "abandoned"})


def _should_schedule_autoclose(bindings: ToolBindings, target_number: int) -> float | None:
    settings = bindings.settings
    if settings is None or not settings.question_autoclose_enabled:
        return None
    hours = float(settings.question_autoclose_hours)
    if hours <= 0:
        return None
    if target_number != bindings.issue.number:
        return None
    if bindings.inbound_is_pr:
        return None
    row = bindings.db.get_issue(bindings.issue_key)
    if row is None or row.classification != "question":
        return None
    if row.state in _AUTOCLOSE_INELIGIBLE_STATES:
        return None
    return hours


def _schedule_autoclose(bindings: ToolBindings, *, comment_id: int, hours: float) -> str | None:
    close_at_dt = datetime.now(UTC) + timedelta(hours=hours)
    close_at = close_at_dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    try:
        bindings.db.upsert_pending_closure(
            issue_key=bindings.issue_key,
            repo=bindings.issue.repo,
            number=bindings.issue.number,
            comment_id=comment_id,
            issue_author=bindings.issue.author,
            close_at=close_at,
        )
    except Exception as exc:  # pragma: no cover
        log.exception(
            "autoclose schedule failed",
            extra={"issue_key": bindings.issue_key, "comment_id": comment_id, "error": str(exc)},
        )
        return None
    return close_at


def _repair_message_escapes(message: str) -> str | None:
    if "\\n" not in message:
        return None
    parts = message.split("`")
    changed = False
    for i in range(0, len(parts), 2):
        fixed = parts[i].replace("\\r\\n", "\n").replace("\\n", "\n")
        if fixed != parts[i]:
            parts[i] = fixed
            changed = True
    return "`".join(parts) if changed else None


def _repair_commit_message_escapes(bindings: ToolBindings, args: Mapping[str, Any], *, tool_name: str) -> None:
    def fail(step: str, proc: subprocess.CompletedProcess[str]) -> NoReturn:
        err = (proc.stderr or proc.stdout).strip() or f"exit {proc.returncode}"
        msg = (
            f"refusing to push: commit messages contain literal `\\n` escapes and the "
            f"automatic repair failed at `{step}`: {err}\n"
            "Reword the affected commits yourself (`git rebase -i origin/"
            + bindings.repo.default_branch
            + "`, real newlines via `git commit -F <file>` or multiple `-m` flags) and retry."
        )
        _audit_command_error(bindings, tool_name, args, msg)

    base = bindings.repo.default_branch
    rev_list = _run_repo_command(
        bindings, ["git", "rev-list", "--topo-order", "--reverse", f"origin/{base}..HEAD"]
    )
    if rev_list.returncode != 0:
        return
    shas = rev_list.stdout.split()
    if not shas:
        return
    messages: dict[str, str] = {}
    repaired: list[str] = []
    for sha in shas:
        show = _run_repo_command(bindings, ["git", "log", "-1", "--format=%B", sha])
        if show.returncode != 0:
            if repaired:
                fail("git log", show)
            return
        message = show.stdout
        fixed = _repair_message_escapes(message)
        if fixed is not None:
            message = fixed
            repaired.append(sha)
        messages[sha] = message
    if not repaired:
        return

    needs_fix = set(repaired)
    rewritten: dict[str, str] = {}
    for sha in shas:
        meta = _run_repo_command(
            bindings,
            ["git", "log", "-1", "--format=%T%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI", sha],
        )
        if meta.returncode != 0:
            fail("git log", meta)
        fields = meta.stdout.strip("\n").split("\x1f")
        if len(fields) != 8:
            fail("git log", meta)
        tree, parents_raw, a_name, a_email, a_date, c_name, c_email, c_date = fields
        parents_old = parents_raw.split()
        parents_new = [rewritten.get(p, p) for p in parents_old]
        if sha not in needs_fix and parents_new == parents_old:
            rewritten[sha] = sha
            continue
        cmd = ["git", "commit-tree", tree]
        for parent in parents_new:
            cmd += ["-p", parent]
        cmd += ["-m", messages[sha].rstrip("\n")]
        made = _run_repo_command(
            bindings,
            cmd,
            extra_env={
                "GIT_AUTHOR_NAME": a_name,
                "GIT_AUTHOR_EMAIL": a_email,
                "GIT_AUTHOR_DATE": a_date,
                "GIT_COMMITTER_NAME": c_name,
                "GIT_COMMITTER_EMAIL": c_email,
                "GIT_COMMITTER_DATE": c_date,
            },
        )
        if made.returncode != 0 or not made.stdout.strip():
            fail("git commit-tree", made)
        rewritten[sha] = made.stdout.strip()

    old_head, new_head = shas[-1], rewritten[shas[-1]]
    update = _run_repo_command(
        bindings,
        ["git", "update-ref", "-m", "veybot: repaired commit message escapes", "HEAD", new_head, old_head],
    )
    if update.returncode != 0:
        fail("git update-ref", update)
    _audit(bindings, tool_name, args, result={"repaired_commit_messages": [sha[:12] for sha in repaired]})
    log.info(
        "repaired commit message escapes",
        extra={"issue": bindings.issue_key, "commits": [sha[:12] for sha in repaired]},
    )


def _guarded_push_branch(bindings: ToolBindings, args: Mapping[str, Any], tool_name: str, branch: str) -> str:
    if bindings.review_mode:
        msg = "refusing to push: PR review worktrees are read-only."
        _audit_command_error(bindings, tool_name, args, msg)
    if branch != bindings.workspace.branch:
        _raise_command(
            f"refusing to push: branch={branch!r} does not match workspace branch {bindings.workspace.branch!r}."
        )
    _run_repo_command(bindings, ["git", "config", "user.email", bindings.author_email])
    _run_repo_command(bindings, ["git", "config", "user.name", bindings.author_name])
    _repair_commit_message_escapes(bindings, args, tool_name=tool_name)
    repo_dir_path = bindings.workspace.repo_dir
    head_proc = _run_repo_command(bindings, ["git", "rev-parse", "HEAD"])
    if head_proc.returncode != 0:
        err = (head_proc.stderr or head_proc.stdout).strip() or f"exit {head_proc.returncode}"
        _audit(bindings, tool_name, args, error=err)
        _raise_command(f"git rev-parse failed: {err}")
    head_sha = head_proc.stdout.strip()

    base = bindings.repo.default_branch
    identities = _run_repo_command(
        bindings,
        ["git", "log", "--format=%H%x09%ae%x09%an", f"origin/{base}..HEAD"],
    )
    if identities.returncode != 0:
        err = (identities.stderr or identities.stdout).strip()
        msg = f"refusing to push: could not inspect commit authors for origin/{base}..HEAD: {err}"
        _audit_command_error(bindings, tool_name, args, msg)
    offending: list[str] = []
    for line in (identities.stdout or "").strip().splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        sha, email, name = parts[0], parts[1], parts[2]
        if email != bindings.author_email or name != bindings.author_name:
            offending.append(f"{sha[:12]} {name} <{email}>")
    if offending:
        details = "\n  ".join(offending)
        msg = (
            "refusing to push: commit author identity mismatch. "
            f"Expected `{bindings.author_name} <{bindings.author_email}>`. "
            f"Offending commits:\n  {details}\n"
            "Amend each commit with `git commit --amend --reset-author --no-edit` "
            "(or rebase with `git rebase -i origin/" + base + " --exec "
            "'git commit --amend --reset-author --no-edit'`) and try again."
        )
        _audit_command_error(bindings, tool_name, args, msg)

    status = _run_repo_command(bindings, ["git", "status", "--porcelain", "--untracked-files=normal"])
    if status.stdout.strip():
        dirty = "\n  ".join(status.stdout.strip().splitlines())
        msg = (
            "refusing to push: working tree is dirty.\n  "
            f"{dirty}\n"
            "Commit (or `git stash`) every change before pushing — anything in the "
            "worktree that isn't in a commit won't appear in the PR."
        )
        _audit_command_error(bindings, tool_name, args, msg)

    try:
        result = bindings.git_transport.push_branch(
            repo=bindings.repo.full_name,
            workspace_key=workspace_key(bindings.repo.full_name, bindings.issue.number),
            repo_dir=repo_dir_path,
            branch=branch,
            expected_head=head_sha,
            slot_uid=bindings.slot_uid,
        )
    except HeadDriftError:
        msg = (
            "refusing to push: HEAD changed between preflight and push "
            "(another commit landed; rerun the gate by re-issuing the push)."
        )
        _audit_command_error(bindings, tool_name, args, msg)
    except GitCommandError as exc:
        err = (exc.stderr or exc.stdout).strip() or f"exit {exc.returncode}"
        _audit(bindings, tool_name, args, error=err)
        _raise_command(f"git push failed: {err}")
    except GitHubError as exc:
        msg = f"gh-proxy rejected push: {exc.status} {exc.message}"
        _audit_command_error(bindings, tool_name, args, msg)
    _share_git_metadata_with_slots(repo_dir_path, bindings.slot_uid)
    _audit(bindings, tool_name, args, result={"head": result.head, "branch": result.branch})
    return result.head


_PRIMARY_TYPES = ("bug", "enhancement", "question", "proposal", "documentation", "wontfix", "invalid", "duplicate")
_AUTO_PR_CLASSIFICATIONS = frozenset({"bug", "documentation"})
_PRIORITIES = ("prio:p0", "prio:p1", "prio:p2", "prio:p3")
_FUNCTIONAL = ("agent", "tool", "tui", "cli", "prompting", "sdk", "auth", "setup", "ux", "providers")
_PLATFORMS = ("platform:linux", "platform:macos", "platform:windows", "platform:wsl")
_PR_RANKS = ("review:p0", "review:p1", "review:p2", "review:p3")
_PR_TYPES = ("feat", "fix", "docs", "refactor", "perf", "test", "chore", "ci", "build")
_CLOSING_ISSUE_RE = re.compile(r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)", re.IGNORECASE)


def _enforce_impl_authorization(
    bindings: ToolBindings,
    tool_name: str,
    args: Mapping[str, Any],
    *,
    action: str,
) -> None:
    if bindings.impl_authorized:
        return
    if bindings.db.has_authorized_impl_event(bindings.issue_key):
        return
    row = bindings.db.get_issue(bindings.issue_key)
    if row is not None:
        if row.pr_number is not None:
            return
        classification = row.classification
        if classification in _AUTO_PR_CLASSIFICATIONS:
            return
    else:
        classification = None
    classification_phrase = f"classified `{classification}`" if classification else "not classified"
    msg = (
        f"refusing to {action}: issue #{bindings.issue.number} is {classification_phrase}; "
        "a repo OWNER or allowlisted maintainer must @-mention you with an explicit go-ahead "
        "before any branch/PR. Post your analysis with `gh_post_comment` and stop."
    )
    _audit_command_error(bindings, tool_name, args, msg)


def _require_review_mode(bindings: ToolBindings, name: str, args: Mapping[str, Any]) -> None:
    if bindings.review_mode:
        return
    msg = f"{name} is only available during incoming PR review tasks."
    _audit_command_error(bindings, name, args, msg)


def _format_pr_file(file: PullRequestFileInfo) -> str:
    return f"- `{file.path}` ({file.status}, +{file.additions}/-{file.deletions})"


def _review_comment_to_payload(comment: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "path": comment.path,
        "line": comment.line,
        "body": comment.body,
        "side": comment.side,
    }
    if comment.start_line is not None:
        payload["start_line"] = comment.start_line
    if comment.start_side is not None:
        payload["start_side"] = comment.start_side
    return payload


# ---------- Declarative tool specs and handlers ----------


@dataclass(slots=True, frozen=True)
class ToolSpec:
    name: str
    properties: dict[str, dict[str, Any]]
    required: tuple[str, ...]
    handler: Callable[[ToolBindings, dict[str, Any]], str]
    review_mode: bool | None = None
    impl_auth_action: str | None = None
    required_nonempty_strings: tuple[str, ...] = ()


def _handle_fetch_issue_thread(bindings: ToolBindings, args: dict[str, Any]) -> str:
    try:
        issue = _run_coro(
            bindings.loop,
            bindings.github.get_issue(bindings.repo.full_name, bindings.issue.number),
        )
        comments = _run_coro(
            bindings.loop,
            bindings.github.list_comments(bindings.repo.full_name, bindings.issue.number),
        )
    except GitHubError as exc:
        _audit(bindings, "fetch_issue_thread", args, error=str(exc))
        _raise_command(f"GitHub fetch failed: {exc.status} {exc.message}")
    lines = [
        f"# {issue.repo}#{issue.number} ({issue.state})",
        f"title: {issue.title}",
        f"author: @{issue.author}",
        f"labels: {', '.join(issue.labels) if issue.labels else '(none)'}",
        "",
        "## Body",
        issue.body.strip() or "(empty)",
        "",
        f"## Comments ({len(comments)})",
    ]
    for c in comments:
        lines.extend(["", f"### @{c.author} at {c.created_at}", c.body.strip()])
    rendered = "\n".join(lines)
    _audit(bindings, "fetch_issue_thread", args, result={"comments": len(comments)})
    return rendered


def _handle_fetch_pr(bindings: ToolBindings, args: dict[str, Any]) -> str:
    pr_number = bindings.default_comment_number
    try:
        pr = _run_coro(bindings.loop, bindings.github.get_pull_request(bindings.repo.full_name, pr_number))
        files = _run_coro(bindings.loop, bindings.github.list_pr_files(bindings.repo.full_name, pr_number))
    except GitHubError as exc:
        _audit(bindings, "fetch_pr", args, error=str(exc))
        _raise_command(f"GitHub fetch failed: {exc.status} {exc.message}")
    linked = tuple(sorted({int(match.group(1)) for match in _CLOSING_ISSUE_RE.finditer(pr.body)}))
    lines = [
        f"# {pr.repo}#{pr.number} ({pr.state})",
        f"title: {pr.title or '(untitled)'}",
        f"author: @{pr.author}",
        f"head: {pr.head_repo or pr.repo}:{pr.head_ref}",
        f"base: {pr.base_ref}",
        f"url: {pr.html_url}",
        "",
        "## Body",
        pr.body.strip() or "(empty)",
        "",
        "## Linked issues",
        ", ".join(f"#{n}" for n in linked) if linked else "(none found in PR body)",
        "",
        f"## Changed files ({len(files)})",
    ]
    lines.extend(_format_pr_file(file) for file in files)
    rendered = "\n".join(lines)
    _audit(bindings, "fetch_pr", args, result={"files": len(files), "linked_issues": list(linked)})
    return rendered


def _handle_post_comment(bindings: ToolBindings, args: dict[str, Any]) -> str:
    body = args.get("body")
    if not isinstance(body, str) or not body.strip():
        _raise_command("gh_post_comment requires a non-empty 'body'.")
    target_number = bindings.default_comment_number
    if isinstance(args.get("number"), int):
        target_number = int(args["number"])
    schedule_close = _should_schedule_autoclose(bindings, target_number)
    body_to_post = body
    if schedule_close is not None:
        body_to_post = f"{body.rstrip()}\n\n{persona.question_autoclose_suffix(schedule_close)}"
    try:
        comment = _run_coro(
            bindings.loop,
            bindings.github.post_comment(bindings.repo.full_name, target_number, body_to_post),
        )
    except GitHubError as exc:
        _audit(bindings, "gh_post_comment", args, error=str(exc))
        _raise_command(f"GitHub rejected comment: {exc.status} {exc.message}")
    audit_result: dict[str, Any] = {"comment_id": comment.id}
    if schedule_close is not None:
        scheduled_at = _schedule_autoclose(
            bindings,
            comment_id=comment.id,
            hours=schedule_close,
        )
        if scheduled_at is not None:
            audit_result["scheduled_close_at"] = scheduled_at
    _audit(bindings, "gh_post_comment", args, result=audit_result)
    return f"comment posted: id={comment.id}"


def _handle_request_review(bindings: ToolBindings, args: dict[str, Any]) -> str:
    reviewers = args.get("reviewers") or []
    assignees = args.get("assignees") or []
    if not isinstance(reviewers, list) or not isinstance(assignees, list):
        _raise_command("gh_request_review expects 'reviewers' and 'assignees' to be arrays of logins.")
    issue_row = bindings.db.get_issue(bindings.issue_key)
    pr_number = issue_row.pr_number if issue_row else None
    if pr_number is None:
        _raise_command("no PR recorded for this issue yet; call gh_open_pr first.")
    try:
        if reviewers:
            _run_coro(
                bindings.loop,
                bindings.github.request_reviewers(
                    repo=bindings.repo.full_name,
                    pr_number=pr_number,
                    reviewers=[str(r) for r in reviewers],
                ),
            )
        if assignees:
            _run_coro(
                bindings.loop,
                bindings.github.add_assignees(
                    bindings.repo.full_name,
                    pr_number,
                    [str(a) for a in assignees],
                ),
            )
    except GitHubError as exc:
        _audit(bindings, "gh_request_review", args, error=str(exc))
        _raise_command(f"GitHub rejected review request: {exc.status} {exc.message}")
    _audit(bindings, "gh_request_review", args, result={"pr": pr_number})
    return f"updated review/assignees on #{pr_number}"


def _handle_mark_unable(bindings: ToolBindings, args: dict[str, Any]) -> str:
    diagnosis = args.get("diagnosis")
    needed = args.get("info_needed")
    if not isinstance(diagnosis, str) or not diagnosis.strip():
        _raise_command("mark_unable_to_reproduce requires a 'diagnosis'.")
    if not isinstance(needed, str) or not needed.strip():
        _raise_command("mark_unable_to_reproduce requires 'info_needed' explaining what to ask for.")
    body = persona.unable_to_reproduce_comment(
        diagnosis=diagnosis,
        info_needed=needed,
    )
    try:
        comment = _run_coro(
            bindings.loop,
            bindings.github.post_comment(bindings.repo.full_name, bindings.issue.number, body),
        )
    except GitHubError as exc:
        _audit(bindings, "mark_unable_to_reproduce", args, error=str(exc))
        _raise_command(f"GitHub rejected comment: {exc.status} {exc.message}")
    result: dict[str, Any] = {"comment_id": comment.id, "state": "needs_info"}
    try:
        labels = _run_coro(
            bindings.loop,
            bindings.github.add_issue_labels(bindings.repo.full_name, bindings.issue.number, [_NEEDS_INFO_LABEL]),
        )
        result["labels"] = list(labels)
    except GitHubError as exc:
        log.warning("needs-info label failed", extra={"issue": bindings.issue_key, "err": str(exc)})
        result["label_error"] = f"{exc.status} {exc.message}"
    except Exception as exc:  # noqa: BLE001
        error = _optional_label_error(exc)
        log.warning("needs-info label failed", extra={"issue": bindings.issue_key, "err": error})
        result["label_error"] = error
    bindings.db.set_issue_state(bindings.issue_key, "needs_info")
    _audit(bindings, "mark_unable_to_reproduce", args, result=result)
    return f"posted needs-info comment id={comment.id}"


def _handle_abort_task(bindings: ToolBindings, args: dict[str, Any]) -> str:
    reason = args.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        _raise_command("abort_task requires a non-empty 'reason' string.")
    reason = reason.strip()
    _audit(bindings, "abort_task", args, result={"reason": reason})
    log.warning(
        "task_aborted",
        extra={"issue": bindings.issue_key, "reason": reason},
    )
    bindings.db.set_issue_state(bindings.issue_key, "abandoned")
    if bindings.abort is not None:
        bindings.abort.signal(reason)
    return "aborted"


def _handle_repro_record(bindings: ToolBindings, args: dict[str, Any]) -> str:
    title = args.get("title")
    command = args.get("command")
    output = args.get("output")
    exit_code = args.get("exit_code")
    if not isinstance(title, str) or not title.strip():
        _raise_command("repro_record requires a non-empty 'title'.")
    if not isinstance(command, str) or not command.strip():
        _raise_command("repro_record requires a non-empty 'command'.")
    if not isinstance(output, str):
        _raise_command("repro_record requires 'output' (may be empty string).")
    if not isinstance(exit_code, int):
        _raise_command("repro_record requires an integer 'exit_code'.")
    bindings.workspace.repro_dir.mkdir(parents=True, exist_ok=True)
    slug = "".join(c if c.isalnum() else "-" for c in title.lower()).strip("-")[:48] or "repro"
    ts = int(time.time())
    target = bindings.workspace.repro_dir / f"{ts}-{slug}.md"
    target.write_text(
        f"# {title}\n\n"
        f"- exit_code: {exit_code}\n"
        f"- command:\n\n```\n{command}\n```\n\n"
        f"## Output\n\n```\n{output}\n```\n",
        encoding="utf-8",
    )
    if _slot_permissions_active(bindings.slot_uid):
        assert bindings.slot_uid is not None
        os.chown(target, bindings.slot_uid, bindings.slot_uid)
    result: dict[str, Any] = {"path": str(target.relative_to(bindings.workspace.root))}
    if _advance_needs_info(bindings, "reproducing"):
        result["cleared_needs_info"] = True
    _audit(bindings, "repro_record", args, result=result)
    return "recorded"


def _handle_set_issue_labels(bindings: ToolBindings, args: dict[str, Any]) -> str:
    if bindings.inbound_is_pr:
        _audit(bindings, "set_issue_labels", args, result={"skipped": "pr_thread"})
        return (
            "no-op: set_issue_labels is not applicable on PR threads — PR labels are "
            "not used for triage. Proceed with the requested change."
        )
    labels = args.get("labels")
    if not isinstance(labels, list) or not labels:
        _raise_command("set_issue_labels requires a non-empty 'labels' array.")
    cleaned = [str(lbl).strip() for lbl in labels if isinstance(lbl, str) and lbl.strip()]
    if not cleaned:
        _raise_command("set_issue_labels requires at least one non-empty label.")
    target_number = bindings.issue.number
    if isinstance(args.get("number"), int):
        target_number = int(args["number"])
    try:
        applied = _run_coro(
            bindings.loop,
            bindings.github.add_issue_labels(bindings.repo.full_name, target_number, cleaned),
        )
    except GitHubError as exc:
        _audit(bindings, "set_issue_labels", args, error=str(exc))
        _raise_command(f"GitHub rejected labels: {exc.status} {exc.message}")
    _audit(bindings, "set_issue_labels", args, result={"labels": list(applied)})
    return f"labels now: {', '.join(applied)}"


def _handle_pr_review_comment(bindings: ToolBindings, args: dict[str, Any]) -> str:
    path = args.get("path")
    line = args.get("line")
    body = args.get("body")
    if not isinstance(path, str) or not path.strip():
        msg = "pr_review_comment requires a non-empty 'path'."
        _audit_command_error(bindings, "pr_review_comment", args, msg)
    if not isinstance(line, int) or line <= 0:
        msg = "pr_review_comment requires a positive integer 'line'."
        _audit_command_error(bindings, "pr_review_comment", args, msg)
    if not isinstance(body, str) or not body.strip():
        msg = "pr_review_comment requires a non-empty 'body'."
        _audit_command_error(bindings, "pr_review_comment", args, msg)
    side = str(args.get("side") or "RIGHT")
    if side not in ("RIGHT", "LEFT"):
        msg = "pr_review_comment 'side' must be RIGHT or LEFT."
        _audit_command_error(bindings, "pr_review_comment", args, msg)
    start_line = args.get("start_line")
    if start_line is not None and (not isinstance(start_line, int) or start_line <= 0):
        msg = "pr_review_comment 'start_line' must be a positive integer when provided."
        _audit_command_error(bindings, "pr_review_comment", args, msg)
    start_side_raw = args.get("start_side")
    start_side = str(start_side_raw) if start_side_raw is not None else None
    if start_side is not None and start_side not in ("RIGHT", "LEFT"):
        msg = "pr_review_comment 'start_side' must be RIGHT or LEFT when provided."
        _audit_command_error(bindings, "pr_review_comment", args, msg)
    staged = bindings.db.stage_review_comment(
        issue_key=bindings.issue_key,
        path=path.strip(),
        line=line,
        side=side,
        start_line=start_line,
        start_side=start_side,
        body=body.strip(),
    )
    count = len(bindings.db.list_staged_review_comments(bindings.issue_key))
    _audit(bindings, "pr_review_comment", args, result={"id": staged.id, "staged": count})
    return f"staged review comment #{staged.id}; staged_count={count}"


def _handle_submit_pr_review(bindings: ToolBindings, args: dict[str, Any]) -> str:
    body = args.get("body")
    if not isinstance(body, str) or not body.strip():
        msg = "submit_pr_review requires a non-empty 'body'."
        _audit_command_error(bindings, "submit_pr_review", args, msg)
    staged = bindings.db.list_staged_review_comments(bindings.issue_key)
    comments = [_review_comment_to_payload(comment) for comment in staged]
    try:
        review = _run_coro(
            bindings.loop,
            bindings.github.submit_pr_review(
                repo=bindings.repo.full_name,
                pr_number=bindings.default_comment_number,
                body=body.strip(),
                event="COMMENT",
                comments=comments,
            ),
        )
    except GitHubError as exc:
        _audit(bindings, "submit_pr_review", args, error=str(exc))
        _raise_command(f"GitHub rejected PR review: {exc.status} {exc.message}")
    cleared = bindings.db.clear_staged_review_comments(bindings.issue_key)
    _audit(
        bindings,
        "submit_pr_review",
        args,
        result={"review_id": review.id, "comments": len(comments), "cleared": cleared, "event": "COMMENT"},
    )
    return f"submitted PR review id={review.id}; comments={len(comments)}"


def _handle_classify_pr(bindings: ToolBindings, args: dict[str, Any]) -> str:
    rank = args.get("rank")
    if rank not in _PR_RANKS:
        msg = f"classify_pr 'rank' must be one of {_PR_RANKS}; got {rank!r}."
        _audit_command_error(bindings, "classify_pr", args, msg)
    pr_type = args.get("type")
    if pr_type not in _PR_TYPES:
        msg = f"classify_pr 'type' must be one of {_PR_TYPES}; got {pr_type!r}."
        _audit_command_error(bindings, "classify_pr", args, msg)
    rationale = args.get("rationale")
    if not isinstance(rationale, str) or not rationale.strip():
        msg = "classify_pr requires a one-sentence 'rationale'."
        _audit_command_error(bindings, "classify_pr", args, msg)

    labels: list[str] = ["triaged", str(rank), str(pr_type)]
    for area in args.get("area") or ():
        if isinstance(area, str) and area in _FUNCTIONAL:
            labels.append(area)
    provider = args.get("provider")
    if isinstance(provider, str) and provider.strip() and provider.startswith("provider:"):
        labels.append("providers")
        labels.append(provider)
    try:
        applied = _run_coro(
            bindings.loop,
            bindings.github.add_issue_labels(bindings.repo.full_name, bindings.default_comment_number, labels),
        )
    except GitHubError as exc:
        _audit(bindings, "classify_pr", args, error=str(exc))
        _raise_command(f"GitHub rejected labels: {exc.status} {exc.message}")
    bindings.db.set_issue_classification(bindings.issue_key, str(rank))
    _audit(
        bindings,
        "classify_pr",
        args,
        result={"rank": rank, "type": pr_type, "labels": list(applied), "rationale": rationale},
    )
    return f"classified PR as {rank}; labels applied: {', '.join(applied)}."


def _handle_classify_issue(bindings: ToolBindings, args: dict[str, Any]) -> str:
    existing = bindings.db.get_issue(bindings.issue_key)
    if bindings.inbound_is_pr:
        note = (
            f"no-op: classify_issue is not applicable on PR threads. "
            f"Issue #{bindings.issue.number} is already classified"
        )
        if existing is not None and existing.classification:
            note += f" as {existing.classification!r}"
        note += ". Proceed with the requested change (amend the branch and push, or post a comment)."
        _audit(bindings, "classify_issue", args, result={"skipped": "pr_thread"})
        return note
    if existing is not None and existing.classification:
        _audit(bindings, "classify_issue", args, result={"skipped": "already_classified"})
        return (
            f"no-op: issue #{bindings.issue.number} is already classified as "
            f"{existing.classification!r}. Continue with that workflow; do not re-classify."
        )
    primary = args.get("primary")
    if primary not in _PRIMARY_TYPES:
        msg = f"classify_issue 'primary' must be one of {_PRIMARY_TYPES}; got {primary!r}."
        _audit_command_error(bindings, "classify_issue", args, msg)
    rationale = args.get("rationale")
    if not isinstance(rationale, str) or not rationale.strip():
        msg = "classify_issue requires a one-sentence 'rationale'."
        _audit_command_error(bindings, "classify_issue", args, msg)
    priority = args.get("priority")
    if primary == "bug":
        if priority not in _PRIORITIES:
            msg = f"classify_issue requires 'priority' in {_PRIORITIES} when primary=='bug'."
            _audit_command_error(bindings, "classify_issue", args, msg)
    else:
        priority = None
    branch_slug = args.get("branch_slug")
    if isinstance(branch_slug, str) and branch_slug.strip():
        try:
            branch_slug = validate_branch_slug(branch_slug)
        except ValueError as exc:
            msg = f"classify_issue rejected branch_slug: {exc}"
            _audit_command_error(bindings, "classify_issue", args, msg)
    else:
        branch_slug = None

    labels: list[str] = [primary]
    if primary == "bug" and isinstance(priority, str):
        labels.append(priority)
    for fn in args.get("functional") or ():
        if isinstance(fn, str) and fn in _FUNCTIONAL:
            labels.append(fn)
    provider = args.get("provider")
    if isinstance(provider, str) and provider.strip() and provider.startswith("provider:"):
        labels.append("providers")
        labels.append(provider)
    platform = args.get("platform")
    if isinstance(platform, str) and platform in _PLATFORMS:
        labels.append(platform)
    labels.append("triaged")

    renamed_to: str | None = None
    if branch_slug:
        try:
            renamed_to = rename_workspace_branch(
                bindings.workspace,
                branch_slug,
                pr_number=existing.pr_number if existing is not None else None,
                slot_uid=bindings.slot_uid,
            )
        except ValueError as exc:
            _audit(bindings, "classify_issue", args, error=str(exc))
            _raise_command(f"classify_issue rejected branch_slug: {exc}")
        except GitCommandError as exc:
            _audit(bindings, "classify_issue", args, error=str(exc))
            _raise_command(f"classify_issue could not rename branch: {exc}")
        if renamed_to != bindings.workspace.branch:
            _raise_command("classify_issue internal: branch rename inconsistent.")
        bindings.db.set_issue_branch(bindings.issue_key, renamed_to)

    try:
        applied = _run_coro(
            bindings.loop,
            bindings.github.add_issue_labels(
                bindings.repo.full_name,
                bindings.issue.number,
                labels,
            ),
        )
    except GitHubError as exc:
        _audit(bindings, "classify_issue", args, error=str(exc))
        _raise_command(f"GitHub rejected labels: {exc.status} {exc.message}")

    bindings.db.set_issue_classification(bindings.issue_key, primary)
    _audit(
        bindings,
        "classify_issue",
        args,
        result={
            "primary": primary,
            "labels": list(applied),
            "rationale": rationale,
            "branch": renamed_to,
        },
    )
    next_step = persona.classify_next_step(str(primary))
    suffix = f" Branch renamed to `{renamed_to}`." if renamed_to else ""
    return f"classified as {primary}; labels applied: {', '.join(applied)}.{suffix} Next: {next_step}."


def _handle_push_branch(bindings: ToolBindings, args: dict[str, Any]) -> str:
    branch = str(args.get("branch") or bindings.workspace.branch)
    skip = bool(args.get("skip_checks", False))
    _run_pre_publish_fix(bindings, args, tool_name="gh_push_branch", stage="push", skip_checks=skip)
    _run_pre_publish_check(bindings, args, tool_name="gh_push_branch", stage="push", skip_checks=skip)
    head = _guarded_push_branch(bindings, args, "gh_push_branch", branch)
    suffix = " (pre-push checks skipped)" if skip else ""
    return f"pushed {branch} at {head[:12]} as {bindings.author_name} <{bindings.author_email}>{suffix}"


def _handle_open_pr(bindings: ToolBindings, args: dict[str, Any]) -> str:
    title = args.get("title")
    body = args.get("body")
    if not isinstance(title, str) or not title.strip():
        _raise_command("gh_open_pr requires a non-empty 'title'.")
    if not isinstance(body, str) or not body.strip():
        _raise_command("gh_open_pr requires a non-empty 'body'.")
    for required in ("## Repro", "## Cause", "## Fix", "## Verification"):
        if required not in body:
            _raise_command(
                f"PR body missing required section header {required!r}. "
                "Follow the template in the system prompt verbatim."
            )
    n = bindings.issue.number
    accepted = [f"{kw} #{n}" for kw in ("Fixes", "Closes", "Resolves", "fixes", "closes", "resolves")]
    if not any(form in body for form in accepted):
        _raise_command(
            f"PR body must include `Fixes #{n}` (or `Closes #{n}` / `Resolves #{n}`) so "
            "GitHub auto-closes the issue when the PR merges. Put it at the end of the "
            "Verification section per the template."
        )
    skip = bool(args.get("skip_checks", False))
    _run_pre_publish_fix(bindings, args, tool_name="gh_open_pr", stage="open PR", skip_checks=skip)
    _run_pre_publish_check(bindings, args, tool_name="gh_open_pr", stage="open PR", skip_checks=skip)
    _guarded_push_branch(bindings, args, "gh_open_pr", bindings.workspace.branch)
    base = args.get("base") or bindings.repo.default_branch
    was_needs_info = _issue_needs_info(bindings)
    try:
        pr = _run_coro(
            bindings.loop,
            bindings.github.open_pull_request(
                repo=bindings.repo.full_name,
                head=bindings.workspace.branch,
                base=str(base),
                title=title,
                body=body,
                draft=bool(args.get("draft", False)),
            ),
        )
    except GitHubError as exc:
        _audit(bindings, "gh_open_pr", args, error=str(exc))
        _raise_command(f"GitHub rejected PR: {exc.status} {exc.message}")
    bindings.db.set_issue_pr(bindings.issue_key, pr.number)
    bindings.db.set_issue_state(bindings.issue_key, "opened")
    needs_info_label_cleared = _remove_needs_info_label(bindings) if was_needs_info else False
    artifact = bindings.workspace.artifacts_dir / "pr.json"
    artifact.write_text(
        json.dumps(
            {
                "repo": pr.repo,
                "number": pr.number,
                "url": pr.html_url,
                "head": pr.head_ref,
                "base": pr.base_ref,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    result: dict[str, Any] = {"pr_number": pr.number, "url": pr.html_url}
    if needs_info_label_cleared:
        result["cleared_needs_info"] = True
    _audit(bindings, "gh_open_pr", args, result=result)
    return f"opened #{pr.number}: {pr.html_url}"


TOOL_SPECS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="classify_issue",
        properties={
            "primary": {"type": "string", "enum": list(_PRIMARY_TYPES)},
            "priority": {"type": "string", "enum": list(_PRIORITIES)},
            "functional": {"type": "array", "items": {"type": "string", "enum": list(_FUNCTIONAL)}},
            "provider": {"type": "string"},
            "platform": {"type": "string", "enum": list(_PLATFORMS)},
            "rationale": {"type": "string"},
            "branch_slug": {"type": "string"},
        },
        required=("primary", "rationale"),
        handler=_handle_classify_issue,
    ),
    ToolSpec(
        name="set_issue_labels",
        properties={
            "labels": {"type": "array", "items": {"type": "string"}},
            "number": {"type": "integer"},
        },
        required=("labels",),
        handler=_handle_set_issue_labels,
    ),
    ToolSpec(
        name="fetch_pr",
        properties={},
        required=(),
        handler=_handle_fetch_pr,
        review_mode=True,
    ),
    ToolSpec(
        name="classify_pr",
        properties={
            "rank": {"type": "string", "enum": list(_PR_RANKS)},
            "type": {"type": "string", "enum": list(_PR_TYPES)},
            "area": {"type": "array", "items": {"type": "string", "enum": list(_FUNCTIONAL)}},
            "provider": {"type": "string"},
            "rationale": {"type": "string"},
        },
        required=("rank", "type", "rationale"),
        handler=_handle_classify_pr,
        review_mode=True,
    ),
    ToolSpec(
        name="pr_review_comment",
        properties={
            "path": {"type": "string"},
            "line": {"type": "integer"},
            "body": {"type": "string"},
            "side": {"type": "string", "enum": ["RIGHT", "LEFT"], "default": "RIGHT"},
            "start_line": {"type": "integer"},
            "start_side": {"type": "string", "enum": ["RIGHT", "LEFT"]},
        },
        required=("path", "line", "body"),
        handler=_handle_pr_review_comment,
        review_mode=True,
    ),
    ToolSpec(
        name="submit_pr_review",
        properties={
            "body": {"type": "string"},
            "event": {"type": "string", "enum": ["COMMENT"], "default": "COMMENT"},
        },
        required=("body",),
        handler=_handle_submit_pr_review,
        review_mode=True,
    ),
    ToolSpec(
        name="gh_post_comment",
        properties={
            "body": {"type": "string"},
            "number": {"type": "integer"},
        },
        required=("body",),
        handler=_handle_post_comment,
    ),
    ToolSpec(
        name="gh_push_branch",
        properties={
            "branch": {"type": "string"},
            "skip_checks": {"type": "boolean"},
        },
        required=(),
        handler=_handle_push_branch,
        review_mode=False,
        impl_auth_action="push branch",
    ),
    ToolSpec(
        name="gh_open_pr",
        properties={
            "title": {"type": "string"},
            "body": {"type": "string"},
            "base": {"type": "string"},
            "draft": {"type": "boolean", "default": False},
            "skip_checks": {"type": "boolean"},
        },
        required=("title", "body"),
        handler=_handle_open_pr,
        review_mode=False,
        impl_auth_action="open PR",
    ),
    ToolSpec(
        name="gh_request_review",
        properties={
            "reviewers": {"type": "array", "items": {"type": "string"}},
            "assignees": {"type": "array", "items": {"type": "string"}},
        },
        required=(),
        handler=_handle_request_review,
    ),
    ToolSpec(
        name="repro_record",
        properties={
            "title": {"type": "string"},
            "command": {"type": "string"},
            "output": {"type": "string"},
            "exit_code": {"type": "integer"},
            "reproduced": {"type": "boolean"},
        },
        required=("title", "command", "output", "exit_code"),
        handler=_handle_repro_record,
    ),
    ToolSpec(
        name="mark_unable_to_reproduce",
        properties={
            "diagnosis": {"type": "string"},
            "info_needed": {"type": "string"},
        },
        required=("diagnosis", "info_needed"),
        handler=_handle_mark_unable,
    ),
    ToolSpec(
        name="abort_task",
        properties={
            "reason": {"type": "string"},
        },
        required=("reason",),
        handler=_handle_abort_task,
    ),
    ToolSpec(
        name="fetch_issue_thread",
        properties={},
        required=(),
        handler=_handle_fetch_issue_thread,
    ),
)

TOOL_TABLE: dict[str, ToolSpec] = {spec.name: spec for spec in TOOL_SPECS}


def _build_parameters_schema(spec: ToolSpec) -> dict[str, Any]:
    props: dict[str, Any] = {}
    for prop_name, prop_val in spec.properties.items():
        prop_copy = dict(prop_val)
        if "description" not in prop_copy:
            try:
                desc = persona.host_tool_parameter_description(spec.name, prop_name)
                prop_copy["description"] = desc
            except Exception:
                pass
        props[prop_name] = prop_copy
    return {
        "type": "object",
        "properties": props,
        **({"required": list(spec.required)} if spec.required else {}),
        "additionalProperties": False,
    }


def _build_tool(spec: ToolSpec, bindings: ToolBindings) -> HostTool[Any, Any]:
    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        if spec.review_mode is True:
            _require_review_mode(bindings, spec.name, args)
        elif spec.review_mode is False and bindings.review_mode:
            target_str = "PR review worktrees" if spec.name == "gh_push_branch" else "PR review tasks"
            msg = f"refusing to {spec.impl_auth_action or 'execute'}: {target_str} are read-only."
            _audit_command_error(bindings, spec.name, args, msg)

        if spec.impl_auth_action is not None:
            _enforce_impl_authorization(bindings, spec.name, args, action=spec.impl_auth_action)

        return spec.handler(bindings, args)

    return host_tool(
        name=spec.name,
        description=persona.host_tool_description(spec.name),
        parameters=_build_parameters_schema(spec),
        execute=execute,
    )


def build(bindings: ToolBindings) -> tuple[HostTool[Any, Any], ...]:
    """Return the full set of host tools bound to one task's context."""
    return tuple(_build_tool(spec, bindings) for spec in TOOL_SPECS)


__all__ = ["AbortController", "TOOL_SPECS", "TOOL_TABLE", "ToolBindings", "ToolSpec", "build"]
