"""`veybot rehearse` — a full-fidelity dry run of one issue.

A rehearsal runs the real task, the real prompts, the real agent and a real
worktree against the live repository, with GitHub's WRITE surface intercepted.
Reads stay live on purpose: a rehearsal whose agent sees a fake issue, fake
comments and fake code measures nothing worth measuring.

Where the interception lives, and why a future tool cannot escape it
--------------------------------------------------------------------
`host_tools` reaches GitHub through exactly two objects, and it constructs
neither of them. `ToolBindings.github` is the REST surface and
`ToolBindings.git_transport` is the push surface; both are injected. A task
entry point receives them as keyword arguments, `worker.run_task` copies them
verbatim into the frozen `ToolBindings` that every tool closure captures, and
`host_tools` itself imports no HTTP client and holds no module-level state. A
tool physically has nowhere else to send a byte.

So a rehearsal does not ask tools to behave. It swaps the two objects out, and
stacks three fail-closed properties on top of that swap:

1. **Deny by default, per method.** `_SealedGitHub` is not a blocklist of
   known writes. It forwards only the names in `_GITHUB_READS` and intercepts
   every other attribute — including names that do not exist yet. A write
   method added to `GitHubBackend` next year is intercepted the day it lands,
   by a wrapper that has never heard of it. The same holds for
   `_SealedGitTransport` and `_GIT_READS`.
2. **Deny by default, per surface.** `assert_bindings_sealable()` walks
   `ToolBindings`' own fields and refuses to start a rehearsal when any field
   is classified neither sealed nor inert. Someone adding a third remote
   surface aborts the rehearsal instead of leaking through it.
3. **Nothing to fall back on.** The `Settings` handed to the task has
   `github_token`, `gh_proxy_url` and `gh_proxy_hmac_key` cleared, so a tool
   that tried to build its own client would have no endpoint and no key.

Every intercepted call is recorded and answered with a plausible success, so
the agent proceeds to the natural end of its run. A rehearsal that makes the
agent think it failed is measuring the wrong thing.
"""

from __future__ import annotations

import dataclasses
import inspect
import os
import subprocess
import threading
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from veybot import tasks
from veybot.config import Settings
from veybot.db import Database
from veybot.git_ops import PushResult
from veybot.github_backend import GitHubBackend
from veybot.github_client import CommentInfo, PullRequestInfo, PullRequestReviewInfo
from veybot.host_tools import ToolBindings
from veybot.manual_triage import build_issues_opened_payload
from veybot.sandbox import GitTransport, SandboxManager, _safe_directory_env

__all__ = [
    "BINDING_SEALERS",
    "INERT_BINDING_FIELDS",
    "AuditedToolCall",
    "InterceptedWrite",
    "LedgerDatabase",
    "Rehearsal",
    "RehearsalError",
    "RehearsalLedger",
    "UnsealedSurfaceError",
    "assert_bindings_sealable",
    "render",
    "run_rehearsal",
    "seal_bindings",
    "seal_github",
    "seal_git_transport",
    "strip_remote_credentials",
]


class RehearsalError(RuntimeError):
    """Raised when a rehearsal cannot be set up (bad ref, PR instead of issue)."""


class UnsealedSurfaceError(RuntimeError):
    """Raised when `ToolBindings` grew a field the seal does not know about.

    Fail-closed on purpose. An unrecognised field might be a live remote
    client, and a rehearsal that leaked one real write would be worse than a
    rehearsal that refused to start.
    """


# ---------------------------------------------------------------------------
# The GitHub surface, split read / write.
#
# `_GITHUB_READS` is the ONLY allowlist. Everything absent from it is treated
# as a write, whether or not this module has ever heard of it.
# ---------------------------------------------------------------------------

_GITHUB_READS: frozenset[str] = frozenset(
    {
        "get_repo",
        "get_issue",
        "list_closing_pull_requests",
        "get_pull_request",
        "list_pr_files",
        "list_issues",
        "list_comments",
        "list_review_comments",
        "list_pr_reviews",
        "get_authenticated_login",
        "list_check_runs",
        "list_commit_statuses",
        "list_workflow_runs_for_sha",
        "get_failed_job_logs",
        "list_comment_reactions",
    }
)

_GIT_READS: frozenset[str] = frozenset({"clone_pool", "fetch_pool", "fetch_base_ref", "fetch_pr_head"})

# Synthetic identifiers are deliberately far outside any plausible real id so
# a number that escapes into a log or a screenshot reads as fake at a glance.
_SYNTHETIC_COMMENT_ID_BASE = 9_000_000_000
_SYNTHETIC_REVIEW_ID_BASE = 9_100_000_000
_SYNTHETIC_PR_NUMBER_BASE = 90_000

_MAX_DIFF_CHARS = 200_000
_GIT_TIMEOUT_SECONDS = 120.0


@dataclass(slots=True, frozen=True)
class InterceptedWrite:
    """One mutating call the rehearsal caught before it left the process."""

    seq: int
    at: float
    """Seconds since the rehearsal started."""
    surface: str
    """`github` for the REST backend, `git` for the push transport."""
    method: str
    args: dict[str, Any]
    result: str
    """Human-readable summary of the synthetic value handed back to the agent."""
    modeled: bool
    """False when this module had no synthetic result for the method and
    returned `None`. The write still did not happen; the agent may simply have
    received a less convincing answer than a modeled write would give it."""


@dataclass(slots=True, frozen=True)
class AuditedToolCall:
    """One host-tool invocation, teed out of the audit funnel."""

    seq: int
    at: float
    tool: str
    args: dict[str, Any]
    result: dict[str, Any] | None
    error: str | None


class RehearsalLedger:
    """Records intercepted writes and audited tool calls, and mints the
    synthetic results the agent sees in their place.

    Touched from three threads — the agent thread (`git_transport.push_branch`,
    `Database.log_tool_call`), the worker event loop (every awaited backend
    call, marshalled there by `host_tools._run_coro`), and the caller — so the
    mutations are locked.
    """

    __slots__ = (
        "_labels",
        "_lock",
        "_next_comment_id",
        "_next_pr",
        "_next_review_id",
        "_seq",
        "_started",
        "bot_login",
        "tool_calls",
        "writes",
    )

    def __init__(self, *, bot_login: str = "veybot", started: float | None = None) -> None:
        self.bot_login = bot_login
        self._started = time.monotonic() if started is None else started
        self._lock = threading.Lock()
        self._seq = 0
        self._next_comment_id = _SYNTHETIC_COMMENT_ID_BASE
        self._next_review_id = _SYNTHETIC_REVIEW_ID_BASE
        self._next_pr = _SYNTHETIC_PR_NUMBER_BASE
        self._labels: dict[tuple[str, int], list[str]] = {}
        self.writes: list[InterceptedWrite] = []
        self.tool_calls: list[AuditedToolCall] = []

    # ---- timing ----
    def elapsed(self) -> float:
        return time.monotonic() - self._started

    # ---- recording ----
    def intercept(
        self,
        *,
        surface: str,
        method: str,
        signature: inspect.Signature | None,
        args: Sequence[Any],
        kwargs: Mapping[str, Any],
    ) -> Any:
        """Record a mutating call and return a plausible success value."""
        bound = _bind_arguments(signature, args, kwargs)
        factory = _SYNTHETIC_RESULTS.get((surface, method))
        with self._lock:
            self._seq += 1
            seq = self._seq
            value = factory(self, bound) if factory is not None else None
            self.writes.append(
                InterceptedWrite(
                    seq=seq,
                    at=self.elapsed(),
                    surface=surface,
                    method=method,
                    args=bound,
                    result=_describe(value),
                    modeled=factory is not None,
                )
            )
        return value

    def record_tool_call(
        self,
        *,
        tool: str,
        args: Mapping[str, Any],
        result: Mapping[str, Any] | None,
        error: str | None,
    ) -> None:
        with self._lock:
            self._seq += 1
            self.tool_calls.append(
                AuditedToolCall(
                    seq=self._seq,
                    at=self.elapsed(),
                    tool=tool,
                    args=dict(args),
                    result=dict(result) if result is not None else None,
                    error=error,
                )
            )

    # ---- synthetic identifier minting (callers hold `_lock`) ----
    def _mint_comment_id(self) -> int:
        self._next_comment_id += 1
        return self._next_comment_id

    def _mint_review_id(self) -> int:
        self._next_review_id += 1
        return self._next_review_id

    def _mint_pr_number(self) -> int:
        self._next_pr += 1
        return self._next_pr

    def _add_labels(self, repo: str, number: int, labels: Sequence[str]) -> tuple[str, ...]:
        current = self._labels.setdefault((repo, number), [])
        for label in labels:
            text = str(label)
            if text not in current:
                current.append(text)
        return tuple(current)

    def _drop_label(self, repo: str, number: int, label: str) -> None:
        current = self._labels.get((repo, number))
        if current is not None and label in current:
            current.remove(label)

    def labels(self) -> dict[tuple[str, int], tuple[str, ...]]:
        with self._lock:
            return {target: tuple(names) for target, names in self._labels.items() if names}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _bind_arguments(
    signature: inspect.Signature | None, args: Sequence[Any], kwargs: Mapping[str, Any]
) -> dict[str, Any]:
    """Name the positional arguments of an intercepted call when we can.

    Falls back to a positional dump for a method that does not exist on the
    real backend at all — which is exactly the future-tool case, and the case
    where losing the names matters least.
    """
    if signature is not None:
        try:
            bound = signature.bind(*args, **kwargs)
        except TypeError:
            pass
        else:
            bound.apply_defaults()
            return dict(bound.arguments)
    named: dict[str, Any] = {f"arg{i}": value for i, value in enumerate(args)}
    named.update(kwargs)
    return named


def _describe(value: Any) -> str:
    if value is None:
        return "None"
    if isinstance(value, tuple) and all(isinstance(item, str) for item in value):
        return ", ".join(value) or "(none)"
    if isinstance(value, CommentInfo):
        return f"CommentInfo(id={value.id})"
    if isinstance(value, PullRequestInfo):
        return f"PullRequestInfo(number={value.number}, url={value.html_url})"
    if isinstance(value, PullRequestReviewInfo):
        return f"PullRequestReviewInfo(id={value.id}, state={value.state})"
    if isinstance(value, PushResult):
        return f"PushResult(branch={value.branch}, head={value.head[:12]})"
    return repr(value)


# ---------------------------------------------------------------------------
# Synthetic results for the writes we model. A write absent from this table is
# still intercepted — it just gets `None` and a `modeled=False` flag so the
# transcript can tell the operator that rehearse has not caught up with the
# tool yet.
# ---------------------------------------------------------------------------


def _synthetic_comment(ledger: RehearsalLedger, bound: Mapping[str, Any]) -> CommentInfo:
    return CommentInfo(
        id=ledger._mint_comment_id(),
        author=ledger.bot_login,
        body=str(bound.get("body", "")),
        created_at=_now_iso(),
    )


def _synthetic_pull_request(ledger: RehearsalLedger, bound: Mapping[str, Any]) -> PullRequestInfo:
    repo = str(bound.get("repo", ""))
    number = ledger._mint_pr_number()
    return PullRequestInfo(
        repo=repo,
        number=number,
        html_url=f"https://github.com/{repo}/pull/{number}",
        head_ref=str(bound.get("head", "")),
        base_ref=str(bound.get("base", "")),
        state="open",
        author=ledger.bot_login,
        head_repo=repo,
        title=str(bound.get("title", "")),
        body=str(bound.get("body", "")),
    )


def _synthetic_labels(ledger: RehearsalLedger, bound: Mapping[str, Any]) -> tuple[str, ...]:
    labels = bound.get("labels") or []
    return ledger._add_labels(str(bound.get("repo", "")), int(bound.get("number", 0)), list(labels))


def _synthetic_label_removal(ledger: RehearsalLedger, bound: Mapping[str, Any]) -> None:
    ledger._drop_label(str(bound.get("repo", "")), int(bound.get("number", 0)), str(bound.get("label", "")))
    return None


def _synthetic_review(ledger: RehearsalLedger, bound: Mapping[str, Any]) -> PullRequestReviewInfo:
    return PullRequestReviewInfo(
        id=ledger._mint_review_id(),
        author=ledger.bot_login,
        body=str(bound.get("body", "")),
        state=str(bound.get("event") or "COMMENTED"),
        submitted_at=_now_iso(),
    )


def _synthetic_none(_ledger: RehearsalLedger, _bound: Mapping[str, Any]) -> None:
    return None


def _synthetic_push(_ledger: RehearsalLedger, bound: Mapping[str, Any]) -> PushResult:
    # `expected_head` is the real local HEAD the preflight just resolved, so the
    # agent gets back the sha it would genuinely have published.
    return PushResult(head=str(bound.get("expected_head", "")), branch=str(bound.get("branch", "")))


_SYNTHETIC_RESULTS: dict[tuple[str, str], Callable[[RehearsalLedger, Mapping[str, Any]], Any]] = {
    ("github", "post_comment"): _synthetic_comment,
    ("github", "open_pull_request"): _synthetic_pull_request,
    ("github", "add_issue_labels"): _synthetic_labels,
    ("github", "remove_issue_label"): _synthetic_label_removal,
    ("github", "submit_pr_review"): _synthetic_review,
    ("github", "request_reviewers"): _synthetic_none,
    ("github", "add_assignees"): _synthetic_none,
    ("github", "close_issue"): _synthetic_none,
    ("git", "push_branch"): _synthetic_push,
}


# ---------------------------------------------------------------------------
# The sealed surfaces.
# ---------------------------------------------------------------------------


class _SealedGitHub:
    """Deny-by-default facade over `GitHubBackend`.

    Only the names in `_GITHUB_READS` reach the live client. Every other
    attribute — modeled write, unmodeled write, method invented after this
    file was last touched — resolves to an interceptor, because `__getattr__`
    is consulted for anything the two slots below do not answer.
    """

    __slots__ = ("_ledger", "_real")

    def __init__(self, real: GitHubBackend, ledger: RehearsalLedger) -> None:
        self._real = real
        self._ledger = ledger

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            # Dunder/private probing (copy, pickle, inspect) is not part of the
            # backend surface and must not be answered with a fake coroutine.
            raise AttributeError(name)
        if name in _GITHUB_READS:
            return getattr(self._real, name)
        signature = _PROTOCOL_SIGNATURES.get(("github", name))
        ledger = self._ledger

        async def _intercepted(*args: Any, **kwargs: Any) -> Any:
            return ledger.intercept(surface="github", method=name, signature=signature, args=args, kwargs=kwargs)

        _intercepted.__name__ = name
        _intercepted.__qualname__ = f"_SealedGitHub.{name}"
        return _intercepted


class _SealedGitTransport:
    """Deny-by-default facade over `GitTransport`.

    `clone_pool` / `fetch_*` only move bytes onto local disk, so they run for
    real — the rehearsal needs the true repository state. `push_branch`, and
    anything else that shows up here later, is intercepted. These calls are
    synchronous, matching the protocol.
    """

    __slots__ = ("_ledger", "_real")

    def __init__(self, real: GitTransport, ledger: RehearsalLedger) -> None:
        self._real = real
        self._ledger = ledger

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in _GIT_READS:
            return getattr(self._real, name)
        signature = _PROTOCOL_SIGNATURES.get(("git", name))
        ledger = self._ledger

        def _intercepted(*args: Any, **kwargs: Any) -> Any:
            return ledger.intercept(surface="git", method=name, signature=signature, args=args, kwargs=kwargs)

        _intercepted.__name__ = name
        _intercepted.__qualname__ = f"_SealedGitTransport.{name}"
        return _intercepted


def _protocol_signature(protocol: type, name: str) -> inspect.Signature | None:
    """Argument names for an intercepted call, read off the protocol.

    Deliberately reads the PROTOCOL and never the live object: on a write path
    the seal must not so much as `getattr` the real backend, or a hostile /
    strict implementation could be provoked into acting. A method absent from
    the protocol yields `None` and the ledger falls back to positional
    names — that is exactly the future-write case, and the case where losing
    argument names matters least.
    """
    fn = getattr(protocol, name, None)
    if not callable(fn):
        return None
    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):
        return None
    parameters = list(signature.parameters.values())
    if parameters and parameters[0].name == "self":
        parameters = parameters[1:]
    return signature.replace(parameters=parameters)


_PROTOCOL_SIGNATURES: dict[tuple[str, str], inspect.Signature] = {
    (surface, name): signature
    for surface, protocol in (("github", GitHubBackend), ("git", GitTransport))
    for name in vars(protocol)
    if not name.startswith("_") and (signature := _protocol_signature(protocol, name)) is not None
}


def seal_github(real: GitHubBackend, ledger: RehearsalLedger) -> GitHubBackend:
    """Wrap a live backend so reads pass through and writes are recorded."""
    return _SealedGitHub(real, ledger)  # type: ignore[return-value]


def seal_git_transport(real: GitTransport, ledger: RehearsalLedger) -> GitTransport:
    """Wrap a live transport so clone/fetch pass through and pushes are recorded."""
    return _SealedGitTransport(real, ledger)  # type: ignore[return-value]


class LedgerDatabase(Database):
    """`Database` that tees every host-tool audit row into the ledger.

    `host_tools._audit` is the single funnel every tool passes through and it
    lands here, so subclassing gives the rehearsal the tool-level view — name,
    args, result, error, order — without `host_tools` knowing a rehearsal is
    happening. The row is still written, so the scratch sqlite file stays a
    faithful copy of what a live run would have recorded.
    """

    def __init__(self, path: Path, ledger: RehearsalLedger) -> None:
        super().__init__(path)
        self._ledger = ledger

    def log_tool_call(
        self,
        *,
        issue_key: str,
        tool: str,
        args: Mapping[str, Any],
        result: Mapping[str, Any] | None = None,
        error: str | None = None,
    ) -> int:
        self._ledger.record_tool_call(tool=tool, args=args, result=result, error=error)
        return super().log_tool_call(issue_key=issue_key, tool=tool, args=args, result=result, error=error)


# ---------------------------------------------------------------------------
# Per-surface classification of `ToolBindings`.
#
# Every field is either SEALED (a remote surface the rehearsal replaces) or
# INERT (local state that cannot reach GitHub). A field in neither set aborts
# the rehearsal, because the safe assumption about an unknown field is that it
# is a live client.
# ---------------------------------------------------------------------------

BINDING_SEALERS: dict[str, Callable[[Any, RehearsalLedger], Any]] = {
    "github": seal_github,
    "git_transport": seal_git_transport,
}

INERT_BINDING_FIELDS: frozenset[str] = frozenset(
    {
        "db",
        "repo",
        "issue",
        "workspace",
        "loop",
        "author_name",
        "author_email",
        "settings",
        "inbound_thread_number",
        "inbound_is_pr",
        "review_mode",
        "impl_authorized",
        "slot_uid",
        "abort",
    }
)


def _binding_field_names() -> frozenset[str]:
    return frozenset(f.name for f in dataclasses.fields(ToolBindings))


def assert_bindings_sealable() -> None:
    """Refuse to rehearse when `ToolBindings` grew an unclassified field."""
    unknown = _binding_field_names() - set(BINDING_SEALERS) - INERT_BINDING_FIELDS
    if unknown:
        raise UnsealedSurfaceError(
            "ToolBindings has field(s) rehearse cannot classify: "
            + ", ".join(sorted(unknown))
            + ". Add each to rehearse.BINDING_SEALERS (if it can reach GitHub) or to "
            "rehearse.INERT_BINDING_FIELDS (if it cannot). Refusing to rehearse rather "
            "than risk a real write."
        )


def seal_bindings(bindings: ToolBindings, ledger: RehearsalLedger) -> ToolBindings:
    """Return a copy of `bindings` whose every remote surface is intercepted."""
    assert_bindings_sealable()
    replacements = {name: sealer(getattr(bindings, name), ledger) for name, sealer in BINDING_SEALERS.items()}
    return dataclasses.replace(bindings, **replacements)


def strip_remote_credentials(settings: Settings) -> Settings:
    """Blank every credential that could reach GitHub.

    Second line of defence. Sealing the injected surfaces stops the tools that
    exist; clearing the credentials stops a tool that tried to build its own
    client out of `bindings.settings`. `model_copy` skips validation on
    purpose — the resulting object is deliberately in a state the validator
    would reject, because it must not be usable against GitHub.
    """
    return settings.model_copy(update={"github_token": None, "gh_proxy_url": None, "gh_proxy_hmac_key": None})


# ---------------------------------------------------------------------------
# Local git inspection.
# ---------------------------------------------------------------------------


def _git(repo_dir: Path, *args: str) -> tuple[int, str, str]:
    env = dict(os.environ)
    env.update(_safe_directory_env(repo_dir))
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_OPTIONAL_LOCKS"] = "0"
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(repo_dir),
            env=env,
            capture_output=True,
            text=True,
            check=False,
            timeout=_GIT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, "", f"{type(exc).__name__}: {exc}"
    return proc.returncode, proc.stdout, proc.stderr


@dataclass(slots=True, frozen=True)
class LocalChanges:
    """What the run left behind in the worktree."""

    commits: tuple[str, ...] = ()
    diff: str = ""
    uncommitted: str = ""
    note: str = ""


def collect_local_changes(repo_dir: Path, base_branch: str) -> LocalChanges:
    """Commits and diff the run produced, relative to `origin/<base_branch>`."""
    if not (repo_dir / ".git").exists():
        return LocalChanges(note=f"no worktree at {repo_dir}")
    span = f"origin/{base_branch}..HEAD"
    code, out, err = _git(repo_dir, "log", "--format=%h %s", span)
    if code != 0:
        return LocalChanges(note=f"git log {span} failed: {err.strip() or f'exit {code}'}")
    commits = tuple(line for line in out.splitlines() if line.strip())
    code, diff, err = _git(repo_dir, "diff", f"origin/{base_branch}...HEAD")
    if code != 0:
        return LocalChanges(commits=commits, note=f"git diff failed: {err.strip() or f'exit {code}'}")
    _, uncommitted, _ = _git(repo_dir, "diff", "HEAD")
    return LocalChanges(commits=commits, diff=_cap(diff), uncommitted=_cap(uncommitted))


def _cap(text: str) -> str:
    if len(text) <= _MAX_DIFF_CHARS:
        return text
    return text[:_MAX_DIFF_CHARS] + f"\n... [truncated at {_MAX_DIFF_CHARS} chars]\n"


# ---------------------------------------------------------------------------
# Running a rehearsal.
# ---------------------------------------------------------------------------

TaskFn = Callable[..., Awaitable[None]]

_TASK_FUNCTIONS: dict[str, TaskFn] = {
    "triage": tasks.triage_issue,
    "port": tasks.port_upstream,
}


@dataclass(slots=True, frozen=True)
class Rehearsal:
    """Everything a reviewer needs to judge one dry run."""

    repo: str
    number: int
    task: str
    issue_title: str
    base_branch: str
    started_at: str
    wall_seconds: float
    outcome: str
    """`completed` or `failed`."""
    error: str | None
    writes: tuple[InterceptedWrite, ...]
    tool_calls: tuple[AuditedToolCall, ...]
    labels: dict[tuple[str, int], tuple[str, ...]]
    branch: str | None
    changes: LocalChanges = field(default_factory=LocalChanges)
    workspace_dir: Path | None = None

    @property
    def comments(self) -> tuple[InterceptedWrite, ...]:
        return tuple(w for w in self.writes if w.surface == "github" and w.method == "post_comment")

    @property
    def pull_requests(self) -> tuple[InterceptedWrite, ...]:
        return tuple(w for w in self.writes if w.surface == "github" and w.method == "open_pull_request")

    @property
    def pushes(self) -> tuple[InterceptedWrite, ...]:
        return tuple(w for w in self.writes if w.surface == "git" and w.method == "push_branch")

    @property
    def unmodeled(self) -> tuple[InterceptedWrite, ...]:
        return tuple(w for w in self.writes if not w.modeled)

    @property
    def failed_tool_calls(self) -> tuple[AuditedToolCall, ...]:
        return tuple(c for c in self.tool_calls if c.error is not None)


def _select_task(settings: Settings, labels: Sequence[str]) -> str:
    """Pick the task the live router would pick for this issue."""
    if settings.port_upstream_enabled and settings.port_label in labels:
        return "port"
    return "triage"


async def run_rehearsal(
    *,
    settings: Settings,
    github: GitHubBackend,
    git_transport: GitTransport,
    repo_full: str,
    number: int,
    workspace_root: Path,
    db_path: Path,
    task: str | None = None,
    fresh: bool = True,
    task_functions: Mapping[str, TaskFn] | None = None,
) -> Rehearsal:
    """Run one issue end to end with GitHub's write surface intercepted.

    `github` and `git_transport` MUST be the live objects: the sealing happens
    here so no caller can forget it, and so reads keep hitting the real
    repository. `db_path` should be a scratch file — a rehearsal writes issue
    rows, labels and tool-call audits exactly as a live run does, and none of
    that belongs in the operational database.
    """
    assert_bindings_sealable()
    functions = dict(_TASK_FUNCTIONS if task_functions is None else task_functions)

    ledger = RehearsalLedger(bot_login=settings.bot_login)
    sealed_github = seal_github(github, ledger)
    sealed_transport = seal_git_transport(git_transport, ledger)

    payload = await build_issues_opened_payload(sealed_github, repo_full, number)
    issue_block = payload["issue"]
    repo_block = payload["repository"]
    labels = [str(entry.get("name", "")) for entry in issue_block.get("labels", [])]
    base_branch = str(repo_block.get("default_branch") or "main")

    task_name = task or _select_task(settings, labels)
    task_fn = functions.get(task_name)
    if task_fn is None:
        raise RehearsalError(f"unknown rehearsal task {task_name!r}; expected one of {', '.join(sorted(functions))}")

    sandbox = SandboxManager(workspace_root, transport=sealed_transport)
    if fresh:
        # A resumed worktree carries the previous rehearsal's commits and a
        # veyyon session the worker would `--continue`, which would make the
        # second rehearsal of an issue measure a continuation instead of a run.
        sandbox.remove_workspace(repo=repo_full, number=number)

    db = LedgerDatabase(db_path, ledger)
    delivery_id = f"rehearse-{repo_full.replace('/', '__')}-{number}-{int(time.time())}"
    started_at = _now_iso()
    outcome = "completed"
    error: str | None = None
    start = time.monotonic()
    try:
        await task_fn(
            settings=strip_remote_credentials(settings),
            db=db,
            github=sealed_github,
            sandbox=sandbox,
            git_transport=sealed_transport,
            payload=payload,
            delivery_id=delivery_id,
            attempts=0,
        )
    except Exception as exc:  # noqa: BLE001 - a failed run is a rehearsal result, not a crash
        outcome = "failed"
        error = f"{type(exc).__name__}: {exc}"
    wall_seconds = time.monotonic() - start

    ws_root = sandbox.workspace_root(repo_full, number)
    repo_dir = ws_root / "repo"
    issue_row = db.get_issue(f"{repo_full}#{number}")
    branch = issue_row.branch if issue_row is not None else None
    changes = collect_local_changes(repo_dir, base_branch)
    db.close()

    return Rehearsal(
        repo=repo_full,
        number=number,
        task=task_name,
        issue_title=str(issue_block.get("title", "")),
        base_branch=base_branch,
        started_at=started_at,
        wall_seconds=wall_seconds,
        outcome=outcome,
        error=error,
        writes=tuple(ledger.writes),
        tool_calls=tuple(ledger.tool_calls),
        labels=ledger.labels(),
        branch=branch,
        changes=changes,
        workspace_dir=ws_root if ws_root.exists() else None,
    )


# ---------------------------------------------------------------------------
# Transcript.
# ---------------------------------------------------------------------------

_RULE = "=" * 74


def _duration(seconds: float) -> str:
    total = int(seconds)
    if total < 60:
        return f"{seconds:.1f}s"
    return f"{total // 60}m {total % 60:02d}s"


def _stamp(seconds: float) -> str:
    total = int(seconds)
    return f"+{total // 60:02d}:{total % 60:02d}"


def _section(title: str) -> str:
    return f"\n--- {title} " + "-" * max(0, 70 - len(title))


def _short(value: Any, limit: int = 160) -> str:
    text = str(value)
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def render(rehearsal: Rehearsal) -> str:
    """Render the transcript a human reads to judge the run."""
    out: list[str] = [
        _RULE,
        f"veybot rehearsal  {rehearsal.repo}#{rehearsal.number}  ({rehearsal.task})",
        _RULE,
        f"issue      : {rehearsal.issue_title}",
        f"started    : {rehearsal.started_at}",
        f"outcome    : {rehearsal.outcome}" + (f" — {rehearsal.error}" if rehearsal.error else ""),
        f"wall clock : {_duration(rehearsal.wall_seconds)}",
        f"host tools : {len(rehearsal.tool_calls)} call(s), {len(rehearsal.failed_tool_calls)} rejected",
        f"intercepted: {len(rehearsal.writes)} GitHub write(s) — none of them reached GitHub",
    ]
    if rehearsal.workspace_dir is not None:
        out.append(f"workspace  : {rehearsal.workspace_dir}")

    out.extend(_render_comments(rehearsal))
    out.extend(_render_labels(rehearsal))
    out.extend(_render_branch(rehearsal))
    out.extend(_render_pull_requests(rehearsal))
    out.extend(_render_other_writes(rehearsal))
    out.extend(_render_rejections(rehearsal))
    out.extend(_render_diff(rehearsal))
    out.append("")
    return "\n".join(out)


def _render_comments(rehearsal: Rehearsal) -> list[str]:
    comments = rehearsal.comments
    out = [_section(f"comments ({len(comments)})")]
    if not comments:
        out.append("(none)")
        return out
    for index, write in enumerate(comments, start=1):
        target = write.args.get("number", rehearsal.number)
        out.append("")
        out.append(f"[{index}] {_stamp(write.at)}  ->  {rehearsal.repo}#{target}")
        out.append("")
        out.append(str(write.args.get("body", "")))
    return out


def _render_labels(rehearsal: Rehearsal) -> list[str]:
    out = [_section("labels")]
    if not rehearsal.labels:
        out.append("(none)")
        return out
    for (repo, number), names in sorted(rehearsal.labels.items()):
        out.append(f"{repo}#{number}: {', '.join(names)}")
    return out


def _render_branch(rehearsal: Rehearsal) -> list[str]:
    out = [_section("branch & commits")]
    out.append(f"branch : {rehearsal.branch or '(none)'}")
    for write in rehearsal.pushes:
        head = str(write.args.get("expected_head", ""))
        out.append(f"push   : {_stamp(write.at)} {write.args.get('branch', '')} at {head[:12] or '(unknown)'}")
    if rehearsal.changes.commits:
        out.append(f"commits ({len(rehearsal.changes.commits)}) on top of origin/{rehearsal.base_branch}:")
        out.extend(f"  {line}" for line in rehearsal.changes.commits)
    else:
        out.append(f"commits: (none on top of origin/{rehearsal.base_branch})")
    if rehearsal.changes.note:
        out.append(f"note   : {rehearsal.changes.note}")
    return out


def _render_pull_requests(rehearsal: Rehearsal) -> list[str]:
    prs = rehearsal.pull_requests
    out = [_section(f"pull request ({len(prs)})")]
    if not prs:
        out.append("(none)")
        return out
    for write in prs:
        draft = " [draft]" if write.args.get("draft") else ""
        out.append("")
        out.append(f"{_stamp(write.at)}  {write.args.get('head', '')} -> {write.args.get('base', '')}{draft}")
        out.append(f"title: {write.args.get('title', '')}")
        out.append("")
        out.append(str(write.args.get("body", "")))
    return out


_ALREADY_RENDERED: frozenset[tuple[str, str]] = frozenset(
    {
        ("github", "post_comment"),
        ("github", "open_pull_request"),
        ("git", "push_branch"),
        ("github", "add_issue_labels"),
    }
)


def _render_other_writes(rehearsal: Rehearsal) -> list[str]:
    others = [w for w in rehearsal.writes if (w.surface, w.method) not in _ALREADY_RENDERED]
    out = [_section(f"other intercepted writes ({len(others)})")]
    if not others:
        out.append("(none)")
    for write in others:
        args = ", ".join(f"{key}={_short(value, 80)}" for key, value in write.args.items())
        out.append(f"{_stamp(write.at)} {write.surface}.{write.method}({args}) -> {_short(write.result, 80)}")
    unmodeled = rehearsal.unmodeled
    if unmodeled:
        out.append("")
        out.append(
            f"WARNING: {len(unmodeled)} intercepted call(s) have no synthetic result in rehearse.py "
            "(" + ", ".join(sorted({f"{w.surface}.{w.method}" for w in unmodeled})) + "). "
            "They were still blocked, but the agent got None back — teach rehearse about them."
        )
    return out


def _render_rejections(rehearsal: Rehearsal) -> list[str]:
    failures = rehearsal.failed_tool_calls
    if not failures:
        return []
    out = [_section(f"rejected tool calls ({len(failures)})")]
    for call in failures:
        out.append(f"{_stamp(call.at)} {call.tool}: {_short(call.error, 300)}")
    return out


def _render_diff(rehearsal: Rehearsal) -> list[str]:
    out = [_section("local diff")]
    changes = rehearsal.changes
    if changes.diff:
        out.append(changes.diff.rstrip("\n"))
    else:
        out.append(f"(no committed change against origin/{rehearsal.base_branch})")
    if changes.uncommitted:
        out.append(_section("uncommitted worktree changes"))
        out.append(changes.uncommitted.rstrip("\n"))
    return out
