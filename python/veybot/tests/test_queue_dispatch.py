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
