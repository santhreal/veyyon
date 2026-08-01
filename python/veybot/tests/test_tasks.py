import asyncio
import logging
import threading
from types import SimpleNamespace

import pytest

from veybot import tasks
from veybot.github_client import CheckRunInfo, IssueInfo, PullRequestInfo, RepoInfo, WorkflowRunInfo


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
