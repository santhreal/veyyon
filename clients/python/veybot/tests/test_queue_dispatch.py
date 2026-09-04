"""Dispatch action -> task mapping in WorkerPool._dispatch.

Regression guard for the route<->dispatch contract: `github_events.route`
queues `pull_request` opened/reopened/ready_for_review events as `review_pr`
tasks, so `_dispatch` MUST invoke `tasks.review_pr` for those actions and no
others (a `synchronize`, say, must not silently spawn a review).
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable

import pytest

from veybot import tasks
from veybot.config import Settings, reset_settings_cache
from veybot.db import Database, EventRow
from veybot.github_events import route
from veybot.queue import WorkerPool
from veybot.slot_pool import SlotPool


class _StubGitHub:
    """Sentinel; dispatch tests stub out the task body."""


class _StubSandbox:
    natives_cache = None


class _StubGitTransport:
    pass


def _make_pool(settings: Settings, db: Database) -> WorkerPool:
    return WorkerPool(
        settings=settings,
        db=db,
        github=_StubGitHub(),  # type: ignore[arg-type]
        sandbox=_StubSandbox(),  # type: ignore[arg-type]
        git_transport=_StubGitTransport(),  # type: ignore[arg-type]
        slot_pool=SlotPool(),
    )


_BOT = "robveybot"
_REPO = {"full_name": "octo/widget"}
_TRACKED_KEY = "octo/widget#42"


def _appender(sink: list[str], name: str) -> Callable[..., object]:
    """A stand-in task that only records the fact that it ran."""

    async def _fake(**_kwargs) -> None:
        sink.append(name)

    return _fake


def _seed_pr_mapping(db: Database, pr_number: int, *, key: str = _TRACKED_KEY) -> None:
    """Register the PR -> tracking-issue row the check_suite filter resolves through.

    Production writes this when the candidate PR is opened. Without it a
    `check_suite` event is not actionable at all, on either side.
    """
    repo, _, number = key.partition("#")
    db.upsert_issue(key=key, repo=repo, number=int(number), state="opened", pr_number=pr_number)


def _pr_issue_resolver(db: Database) -> Callable[[str, int], str | None]:
    """The resolver `server.py` injects into `route()`, over the test Database.

    `WorkerPool._resolve_issue_from_pr` is the same `find_issue_by_pr` lookup.
    Handing `route()` a hardcoded stub instead would let the two sides consult
    different mappings, which is the drift these tests exist to catch.
    """

    def _resolve(repo_full: str, pr_number: int) -> str | None:
        row = db.find_issue_by_pr(repo_full, pr_number)
        return row.key if row else None

    return _resolve


def _route(settings: Settings, db: Database, event_type: str, payload: dict, **overrides):
    """`route()` wired exactly as `server.py` wires it for this Settings/Database."""
    kwargs: dict = {
        "allowlist": settings.repo_allowlist,
        "bot_login": settings.bot_login,
        "port_label": settings.port_label,
        "triage_trigger": settings.triage_trigger,
        "triage_label": settings.triage_label,
        "resolve_issue_from_pr": _pr_issue_resolver(db),
    }
    kwargs.update(overrides)
    return route(event_type, payload, **kwargs)


def _stored_row(delivery: str, event_type: str, payload: dict, issue_key: str | None) -> EventRow:
    """An `EventRow` shaped the way the events table hands one to the dispatcher."""
    return EventRow(
        delivery_id=delivery,
        event_type=event_type,
        repo="octo/widget",
        issue_key=issue_key,
        payload=payload,
        received_at="2026-01-01T00:00:00Z",
        state="running",
        attempts=1,
        last_error=None,
    )


async def _replay(settings: Settings, db: Database, row: EventRow) -> EventRow:
    """Insert the row, drive the REAL dispatcher, return its terminal DB state.

    `_dispatch_and_mark` rather than `_dispatch`, so the assertion is about the
    outcome an operator reads out of the events table.
    """
    db.record_event(
        delivery_id=row.delivery_id,
        event_type=row.event_type,
        repo=row.repo,
        issue_key=row.issue_key,
        payload=row.payload,
    )
    await _make_pool(settings, db)._dispatch_and_mark(row)  # noqa: SLF001
    stored = db.get_event(row.delivery_id)
    assert stored is not None
    return stored


def _pr_row(action: str, *, delivery: str = "pr1") -> EventRow:
    return EventRow(
        delivery_id=delivery,
        event_type="pull_request",
        repo="octo/widget",
        issue_key="octo/widget#7",
        payload={"action": action, "pull_request": {"number": 7}},
        received_at="2026-01-01T00:00:00Z",
        state="running",
        attempts=1,
        last_error=None,
    )


@pytest.mark.parametrize("action", ["opened", "reopened", "ready_for_review"])
@pytest.mark.asyncio
async def test_dispatch_routes_pr_review_actions_to_review_pr(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    """Every PR action `route` can queue for review MUST reach `tasks.review_pr`."""
    seen: list[str] = []

    async def fake_review_pr(*, payload, **_kwargs) -> None:
        seen.append(str(payload.get("action")))

    monkeypatch.setattr(tasks, "review_pr", fake_review_pr)

    await _make_pool(settings, db)._dispatch(_pr_row(action))  # noqa: SLF001

    assert seen == [action]


@pytest.mark.asyncio
async def test_dispatch_pr_synchronize_is_noop(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Actions `route` never queues for review must NOT spawn a review task."""
    called = False

    async def fake_review_pr(**_kwargs) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(tasks, "review_pr", fake_review_pr)

    await _make_pool(settings, db)._dispatch(_pr_row("synchronize"))  # noqa: SLF001

    assert called is False


@pytest.mark.asyncio
async def test_dispatch_loop_survives_transient_claim_failure(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A transient claim failure must not kill the dispatch loop.

    The catch-all used to sit outside the `while`: one DB hiccup logged
    "dispatch loop crashed" and returned, leaving the webhook server
    enqueueing into a queue nobody drains. The loop must log, back off,
    and dispatch the next event.
    """
    import veybot.queue as queue_mod

    monkeypatch.setattr(queue_mod, "_DISPATCH_RETRY_SECONDS", 0.01)
    monkeypatch.setattr(queue_mod, "_IDLE_POLL_SECONDS", 0.01)
    pool = _make_pool(settings, db)
    dispatched: list[str] = []
    claims = 0

    async def fake_claim() -> EventRow | None:
        nonlocal claims
        claims += 1
        if claims == 1:
            raise RuntimeError("db hiccup")
        if claims == 2:
            return _pr_row("opened", delivery="after-hiccup")
        pool._stop.set()  # noqa: SLF001
        pool._wakeup.set()  # noqa: SLF001 — skip the idle wait so the loop re-checks stop
        return None

    async def fake_run_event(row: EventRow) -> None:
        dispatched.append(row.delivery_id)
        pool._stop.set()  # noqa: SLF001

    monkeypatch.setattr(pool, "_claim_next_unique", fake_claim)
    monkeypatch.setattr(pool, "_run_event", fake_run_event)

    await asyncio.wait_for(pool._dispatch_loop(), timeout=5.0)  # noqa: SLF001

    assert dispatched == ["after-hiccup"]
    assert claims >= 2


PORT_LABEL = "upstream-port"


def _issues_row(action: str, *, labels: list[dict], label: dict | None = None) -> EventRow:
    payload: dict = {
        "action": action,
        "issue": {"number": 42, "user": {"login": "radar-bot"}, "labels": labels},
        "repository": {"full_name": "octo/widget"},
    }
    if label is not None:
        payload["label"] = label
    return EventRow(
        delivery_id=f"issues-{action}",
        event_type="issues",
        repo="octo/widget",
        issue_key="octo/widget#42",
        payload=payload,
        received_at="2026-01-01T00:00:00Z",
        state="running",
        attempts=1,
        last_error=None,
    )


@pytest.mark.asyncio
async def test_dispatch_agrees_with_route_on_a_labeled_issue_opened(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`_dispatch` re-derives the handler from `(event_type, action)` off the
    EventRow and never sees the `RouteDecision`. If the two label decisions
    drift, `route` queues an upstream-port issue and `_dispatch` hands it to
    `triage_issue` — the port runs as bug triage. Same payload, both sides."""
    row = _issues_row("opened", labels=[{"name": "enhancement"}, {"name": PORT_LABEL}])
    decision = route(
        "issues",
        row.payload,
        allowlist=settings.repo_allowlist,
        bot_login=settings.bot_login,
        port_label=settings.port_label,
    )
    assert decision.task == "port_upstream"

    reached: list[str] = []

    async def fake_port_upstream(**_kwargs) -> None:
        reached.append("port_upstream")

    async def fake_triage(**_kwargs) -> None:
        reached.append("triage_issue")

    monkeypatch.setattr(tasks, "port_upstream", fake_port_upstream)
    monkeypatch.setattr(tasks, "triage_issue", fake_triage)

    await _make_pool(settings, db)._dispatch(row)  # noqa: SLF001

    assert reached == [decision.task]


@pytest.mark.asyncio
async def test_dispatch_unlabeled_issue_opened_still_reaches_triage(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The port branch must not capture ordinary issues on its way past."""
    reached: list[str] = []

    async def fake_port_upstream(**_kwargs) -> None:
        reached.append("port_upstream")

    async def fake_triage(**_kwargs) -> None:
        reached.append("triage_issue")

    monkeypatch.setattr(tasks, "port_upstream", fake_port_upstream)
    monkeypatch.setattr(tasks, "triage_issue", fake_triage)

    await _make_pool(settings, db)._dispatch(_issues_row("opened", labels=[{"name": "bug"}]))  # noqa: SLF001

    assert reached == ["triage_issue"]


@pytest.mark.asyncio
async def test_dispatch_issues_labeled_reaches_port_upstream(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`issues.labeled` is a brand new `(event_type, action)` pair — both the
    live webhook and the CLI's synthesized backlog rows land on it. Without its
    own dispatch branch every one of them falls into the no-op arm."""
    reached: list[str] = []

    async def fake_port_upstream(*, payload, **_kwargs) -> None:
        reached.append(str(payload.get("action")))

    monkeypatch.setattr(tasks, "port_upstream", fake_port_upstream)

    row = _issues_row("labeled", labels=[{"name": PORT_LABEL}], label={"name": PORT_LABEL})
    await _make_pool(settings, db)._dispatch(row)  # noqa: SLF001

    assert reached == ["labeled"]


@pytest.mark.asyncio
async def test_dispatch_issues_labeled_with_other_label_is_noop(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A stray `labeled` row (replayed, hand-inserted) whose label is not the
    port label must not spawn a port agent."""
    called = False

    async def fake_port_upstream(**_kwargs) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(tasks, "port_upstream", fake_port_upstream)

    row = _issues_row("labeled", labels=[{"name": PORT_LABEL}], label={"name": "bug"})
    await _make_pool(settings, db)._dispatch(row)  # noqa: SLF001

    assert called is False


@pytest.mark.asyncio
async def test_dispatch_check_suite_completed_reaches_ci_repair(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`check_suite` is a new event type entirely; without a dispatch branch the
    row is claimed, marked done, and the red candidate is never repaired.

    The payload is one `route` genuinely queues — failing conclusion,
    bot-authored candidate, PR mapped to a tracking issue — because `_dispatch`
    now re-applies that whole filter chain before it runs the repair.
    """
    seen: list[str] = []

    async def fake_ci_repair(*, payload, **_kwargs) -> None:
        seen.append(str(payload.get("check_suite", {}).get("head_sha")))

    monkeypatch.setattr(tasks, "ci_repair", fake_ci_repair)
    _seed_pr_mapping(db, 90)

    payload = {
        "action": "completed",
        "check_suite": {
            "conclusion": "failure",
            "head_sha": "deadbeef",
            "pull_requests": [{"number": 90, "user": {"login": settings.bot_login}}],
        },
        "repository": _REPO,
    }
    decision = _route(settings, db, "check_suite", payload)
    assert decision.task == "ci_repair"

    row = _stored_row("cs1", "check_suite", payload, decision.issue_key)
    assert await _make_pool(settings, db)._dispatch(row) is None  # noqa: SLF001

    assert seen == ["deadbeef"]


@pytest.mark.asyncio
async def test_replayed_green_check_suite_never_reaches_ci_repair(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A green `check_suite.completed` row can only reach `_dispatch` by REPLAY
    — `veybot replay <delivery>`, or the restart re-queue of an in-flight row —
    because only rows `route()` queued are ever written to the events table,
    and `route()` refuses this one at the webhook. That is precisely why the
    router's filter alone was not enough: `_dispatch` re-derived the handler
    from `(check_suite, completed)` and ran `ci_repair` applying NONE of the
    router's conditions, so the replayed row got LESS filtering than the live
    one did.

    If this regresses, a passing candidate gets a repair agent pointed at it,
    burning one of `VEYBOT_CI_MAX_REPAIRS` attempts and a concurrency lane to
    fix nothing.
    """
    ran: list[str] = []
    monkeypatch.setattr(tasks, "ci_repair", _appender(ran, "ci_repair"))
    _seed_pr_mapping(db, 90)

    payload = {
        "action": "completed",
        "check_suite": {
            "conclusion": "success",
            "head_sha": "deadbeef",
            "pull_requests": [{"number": 90, "user": {"login": settings.bot_login}}],
        },
        "repository": _REPO,
    }
    decision = _route(settings, db, "check_suite", payload)
    assert not decision.should_queue

    stored = await _replay(settings, db, _stored_row("replay-green", "check_suite", payload, _TRACKED_KEY))

    assert ran == []
    assert stored.state == "skipped"
    assert "is not a failure" in (stored.last_error or "")


@pytest.mark.asyncio
async def test_replayed_check_suite_on_a_human_pull_request_never_reaches_ci_repair(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failing `check_suite` on a CONTRIBUTOR's pull request can only reach
    `_dispatch` by REPLAY: `route()` skips it at the webhook with "not authored
    by bot", so no such row is ever queued live. The router's filter alone was
    not enough because `_dispatch` applied none of the router's conditions to
    the stored row — a replayed row therefore got LESS filtering than the live
    one, which is the opposite of safe.

    The PR here IS mapped to a tracking issue, so bot-authorship is the only
    filter under test. If this regresses, veybot pushes repair commits onto a
    human's branch nobody asked it to touch.
    """
    ran: list[str] = []
    monkeypatch.setattr(tasks, "ci_repair", _appender(ran, "ci_repair"))
    _seed_pr_mapping(db, 90)

    payload = {
        "action": "completed",
        "check_suite": {
            "conclusion": "failure",
            "head_sha": "deadbeef",
            "pull_requests": [{"number": 90, "user": {"login": "contributor"}}],
        },
        "repository": _REPO,
    }
    decision = _route(settings, db, "check_suite", payload)
    assert not decision.should_queue

    stored = await _replay(settings, db, _stored_row("replay-human", "check_suite", payload, _TRACKED_KEY))

    assert ran == []
    assert stored.state == "skipped"
    assert "not authored by bot" in (stored.last_error or "")


@pytest.mark.asyncio
async def test_replayed_comment_on_a_contributor_pull_request_never_reaches_a_task(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An `issue_comment.created` on a CONTRIBUTOR's pull request can only reach
    `_dispatch` by REPLAY: `route()` skips it with "incoming PR comments
    ignored" and only queued rows land in the events table. The router's filter
    alone was not enough because `_dispatch` selected `handle_pr_conversation`
    on `"pull_request" in issue` ALONE — no bot-authorship check — so the
    replayed row dispatched exactly where the router had refused.

    `handle_comment` is stubbed too: the router queued NO task for this row, so
    falling through to the plain-comment handler would be just as wrong as
    running the PR one. If this regresses, veybot resumes an amend-and-push
    session against a branch it does not own.
    """
    ran: list[str] = []
    monkeypatch.setattr(tasks, "handle_pr_conversation", _appender(ran, "handle_pr_conversation"))
    monkeypatch.setattr(tasks, "handle_comment", _appender(ran, "handle_comment"))

    payload = {
        "action": "created",
        "issue": {"number": 90, "user": {"login": "contributor"}, "pull_request": {"url": "x"}},
        "comment": {"body": "please rebase", "user": {"login": "alice"}},
        "repository": _REPO,
    }
    decision = _route(settings, db, "issue_comment", payload)
    assert not decision.should_queue

    stored = await _replay(settings, db, _stored_row("replay-contrib", "issue_comment", payload, decision.issue_key))

    assert ran == []
    assert stored.state == "skipped"
    assert "incoming PR comments ignored" in (stored.last_error or "")


@pytest.mark.parametrize(("merged", "expected"), [(True, "merged"), (False, "closed")])
@pytest.mark.asyncio
async def test_pull_request_closed_cleanup_state_matches_the_router_reason(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch, merged: bool, expected: str
) -> None:
    """`route()` worded its queue reason from `pull_request.merged`, and
    `_dispatch` computed `cleanup_workspace`'s target issue state from the same
    field independently. They agreed by construction, not by contract: either
    could be refined without the other. Both now call `pull_request_close_state`
    and this pins one output to the other.

    If this regresses, a merged candidate is filed under `closed` and a shipped
    PR reads as abandoned on the dashboard.
    """
    states: list[str] = []

    async def fake_cleanup(*, target_state, **_kwargs) -> None:
        states.append(target_state)

    monkeypatch.setattr(tasks, "cleanup_workspace", fake_cleanup)

    payload = {
        "action": "closed",
        "pull_request": {"number": 91, "merged": merged, "user": {"login": "alice"}},
        "repository": _REPO,
    }
    decision = _route(settings, db, "pull_request", payload)
    assert decision.task == "cleanup_workspace"

    row = _stored_row(f"prclose-{expected}", "pull_request", payload, decision.issue_key)
    await _make_pool(settings, db)._dispatch(row)  # noqa: SLF001

    assert states == [expected]
    assert decision.reason == f"pull_request.{states[0]}"


TRIAGE_LABEL = "veybot"


@pytest.mark.asyncio
async def test_dispatch_issues_labeled_with_triage_label_reaches_triage_issue(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`route` and `_dispatch` re-derive the handler INDEPENDENTLY, so their
    agreement is a real invariant that can silently break.

    Under the shipped `VEYBOT_TRIAGE_TRIGGER=label`, `route` queues
    `triage_issue` off an `issues.labeled` event. The dispatcher used to match
    only `action == "opened"` for triage, so every label-triggered row fell
    into the `no-op dispatch` arm: claimed, logged, marked done, no agent ever
    run. That failure mode is worse than the feature being off — the events
    table and the dashboard both report work completing. Same payload, both
    sides, one shared predicate.
    """
    assert settings.triage_trigger == "label"
    row = _issues_row("labeled", labels=[{"name": TRIAGE_LABEL}], label={"name": TRIAGE_LABEL})
    decision = route(
        "issues",
        row.payload,
        allowlist=settings.repo_allowlist,
        bot_login=settings.bot_login,
        port_label=settings.port_label,
        triage_trigger=settings.triage_trigger,
        triage_label=settings.triage_label,
    )
    assert decision.task == "triage_issue"

    reached: list[str] = []

    async def fake_triage(**_kwargs) -> None:
        reached.append("triage_issue")

    async def fake_port_upstream(**_kwargs) -> None:
        reached.append("port_upstream")

    monkeypatch.setattr(tasks, "triage_issue", fake_triage)
    monkeypatch.setattr(tasks, "port_upstream", fake_port_upstream)

    await _make_pool(settings, db)._dispatch(row)  # noqa: SLF001

    assert reached == [decision.task]


@pytest.mark.asyncio
async def test_dispatch_ignores_a_triage_label_row_when_the_trigger_is_off(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both sides must consult the SAME trigger mode. If the dispatcher hard-
    coded the labeled->triage pair, a replayed or hand-inserted row would run
    an agent on a deployment whose operator turned triage off."""
    monkeypatch.setenv("VEYBOT_TRIAGE_TRIGGER", "off")
    reset_settings_cache()
    off_settings = Settings()  # type: ignore[call-arg]
    off_settings.ensure_paths()
    called = False

    async def fake_triage(**_kwargs) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(tasks, "triage_issue", fake_triage)

    row = _issues_row("labeled", labels=[{"name": TRIAGE_LABEL}], label={"name": TRIAGE_LABEL})
    await _make_pool(off_settings, db)._dispatch(row)  # noqa: SLF001

    assert called is False


@pytest.mark.asyncio
async def test_dispatch_manual_issues_opened_row_triages_even_in_label_mode(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`veybot triage owner/repo#N` writes a synthetic `issues.opened` row
    straight into the events table, bypassing `route` entirely. Gating the
    dispatcher's `opened` branch on the trigger would make the CLI a no-op on
    every opt-in deployment — an explicit human request, silently dropped."""
    assert settings.triage_trigger == "label"
    reached: list[str] = []

    async def fake_triage(**_kwargs) -> None:
        reached.append("triage_issue")

    monkeypatch.setattr(tasks, "triage_issue", fake_triage)

    await _make_pool(settings, db)._dispatch(_issues_row("opened", labels=[]))  # noqa: SLF001

    assert reached == ["triage_issue"]


@pytest.mark.asyncio
async def test_dispatch_labeled_row_with_an_unrelated_label_is_still_a_noop(
    settings: Settings, db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Widening the triage branch to every `issues.labeled` (the tempting
    one-line fix) would spawn an agent for each routine label a maintainer
    adds. Only the configured label admits work."""
    called = False

    async def fake_triage(**_kwargs) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(tasks, "triage_issue", fake_triage)

    row = _issues_row("labeled", labels=[{"name": "bug"}], label={"name": "bug"})
    await _make_pool(settings, db)._dispatch(row)  # noqa: SLF001

    assert called is False


# ---- route() <-> _dispatch() coverage of every queueable (event, action) pair ----

_TASK_NAMES = (
    "triage_issue",
    "port_upstream",
    "handle_comment",
    "handle_pr_conversation",
    "handle_review",
    "review_pr",
    "ci_repair",
    "cleanup_workspace",
)

# (label, event_type, payload). Every entry MUST make `route` return a queue
# decision; the test asserts that and then asserts `_dispatch` reaches the very
# task `route` named.
_QUEUEABLE_EVENTS: list[tuple[str, str, dict]] = [
    (
        "issues.opened",
        "issues",
        {"action": "opened", "issue": {"number": 4, "user": {"login": "alice"}, "labels": []}, "repository": _REPO},
    ),
    (
        "issues.opened[port]",
        "issues",
        {
            "action": "opened",
            "issue": {"number": 4, "user": {"login": "radar"}, "labels": [{"name": PORT_LABEL}]},
            "repository": _REPO,
        },
    ),
    (
        "issues.labeled[triage]",
        "issues",
        {
            "action": "labeled",
            "label": {"name": TRIAGE_LABEL},
            "issue": {"number": 4, "user": {"login": "alice"}, "labels": [{"name": TRIAGE_LABEL}]},
            "repository": _REPO,
        },
    ),
    (
        "issues.labeled[port]",
        "issues",
        {
            "action": "labeled",
            "label": {"name": PORT_LABEL},
            "issue": {"number": 4, "user": {"login": "radar"}, "labels": [{"name": PORT_LABEL}]},
            "repository": _REPO,
        },
    ),
    (
        "issues.closed",
        "issues",
        {"action": "closed", "issue": {"number": 4, "user": {"login": "alice"}, "labels": []}, "repository": _REPO},
    ),
    (
        "issue_comment.created",
        "issue_comment",
        {
            "action": "created",
            "issue": {"number": 4, "user": {"login": "alice"}},
            "comment": {"body": "ping", "user": {"login": "alice"}},
            "repository": _REPO,
        },
    ),
    (
        "issue_comment.created[bot PR]",
        "issue_comment",
        {
            "action": "created",
            "issue": {"number": 90, "user": {"login": _BOT}, "pull_request": {"url": "x"}},
            "comment": {"body": "ping", "user": {"login": "alice"}},
            "repository": _REPO,
        },
    ),
    (
        "pull_request.opened",
        "pull_request",
        {
            "action": "opened",
            "pull_request": {"number": 91, "state": "open", "draft": False, "user": {"login": "alice"}},
            "repository": _REPO,
        },
    ),
    (
        "pull_request.closed",
        "pull_request",
        {
            "action": "closed",
            "pull_request": {"number": 91, "merged": False, "user": {"login": "alice"}},
            "repository": _REPO,
        },
    ),
    (
        "pull_request_review_comment.created",
        "pull_request_review_comment",
        {
            "action": "created",
            "pull_request": {"number": 92, "user": {"login": _BOT}},
            "comment": {"body": "nit", "user": {"login": "alice"}},
            "repository": _REPO,
        },
    ),
    (
        "check_suite.completed",
        "check_suite",
        {
            "action": "completed",
            "check_suite": {
                "conclusion": "failure",
                "head_sha": "deadbeef",
                "head_branch": "farm/abcd1234/x",
                "pull_requests": [{"number": 93, "user": {"login": _BOT}}],
            },
            "repository": _REPO,
        },
    ),
]


@pytest.mark.parametrize(("label", "event_type", "payload"), _QUEUEABLE_EVENTS, ids=[e[0] for e in _QUEUEABLE_EVENTS])
@pytest.mark.asyncio
async def test_every_queueable_event_reaches_the_task_route_named(
    settings: Settings,
    db: Database,
    monkeypatch: pytest.MonkeyPatch,
    label: str,
    event_type: str,
    payload: dict,
) -> None:
    """Enumerates every `(event_type, action)` pair `route` can queue and proves
    each lands on a real dispatch branch, invoking the exact task `route` named.

    The two sides derive the handler independently: `route` returns a
    `RouteDecision` that is thrown away, and `_dispatch` re-derives from the
    stored `(event_type, action)`. A pair `route` queues but `_dispatch` does
    not recognize falls into the `no-op dispatch` arm and is marked done with
    no work performed — the exact bug the label trigger introduced. Adding a
    new queueable pair without a dispatch branch fails here.
    """
    reached: list[str] = []
    for name in _TASK_NAMES:
        monkeypatch.setattr(tasks, name, _appender(reached, name))
    # The check_suite entry is only actionable because its PR maps to a tracked
    # issue, and BOTH sides resolve that mapping out of this Database now.
    _seed_pr_mapping(db, 93)

    decision = _route(
        settings,
        db,
        event_type,
        payload,
        triage_trigger="auto" if label == "issues.opened" else settings.triage_trigger,
    )
    assert decision.should_queue, f"{label} no longer queues: {decision.reason}"
    assert decision.task in _TASK_NAMES, f"{label} names an unknown task {decision.task!r}"

    row = _stored_row(f"cover-{label}", event_type, payload, decision.issue_key)
    await _make_pool(settings, db)._dispatch(row)  # noqa: SLF001

    assert reached == [decision.task], f"{label} routed to {decision.task} but dispatched to {reached}"


# ---- the same coverage from the other side: payloads route() REFUSES ----

# (label, event_type, payload). Every entry MUST make `route` SKIP. Labels name
# the queueable pair each entry is the refused counterpart of, so the table is
# readable as "one or more skips per queueable pair".
_ROUTER_SKIPS: list[tuple[str, str, dict]] = [
    (
        "issues.opened -> reopened",
        "issues",
        {"action": "reopened", "issue": {"number": 4, "user": {"login": "alice"}, "labels": []}, "repository": _REPO},
    ),
    (
        "issues.opened[port] -> reopened",
        "issues",
        {
            "action": "reopened",
            "issue": {"number": 4, "user": {"login": "radar"}, "labels": [{"name": PORT_LABEL}]},
            "repository": _REPO,
        },
    ),
    (
        "issues.labeled[triage] -> unrelated label",
        "issues",
        {
            "action": "labeled",
            "label": {"name": "wontfix"},
            "issue": {"number": 4, "user": {"login": "alice"}, "labels": [{"name": "wontfix"}]},
            "repository": _REPO,
        },
    ),
    (
        "issues.labeled[port] -> unrelated label",
        "issues",
        {
            "action": "labeled",
            "label": {"name": "wontfix"},
            "issue": {"number": 4, "user": {"login": "radar"}, "labels": [{"name": "wontfix"}]},
            "repository": _REPO,
        },
    ),
    (
        "issues.closed -> deleted",
        "issues",
        {"action": "deleted", "issue": {"number": 4, "user": {"login": "alice"}, "labels": []}, "repository": _REPO},
    ),
    (
        "issue_comment.created -> edited",
        "issue_comment",
        {
            "action": "edited",
            "issue": {"number": 4, "user": {"login": "alice"}},
            "comment": {"body": "ping", "user": {"login": "alice"}},
            "repository": _REPO,
        },
    ),
    (
        "issue_comment.created[bot PR] -> contributor PR",
        "issue_comment",
        {
            "action": "created",
            "issue": {"number": 90, "user": {"login": "contributor"}, "pull_request": {"url": "x"}},
            "comment": {"body": "ping", "user": {"login": "alice"}},
            "repository": _REPO,
        },
    ),
    (
        "pull_request.opened -> synchronize",
        "pull_request",
        {
            "action": "synchronize",
            "pull_request": {"number": 91, "state": "open", "draft": False, "user": {"login": "alice"}},
            "repository": _REPO,
        },
    ),
    (
        "pull_request.closed -> locked",
        "pull_request",
        {
            "action": "locked",
            "pull_request": {"number": 91, "merged": False, "user": {"login": "alice"}},
            "repository": _REPO,
        },
    ),
    (
        "pull_request_review_comment.created -> edited",
        "pull_request_review_comment",
        {
            "action": "edited",
            "pull_request": {"number": 92, "user": {"login": _BOT}},
            "comment": {"body": "nit", "user": {"login": "alice"}},
            "repository": _REPO,
        },
    ),
    (
        "check_suite.completed -> green suite",
        "check_suite",
        {
            "action": "completed",
            "check_suite": {
                "conclusion": "success",
                "head_sha": "deadbeef",
                "pull_requests": [{"number": 93, "user": {"login": _BOT}}],
            },
            "repository": _REPO,
        },
    ),
    (
        "check_suite.completed -> human-authored PR",
        "check_suite",
        {
            "action": "completed",
            "check_suite": {
                "conclusion": "failure",
                "head_sha": "deadbeef",
                "pull_requests": [{"number": 93, "user": {"login": "contributor"}}],
            },
            "repository": _REPO,
        },
    ),
    (
        "check_suite.completed -> PR maps to no tracked issue",
        "check_suite",
        {
            "action": "completed",
            "check_suite": {
                "conclusion": "failure",
                "head_sha": "deadbeef",
                "pull_requests": [{"number": 404, "user": {"login": _BOT}}],
            },
            "repository": _REPO,
        },
    ),
]


@pytest.mark.parametrize(("label", "event_type", "payload"), _ROUTER_SKIPS, ids=[e[0] for e in _ROUTER_SKIPS])
@pytest.mark.asyncio
async def test_no_payload_route_skips_is_dispatched_to_a_task(
    settings: Settings,
    db: Database,
    monkeypatch: pytest.MonkeyPatch,
    label: str,
    event_type: str,
    payload: dict,
) -> None:
    """FILTER agreement, the sibling of
    `test_every_queueable_event_reaches_the_task_route_named`.

    That test proves a queued pair reaches the task `route` named. It says
    nothing about the payloads `route` REFUSES, and that omission is the hole
    the check_suite and PR-comment divergences lived in: `_dispatch` re-derives
    the handler from `(event_type, action)` off a stored row, so the router's
    filters were the ONLY thing standing between a replayed row and a task.
    Every entry below is a payload `route` skips; none may reach a task through
    the REAL `_dispatch`.

    Coverage is at least one entry per queueable `(event_type, action)` pair,
    spanning both action-level refusals (catching a dispatch arm widened to an
    action `route` never queues) and the shared predicates
    `is_port_upstream_event`, `is_triage_label_event`, `is_pr_conversation_event`
    and `ci_repair_event`.

    Deliberately NOT covered, because the dispatcher is not contracted to
    re-apply them: receipt-time policy (`repo_allowlist`, per-user rate
    limiting, the `port_upstream`/`pr_review` kill switches) and
    `triage_trigger` — `manual_triage.enqueue_manual_triage` writes synthetic
    `issues.opened` rows precisely so the dispatcher WILL run them under
    `triage_trigger=label`, which
    `test_dispatch_manual_issues_opened_row_triages_even_in_label_mode` pins.
    """
    reached: list[str] = []
    for name in _TASK_NAMES:
        monkeypatch.setattr(tasks, name, _appender(reached, name))
    # PR 93 is tracked, PR 404 is not: the "maps to no tracked issue" entry has
    # to fail on the mapping and nothing else.
    _seed_pr_mapping(db, 93)

    decision = _route(settings, db, event_type, payload)
    assert not decision.should_queue, f"{label} no longer skips; move it to _QUEUEABLE_EVENTS"

    row = _stored_row(f"skip-{label}", event_type, payload, decision.issue_key)
    await _make_pool(settings, db)._dispatch(row)  # noqa: SLF001

    assert reached == [], f"{label} was skipped by route ({decision.reason}) but dispatched to {reached}"
