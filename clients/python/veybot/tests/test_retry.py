"""Automatic backoff-retry of transiently-failed events.

Covers the three layers of the feature:
- `Settings`: backoff schedule parsing + per-retry delay (escalation/clamp).
- `Database`: `schedule_retry` re-queues with an `available_at` gate that
  `claim_next_event` honors, and a manual requeue clears that gate.
- `WorkerPool._run_event`: a raising handler is retried up to the budget,
  then marked `failed`.
"""

from __future__ import annotations

import pytest

from veybot import config as config_mod
from veybot.config import Settings, reset_settings_cache
from veybot.db import Database, issue_key
from veybot.queue import WorkerPool
from veybot.slot_pool import SlotPool


def _record(db: Database, delivery: str = "d1") -> None:
    db.record_event(
        delivery_id=delivery,
        event_type="issues",
        repo="octo/widget",
        issue_key=issue_key("octo/widget", 1),
        payload={"action": "opened"},
    )


# ---- Settings: backoff schedule ----------------------------------------------


def test_event_retry_delays_parsing_skips_garbage(env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VEYBOT_EVENT_RETRY_DELAYS_SECONDS", "30, 120 ,600,,abc,-5")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.event_retry_delays == (30.0, 120.0, 600.0)


def test_event_retry_delays_defaults_when_empty(env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VEYBOT_EVENT_RETRY_DELAYS_SECONDS", "   ")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    assert cfg.event_retry_delays == (30.0,)


def test_retry_delay_escalates_and_clamps(env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VEYBOT_EVENT_RETRY_DELAYS_SECONDS", "1,2,3")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    # Pin jitter to its midpoint (0.8 + 0.5*0.4 = 1.0) so we assert exact bases.
    monkeypatch.setattr(config_mod.random, "random", lambda: 0.5)
    assert cfg.retry_delay_seconds(1) == 1.0
    assert cfg.retry_delay_seconds(2) == 2.0
    assert cfg.retry_delay_seconds(3) == 3.0
    assert cfg.retry_delay_seconds(4) == 3.0  # clamps to the last delay
    assert cfg.retry_delay_seconds(0) == 1.0  # clamps to the first delay


def test_retry_delay_jitter_stays_in_band(env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VEYBOT_EVENT_RETRY_DELAYS_SECONDS", "100")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    for _ in range(200):
        assert 80.0 <= cfg.retry_delay_seconds(1) <= 120.0


# ---- Database: schedule_retry + claim gating ---------------------------------


def test_schedule_retry_gates_claim_until_available(db: Database) -> None:
    _record(db)
    claimed = db.claim_next_event()
    assert claimed is not None and claimed.attempts == 1

    assert db.schedule_retry("d1", delay_seconds=3600, error="ephemeral boom")
    ev = db.get_event("d1")
    assert ev is not None
    assert ev.state == "queued"
    assert ev.attempts == 1  # claim budget preserved, not reset
    assert ev.last_error == "ephemeral boom"

    # Backed off into the future -> not yet claimable.
    assert db.claim_next_event() is None


def test_schedule_retry_zero_delay_is_immediately_claimable(db: Database) -> None:
    _record(db)
    db.claim_next_event()
    assert db.schedule_retry("d1", delay_seconds=0, error="boom")
    again = db.claim_next_event()
    assert again is not None
    assert again.attempts == 2  # re-claim advances the attempt counter


def test_schedule_retry_only_transitions_running_or_failed(db: Database) -> None:
    _record(db)
    # A still-queued row must not be touched by schedule_retry.
    assert not db.schedule_retry("d1", delay_seconds=0)
    assert db.get_event("d1").state == "queued"

    # A terminally-failed row can be revived.
    db.claim_next_event()
    db.mark_event("d1", "failed", error="x")
    assert db.schedule_retry("d1", delay_seconds=3600, error="retry me")
    assert db.get_event("d1").state == "queued"


def test_manual_requeue_clears_retry_backoff(db: Database) -> None:
    _record(db)
    db.claim_next_event()
    db.schedule_retry("d1", delay_seconds=3600, error="boom")
    assert db.claim_next_event() is None  # still backed off

    assert db.requeue_event("d1")  # operator override
    assert db.claim_next_event() is not None  # available_at cleared -> claimable


# ---- WorkerPool: retry-then-exhaust through the real failure path -------------


class _StubGitHub:
    pass


class _StubSandbox:
    natives_cache = None


class _StubGitTransport:
    pass


def _retry_settings(monkeypatch: pytest.MonkeyPatch, *, max_retries: int) -> Settings:
    monkeypatch.setenv("VEYBOT_EVENT_MAX_RETRIES", str(max_retries))
    monkeypatch.setenv("VEYBOT_EVENT_RETRY_DELAYS_SECONDS", "0")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    return cfg


@pytest.mark.asyncio
async def test_run_event_retries_then_marks_failed(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch, db: Database
) -> None:
    cfg = _retry_settings(monkeypatch, max_retries=1)
    monkeypatch.setattr("veybot.queue._reap_slot", lambda uid: None)
    pool = WorkerPool(
        settings=cfg,
        db=db,
        github=_StubGitHub(),  # type: ignore[arg-type]
        sandbox=_StubSandbox(),  # type: ignore[arg-type]
        git_transport=_StubGitTransport(),  # type: ignore[arg-type]
        slot_pool=SlotPool([2001]),
    )

    async def boom(*_args: object, **_kwargs: object) -> None:
        raise ValueError("ephemeral boom")

    monkeypatch.setattr(pool, "_dispatch", boom)
    _record(db)

    # Attempt 1 fails -> scheduled for retry (queued), not failed.
    row1 = db.claim_next_event()
    assert row1 is not None and row1.attempts == 1
    await pool._run_event(row1)
    ev = db.get_event("d1")
    assert ev is not None and ev.state == "queued"
    assert "ephemeral boom" in (ev.last_error or "")

    # Attempt 2 fails with the retry budget exhausted -> failed.
    row2 = db.claim_next_event()
    assert row2 is not None and row2.attempts == 2
    await pool._run_event(row2)
    ev = db.get_event("d1")
    assert ev is not None and ev.state == "failed"
    assert "ephemeral boom" in (ev.last_error or "")


@pytest.mark.asyncio
async def test_run_event_success_after_transient_failure(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch, db: Database
) -> None:
    """A handler that fails once then succeeds ends `done`, not `failed`."""
    cfg = _retry_settings(monkeypatch, max_retries=3)
    monkeypatch.setattr("veybot.queue._reap_slot", lambda uid: None)
    pool = WorkerPool(
        settings=cfg,
        db=db,
        github=_StubGitHub(),  # type: ignore[arg-type]
        sandbox=_StubSandbox(),  # type: ignore[arg-type]
        git_transport=_StubGitTransport(),  # type: ignore[arg-type]
        slot_pool=SlotPool([2001]),
    )

    calls = {"n": 0}

    async def flaky(*_args: object, **_kwargs: object) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise ValueError("ephemeral boom")

    monkeypatch.setattr(pool, "_dispatch", flaky)
    _record(db)

    row1 = db.claim_next_event()
    assert row1 is not None
    await pool._run_event(row1)
    assert db.get_event("d1").state == "queued"  # retry scheduled

    row2 = db.claim_next_event()
    assert row2 is not None
    await pool._run_event(row2)
    assert db.get_event("d1").state == "done"
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_inflight_collision_does_not_consume_retry_budget(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch, db: Database
) -> None:
    """A same-issue in-flight collision must not burn a real retry attempt.

    `_claim_next_unique` claims a row (which increments `attempts` in the DB
    claim transaction), then discovers the issue is already tracked in the
    in-memory `_inflight` set (the narrow window where the prior run has
    marked its DB row terminal but `_release` hasn't cleared the key yet) and
    requeues it. That requeue is NOT a genuine execution attempt, so it must
    restore `attempts`; otherwise every benign scheduling collision silently
    eats one slot of the `0 < attempts <= max_retries` budget, and an event
    that collided a couple of times gets far fewer real retries than
    configured before `_run_event` gives up and marks it `failed`.
    """
    cfg = _retry_settings(monkeypatch, max_retries=3)
    monkeypatch.setattr("veybot.queue._reap_slot", lambda uid: None)
    # Skip the 0.5s anti-spin sleep the collision path takes.
    async def _no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr("veybot.queue.asyncio.sleep", _no_sleep)
    pool = WorkerPool(
        settings=cfg,
        db=db,
        github=_StubGitHub(),  # type: ignore[arg-type]
        sandbox=_StubSandbox(),  # type: ignore[arg-type]
        git_transport=_StubGitTransport(),  # type: ignore[arg-type]
        slot_pool=SlotPool([2001]),
    )
    key = issue_key("octo/widget", 1)
    _record(db)
    # Simulate the same issue already inflight (DB terminal, key not yet cleared).
    pool._inflight.add(key)

    row = await pool._claim_next_unique()
    assert row is None, "collision must requeue rather than dispatch"
    ev = db.get_event("d1")
    assert ev is not None and ev.state == "queued"
    # The spurious claim's attempts increment must have been rolled back.
    assert ev.attempts == 0, f"collision burned retry budget: attempts={ev.attempts}"


@pytest.mark.asyncio
async def test_run_event_clears_stale_cancel_for_reused_delivery(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch, db: Database
) -> None:
    """A stale `_cancelled` entry from a prior run of a reused delivery id must
    not kill a fresh run. `_run_event` clears the slate at start, so the new run
    completes normally instead of being marked `failed`/"cancelled by operator"."""
    cfg = _retry_settings(monkeypatch, max_retries=1)
    monkeypatch.setattr("veybot.queue._reap_slot", lambda uid: None)
    pool = WorkerPool(
        settings=cfg,
        db=db,
        github=_StubGitHub(),  # type: ignore[arg-type]
        sandbox=_StubSandbox(),  # type: ignore[arg-type]
        git_transport=_StubGitTransport(),  # type: ignore[arg-type]
        slot_pool=SlotPool([2001]),
    )

    async def ok(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr(pool, "_dispatch", ok)
    _record(db)  # delivery "d1"
    # Simulate poison left by a cancel that raced a prior run's completion.
    pool._cancelled.add("d1")

    row = db.claim_next_event()
    assert row is not None
    await pool._run_event(row)

    ev = db.get_event("d1")
    assert ev is not None and ev.state == "done", f"stale cancel killed a fresh run: {ev.state if ev else None}"
    assert "d1" not in pool._cancelled
