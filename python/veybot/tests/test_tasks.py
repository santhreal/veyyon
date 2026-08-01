from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import os
import re
import subprocess
import threading
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from veyyon_rpc import HostToolContext, RpcCommandError

from veybot import persona, tasks, worker
from veybot.config import Settings, reset_settings_cache
from veybot.db import Database
from veybot.github_client import CheckRunInfo, GitHubClient, IssueInfo, PullRequestInfo, RepoInfo, WorkflowRunInfo
from veybot.sandbox import LocalGitTransport, SandboxManager


async def test_triage_issue_keeps_event_loop_live_while_workspace_setup_blocks(db, settings, monkeypatch, tmp_path):
    async def _resolve_repo_and_issue(_github, _payload):
        repo = RepoInfo(
            full_name="octo/widget",
            default_branch="main",
            clone_url="https://x/octo/widget.git",
            private=False,
        )
        issue = IssueInfo(
            repo="octo/widget",
            number=1,
            title="bug",
            body="b",
            state="open",
            author="alice",
            labels=(),
            is_pull_request=False,
        )
        return repo, issue

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve_repo_and_issue)

    async def _no_closing(*a, **k):
        return ()

    github = SimpleNamespace(list_closing_pull_requests=_no_closing)

    entered = threading.Event()
    release = threading.Event()
    captured: dict[str, object] = {}

    def _blocking_ensure(**_kwargs):
        entered.set()
        # True ONLY if a concurrent coroutine set `release` while we blocked here.
        # Blocks a WORKER THREAD (via to_thread) in the fixed code; blocks the
        # LOOP itself in the broken code.
        captured["release_seen_in_time"] = release.wait(1.0)
        return SimpleNamespace(branch="farm/x/y", session_dir=str(tmp_path / "sess"))

    sandbox = SimpleNamespace(natives_cache=None, ensure_workspace=_blocking_ensure)

    async def _noop_run_task(**_kwargs):
        return None

    monkeypatch.setattr(tasks, "run_task", _noop_run_task)

    async def _releaser():
        # Waits (off-loop) until ensure_workspace has actually started, then
        # releases it. This coroutine can ONLY make progress if the event loop
        # is live while ensure_workspace is blocking.
        await asyncio.to_thread(entered.wait, 1.0)
        assert entered.is_set(), "ensure_workspace never started"
        release.set()

    triage_task = asyncio.create_task(
        tasks.triage_issue(
            settings=settings,
            db=db,
            github=github,
            sandbox=sandbox,
            git_transport=SimpleNamespace(),
            payload={},
            delivery_id="d1",
        )
    )
    releaser_task = asyncio.create_task(_releaser())

    await asyncio.wait_for(triage_task, timeout=3.0)
    await asyncio.wait_for(releaser_task, timeout=1.0)

    assert captured.get("release_seen_in_time") is True, (
        "event loop was frozen during ensure_workspace: the concurrent releaser "
        "could not run, so release.wait timed out (this is the pre-fix hang)"
    )


async def test_run_workspace_op_drains_thread_before_propagating_cancel():
    started = threading.Event()
    proceed = threading.Event()
    finished = threading.Event()

    def slow_op(**_kwargs):
        started.set()
        # Block on the worker thread until the test releases us.
        assert proceed.wait(2.0), "proceed was never set — test bug"
        finished.set()
        return "done"

    task = asyncio.create_task(tasks._run_workspace_op(slow_op))
    # Wait (off-loop) until the worker thread is actually running.
    await asyncio.to_thread(started.wait, 1.0)
    assert started.is_set()

    async def pump(turns: int = 20) -> None:
        # Deterministically advance the loop without a wall-clock sleep: each
        # sleep(0) drains the ready queue, so a DETACHING (pre-fix) helper would
        # resolve `task` within these turns. A draining helper keeps it pending
        # while the worker thread is still blocked on `proceed`.
        for _ in range(turns):
            await asyncio.sleep(0)

    # Cancel the AWAITING coroutine while the thread is mid-flight, then a SECOND
    # time while it is still blocked. The repeated cancel must land on the drain
    # loop's re-`await` and be swallowed by its `continue` branch, NOT abandon
    # the thread. The whole sequence runs under try/finally so any failed assert
    # still releases the worker and cannot leak a blocked thread into later tests.
    try:
        task.cancel()
        await pump()
        assert not task.done(), "helper propagated the first cancel before the thread completed (thread abandoned)"
        task.cancel()
        await pump()
        # The thread is still blocked on `proceed`, so it has not finished and
        # the task has not resolved despite two cancels.
        assert not finished.is_set(), "thread finished before we released it — impossible unless abandoned"
        assert not task.done(), "helper abandoned the thread after a repeated cancel"
    finally:
        proceed.set()

    # The helper must now let the thread finish, THEN raise CancelledError.
    with pytest.raises(asyncio.CancelledError):
        await task
    # Deterministic in the fixed helper: the thread completed before the cancel propagated.
    assert finished.is_set(), "thread did not complete before cancellation propagated"


async def test_run_workspace_op_logs_worker_exception_on_concurrent_cancel(caplog):
    started = threading.Event()
    proceed = threading.Event()
    boom = RuntimeError("git exploded")

    def failing_op(**_kwargs):
        started.set()
        assert proceed.wait(2.0), "proceed was never set — test bug"
        raise boom

    task = asyncio.create_task(tasks._run_workspace_op(failing_op))
    await asyncio.to_thread(started.wait, 1.0)
    assert started.is_set()

    # Cancel the caller while the worker is still blocked (mid-flight), so the
    # helper enters its cancel-drain loop and is awaiting the shielded inner.
    task.cancel()
    await asyncio.sleep(0.05)

    with caplog.at_level(logging.WARNING, logger="veybot.tasks"):
        # Release the worker so inner completes WITH an exception while the
        # helper is draining -> the drain's `await shield(inner)` re-raises boom,
        # breaks the loop, and the guarded log.warning must fire.
        proceed.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert warnings, "worker exception during cancel was not logged"
    assert any(r.exc_info and r.exc_info[1] is boom for r in warnings), (
        "the worker's exception was not attached to the warning"
    )


# ---- port_upstream / ci_repair ----

KEY = "octo/widget#42"


def _repo() -> RepoInfo:
    return RepoInfo(
        full_name="octo/widget",
        default_branch="main",
        clone_url="https://example.invalid/octo/widget.git",
        private=False,
    )


def _issue(*, labels: tuple[str, ...] = ("upstream-port",)) -> IssueInfo:
    return IssueInfo(
        repo="octo/widget",
        number=42,
        title="Port upstream #9",
        body="<!-- upstream-port-kind: fix -->\nUpstream merged PR: https://example.invalid/9",
        state="open",
        author="radar-bot",
        labels=labels,
        is_pull_request=False,
    )


def _pr(state: str = "open") -> PullRequestInfo:
    return PullRequestInfo(
        repo="octo/widget",
        number=90,
        html_url="https://example.invalid/octo/widget/pull/90",
        head_ref="farm/abcd1234/port-upstream-9",
        base_ref="main",
        state=state,
        author="robveybot",
        head_repo="octo/widget",
    )


def _workspace(tmp_path, branch: str = "farm/abcd1234/port-upstream-9"):
    return SimpleNamespace(branch=branch, session_dir=str(tmp_path / "sess"))


class _Recorder:
    """Records `run_task` invocations so a test can prove no agent was spent."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def __call__(self, **kwargs) -> None:
        self.calls.append(kwargs)


def _forbidden_workspace(**_kwargs):
    raise AssertionError("ensure_workspace must not run when the task bails out")


async def test_port_upstream_skips_when_candidate_pr_is_still_open(db, settings, monkeypatch, tmp_path):
    """A tracking issue reaches us twice: the label can be removed and re-added,
    and a delivery can be replayed after a restart. Without the re-entry guard
    the second arrival spends a whole agent producing a duplicate candidate for
    a pull request that is already open and waiting on a human."""

    async def _resolve(_github, _payload):
        return _repo(), _issue()

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve)
    recorder = _Recorder()
    monkeypatch.setattr(tasks, "run_task", recorder)
    db.upsert_issue(key=KEY, repo="octo/widget", number=42, state="opened", pr_number=90)

    async def _get_pr(_repo_full, number):
        assert number == 90
        return _pr("open")

    await tasks.port_upstream(
        settings=settings,
        db=db,
        github=SimpleNamespace(get_pull_request=_get_pr),
        sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=_forbidden_workspace),
        git_transport=SimpleNamespace(),
        payload={},
        delivery_id="d1",
    )

    assert recorder.calls == []


async def test_port_upstream_runs_again_when_the_prior_candidate_was_closed(db, settings, monkeypatch, tmp_path):
    """A closed candidate is not a candidate. Guarding on `pr_number` alone
    would strand every issue whose first attempt was rejected and re-labeled."""

    async def _resolve(_github, _payload):
        return _repo(), _issue()

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve)
    recorder = _Recorder()
    monkeypatch.setattr(tasks, "run_task", recorder)
    db.upsert_issue(key=KEY, repo="octo/widget", number=42, state="closed", pr_number=90)

    async def _get_pr(_repo_full, _number):
        return _pr("closed")

    await tasks.port_upstream(
        settings=settings,
        db=db,
        github=SimpleNamespace(get_pull_request=_get_pr),
        sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=lambda **_k: _workspace(tmp_path)),
        git_transport=SimpleNamespace(),
        payload={},
        delivery_id="d1",
    )

    assert [call["task_kind"] for call in recorder.calls] == ["port_upstream"]
    assert db.get_issue(KEY).branch == "farm/abcd1234/port-upstream-9"


async def test_port_upstream_skips_after_gh_open_pr_already_succeeded(db, settings, monkeypatch, tmp_path):
    """`gh_open_pr` fired once for this issue, so the candidate exists even if
    the issues row lost its `pr_number` (restored DB, repaired mapping). The
    audit trail is the second, independent proof that the work is done."""

    async def _resolve(_github, _payload):
        return _repo(), _issue()

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve)
    recorder = _Recorder()
    monkeypatch.setattr(tasks, "run_task", recorder)
    db.log_tool_call(issue_key=KEY, tool="gh_open_pr", args={}, result={"pr_number": 90})

    await tasks.port_upstream(
        settings=settings,
        db=db,
        github=SimpleNamespace(),
        sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=_forbidden_workspace),
        git_transport=SimpleNamespace(),
        payload={},
        delivery_id="d1",
    )

    assert recorder.calls == []


async def test_port_upstream_skips_when_the_label_was_removed(db, settings, monkeypatch, tmp_path):
    """The live label is the authorization. A maintainer who strips it between
    the webhook and the claim has withdrawn the request; a replayed delivery
    weeks later must not resurrect it."""

    async def _resolve(_github, _payload):
        return _repo(), _issue(labels=("enhancement",))

    monkeypatch.setattr(tasks, "_resolve_repo_and_issue", _resolve)
    recorder = _Recorder()
    monkeypatch.setattr(tasks, "run_task", recorder)

    await tasks.port_upstream(
        settings=settings,
        db=db,
        github=SimpleNamespace(),
        sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=_forbidden_workspace),
        git_transport=SimpleNamespace(),
        payload={},
        delivery_id="d1",
    )

    assert recorder.calls == []


def _check_payload(head_sha: str = "abc123") -> dict:
    return {
        "action": "completed",
        "check_suite": {
            "conclusion": "failure",
            "head_sha": head_sha,
            "pull_requests": [{"number": 90}],
        },
        "repository": {"full_name": "octo/widget"},
    }


def _ci_github(*, runs, statuses, comments: list[tuple[int, str]] | None = None):
    async def _list_check_runs(_repo_full, _sha):
        return runs

    async def _list_commit_statuses(_repo_full, _sha):
        return statuses

    async def _list_workflow_runs(_repo_full, _sha):
        return [WorkflowRunInfo(id=7, name="checks", status="completed", conclusion="failure")]

    async def _get_failed_job_logs(_repo_full, _run_id):
        return "=== Lint & type check ===\nerror TS2345: nope\n"

    async def _get_repo(_repo_full):
        return _repo()

    async def _get_issue(_repo_full, _number):
        return _issue()

    async def _post_comment(_repo_full, number, body):
        if comments is not None:
            comments.append((number, body))
        return SimpleNamespace(id=1)

    return SimpleNamespace(
        list_check_runs=_list_check_runs,
        list_commit_statuses=_list_commit_statuses,
        list_workflow_runs_for_sha=_list_workflow_runs,
        get_failed_job_logs=_get_failed_job_logs,
        get_repo=_get_repo,
        get_issue=_get_issue,
        post_comment=_post_comment,
    )


def _run(name: str, conclusion: str | None, *, status: str = "completed") -> CheckRunInfo:
    return CheckRunInfo(
        name=name,
        status=status,
        conclusion=conclusion,
        started_at="2026-01-01T00:00:00Z",
        id=1,
        details_url=None,
    )


def _seed_candidate(db) -> None:
    db.upsert_issue(
        key=KEY,
        repo="octo/widget",
        number=42,
        state="opened",
        branch="farm/abcd1234/port-upstream-9",
        session_dir="/tmp/sess",
        pr_number=90,
    )


async def test_ci_repair_dispatches_an_agent_on_a_real_failure(db, settings, monkeypatch, tmp_path):
    """The happy path: a genuinely red suite must reach the agent ON THE
    CANDIDATE BRANCH. A fresh branch here would push the repair somewhere the
    pull request cannot see it."""
    _seed_candidate(db)
    recorder = _Recorder()
    monkeypatch.setattr(tasks, "run_task", recorder)
    seen: dict = {}

    def _ensure(**kwargs):
        seen.update(kwargs)
        return _workspace(tmp_path)

    await tasks.ci_repair(
        settings=settings,
        db=db,
        github=_ci_github(runs=[_run("Lint & type check", "failure")], statuses=[]),
        sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=_ensure),
        git_transport=SimpleNamespace(),
        payload=_check_payload(),
        delivery_id="d1",
    )

    assert len(recorder.calls) == 1
    call = recorder.calls[0]
    assert call["task_kind"] == "ci_repair"
    assert call["pr_number"] == 90
    assert seen["existing_branch"] == "farm/abcd1234/port-upstream-9"
    ci = call["ci"]
    assert (ci.attempt, ci.max_attempts) == (1, settings.ci_max_repairs)
    assert ci.failing == ("Lint & type check",)
    assert "error TS2345" in ci.log_excerpt
    assert db.ci_repair_attempts(KEY, "abc123") == 1


async def test_ci_repair_does_not_start_an_agent_when_checks_are_green(db, settings, monkeypatch, tmp_path):
    """A failing suite can be superseded by a green one before we claim the
    event. Repairing then would push a pointless commit onto a candidate a
    human may already be reading."""
    _seed_candidate(db)
    recorder = _Recorder()
    monkeypatch.setattr(tasks, "run_task", recorder)

    await tasks.ci_repair(
        settings=settings,
        db=db,
        github=_ci_github(runs=[_run("Lint & type check", "success")], statuses=[]),
        sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=_forbidden_workspace),
        git_transport=SimpleNamespace(),
        payload=_check_payload(),
        delivery_id="d1",
    )

    assert recorder.calls == []


async def test_ci_repair_does_not_start_an_agent_while_checks_are_pending(db, settings, monkeypatch, tmp_path):
    """A run still in progress is not a failure. Dispatching on it burns one of
    only two concurrency lanes and races the checks it would be reading."""
    _seed_candidate(db)
    recorder = _Recorder()
    monkeypatch.setattr(tasks, "run_task", recorder)

    await tasks.ci_repair(
        settings=settings,
        db=db,
        github=_ci_github(
            runs=[_run("Lint & type check", "failure"), _run("Tests", None, status="in_progress")],
            statuses=[],
        ),
        sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=_forbidden_workspace),
        git_transport=SimpleNamespace(),
        payload=_check_payload(),
        delivery_id="d1",
    )

    assert recorder.calls == []
    assert db.ci_repair_attempts(KEY, "abc123") == 0, "a pending suite must not spend the repair budget"


async def test_ci_repair_budget_survives_a_burst_of_superseded_suites(db, settings, monkeypatch, tmp_path):
    """GitHub re-fires `check_suite.completed` per suite, and a red one is
    routinely superseded by a green rerun before we claim it. Charging the
    budget before reading live check state let three such no-ops exhaust the
    allowance, so the next genuine failure got the hand-off comment instead of
    the repair it was owed."""
    _seed_candidate(db)
    recorder = _Recorder()
    monkeypatch.setattr(tasks, "run_task", recorder)
    green = _ci_github(runs=[_run("Lint & type check", "success")], statuses=[])

    for _ in range(settings.ci_max_repairs):
        await tasks.ci_repair(
            settings=settings,
            db=db,
            github=green,
            sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=_forbidden_workspace),
            git_transport=SimpleNamespace(),
            payload=_check_payload(),
            delivery_id="d1",
        )

    assert db.ci_repair_attempts(KEY, "abc123") == 0

    await tasks.ci_repair(
        settings=settings,
        db=db,
        github=_ci_github(runs=[_run("Lint & type check", "failure")], statuses=[]),
        sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=lambda **_k: _workspace(tmp_path)),
        git_transport=SimpleNamespace(),
        payload=_check_payload(),
        delivery_id="d2",
    )

    assert [c["ci"].attempt for c in recorder.calls] == [1]


async def test_ci_repair_hands_off_once_when_the_budget_is_exhausted(db, settings, monkeypatch, tmp_path):
    """Past the cap the pull request belongs to a human: no agent, one comment.
    The comment must be idempotent — a restarted daemon replaying the same
    delivery, or a second red suite on the same commit, must not re-post it."""
    _seed_candidate(db)
    for _ in range(settings.ci_max_repairs):
        db.bump_ci_repair(KEY, "abc123")
    recorder = _Recorder()
    monkeypatch.setattr(tasks, "run_task", recorder)
    comments: list[tuple[int, str]] = []
    github = _ci_github(runs=[_run("Lint & type check", "failure")], statuses=[], comments=comments)

    for _ in range(3):
        await tasks.ci_repair(
            settings=settings,
            db=db,
            github=github,
            sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=_forbidden_workspace),
            git_transport=SimpleNamespace(),
            payload=_check_payload(),
            delivery_id="d1",
        )

    assert recorder.calls == []
    assert len(comments) == 1
    number, body = comments[0]
    assert number == 90
    assert str(settings.ci_max_repairs) in body


async def test_ci_repair_skips_a_pull_request_with_no_tracked_issue(db, settings, monkeypatch, tmp_path):
    """No issues row means no branch to reuse and no budget to charge. This is
    the fallback that keeps a contributor's PR out of the repair loop even if
    routing ever let one through."""
    recorder = _Recorder()
    monkeypatch.setattr(tasks, "run_task", recorder)

    async def _get_pr(_repo_full, _number):
        return _pr("open")

    github = _ci_github(runs=[_run("Lint & type check", "failure")], statuses=[])
    github.get_pull_request = _get_pr

    await tasks.ci_repair(
        settings=settings,
        db=db,
        github=github,
        sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=_forbidden_workspace),
        git_transport=SimpleNamespace(),
        payload=_check_payload(),
        delivery_id="d1",
    )

    assert recorder.calls == []


# ---------------------------------------------------------------------------
# Triage comment cadence
# ---------------------------------------------------------------------------
#
# These drive the REAL `tasks.triage_issue` — real sandbox worktree off a real
# local bare repo, real `host_tools`, real audit rows, real `git push` — with
# only the veyyon subprocess replaced by a script of host-tool calls. What the
# script asks for and what actually reaches GitHub are therefore two different
# things, which is the whole point: the cadence gate sits between them.

_CADENCE_REPO = "octo/widget"
_CADENCE_KEY = "octo/widget#1"
_COMMENTS_PATH_RE = re.compile(rf"/repos/{_CADENCE_REPO}/issues/(?P<number>\d+)/comments")

_ACK_BODY = (
    "`src/dialog.ts:14` builds the prompt straight from the raw payload, so it "
    "never runs the normalization `normalizeRenderQuestions` already applies on "
    "the transcript side. Reproducing now."
)

_REPRO_BODY = """Reproduced with `bun test dialog.test.ts`:

```
TypeError: questions.map is not a function
    at askDialog (src/dialog.ts:14:22)
```

**Cause:** `src/dialog.ts:14` passes the raw payload to `askDialog`, bypassing normalization.
**Next:** normalize at dialog entry, mirroring the transcript renderer.
"""

_PR_BODY = """## Repro
`bun test dialog.test.ts` throws on a payload with a bare-string question.

## Cause
`src/dialog.ts:14` hands the raw payload to `askDialog`.

## Fix
- normalize at dialog entry
Mirrors: `render.ts` — the transcript renderer's `normalizeRenderQuestions`.

## Verification
`bun test dialog.test.ts` passes. Fixes #1
"""

_LINK_BODY = "Fix opened in #7 — `normalizeDialogQuestions` at dialog entry, mirroring `normalizeRenderQuestions`."


def _git_seed(cwd, *args: str) -> None:
    env = os.environ | {
        "GIT_AUTHOR_NAME": "seed",
        "GIT_AUTHOR_EMAIL": "seed@example.invalid",
        "GIT_COMMITTER_NAME": "seed",
        "GIT_COMMITTER_EMAIL": "seed@example.invalid",
    }
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True, env=env)


def _seed_upstream(root: Path) -> Path:
    """A local bare repo standing in for `origin`, with a pattern to mirror."""
    root.mkdir(parents=True, exist_ok=True)
    bare = root / "upstream.git"
    bare.mkdir()
    _git_seed(root, "init", "--initial-branch=main", "--bare", str(bare))
    seed = root / "seed"
    seed.mkdir()
    _git_seed(seed, "init", "--initial-branch=main")
    (seed / "render.ts").write_text("export function normalizeRenderQuestions() {}\n", encoding="utf-8")
    (seed / "dialog.ts").write_text("export function askDialog() {}\n", encoding="utf-8")
    _git_seed(seed, "add", ".")
    _git_seed(seed, "commit", "-m", "init")
    _git_seed(seed, "remote", "add", "origin", str(bare))
    _git_seed(seed, "push", "origin", "main")
    return bare


def _land_fix(repo_dir: Path) -> None:
    """Script step: edit + commit as the bot, so the push gate is satisfied."""
    (repo_dir / "dialog.ts").write_text(
        "export function normalizeDialogQuestions() {}\nexport function askDialog() {}\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "add", "."], cwd=str(repo_dir), check=True, capture_output=True, text=True)
    subprocess.run(
        ["git", "commit", "-m", "fix(dialog): normalize questions at entry", "-m", "Fixes #1"],
        cwd=str(repo_dir),
        check=True,
        capture_output=True,
        text=True,
    )


class _FakeGitHubApi:
    """Records every write the triage path makes; serves the reads it needs."""

    def __init__(self, bare: Path) -> None:
        self.bare = bare
        self.comments: list[dict] = []
        self.prs: list[dict] = []
        self.labels: list[str] = []
        self._next_comment_id = 100

    @property
    def comment_bodies(self) -> list[str]:
        return [c["body"] for c in self.comments]

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        if method == "GET" and path == f"/repos/{_CADENCE_REPO}":
            return httpx.Response(200, json=self._repo())
        if method == "GET" and path == f"/repos/{_CADENCE_REPO}/issues/1":
            return httpx.Response(200, json=self._issue())
        if method == "GET" and path == f"/repos/{_CADENCE_REPO}/issues/1/timeline":
            return httpx.Response(200, json=[])
        if method == "GET" and path == f"/repos/{_CADENCE_REPO}/issues/1/comments":
            return httpx.Response(200, json=self.comments)
        posted = _COMMENTS_PATH_RE.fullmatch(path)
        if method == "POST" and posted is not None:
            self._next_comment_id += 1
            comment = {
                "id": self._next_comment_id,
                "number": int(posted.group("number")),
                "user": {"login": "robveybot"},
                "body": json.loads(request.content)["body"],
                "created_at": "2026-05-14T20:00:00Z",
            }
            self.comments.append(comment)
            return httpx.Response(201, json=comment)
        if method == "POST" and path == f"/repos/{_CADENCE_REPO}/issues/1/labels":
            self.labels.extend(json.loads(request.content)["labels"])
            return httpx.Response(200, json=[{"name": name} for name in self.labels])
        if method == "POST" and path == f"/repos/{_CADENCE_REPO}/pulls":
            body = json.loads(request.content)
            pr = {
                "number": 7,
                "html_url": "https://example.invalid/octo/widget/pull/7",
                "head": {"ref": body["head"]},
                "base": {"ref": body["base"]},
                "state": "open",
                "title": body["title"],
                "body": body["body"],
            }
            self.prs.append(pr)
            return httpx.Response(201, json=pr)
        return httpx.Response(404, json={"message": f"unmocked {method} {path}"})

    def _repo(self) -> dict:
        return {
            "full_name": _CADENCE_REPO,
            "default_branch": "main",
            "clone_url": str(self.bare),
            "private": False,
        }

    def _issue(self) -> dict:
        return {
            "number": 1,
            "title": "askDialog crashes on a bare-string question",
            "body": "`bun test dialog.test.ts` throws TypeError.",
            "state": "open",
            "user": {"login": "alice"},
            "labels": [],
        }

    def payload(self) -> dict:
        return {"action": "opened", "issue": self._issue(), "repository": self._repo()}


class _ScriptedRpcClient:
    """Stand-in for `veyyon --mode rpc` that replays a fixed host-tool script.

    `worker._run_rpc_blocking` hands the client every real host tool as
    `custom_tools`, so replaying through them exercises the genuine tool
    bodies, the genuine audit rows, and the genuine backend the task installed.
    Only the model's choice of what to call is scripted.
    """

    def __init__(self, session: _ScriptedSession, kwargs: dict) -> None:
        self._session = session
        self._tools = {tool.name: tool for tool in kwargs.get("custom_tools", ())}
        self._cwd = Path(kwargs["cwd"])
        self._on_tool_end = None

    def __enter__(self) -> _ScriptedRpcClient:
        return self

    def __exit__(self, *_exc) -> bool:
        return False

    def install_headless_ui(self) -> None: ...

    def on_message_update(self, _cb) -> None: ...

    def on_tool_execution_end(self, cb) -> None:
        self._on_tool_end = cb

    def set_todos(self, phases) -> None:
        self._session.todo_phases = phases

    def get_todos(self):
        return ()

    def stop(self) -> None: ...

    def _mark_closed(self, _error) -> None: ...

    def prompt_and_wait(self, prompt, timeout):
        self._session.prompts.append(prompt)
        if len(self._session.prompts) == 1:
            self._replay()
        return SimpleNamespace(messages=[], events=[], assistant_text="done", assistant_message=None)

    def _replay(self) -> None:
        ctx = HostToolContext(tool_call_id="tc-1", _cancel_event=threading.Event(), _send_update=lambda _p: None)
        for step in self._session.script:
            if callable(step):
                step(self._cwd)
                continue
            name, args = step
            try:
                result = self._tools[name].execute(dict(args), ctx)
            except RpcCommandError as exc:
                self._session.refusals.append((name, str(exc)))
                if self._on_tool_end is not None:
                    self._on_tool_end(SimpleNamespace(tool_name=name, result=None))
                continue
            self._session.accepted.append(name)
            if self._on_tool_end is not None:
                self._on_tool_end(SimpleNamespace(tool_name=name, result=result))


class _ScriptedSession:
    """One scripted agent turn plus everything it did."""

    def __init__(self, script) -> None:
        self.script = script
        self.prompts: list[str] = []
        self.accepted: list[str] = []
        self.refusals: list[tuple[str, str]] = []
        self.todo_phases: list = []

    def client(self, **kwargs) -> _ScriptedRpcClient:
        return _ScriptedRpcClient(self, kwargs)

    def refusal_for(self, tool: str) -> str:
        matches = [msg for name, msg in self.refusals if name == tool]
        assert matches, f"{tool} was not refused; refusals={self.refusals}"
        return matches[0]


@dataclasses.dataclass(slots=True)
class _CadenceRun:
    session: _ScriptedSession
    api: _FakeGitHubApi
    audit: list[tuple[str, bool]]
    """(tool, succeeded) for every audit row, in write order."""
    issue_state: str | None
    issue_pr: int | None

    def accepted_audit(self) -> list[str]:
        return [tool for tool, ok in self.audit if ok]


async def _run_cadence_triage(tmp_path: Path, monkeypatch, script, *, seed_comment: bool = False) -> _CadenceRun:
    monkeypatch.setenv("VEYBOT_TASK_COMPLETION_MAX_REMINDERS", "0")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()

    api = _FakeGitHubApi(_seed_upstream(tmp_path / "git"))
    session = _ScriptedSession(script)
    monkeypatch.setattr(worker, "RpcClient", session.client)

    database = Database(cfg.sqlite_path)
    try:
        if seed_comment:
            # Stands in for an earlier attempt that already spoke to the reporter.
            database.log_tool_call(
                issue_key=_CADENCE_KEY, tool="gh_post_comment", args={"body": "x"}, result={"comment_id": 1}
            )
        await tasks.triage_issue(
            settings=cfg,
            db=database,
            github=GitHubClient("ghp_test", transport=api.transport()),
            sandbox=SandboxManager(cfg.workspace_root),
            git_transport=LocalGitTransport(token=None),
            payload=api.payload(),
            delivery_id="d-cadence",
        )
        rows = database._conn.execute(  # noqa: SLF001 - test-only audit inspection
            "SELECT tool, error FROM tool_calls WHERE issue_key=? ORDER BY id",
            (_CADENCE_KEY,),
        ).fetchall()
        issue_row = database.get_issue(_CADENCE_KEY)
        return _CadenceRun(
            session=session,
            api=api,
            audit=[(row["tool"], row["error"] is None) for row in rows],
            issue_state=issue_row.state if issue_row else None,
            issue_pr=issue_row.pr_number if issue_row else None,
        )
    finally:
        database.close()


def _classify_step() -> tuple[str, dict]:
    return (
        "classify_issue",
        {
            "primary": "bug",
            "priority": "prio:p1",
            "rationale": "crash on a documented payload shape",
            "branch_slug": "normalize-dialog-questions",
        },
    )


def _repro_step() -> tuple[str, dict]:
    return (
        "repro_record",
        {
            "title": "askDialog throws on bare-string question",
            "command": "bun test dialog.test.ts",
            "output": "TypeError: questions.map is not a function\n    at askDialog (src/dialog.ts:14:22)",
            "exit_code": 1,
            "reproduced": True,
        },
    )


def _open_pr_step(body: str = _PR_BODY) -> tuple[str, dict]:
    return ("gh_open_pr", {"title": "fix(dialog): normalize questions at entry", "body": body})


def _full_cadence_script() -> list:
    return [
        _classify_step(),
        ("gh_post_comment", {"body": _ACK_BODY}),
        _repro_step(),
        ("gh_post_comment", {"body": _REPRO_BODY}),
        _land_fix,
        _open_pr_step(),
        ("gh_post_comment", {"body": _LINK_BODY}),
    ]


async def test_triage_cadence_posts_three_evidence_bearing_comments_in_order(env, tmp_path, monkeypatch):
    """Locks the roboomp three-beat shape end to end: classify, then an ack that
    already names code, then the reproduction report, then the PR, then the
    link. Before this the prompt asked for a canned "looking into this" ack and
    nothing correlated any comment with evidence, so the issue went dark from
    label to PR. If the ordering or the beat count regresses, the reporter is
    back to nine minutes of silence followed by a pull request."""
    run = await _run_cadence_triage(tmp_path, monkeypatch, _full_cadence_script())

    assert run.session.refusals == []
    # Exact audit order. `gh_open_pr` audits twice: once for the push preflight
    # it performs itself, once for the PR.
    assert run.accepted_audit() == [
        "classify_issue",
        "gh_post_comment",
        "repro_record",
        "gh_post_comment",
        "gh_open_pr",
        "gh_open_pr",
        "gh_post_comment",
    ]

    assert len(run.api.comments) == 3
    ack, repro, link = run.api.comment_bodies
    assert "src/dialog.ts:14" in ack
    assert "```" in repro and "src/dialog.ts:14" in repro
    assert "Cause:" in repro and "Next:" in repro
    assert "#7" in link and "normalizeRenderQuestions" in link

    assert run.api.prs and "Mirrors:" in run.api.prs[0]["body"]
    assert run.issue_state == "opened"
    assert run.issue_pr == 7
    refs = subprocess.run(
        ["git", "-C", str(run.api.bare), "for-each-ref", "--format=%(refname)"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    assert any(ref.startswith("refs/heads/farm/") for ref in refs), refs


async def test_triage_cadence_refuses_a_contentless_ack(env, tmp_path, monkeypatch):
    """The exact ack the old prompt asked for by example. A comment that names
    nothing from the codebase must never reach the reporter: it spends their
    attention and buys them nothing. If this regresses, veybot is back to
    announcing itself before it has read a line of code."""
    script = [
        _classify_step(),
        ("gh_post_comment", {"body": "Looking into this, will report back with a repro."}),
    ]
    run = await _run_cadence_triage(tmp_path, monkeypatch, script)

    assert run.api.comments == []
    assert "names nothing from the codebase" in run.session.refusal_for("gh_post_comment")
    assert run.accepted_audit() == ["classify_issue"]


async def test_triage_cadence_lets_the_same_ack_through_once_it_names_code(env, tmp_path, monkeypatch):
    """The gate measures evidence, not length or tone. The same sentence with a
    real citation attached is exactly the beat we want, so it must pass — a gate
    that also rejected this would push the agent into silence instead of
    substance."""
    body = "Looking at `src/dialog.ts:14` — it skips the normalization `normalizeRenderQuestions` does."
    run = await _run_cadence_triage(tmp_path, monkeypatch, [_classify_step(), ("gh_post_comment", {"body": body})])

    assert run.session.refusals == []
    assert run.api.comment_bodies == [body]


async def test_triage_cadence_refuses_a_pull_request_with_no_reproduction(env, tmp_path, monkeypatch):
    """A run that never reproduced anything cannot open a PR as though it had.
    `repro_record` is the only evidence that the bug was ever observed rather
    than inferred from reading source; without it the PR body's `## Repro`
    section is fiction and a reviewer has no way to tell."""
    script = [
        _classify_step(),
        ("gh_post_comment", {"body": _ACK_BODY}),
        _land_fix,
        _open_pr_step(),
    ]
    run = await _run_cadence_triage(tmp_path, monkeypatch, script)

    assert run.api.prs == []
    assert "nothing was reproduced" in run.session.refusal_for("gh_open_pr")
    assert run.issue_pr is None


async def test_triage_cadence_refuses_a_pull_request_that_skipped_the_reproduction_report(env, tmp_path, monkeypatch):
    """Recording a reproduction privately and going straight to the PR is the
    "goes dark" failure this cadence exists to remove: the reporter watches the
    label land and then nothing until a pull request appears."""
    script = [
        _classify_step(),
        ("gh_post_comment", {"body": _ACK_BODY}),
        _repro_step(),
        _land_fix,
        _open_pr_step(),
    ]
    run = await _run_cadence_triage(tmp_path, monkeypatch, script)

    assert run.api.prs == []
    assert "reproduction was never reported" in run.session.refusal_for("gh_open_pr")


async def test_triage_cadence_refuses_a_reproduction_comment_without_evidence(env, tmp_path, monkeypatch):
    """The comment after `repro_record` is the one moment the agent is holding
    the verbatim failure, its origin, and the cause. "Reproduced, working on a
    fix in `src/dialog.ts`" clears the names-code floor but throws that evidence
    away, which is exactly the padded beat this cadence forbids."""
    script = [
        _classify_step(),
        _repro_step(),
        ("gh_post_comment", {"body": "Reproduced. Working on a fix in `src/dialog.ts`."}),
    ]
    run = await _run_cadence_triage(tmp_path, monkeypatch, script)

    assert run.api.comments == []
    refusal = run.session.refusal_for("gh_post_comment")
    assert "verbatim failure" in refusal
    assert "Cause:" in refusal
    assert "Next:" in refusal


async def test_triage_cadence_refuses_a_pull_request_body_without_a_mirrors_line(env, tmp_path, monkeypatch):
    """The `Mirrors:` line is the beat that makes a fix read as native: it says
    the change copies a shape this repo already uses. Dropping it is how bots
    ship plausible-looking foreign code, so the PR must not open without it."""
    body = _PR_BODY.replace("Mirrors: `render.ts` — the transcript renderer's `normalizeRenderQuestions`.\n", "")
    script = [
        _classify_step(),
        ("gh_post_comment", {"body": _ACK_BODY}),
        _repro_step(),
        ("gh_post_comment", {"body": _REPRO_BODY}),
        _land_fix,
        _open_pr_step(body),
    ]
    run = await _run_cadence_triage(tmp_path, monkeypatch, script)

    assert run.api.prs == []
    assert "Mirrors:" in run.session.refusal_for("gh_open_pr")
    assert len(run.api.comments) == 2


async def test_triage_cadence_leaves_the_needs_info_exit_open(env, tmp_path, monkeypatch):
    """`mark_unable_to_reproduce` posts veybot's own template through the same
    backend call the agent's comments use. Judging that template against the
    agent's evidence contract would lock the agent out of its only honest exit
    when a report cannot be reproduced."""
    script = [
        _classify_step(),
        _repro_step(),
        (
            "mark_unable_to_reproduce",
            {"diagnosis": "the payload shape is not in the report", "info_needed": "paste the failing payload"},
        ),
    ]
    run = await _run_cadence_triage(tmp_path, monkeypatch, script)

    assert run.session.refusals == []
    assert len(run.api.comments) == 1
    assert run.api.comment_bodies[0].startswith("## Could not reproduce")
    assert run.issue_state == "needs_info"


async def test_triage_cadence_does_not_re_demand_a_report_the_reporter_already_read(env, tmp_path, monkeypatch):
    """A resumed or re-triggered run must not force a duplicate reproduction
    comment. Re-posting evidence the reporter already has is precisely the
    padding this cadence removes, so a prior recorded comment satisfies the
    beat."""
    script = [
        _classify_step(),
        _repro_step(),
        _land_fix,
        _open_pr_step(),
    ]
    run = await _run_cadence_triage(tmp_path, monkeypatch, script, seed_comment=True)

    assert run.session.refusals == []
    assert run.api.prs and run.issue_pr == 7


async def test_triage_cadence_ignores_a_question_classification(env, tmp_path, monkeypatch):
    """The cadence belongs to `bug` / `documentation`. A `question` answer is
    one comment of prose and frequently cites nothing; gating it would block the
    single output that workflow is allowed to produce."""
    script = [
        ("classify_issue", {"primary": "question", "rationale": "how-to about config"}),
        ("gh_post_comment", {"body": "Set the option in your config file and restart."}),
    ]
    run = await _run_cadence_triage(tmp_path, monkeypatch, script)

    assert run.session.refusals == []
    assert len(run.api.comments) == 1


async def test_triage_cadence_covers_the_documentation_classification(env, tmp_path, monkeypatch):
    """`documentation` takes the same reproduce-fix-PR route as `bug`, so it
    owes the same cadence. Gating only `bug` would leave the doc path free to
    post the canned ack the rest of this change removes."""
    script = [
        ("classify_issue", {"primary": "documentation", "rationale": "setup doc names a removed flag"}),
        ("gh_post_comment", {"body": "On it, will report back shortly."}),
    ]
    run = await _run_cadence_triage(tmp_path, monkeypatch, script)

    assert run.api.comments == []
    assert "names nothing from the codebase" in run.session.refusal_for("gh_post_comment")


async def test_triage_cadence_accepts_mirrors_none_with_a_reason(env, tmp_path, monkeypatch):
    """Not every fix has a precedent, and a forced choice with no working escape
    is a deadlock. `Mirrors: none` plus a reason is the documented way out and
    must actually open the PR — otherwise the agent's only option is to invent a
    precedent that does not exist."""
    body = _PR_BODY.replace(
        "Mirrors: `render.ts` — the transcript renderer's `normalizeRenderQuestions`.",
        "Mirrors: none - dialog entry is the first call site to normalize its own input.",
    )
    script = [
        _classify_step(),
        ("gh_post_comment", {"body": _ACK_BODY}),
        _repro_step(),
        ("gh_post_comment", {"body": _REPRO_BODY}),
        _land_fix,
        _open_pr_step(body),
    ]
    run = await _run_cadence_triage(tmp_path, monkeypatch, script)

    assert run.session.refusals == []
    assert run.api.prs and run.issue_pr == 7


async def test_triage_cadence_only_governs_the_reporters_own_thread(env, tmp_path, monkeypatch):
    """`gh_post_comment` takes an explicit `number`, so the agent can leave a
    note on a linked or duplicate issue. The cadence is a promise to the person
    who filed *this* issue; applying it to a cross-reference would forbid
    "duplicate of #1" — a comment that is complete precisely because it is
    short."""
    script = [
        _classify_step(),
        ("gh_post_comment", {"number": 42, "body": "Tracking this in #1, which has the reproduction."}),
    ]
    run = await _run_cadence_triage(tmp_path, monkeypatch, script)

    assert run.session.refusals == []
    assert [c["number"] for c in run.api.comments] == [42]


async def test_triage_cadence_stops_demanding_evidence_after_the_pull_request(env, tmp_path, monkeypatch):
    """The third beat is a short link comment, not a second report. Once the PR
    exists the reproduction is already on the issue and in the PR body, so
    re-imposing the fenced-block contract would force the agent to paste the
    same trace a third time — the padding this cadence removes."""
    run = await _run_cadence_triage(tmp_path, monkeypatch, _full_cadence_script())

    assert run.session.refusals == []
    link = run.api.comment_bodies[-1]
    assert "```" not in link
    assert persona.triage_reproduction_gaps(link), "link comment would fail the reproduction contract"
    assert persona.triage_ack_gaps(link) == ()


async def test_triage_todo_plan_gives_each_beat_its_own_phase(env, tmp_path, monkeypatch):
    """The plan `run_task` pushes into the live session is what the agent works
    from, and the gate only refuses — it cannot tell the agent that a beat
    exists. Without a phase of its own the reproduction report has no slot in
    the plan, so the agent walks from classify to fix and only discovers the
    second beat by being refused, burning a turn every run."""
    run = await _run_cadence_triage(tmp_path, monkeypatch, [_classify_step()])

    phases = run.session.todo_phases
    assert [phase["name"] for phase in phases] == ["Classify", "Respond", "Reproduce", "Fix and publish"]
    assert all(phase["tasks"] for phase in phases)
    reproduce = next(phase for phase in phases if phase["name"] == "Reproduce")
    assert any("repro_record" in task for task in reproduce["tasks"])
    assert any("gh_post_comment" in task for task in reproduce["tasks"])
