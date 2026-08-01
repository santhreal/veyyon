"""Dispatch action -> task mapping in WorkerPool._dispatch.

Regression guard for the route<->dispatch contract: `github_events.route`
queues `pull_request` opened/reopened/ready_for_review events as `review_pr`
tasks, so `_dispatch` MUST invoke `tasks.review_pr` for those actions and no
others (a `synchronize`, say, must not silently spawn a review).
"""

from __future__ import annotations

import asyncio

import pytest

from veybot import tasks
from veybot.config import Settings
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
    row is claimed, marked done, and the red candidate is never repaired."""
    seen: list[str] = []

    async def fake_ci_repair(*, payload, **_kwargs) -> None:
        seen.append(str(payload.get("check_suite", {}).get("head_sha")))

    monkeypatch.setattr(tasks, "ci_repair", fake_ci_repair)

    row = EventRow(
        delivery_id="cs1",
        event_type="check_suite",
        repo="octo/widget",
        issue_key="octo/widget#42",
        payload={
            "action": "completed",
            "check_suite": {"conclusion": "failure", "head_sha": "deadbeef", "pull_requests": [{"number": 90}]},
            "repository": {"full_name": "octo/widget"},
        },
        received_at="2026-01-01T00:00:00Z",
        state="running",
        attempts=1,
        last_error=None,
    )
    await _make_pool(settings, db)._dispatch(row)  # noqa: SLF001

    assert seen == ["deadbeef"]
