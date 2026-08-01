"""`veybot rehearse` — the boundary that keeps a dry run off GitHub.

The load-bearing property here is negative: in rehearse mode NO write reaches
GitHub. Asserting that against a cooperative mock would prove nothing, so every
test in this file drives the sealed surfaces against `ExplodingBackend` /
`ExplodingTransport`, whose write paths raise `LeakedWrite` on attribute
access. A leak therefore fails loudly, right here, instead of being asserted
away — or discovered as a real pull request on someone's repository.
"""

from __future__ import annotations

import asyncio
import dataclasses
import subprocess
import threading
from pathlib import Path
from typing import Any

import pytest
from click.testing import CliRunner
from veyyon_rpc import HostToolContext, RpcCommandError, host_tool

from veybot import cli, host_tools, rehearse
from veybot.config import Settings
from veybot.db import Database
from veybot.git_ops import PushResult
from veybot.github_backend import GitHubBackend
from veybot.github_client import CommentInfo, IssueInfo, PullRequestInfo, PullRequestReviewInfo, RepoInfo
from veybot.host_tools import ToolBindings
from veybot.manual_triage import ManualTriageError
from veybot.persona import question_autoclose_suffix
from veybot.rehearse import (
    AuditedToolCall,
    InterceptedWrite,
    LocalChanges,
    Rehearsal,
    RehearsalLedger,
    UnsealedSurfaceError,
    assert_bindings_sealable,
    collect_local_changes,
    render,
    run_rehearsal,
    seal_bindings,
    seal_git_transport,
    seal_github,
    strip_remote_credentials,
)
from veybot.sandbox import Workspace

# ---------------------------------------------------------------------------
# Doubles. Reads answer; writes explode.
# ---------------------------------------------------------------------------


class LeakedWrite(AssertionError):
    """A mutating call escaped the seal and reached the live surface."""


_ISSUE = IssueInfo(
    repo="octo/widget",
    number=42,
    title="AskDialog crashes on empty questions",
    body="steps to reproduce",
    state="open",
    author="alice",
    labels=("bug",),
    is_pull_request=False,
)

_REPO = RepoInfo(
    full_name="octo/widget",
    default_branch="main",
    clone_url="https://github.com/octo/widget.git",
    private=False,
)


class ExplodingBackend:
    """`GitHubBackend` whose reads answer and whose writes raise.

    Writes raise on *attribute access*, not on call, so a seal that merely
    hands the real bound method back to the agent is caught even if the agent
    never gets around to invoking it.
    """

    def __init__(self) -> None:
        self.reads: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    async def get_issue(self, repo: str, number: int) -> IssueInfo:
        self.reads.append(("get_issue", (repo, number), {}))
        return _ISSUE

    async def get_repo(self, repo: str) -> RepoInfo:
        self.reads.append(("get_repo", (repo,), {}))
        return _REPO

    async def list_comments(self, repo: str, number: int) -> list[CommentInfo]:
        self.reads.append(("list_comments", (repo, number), {}))
        return []

    async def list_closing_pull_requests(self, repo: str, number: int) -> tuple[int, ...]:
        self.reads.append(("list_closing_pull_requests", (repo, number), {}))
        return ()

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in rehearse._GITHUB_READS:
            reads = self.reads

            async def _read(*args: Any, **kwargs: Any) -> str:
                reads.append((name, args, kwargs))
                return f"live:{name}"

            return _read
        raise LeakedWrite(f"github.{name} reached the live backend")


class ExplodingTransport:
    """`GitTransport` whose clone/fetch work and whose push raises."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def clone_pool(self, *, repo: str, clone_url: str, default_branch: str, target: Path) -> None:
        self.calls.append(("clone_pool", {"repo": repo, "clone_url": clone_url, "target": target}))

    def fetch_pool(self, *, repo: str, pool_dir: Path) -> None:
        self.calls.append(("fetch_pool", {"repo": repo, "pool_dir": pool_dir}))

    def fetch_base_ref(self, *, repo: str, pool_dir: Path, ref: str) -> None:
        self.calls.append(("fetch_base_ref", {"repo": repo, "pool_dir": pool_dir, "ref": ref}))

    def fetch_pr_head(self, *, repo: str, pool_dir: Path, pr_number: int) -> None:
        self.calls.append(("fetch_pr_head", {"repo": repo, "pool_dir": pool_dir, "pr_number": pr_number}))

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        raise LeakedWrite(f"git.{name} reached the live transport")


# Plausible arguments for every write the protocol declares, so the "nothing
# escapes" test can drive the real shapes rather than a hand-picked subset.
_WRITE_CALLS: dict[str, dict[str, Any]] = {
    "post_comment": {"repo": "octo/widget", "number": 42, "body": "hello"},
    "open_pull_request": {
        "repo": "octo/widget",
        "head": "farm/abc12345/boom",
        "base": "main",
        "title": "fix: boom",
        "body": "## Repro\n## Cause\n## Fix\n## Verification\nFixes #42",
    },
    "request_reviewers": {"repo": "octo/widget", "pr_number": 7, "reviewers": ["carol"]},
    "add_issue_labels": {"repo": "octo/widget", "number": 42, "labels": ["bug", "prio:p1"]},
    "remove_issue_label": {"repo": "octo/widget", "number": 42, "label": "needs-info"},
    "submit_pr_review": {
        "repo": "octo/widget",
        "pr_number": 7,
        "body": "looks fine",
        "event": "COMMENT",
        "comments": [],
    },
    "add_assignees": {"repo": "octo/widget", "number": 42, "assignees": ["dave"]},
    "close_issue": {"repo": "octo/widget", "number": 42, "reason": "completed"},
}


# Plausible arguments for every read, so the "reads stay live" test drives the
# real arities instead of assuming they all take `(repo, number)`.
_READ_CALLS: dict[str, tuple[Any, ...]] = {
    "get_repo": ("octo/widget",),
    "get_issue": ("octo/widget", 42),
    "list_closing_pull_requests": ("octo/widget", 42),
    "get_pull_request": ("octo/widget", 7),
    "list_pr_files": ("octo/widget", 7),
    "list_issues": ("octo/widget",),
    "list_comments": ("octo/widget", 42),
    "list_review_comments": ("octo/widget", 7),
    "list_pr_reviews": ("octo/widget", 7),
    "get_authenticated_login": (),
    "list_check_runs": ("octo/widget", "a" * 40),
    "list_commit_statuses": ("octo/widget", "a" * 40),
    "list_workflow_runs_for_sha": ("octo/widget", "a" * 40),
    "get_failed_job_logs": ("octo/widget", 99),
    "list_comment_reactions": ("octo/widget", 12345),
}


def _protocol_writes() -> frozenset[str]:
    members = {name for name in vars(GitHubBackend) if not name.startswith("_")}
    return frozenset(members - rehearse._GITHUB_READS)


# ---------------------------------------------------------------------------
# Local fixtures.
# ---------------------------------------------------------------------------


def _workspace(tmp_path: Path, *, branch: str = "farm/abc12345/boom") -> Workspace:
    root = tmp_path / "ws"
    repo_dir = root / "repo"
    session_dir = root / ".veyyon-session"
    context_dir = root / "context"
    artifacts_dir = root / "artifacts"
    for path in (root, repo_dir, session_dir, context_dir, context_dir / "repro", artifacts_dir):
        path.mkdir(parents=True, exist_ok=True)
    return Workspace(
        root=root,
        repo_dir=repo_dir,
        session_dir=session_dir,
        context_dir=context_dir,
        artifacts_dir=artifacts_dir,
        branch=branch,
        repo_full_name="octo/widget",
        issue_number=42,
    )


def _loop() -> tuple[asyncio.AbstractEventLoop, threading.Thread]:
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    return loop, thread


def _stop(loop: asyncio.AbstractEventLoop, thread: threading.Thread) -> None:
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=2.0)
    loop.close()


def _bindings(db: Database, tmp_path: Path, backend: Any, transport: Any, loop: Any, **overrides: Any) -> ToolBindings:
    bindings = ToolBindings(
        db=db,
        github=backend,
        git_transport=transport,
        repo=_REPO,
        issue=_ISSUE,
        workspace=overrides.pop("workspace", None) or _workspace(tmp_path),
        loop=loop,
        author_name="robveybot",
        author_email="robveybot@example.invalid",
        **overrides,
    )
    db.upsert_issue(
        key=bindings.issue_key,
        repo="octo/widget",
        number=42,
        state="reproducing",
        branch=bindings.workspace.branch,
        session_dir=str(bindings.workspace.session_dir),
    )
    return bindings


def _ctx() -> HostToolContext[Any]:
    return HostToolContext(tool_call_id="tc-1", _cancel_event=threading.Event(), _send_update=lambda _payload: None)


def _tool(tools: tuple[Any, ...], name: str) -> Any:
    for tool in tools:
        if tool.name == name:
            return tool
    raise AssertionError(f"tool {name!r} not built")


def _git(repo_dir: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args],
        cwd=str(repo_dir),
        capture_output=True,
        text=True,
        check=True,
        env={
            "PATH": "/usr/bin:/bin:/usr/local/bin",
            "HOME": str(repo_dir),
            "GIT_AUTHOR_NAME": "robveybot",
            "GIT_AUTHOR_EMAIL": "robveybot@example.invalid",
            "GIT_COMMITTER_NAME": "robveybot",
            "GIT_COMMITTER_EMAIL": "robveybot@example.invalid",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_SYSTEM": "/dev/null",
        },
    )
    return proc.stdout


def _real_repo(tmp_path: Path) -> Workspace:
    """A worktree with an `origin/main` ref and one bot-authored commit.

    `_guarded_push_branch` walks `origin/<base>..HEAD`, so the push tests need
    a genuine repository rather than a stub directory.
    """
    workspace = _workspace(tmp_path)
    repo_dir = workspace.repo_dir
    _git(repo_dir, "init", "--initial-branch=main", "--quiet")
    _git(repo_dir, "config", "user.name", "robveybot")
    _git(repo_dir, "config", "user.email", "robveybot@example.invalid")
    (repo_dir / "app.py").write_text("def render(q):\n    return q\n", encoding="utf-8")
    _git(repo_dir, "add", "app.py")
    _git(repo_dir, "commit", "--quiet", "-m", "base")
    _git(repo_dir, "update-ref", "refs/remotes/origin/main", "HEAD")
    _git(repo_dir, "checkout", "--quiet", "-b", workspace.branch)
    (repo_dir / "app.py").write_text("def render(q):\n    return q or []\n", encoding="utf-8")
    _git(repo_dir, "add", "app.py")
    _git(repo_dir, "commit", "--quiet", "-m", "fix: normalize empty questions")
    return workspace


# ---------------------------------------------------------------------------
# 1. No write reaches GitHub.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("method", sorted(_protocol_writes()))
async def test_every_declared_write_is_intercepted_not_delivered(method: str) -> None:
    """Every mutating method on `GitHubBackend` is caught by the seal.

    Locks out the regression where a write is mistakenly listed in
    `_GITHUB_READS`, or where the wrapper forwards by default instead of
    intercepting by default. The backend raises `LeakedWrite` on attribute
    access, so a forwarded write fails here rather than mutating a repository.
    """
    ledger = RehearsalLedger(bot_login="robveybot")
    sealed = seal_github(ExplodingBackend(), ledger)

    await getattr(sealed, method)(**_WRITE_CALLS[method])

    assert [w.method for w in ledger.writes] == [method]
    assert ledger.writes[0].modeled is True, f"{method} has no synthetic result registered"
    assert ledger.writes[0].surface == "github"


async def test_intercepted_write_arguments_are_recorded_by_name() -> None:
    """The ledger stores named arguments, not a positional blob.

    The transcript reads `args["body"]` and `args["title"]`; if binding ever
    silently degrades to positional names the rendered comment bodies vanish
    while every other assertion still passes.
    """
    ledger = RehearsalLedger()
    sealed = seal_github(ExplodingBackend(), ledger)

    await sealed.post_comment("octo/widget", 42, "the crash is in the live render path")

    assert ledger.writes[0].args == {
        "repo": "octo/widget",
        "number": 42,
        "body": "the crash is in the live render path",
    }


async def test_writes_return_plausible_success_so_the_agent_continues() -> None:
    """A rehearsal must not look like a failed run to the agent.

    If interception returned `None` for `post_comment` / `open_pull_request`,
    the host tool would raise on `comment.id` / `pr.number` and the agent would
    spend the rest of the run recovering from an error that never happened.
    """
    ledger = RehearsalLedger(bot_login="robveybot")
    sealed = seal_github(ExplodingBackend(), ledger)

    comment = await sealed.post_comment("octo/widget", 42, "ack")
    pr = await sealed.open_pull_request(**_WRITE_CALLS["open_pull_request"])
    review = await sealed.submit_pr_review(**_WRITE_CALLS["submit_pr_review"])

    assert isinstance(comment, CommentInfo) and comment.id > 0 and comment.author == "robveybot"
    assert isinstance(pr, PullRequestInfo)
    assert pr.number > 0
    assert pr.html_url.endswith(f"/octo/widget/pull/{pr.number}")
    assert pr.head_ref == "farm/abc12345/boom"
    assert isinstance(review, PullRequestReviewInfo) and review.state == "COMMENT"


async def test_synthetic_comment_ids_are_unique_per_call() -> None:
    """Two comments must not collide on one id.

    `gh_post_comment` schedules an auto-close keyed on the comment id; a
    repeated id would make the second schedule silently overwrite the first
    and the transcript would misattribute the answer.
    """
    ledger = RehearsalLedger()
    sealed = seal_github(ExplodingBackend(), ledger)

    first = await sealed.post_comment("octo/widget", 42, "one")
    second = await sealed.post_comment("octo/widget", 42, "two")

    assert first.id != second.id


async def test_push_branch_is_intercepted_and_echoes_the_real_head() -> None:
    """`gh_push_branch` must not reach the transport, and must get its sha back.

    `_guarded_push_branch` returns `result.head` to the agent and `gh_open_pr`
    keeps going from it. Returning a bogus head would make the transcript
    report a commit that does not exist locally.
    """
    ledger = RehearsalLedger()
    transport = ExplodingTransport()
    sealed = seal_git_transport(transport, ledger)

    result = sealed.push_branch(
        repo="octo/widget",
        workspace_key="octo__widget__42",
        repo_dir=Path("/tmp/repo"),
        branch="farm/abc12345/boom",
        expected_head="a" * 40,
        slot_uid=None,
    )

    assert isinstance(result, PushResult)
    assert result.head == "a" * 40
    assert result.branch == "farm/abc12345/boom"
    assert [w.method for w in ledger.writes] == ["push_branch"]
    assert ledger.writes[0].surface == "git"


# ---------------------------------------------------------------------------
# 2. Reads still pass through.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("method", sorted(rehearse._GITHUB_READS))
async def test_every_declared_read_reaches_the_live_backend(method: str) -> None:
    """Reads are the whole point of a rehearsal — none may be stubbed.

    An agent shown a fake issue, fake comments or a fake CI state is judged on
    fiction. If a read ever slips out of the allowlist it becomes an
    intercepted write returning `None`, and this test catches it.
    """
    ledger = RehearsalLedger()
    backend = ExplodingBackend()
    sealed = seal_github(backend, ledger)

    await getattr(sealed, method)(*_READ_CALLS[method])

    assert [name for name, _args, _kwargs in backend.reads] == [method]
    assert ledger.writes == [], f"{method} was recorded as a write"


def test_transport_clone_and_fetch_reach_the_live_transport() -> None:
    """Clone/fetch move bytes onto local disk only, so they must run for real.

    Intercepting them would leave the rehearsal with an empty worktree and the
    agent reading nothing.
    """
    ledger = RehearsalLedger()
    transport = ExplodingTransport()
    sealed = seal_git_transport(transport, ledger)

    sealed.clone_pool(repo="octo/widget", clone_url="https://x/y.git", default_branch="main", target=Path("/tmp/p"))
    sealed.fetch_pool(repo="octo/widget", pool_dir=Path("/tmp/p"))
    sealed.fetch_base_ref(repo="octo/widget", pool_dir=Path("/tmp/p"), ref="main")
    sealed.fetch_pr_head(repo="octo/widget", pool_dir=Path("/tmp/p"), pr_number=7)

    assert [name for name, _ in transport.calls] == ["clone_pool", "fetch_pool", "fetch_base_ref", "fetch_pr_head"]
    assert ledger.writes == []


def test_read_allowlist_and_write_table_cover_the_protocol_exactly() -> None:
    """Every `GitHubBackend` method is explicitly classified.

    Nothing breaks silently if this drifts — an unclassified method is
    intercepted and returns `None`, which is safe but degrades the rehearsal.
    Failing here is how the drift gets noticed.
    """
    members = {name for name in vars(GitHubBackend) if not name.startswith("_")}
    modeled = {method for surface, method in rehearse._SYNTHETIC_RESULTS if surface == "github"}

    assert rehearse._GITHUB_READS <= members
    assert modeled <= members
    assert rehearse._GITHUB_READS | modeled == members
    assert not (rehearse._GITHUB_READS & modeled)
    # The per-method call tables above must cover the protocol too, or the
    # parametrized leak tests would quietly stop exercising a new method.
    assert set(_READ_CALLS) == rehearse._GITHUB_READS
    assert set(_WRITE_CALLS) == _protocol_writes()


# ---------------------------------------------------------------------------
# 3. A tool nobody has written yet.
# ---------------------------------------------------------------------------


async def test_unknown_backend_method_is_intercepted_rather_than_forwarded() -> None:
    """Deny-by-default: a method invented after this file was written is caught.

    This is the whole reason the seal is an allowlist of reads instead of a
    blocklist of writes. `ExplodingBackend` raises on any attribute it does not
    recognise, so a forwarding seal fails instead of calling GitHub.
    """
    ledger = RehearsalLedger()
    sealed = seal_github(ExplodingBackend(), ledger)

    result = await sealed.transfer_issue(repo="octo/widget", number=42, destination="octo/other")

    assert result is None
    assert [(w.method, w.modeled) for w in ledger.writes] == [("transfer_issue", False)]
    assert ledger.writes[0].args == {"repo": "octo/widget", "number": 42, "destination": "octo/other"}


def test_unknown_transport_method_is_intercepted_rather_than_forwarded() -> None:
    """Same rule on the git side: a new remote-facing verb cannot slip out."""
    ledger = RehearsalLedger()
    sealed = seal_git_transport(ExplodingTransport(), ledger)

    assert sealed.push_tag(repo="octo/widget", tag="v1.2.3") is None
    assert [(w.surface, w.method, w.modeled) for w in ledger.writes] == [("git", "push_tag", False)]


def _future_milestone_tool(bindings: ToolBindings) -> Any:
    """A host tool that does not exist in `host_tools.py`.

    Built exactly the way a future one would be: from `ToolBindings`, reaching
    GitHub through `bindings.github` and `bindings.git_transport`, calling two
    methods this module has never heard of.
    """

    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        milestone = host_tools._run_coro(
            bindings.loop,
            bindings.github.set_issue_milestone(bindings.repo.full_name, bindings.issue.number, str(args["milestone"])),
        )
        bindings.git_transport.push_tag(repo=bindings.repo.full_name, tag=str(args["tag"]))
        host_tools._audit(bindings, "set_issue_milestone", args, result={"milestone": str(milestone)})
        return "milestone set"

    return host_tool(
        name="set_issue_milestone",
        description="Attach the issue to a milestone.",
        parameters={"type": "object", "properties": {}, "additionalProperties": True},
        execute=execute,
    )


def test_future_mutating_host_tool_is_caught_by_the_boundary(db: Database, tmp_path: Path) -> None:
    """A host tool written by someone who has never heard of rehearse is safe.

    This is the acceptance property. `bindings.github` and
    `bindings.git_transport` are the only routes out of the process, so
    sealing the bindings intercepts the tool without the tool knowing, and the
    exploding surfaces prove nothing reached the wire.
    """
    ledger = RehearsalLedger()
    backend = ExplodingBackend()
    transport = ExplodingTransport()
    loop, thread = _loop()
    try:
        bindings = seal_bindings(_bindings(db, tmp_path, backend, transport, loop), ledger)
        assert _future_milestone_tool(bindings).execute({"milestone": "v2", "tag": "v2.0.0"}, _ctx()) == "milestone set"
    finally:
        _stop(loop, thread)

    assert [(w.surface, w.method) for w in ledger.writes] == [
        ("github", "set_issue_milestone"),
        ("git", "push_tag"),
    ]
    assert all(w.modeled is False for w in ledger.writes)
    assert ledger.writes[0].args == {"arg0": "octo/widget", "arg1": 42, "arg2": "v2"}
    assert backend.reads == []
    assert transport.calls == []
    # The tool still audited itself, so a rehearsal counts it like any other.
    assert db.has_successful_tool_call("octo/widget#42", "set_issue_milestone")


def test_unsealed_bindings_let_the_future_tool_through(db: Database, tmp_path: Path) -> None:
    """Negative control: without the seal, the same tool reaches the wire.

    Every leak assertion in this file rests on `ExplodingBackend` /
    `ExplodingTransport` actually exploding when reached through a real host
    tool. If they ever stopped doing so, the positive tests would pass while
    proving nothing — this test fails first.
    """
    loop, thread = _loop()
    try:
        bindings = _bindings(db, tmp_path, ExplodingBackend(), ExplodingTransport(), loop)
        with pytest.raises(LeakedWrite, match="set_issue_milestone"):
            _future_milestone_tool(bindings).execute({"milestone": "v2", "tag": "v2.0.0"}, _ctx())
    finally:
        _stop(loop, thread)


def test_unsealed_bindings_let_the_real_comment_tool_through(db: Database, tmp_path: Path) -> None:
    """Negative control for the production toolset.

    Proves `gh_post_comment` genuinely reaches `bindings.github.post_comment`,
    so the sealed variant of this test is measuring interception rather than a
    tool that never called out in the first place.
    """
    loop, thread = _loop()
    try:
        bindings = _bindings(db, tmp_path, ExplodingBackend(), ExplodingTransport(), loop)
        tool = _tool(host_tools.build(bindings), "gh_post_comment")
        with pytest.raises(LeakedWrite, match="post_comment"):
            tool.execute({"body": "leak"}, _ctx())
    finally:
        _stop(loop, thread)


# ---------------------------------------------------------------------------
# 4. The real host-tool set, driven through the seal.
# ---------------------------------------------------------------------------


def test_real_comment_and_label_tools_write_nothing_to_github(db: Database, tmp_path: Path) -> None:
    """`gh_post_comment` and `set_issue_labels` are fully intercepted.

    Drives the production tools from `host_tools.build`, not a reimplementation
    of them, so a change to how a tool reaches the backend is covered.
    """
    ledger = RehearsalLedger(bot_login="robveybot")
    backend = ExplodingBackend()
    loop, thread = _loop()
    try:
        bindings = seal_bindings(_bindings(db, tmp_path, backend, ExplodingTransport(), loop), ledger)
        tools = host_tools.build(bindings)

        assert (
            _tool(tools, "gh_post_comment")
            .execute({"body": "on it: the render path"}, _ctx())
            .startswith("comment posted")
        )
        assert (
            _tool(tools, "set_issue_labels").execute({"labels": ["bug", "agent"]}, _ctx()) == "labels now: bug, agent"
        )
    finally:
        _stop(loop, thread)

    assert [w.method for w in ledger.writes] == ["post_comment", "add_issue_labels"]
    assert ledger.writes[0].args["body"] == "on it: the render path"
    assert ledger.writes[1].args["labels"] == ["bug", "agent"]


def test_the_transcript_records_the_comment_body_the_issue_would_have_received(
    settings: Settings, db: Database, tmp_path: Path
) -> None:
    """The ledger must capture the FINAL body, not the agent's draft.

    `gh_post_comment` appends the 👎-to-keep-open auto-close suffix to answers
    on question issues. Recording the pre-suffix draft would make a rehearsal
    understate what the reporter actually sees, which is the one thing the
    transcript exists to show.
    """
    ledger = RehearsalLedger(bot_login="robveybot")
    loop, thread = _loop()
    try:
        bindings = seal_bindings(
            _bindings(db, tmp_path, ExplodingBackend(), ExplodingTransport(), loop, settings=settings),
            ledger,
        )
        db.set_issue_classification(bindings.issue_key, "question")
        tools = host_tools.build(bindings)
        _tool(tools, "gh_post_comment").execute({"body": "Run `bun run build` first."}, _ctx())
    finally:
        _stop(loop, thread)

    posted = ledger.writes[0].args["body"]
    suffix = question_autoclose_suffix(float(settings.question_autoclose_hours))
    assert posted == f"Run `bun run build` first.\n\n{suffix}"
    assert suffix in render(_rehearsal(writes=ledger.writes))


def test_real_push_and_open_pr_tools_write_nothing_to_github(db: Database, tmp_path: Path) -> None:
    """`gh_push_branch` and `gh_open_pr` publish nothing in rehearse mode.

    These are the two tools that would create visible, hard-to-undo artefacts
    on GitHub, and both run their full local preflight first (identity gate,
    dirty-tree gate, commit-message repair). The test uses a genuine git
    worktree so that preflight really executes; only the final hop is sealed.
    """
    ledger = RehearsalLedger(bot_login="robveybot")
    backend = ExplodingBackend()
    transport = ExplodingTransport()
    workspace = _real_repo(tmp_path)
    loop, thread = _loop()
    try:
        bindings = seal_bindings(
            _bindings(db, tmp_path, backend, transport, loop, workspace=workspace, impl_authorized=True),
            ledger,
        )
        tools = host_tools.build(bindings)

        pushed = _tool(tools, "gh_push_branch").execute({}, _ctx())
        opened = _tool(tools, "gh_open_pr").execute(
            {
                "title": "fix(agent): normalize dialog questions",
                "body": (
                    "## Repro\nempty list\n## Cause\nlive path skips normalization\n"
                    "## Fix\nnormalizeDialogQuestions\n## Verification\nregression test\n\nFixes #42"
                ),
            },
            _ctx(),
        )
    finally:
        _stop(loop, thread)

    assert pushed.startswith(f"pushed {workspace.branch} at ")
    assert opened.startswith("opened #")
    assert [w.method for w in ledger.writes] == ["push_branch", "push_branch", "open_pull_request"]
    assert ledger.writes[-1].args["title"] == "fix(agent): normalize dialog questions"
    assert transport.calls == []
    assert backend.reads == []
    # The synthetic PR still lands in the local audit trail exactly as a live
    # run would record it, so the transcript and the sqlite copy agree.
    issue_row = db.get_issue("octo/widget#42")
    assert issue_row is not None
    assert issue_row.pr_number == rehearse._SYNTHETIC_PR_NUMBER_BASE + 1
    assert issue_row.state == "opened"
    assert (workspace.artifacts_dir / "pr.json").exists()


def test_push_preflight_still_rejects_a_dirty_worktree(db: Database, tmp_path: Path) -> None:
    """Rehearse must not soften the gates the agent has to satisfy.

    A rehearsal exists to predict a real run. If sealing the transport also
    swallowed the dirty-tree refusal, the rehearsal would show a clean push
    that production would reject.
    """
    ledger = RehearsalLedger()
    workspace = _real_repo(tmp_path)
    (workspace.repo_dir / "scratch.txt").write_text("uncommitted\n", encoding="utf-8")
    loop, thread = _loop()
    try:
        bindings = seal_bindings(
            _bindings(
                db, tmp_path, ExplodingBackend(), ExplodingTransport(), loop, workspace=workspace, impl_authorized=True
            ),
            ledger,
        )
        tools = host_tools.build(bindings)
        with pytest.raises(RpcCommandError) as excinfo:
            _tool(tools, "gh_push_branch").execute({}, _ctx())
    finally:
        _stop(loop, thread)

    assert "working tree is dirty" in str(excinfo.value)
    assert ledger.writes == []


def test_ledger_database_tees_every_audited_tool_call(tmp_path: Path) -> None:
    """The tool-call count in the transcript comes from the audit funnel.

    `host_tools._audit` is the one place every tool records itself, so
    `LedgerDatabase` sees each call exactly once — including the calls that
    never touch GitHub (`repro_record`, `abort_task`) and the ones that fail.
    """
    ledger = RehearsalLedger()
    database = rehearse.LedgerDatabase(tmp_path / "rehearsal.sqlite", ledger)
    try:
        database.log_tool_call(issue_key="octo/widget#42", tool="repro_record", args={"title": "t"}, result={"ok": 1})
        database.log_tool_call(issue_key="octo/widget#42", tool="gh_open_pr", args={}, error="refused")
    finally:
        database.close()

    assert [(c.tool, c.error) for c in ledger.tool_calls] == [("repro_record", None), ("gh_open_pr", "refused")]
    assert ledger.tool_calls[0].result == {"ok": 1}


# ---------------------------------------------------------------------------
# 5. Fail-closed surface classification.
# ---------------------------------------------------------------------------


def test_binding_classification_covers_toolbindings_exactly() -> None:
    """The seal's field tables track `ToolBindings` with no drift.

    A field present in neither table would be assumed inert and could be a
    live client. A stale name in a table means the tables have rotted and the
    next reader cannot trust them.
    """
    fields = {f.name for f in dataclasses.fields(ToolBindings)}
    classified = set(rehearse.BINDING_SEALERS) | rehearse.INERT_BINDING_FIELDS

    assert fields - classified == set(), "unclassified ToolBindings field(s)"
    assert classified - fields == set(), "stale entry in the classification tables"
    assert set(rehearse.BINDING_SEALERS) == {"github", "git_transport"}


def test_unclassified_binding_field_refuses_to_rehearse(monkeypatch: pytest.MonkeyPatch) -> None:
    """An unrecognised binding field aborts the run instead of leaking.

    Simulates a future author adding a third remote surface to `ToolBindings`.
    The safe assumption about a field the seal has never heard of is that it
    can reach GitHub, so the rehearsal must refuse rather than proceed.
    """
    monkeypatch.setattr(rehearse, "INERT_BINDING_FIELDS", rehearse.INERT_BINDING_FIELDS - {"slot_uid"})

    with pytest.raises(UnsealedSurfaceError) as excinfo:
        assert_bindings_sealable()

    assert "slot_uid" in str(excinfo.value)


def test_seal_bindings_replaces_only_the_remote_surfaces(db: Database, tmp_path: Path) -> None:
    """Sealing swaps the two egress fields and leaves everything else alone.

    If sealing also replaced `db` or `workspace`, the rehearsal would stop
    being a faithful copy of a live run.
    """
    ledger = RehearsalLedger()
    backend = ExplodingBackend()
    transport = ExplodingTransport()
    loop, thread = _loop()
    try:
        original = _bindings(db, tmp_path, backend, transport, loop)
        sealed = seal_bindings(original, ledger)
    finally:
        _stop(loop, thread)

    assert sealed.github is not backend
    assert sealed.git_transport is not transport
    assert sealed.db is original.db
    assert sealed.workspace is original.workspace
    assert sealed.author_email == original.author_email
    assert sealed.issue is original.issue


def test_stripped_settings_cannot_reach_github(settings: Settings) -> None:
    """The credentials are removed as a second, independent line of defence.

    Sealing stops the tools that exist. Clearing the credentials stops a tool
    that tried to build its own client out of `bindings.settings` — it would
    have no endpoint and no key.
    """
    assert settings.gh_proxy_url is not None
    assert settings.gh_proxy_hmac_key is not None

    stripped = strip_remote_credentials(settings)

    assert stripped.github_token is None
    assert stripped.gh_proxy_url is None
    assert stripped.gh_proxy_hmac_key is None
    # Everything the task legitimately needs survives.
    assert stripped.bot_login == settings.bot_login
    assert stripped.git_author_email == settings.git_author_email
    assert stripped.workspace_root == settings.workspace_root
    # The original is untouched: a rehearsal must not disarm the live process.
    assert settings.gh_proxy_url is not None


# ---------------------------------------------------------------------------
# 6. The transcript.
# ---------------------------------------------------------------------------


def _write(seq: int, at: float, surface: str, method: str, **args: Any) -> InterceptedWrite:
    return InterceptedWrite(seq=seq, at=at, surface=surface, method=method, args=args, result="ok", modeled=True)


def _rehearsal(**overrides: Any) -> Rehearsal:
    base: dict[str, Any] = {
        "repo": "octo/widget",
        "number": 42,
        "task": "triage",
        "issue_title": "AskDialog crashes on empty questions",
        "base_branch": "main",
        "started_at": "2026-07-31T00:00:00+00:00",
        "wall_seconds": 552.0,
        "outcome": "completed",
        "error": None,
        "writes": (),
        "tool_calls": (),
        "labels": {},
        "branch": "farm/abc12345/boom",
    }
    base.update(overrides)
    return Rehearsal(**base)


def test_transcript_shows_comment_bodies_verbatim_and_in_order() -> None:
    """The reviewer judges the prose, so it must appear unedited and in order.

    Reordering or paraphrasing would destroy the only thing this command
    exists to show: what the issue thread would actually read like.
    """
    first = "Reading the code now: the live render path lacks the normalization."
    second = "Root cause is `renderDialog` at src/dialog.ts:214. Fix incoming."
    third = "Fix opened in #90001 — mirrors `normalizeRenderQuestions`."
    rehearsal = _rehearsal(
        writes=(
            _write(1, 31.0, "github", "post_comment", repo="octo/widget", number=42, body=first),
            _write(2, 214.0, "github", "post_comment", repo="octo/widget", number=42, body=second),
            _write(3, 540.0, "github", "post_comment", repo="octo/widget", number=42, body=third),
        )
    )

    text = render(rehearsal)

    assert first in text
    assert second in text
    assert third in text
    assert text.index(first) < text.index(second) < text.index(third)
    assert "comments (3)" in text


def test_transcript_shows_the_full_pr_title_and_body() -> None:
    """A truncated PR body hides exactly the section a reviewer checks.

    The body carries `## Repro` / `## Cause` / `## Fix` / `## Verification`
    and the `Fixes #N` keyword; all of it must survive rendering.
    """
    body = (
        "## Repro\n`bun test dialog`\n## Cause\nlive path skips normalization\n"
        "## Fix\n`normalizeDialogQuestions` at dialog entry\n## Verification\nregression test\n\nFixes #42"
    )
    rehearsal = _rehearsal(
        writes=(
            _write(
                1,
                600.0,
                "github",
                "open_pull_request",
                repo="octo/widget",
                head="farm/abc12345/boom",
                base="main",
                title="fix(agent): normalize dialog questions",
                body=body,
            ),
        )
    )

    text = render(rehearsal)

    assert "fix(agent): normalize dialog questions" in text
    assert body in text
    assert "farm/abc12345/boom -> main" in text


def test_transcript_orders_comments_before_labels_branch_and_pr() -> None:
    """Section order is the contract: comments, labels, branch, PR, diff.

    A reviewer reads it top to bottom as the issue thread would unfold; a
    shuffled transcript makes a good run look incoherent.
    """
    text = render(
        _rehearsal(
            writes=(_write(1, 1.0, "github", "post_comment", repo="octo/widget", number=42, body="hi"),),
            labels={("octo/widget", 42): ("bug", "agent")},
            changes=LocalChanges(commits=("abc1234 fix: boom",), diff="diff --git a/app.py b/app.py\n"),
        )
    )

    assert (
        text.index("--- comments")
        < text.index("--- labels")
        < text.index("--- branch & commits")
        < text.index("--- pull request")
        < text.index("--- local diff")
    )


def test_transcript_reports_wall_time_and_tool_call_count() -> None:
    """Efficiency is the second thing this command is for.

    Without wall time and a call count you cannot tell a nine-minute run from
    a ninety-minute one, which is the difference between shippable and not.
    """
    text = render(
        _rehearsal(
            wall_seconds=552.0,
            tool_calls=(
                AuditedToolCall(seq=1, at=1.0, tool="classify_issue", args={}, result={"ok": 1}, error=None),
                AuditedToolCall(seq=2, at=2.0, tool="gh_post_comment", args={}, result=None, error=None),
                AuditedToolCall(seq=3, at=3.0, tool="gh_open_pr", args={}, result=None, error="refused"),
            ),
        )
    )

    assert "9m 12s" in text
    assert "3 call(s), 1 rejected" in text
    assert "gh_open_pr: refused" in text


def test_transcript_states_that_nothing_reached_github() -> None:
    """The banner is the one claim a reviewer must not have to infer."""
    text = render(_rehearsal(writes=(_write(1, 1.0, "github", "post_comment", repo="o/r", number=1, body="x"),)))

    assert "1 GitHub write(s) — none of them reached GitHub" in text


def test_transcript_shows_the_local_diff_and_commits() -> None:
    """The prose about a fix is not the fix. The reviewer judges the diff.

    Without the diff a rehearsal can only be scored on how confident the
    agent's comments sounded.
    """
    diff = "diff --git a/app.py b/app.py\n@@\n-    return q\n+    return q or []\n"
    text = render(
        _rehearsal(changes=LocalChanges(commits=("abc1234 fix: normalize empty questions",), diff=diff)),
    )

    assert diff.rstrip("\n") in text
    assert "abc1234 fix: normalize empty questions" in text
    assert "commits (1) on top of origin/main" in text


def test_transcript_separates_uncommitted_work_from_the_commit() -> None:
    """Uncommitted changes never reach a PR, so they must not read as if they had."""
    text = render(_rehearsal(changes=LocalChanges(diff="committed\n", uncommitted="stray\n")))

    assert "uncommitted worktree changes" in text
    assert text.index("--- local diff") < text.index("--- uncommitted worktree changes")


def test_transcript_warns_when_a_write_has_no_synthetic_result() -> None:
    """An unmodeled write is safe but degrades fidelity, so it is called out.

    Silence here would let a rehearsal quietly hand the agent `None` for a new
    tool and blame the model for the resulting confusion.
    """
    text = render(
        _rehearsal(
            writes=(
                InterceptedWrite(
                    seq=1, at=5.0, surface="github", method="transfer_issue", args={}, result="None", modeled=False
                ),
            )
        )
    )

    assert "WARNING" in text
    assert "github.transfer_issue" in text


def test_transcript_reports_a_failed_run_with_its_error() -> None:
    """A rehearsal that crashed is a result, not a missing transcript."""
    text = render(_rehearsal(outcome="failed", error="RpcError: agent exited 1"))

    assert "outcome    : failed" in text
    assert "RpcError: agent exited 1" in text


def test_transcript_of_a_silent_run_says_so_in_every_section() -> None:
    """A run that produced nothing must be unmistakably empty.

    An empty transcript with no `(none)` markers reads like a rendering bug
    rather than an agent that did nothing.
    """
    text = render(_rehearsal())

    assert "comments (0)" in text
    assert "pull request (0)" in text
    assert "other intercepted writes (0)" in text
    assert "(no committed change against origin/main)" in text


# ---------------------------------------------------------------------------
# 7. Label accumulation.
# ---------------------------------------------------------------------------


async def test_labels_accumulate_across_calls_like_the_real_api() -> None:
    """`add_issue_labels` returns the issue's full label set, not the delta.

    `set_issue_labels` echoes the result back to the agent as "labels now: …".
    Returning only the newly added labels would teach the agent that its
    earlier labels had been dropped.
    """
    ledger = RehearsalLedger()
    sealed = seal_github(ExplodingBackend(), ledger)

    first = await sealed.add_issue_labels("octo/widget", 42, ["bug"])
    second = await sealed.add_issue_labels("octo/widget", 42, ["prio:p1", "bug"])

    assert first == ("bug",)
    assert second == ("bug", "prio:p1")
    assert ledger.labels() == {("octo/widget", 42): ("bug", "prio:p1")}


async def test_removing_a_label_drops_it_from_the_rendered_set() -> None:
    """`needs-info` cleanup happens mid-run; the transcript must show the end state."""
    ledger = RehearsalLedger()
    sealed = seal_github(ExplodingBackend(), ledger)

    await sealed.add_issue_labels("octo/widget", 42, ["bug", "needs-info"])
    await sealed.remove_issue_label("octo/widget", 42, "needs-info")

    assert ledger.labels() == {("octo/widget", 42): ("bug",)}


async def test_labels_are_tracked_per_target_thread() -> None:
    """An issue and its PR carry different labels and must not be merged."""
    ledger = RehearsalLedger()
    sealed = seal_github(ExplodingBackend(), ledger)

    await sealed.add_issue_labels("octo/widget", 42, ["bug"])
    await sealed.add_issue_labels("octo/widget", 43, ["review:p1"])

    assert ledger.labels() == {("octo/widget", 42): ("bug",), ("octo/widget", 43): ("review:p1",)}


# ---------------------------------------------------------------------------
# 8. Local change collection.
# ---------------------------------------------------------------------------


def test_collect_local_changes_reads_the_real_worktree(tmp_path: Path) -> None:
    """The diff comes from git, not from anything the agent claimed."""
    workspace = _real_repo(tmp_path)

    changes = collect_local_changes(workspace.repo_dir, "main")

    assert len(changes.commits) == 1
    assert "fix: normalize empty questions" in changes.commits[0]
    assert "return q or []" in changes.diff
    assert changes.uncommitted == ""
    assert changes.note == ""


def test_collect_local_changes_separates_uncommitted_edits(tmp_path: Path) -> None:
    """Work the agent forgot to commit would never ship; show it separately."""
    workspace = _real_repo(tmp_path)
    (workspace.repo_dir / "app.py").write_text("def render(q):\n    return list(q or [])\n", encoding="utf-8")

    changes = collect_local_changes(workspace.repo_dir, "main")

    assert "return q or []" in changes.diff
    assert "list(q or [])" in changes.uncommitted


def test_collect_local_changes_reports_a_missing_worktree(tmp_path: Path) -> None:
    """A run that died before cloning has no diff; say so rather than print nothing."""
    changes = collect_local_changes(tmp_path / "absent", "main")

    assert changes.commits == ()
    assert changes.diff == ""
    assert "no worktree" in changes.note


def test_collect_local_changes_truncates_a_runaway_diff(tmp_path: Path) -> None:
    """A multi-megabyte diff must not wedge the terminal, and must say it was cut."""
    workspace = _real_repo(tmp_path)
    (workspace.repo_dir / "big.txt").write_text("x" * (rehearse._MAX_DIFF_CHARS + 5_000), encoding="utf-8")
    _git(workspace.repo_dir, "add", "big.txt")
    _git(workspace.repo_dir, "commit", "--quiet", "-m", "add big file")

    changes = collect_local_changes(workspace.repo_dir, "main")

    assert len(changes.diff) <= rehearse._MAX_DIFF_CHARS + 100
    assert "truncated at" in changes.diff


# ---------------------------------------------------------------------------
# 9. run_rehearsal, end to end.
# ---------------------------------------------------------------------------


async def test_run_rehearsal_hands_the_task_only_sealed_surfaces(
    settings: Settings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The seal happens inside `run_rehearsal`, so no caller can forget it.

    The fake task below stands in for `tasks.triage_issue`: it takes the same
    keyword arguments, builds `ToolBindings` out of them exactly as
    `worker.run_task` does, and drives the production host tools. The exploding
    surfaces prove that everything it published was intercepted.
    """
    backend = ExplodingBackend()
    transport = ExplodingTransport()
    seen: dict[str, Any] = {}

    async def fake_triage(
        *,
        settings: Settings,
        db: Database,
        github: Any,
        sandbox: Any,
        git_transport: Any,
        payload: dict[str, Any],
        delivery_id: str,
        attempts: int = 0,
        slot_uid: int | None = None,
    ) -> None:
        seen["settings"] = settings
        seen["payload"] = payload
        loop = asyncio.get_running_loop()
        bindings = ToolBindings(
            db=db,
            github=github,
            git_transport=git_transport,
            repo=_REPO,
            issue=_ISSUE,
            workspace=_workspace(tmp_path),
            loop=loop,
            settings=settings,
            author_name="robveybot",
            author_email="robveybot@example.invalid",
        )
        db.upsert_issue(
            key=bindings.issue_key,
            repo="octo/widget",
            number=42,
            state="reproducing",
            branch=bindings.workspace.branch,
        )
        tools = host_tools.build(bindings)
        # Host tools block the calling thread on the worker loop, so they must
        # run off it — exactly as `worker.run_task` does with `to_thread`.
        await asyncio.to_thread(_tool(tools, "set_issue_labels").execute, {"labels": ["bug"]}, _ctx())
        await asyncio.to_thread(
            _tool(tools, "gh_post_comment").execute, {"body": "ack: reading the render path"}, _ctx()
        )
        await asyncio.to_thread(_tool(tools, "gh_post_comment").execute, {"body": "root cause: dialog.ts:214"}, _ctx())

    result = await run_rehearsal(
        settings=settings,
        github=backend,
        git_transport=transport,
        repo_full="octo/widget",
        number=42,
        workspace_root=tmp_path / "rehearse-ws",
        db_path=tmp_path / "rehearse-ws" / "rehearsal.sqlite",
        task="triage",
        task_functions={"triage": fake_triage},
    )

    assert result.outcome == "completed", result.error
    assert [w.method for w in result.writes] == ["add_issue_labels", "post_comment", "post_comment"]
    assert [w.args["body"] for w in result.comments] == [
        "ack: reading the render path",
        "root cause: dialog.ts:214",
    ]
    assert result.labels == {("octo/widget", 42): ("bug",)}
    assert [c.tool for c in result.tool_calls] == ["set_issue_labels", "gh_post_comment", "gh_post_comment"]
    assert result.wall_seconds >= 0.0
    # Reads went through untouched; nothing else did.
    assert {name for name, _a, _k in backend.reads} == {"get_issue", "get_repo"}
    assert transport.calls == []
    # The task was handed a disarmed Settings.
    assert seen["settings"].gh_proxy_url is None
    assert seen["settings"].gh_proxy_hmac_key is None
    assert seen["payload"]["issue"]["number"] == 42

    text = render(result)
    assert text.index("ack: reading the render path") < text.index("root cause: dialog.ts:214")


async def test_run_rehearsal_reports_a_failing_task_instead_of_raising(settings: Settings, tmp_path: Path) -> None:
    """A crashed agent is a rehearsal result the operator needs to see.

    Propagating the exception would throw away the comments the run had
    already produced, which are usually the evidence for why it crashed.
    """

    async def boom(**_kwargs: Any) -> None:
        raise RuntimeError("veyyon exited 1")

    result = await run_rehearsal(
        settings=settings,
        github=ExplodingBackend(),
        git_transport=ExplodingTransport(),
        repo_full="octo/widget",
        number=42,
        workspace_root=tmp_path / "ws",
        db_path=tmp_path / "ws" / "r.sqlite",
        task="triage",
        task_functions={"triage": boom},
    )

    assert result.outcome == "failed"
    assert "veyyon exited 1" in (result.error or "")
    assert "RuntimeError: veyyon exited 1" in render(result)


async def test_run_rehearsal_rejects_an_unknown_task(settings: Settings, tmp_path: Path) -> None:
    """A typo'd `--task` must not silently fall back to triage."""
    with pytest.raises(rehearse.RehearsalError):
        await run_rehearsal(
            settings=settings,
            github=ExplodingBackend(),
            git_transport=ExplodingTransport(),
            repo_full="octo/widget",
            number=42,
            workspace_root=tmp_path / "ws",
            db_path=tmp_path / "ws" / "r.sqlite",
            task="nonsense",
        )


async def test_run_rehearsal_auto_selects_the_port_task_for_a_labeled_issue(settings: Settings, tmp_path: Path) -> None:
    """Rehearsing a port issue with the triage prompt measures the wrong thing.

    `github_events.route` sends `upstream-port` issues to `port_upstream`, and
    the rehearsal must pick the same task from the live labels rather than
    always running the triage prompt.
    """
    port_issue = IssueInfo(
        repo="octo/widget",
        number=42,
        title="port: upstream #7211",
        body="mirror",
        state="open",
        author="radar",
        labels=(settings.port_label,),
        is_pull_request=False,
    )

    class PortBackend(ExplodingBackend):
        async def get_issue(self, repo: str, number: int) -> IssueInfo:
            self.reads.append(("get_issue", (repo, number), {}))
            return port_issue

    chosen: dict[str, Any] = {}

    async def fake_triage(**_kwargs: Any) -> None:
        chosen["task"] = "triage"

    async def fake_port(**kwargs: Any) -> None:
        chosen["task"] = "port"
        chosen["payload"] = kwargs["payload"]

    result = await run_rehearsal(
        settings=settings,
        github=PortBackend(),
        git_transport=ExplodingTransport(),
        repo_full="octo/widget",
        number=42,
        workspace_root=tmp_path / "ws",
        db_path=tmp_path / "ws" / "r.sqlite",
        task_functions={"triage": fake_triage, "port": fake_port},
    )

    assert result.task == "port"
    assert chosen["task"] == "port"
    assert {"name": settings.port_label} in chosen["payload"]["issue"]["labels"]
    assert chosen["payload"]["issue"]["title"] == "port: upstream #7211"


async def test_run_rehearsal_selects_triage_for_an_unlabeled_issue(settings: Settings, tmp_path: Path) -> None:
    """The port arm must not swallow ordinary issues.

    Boundary partner to the test above: same code path, label absent, so an
    over-eager selector shows up here instead of in a rehearsal that quietly
    used the wrong prompt.
    """
    chosen: dict[str, Any] = {}

    async def fake_triage(**kwargs: Any) -> None:
        chosen["payload"] = kwargs["payload"]

    async def fake_port(**_kwargs: Any) -> None:
        raise AssertionError("port task selected for an unlabeled issue")

    result = await run_rehearsal(
        settings=settings,
        github=ExplodingBackend(),
        git_transport=ExplodingTransport(),
        repo_full="octo/widget",
        number=42,
        workspace_root=tmp_path / "ws",
        db_path=tmp_path / "ws" / "r.sqlite",
        task_functions={"triage": fake_triage, "port": fake_port},
    )

    assert result.task == "triage"
    assert settings.port_label not in [e["name"] for e in chosen["payload"]["issue"]["labels"]]


async def test_run_rehearsal_refuses_a_pull_request_reference(settings: Settings, tmp_path: Path) -> None:
    """`owner/repo#N` that names a PR is a user error, not a rehearsal."""

    class PrBackend(ExplodingBackend):
        async def get_issue(self, repo: str, number: int) -> IssueInfo:
            return IssueInfo(
                repo=repo,
                number=number,
                title="a pr",
                body="",
                state="open",
                author="alice",
                labels=(),
                is_pull_request=True,
            )

    # `build_issues_opened_payload` owns this refusal; rehearse must not
    # swallow it into a half-finished run.

    with pytest.raises(ManualTriageError):
        await run_rehearsal(
            settings=settings,
            github=PrBackend(),
            git_transport=ExplodingTransport(),
            repo_full="octo/widget",
            number=42,
            workspace_root=tmp_path / "ws",
            db_path=tmp_path / "ws" / "r.sqlite",
            task="triage",
        )


async def test_run_rehearsal_writes_only_to_the_scratch_database(settings: Settings, tmp_path: Path) -> None:
    """Operational state must survive a rehearsal untouched.

    A rehearsal upserts issue rows and records a synthetic PR number. Landing
    those in the live sqlite file would make the daemon believe an issue had
    already been answered.
    """
    scratch = tmp_path / "ws" / "r.sqlite"

    async def fake(**kwargs: Any) -> None:
        kwargs["db"].upsert_issue(key="octo/widget#42", repo="octo/widget", number=42, state="opened")

    await run_rehearsal(
        settings=settings,
        github=ExplodingBackend(),
        git_transport=ExplodingTransport(),
        repo_full="octo/widget",
        number=42,
        workspace_root=tmp_path / "ws",
        db_path=scratch,
        task="triage",
        task_functions={"triage": fake},
    )

    assert scratch.exists()
    live = Database(settings.sqlite_path)
    try:
        assert live.get_issue("octo/widget#42") is None
        assert live.list_issues() == []
    finally:
        live.close()


# ---------------------------------------------------------------------------
# 10. `veybot rehearse` — the command the operator types.
# ---------------------------------------------------------------------------


def _invoke_cli(monkeypatch: pytest.MonkeyPatch, *args: str, result: Rehearsal | None = None) -> Any:
    """Run `veybot rehearse` with the network constructors and the runner stubbed.

    The seal itself is covered above against exploding surfaces; this exercises
    the layer the operator touches — argument parsing, the allowlist guard,
    where the workspace and scratch database land, and the exit code.
    """
    captured: dict[str, Any] = {}
    monkeypatch.setattr(cli, "_build_github", lambda _cfg: ExplodingBackend())
    monkeypatch.setattr(cli, "_build_git_transport", lambda _cfg: ExplodingTransport())

    async def fake_run(**kwargs: Any) -> Rehearsal:
        captured.update(kwargs)
        return result if result is not None else _rehearsal()

    monkeypatch.setattr(cli, "run_rehearsal", fake_run)
    invocation = CliRunner().invoke(cli.main, ["rehearse", *args])
    invocation.captured = captured  # type: ignore[attr-defined]
    return invocation


def test_cli_rehearse_prints_the_transcript(env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    """The transcript goes to stdout — that is the entire deliverable."""
    body = "the live render path lacks the normalization"
    rehearsal = _rehearsal(
        writes=(_write(1, 12.0, "github", "post_comment", repo="octo/widget", number=42, body=body),)
    )

    invocation = _invoke_cli(monkeypatch, "octo/widget#42", result=rehearsal)

    assert invocation.exit_code == 0, invocation.output
    assert body in invocation.output
    assert "none of them reached GitHub" in invocation.output


def test_cli_rehearse_defaults_workspace_and_scratch_db_under_the_configured_root(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A rehearsal must not land in the live worktree or the live database.

    Sharing `<workspace_root>/<owner>__<repo>__<n>` with the daemon would let a
    rehearsal reset a worktree a real task was mid-way through.
    """
    invocation = _invoke_cli(monkeypatch, "octo/widget#42")

    assert invocation.exit_code == 0, invocation.output
    root = Path(env["VEYBOT_WORKSPACE_ROOT"]) / "_rehearse"
    assert invocation.captured["workspace_root"] == root
    assert invocation.captured["db_path"] == root / "rehearsal.sqlite"
    assert invocation.captured["db_path"] != Path(env["VEYBOT_SQLITE_PATH"])
    assert invocation.captured["fresh"] is True


def test_cli_rehearse_resume_flag_keeps_the_previous_worktree(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--resume` is the opt-in; without it every rehearsal starts clean.

    A resumed worktree carries the last run's commits and a veyyon session the
    worker would `--continue`, so the default must be fresh.
    """
    invocation = _invoke_cli(monkeypatch, "octo/widget#42", "--resume")

    assert invocation.exit_code == 0, invocation.output
    assert invocation.captured["fresh"] is False


def test_cli_rehearse_writes_the_transcript_to_out(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """`--out` exists because a real transcript is longer than a scrollback."""
    destination = tmp_path / "reports" / "7211.txt"

    invocation = _invoke_cli(monkeypatch, "octo/widget#42", "--out", str(destination))

    assert invocation.exit_code == 0, invocation.output
    written = destination.read_text(encoding="utf-8")
    assert "veybot rehearsal" in written
    assert written in invocation.output


def test_cli_rehearse_exits_nonzero_when_the_run_failed(env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    """A failed rehearsal must be visible to a shell, not just to a reader.

    Printing the transcript and exiting 0 would let `veybot rehearse … && …`
    chain past a run that never finished.
    """
    invocation = _invoke_cli(monkeypatch, "octo/widget#42", result=_rehearsal(outcome="failed", error="boom"))

    assert invocation.exit_code == 1
    assert "boom" in invocation.output


def test_cli_rehearse_refuses_a_repo_outside_the_allowlist(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Rehearsing an unallowlisted repo would clone a repository we never triage."""
    invocation = _invoke_cli(monkeypatch, "someone/else#1")

    assert invocation.exit_code == 2
    assert "not in VEYBOT_REPO_ALLOWLIST" in invocation.output
    assert invocation.captured == {}


def test_cli_rehearse_refuses_a_malformed_reference(env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    """`owner/repo` without `#N` is a typo, not issue 0."""
    invocation = _invoke_cli(monkeypatch, "octo/widget")

    assert invocation.exit_code == 2
    assert invocation.captured == {}


def test_cli_rehearse_forwards_an_explicit_task_choice(env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    """`--task port` overrides label-based auto-selection."""
    invocation = _invoke_cli(monkeypatch, "octo/widget#42", "--task", "port")

    assert invocation.exit_code == 0, invocation.output
    assert invocation.captured["task"] == "port"


def test_cli_rehearse_rejects_an_unknown_task_choice(env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    """Click enumerates the task kinds so a typo fails before any clone."""
    invocation = _invoke_cli(monkeypatch, "octo/widget#42", "--task", "merge")

    assert invocation.exit_code == 2
    assert invocation.captured == {}


def test_cli_rehearse_end_to_end_intercepts_the_real_host_tools(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The whole command, unmocked below the network constructors.

    Every other CLI test stubs `run_rehearsal`; this one runs it, so the wiring
    the operator depends on is proven as a unit: the CLI seals the surfaces,
    the production host tools run against the seal, nothing reaches the
    backend, and the transcript reaches stdout with exit 0. A regression that
    passed the raw backend into `run_rehearsal` would explode here and nowhere
    else.
    """
    backend = ExplodingBackend()
    transport = ExplodingTransport()
    monkeypatch.setattr(cli, "_build_github", lambda _cfg: backend)
    monkeypatch.setattr(cli, "_build_git_transport", lambda _cfg: transport)

    async def real_tools_task(**kwargs: Any) -> None:
        bindings = _bindings(
            kwargs["db"],
            tmp_path,
            kwargs["github"],
            kwargs["git_transport"],
            asyncio.get_running_loop(),
        )
        tools = host_tools.build(bindings)
        # Host tools block on the loop from a worker thread, so they must not
        # be driven from the loop itself.
        await asyncio.to_thread(
            _tool(tools, "gh_post_comment").execute,
            {"body": "the live render path lacks the normalization"},
            _ctx(),
        )
        await asyncio.to_thread(_tool(tools, "set_issue_labels").execute, {"labels": ["bug"]}, _ctx())

    monkeypatch.setattr(rehearse, "_TASK_FUNCTIONS", {"triage": real_tools_task})

    invocation = CliRunner().invoke(cli.main, ["rehearse", "octo/widget#42", "--workspace-root", str(tmp_path / "rw")])

    assert invocation.exit_code == 0, invocation.output
    assert "the live render path lacks the normalization" in invocation.output
    assert "octo/widget#42: bug" in invocation.output
    # The doubles raise on any mutating attribute access, and `run_rehearsal`
    # turns a raising task into `outcome="failed"` -> exit 1. Exit 0 with both
    # writes on the transcript is therefore proof they were intercepted.
    assert "intercepted: 2 GitHub write(s) — none of them reached GitHub" in invocation.output
    assert sorted(name for name, _a, _k in backend.reads) == ["get_issue", "get_repo"]
