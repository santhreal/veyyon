"""Async worker pool draining the durable sqlite event queue."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import traceback
from collections.abc import Callable
from contextlib import suppress

from veybot import tasks
from veybot.cancellation import clear_current_event, set_current_event
from veybot.config import Settings
from veybot.db import Database, EventRow
from veybot.github_backend import GitHubBackend
from veybot.sandbox import GitTransport, SandboxManager, _reap_slot
from veybot.slot_pool import SlotPool

log = logging.getLogger(__name__)

# Backoff between dispatch-loop iterations after an unexpected failure; keeps a
# persistently broken dependency (e.g. the DB) loud without hot-spinning.
_DISPATCH_RETRY_SECONDS = 5.0

# How long the dispatch loop waits for a wakeup before re-polling an idle queue.
_IDLE_POLL_SECONDS = 10.0


class WorkerPool:
    """Long-lived dispatcher: drains queued events into per-task coroutines."""

    def __init__(
        self,
        *,
        settings: Settings,
        db: Database,
        github: GitHubBackend,
        sandbox: SandboxManager,
        git_transport: GitTransport,
        slot_pool: SlotPool | None = None,
    ) -> None:
        self.settings = settings
        self.db = db
        self.github = github
        self.sandbox = sandbox
        self.git_transport = git_transport
        self._workers: list[asyncio.Task[None]] = []
        self._wakeup = asyncio.Event()
        self._stop = asyncio.Event()
        self._slot_pool: SlotPool | None
        self._semaphore: asyncio.Semaphore | None
        if slot_pool is not None:
            self._slot_pool = slot_pool
            self._semaphore = None
        elif os.geteuid() == 0:
            self._slot_pool = SlotPool(range(2001, 2001 + settings.max_concurrency))
            self._semaphore = None
        else:
            self._slot_pool = None
            self._semaphore = asyncio.Semaphore(settings.max_concurrency)
        self._inflight: set[str] = set()
        self._inflight_lock = asyncio.Lock()
        # Cancellation: workers register a stop hook via the contextvar helpers
        # in this module; the API surface fires them on demand.
        #
        # `_arm_cancel`/`_disarm_cancel` run on a WORKER THREAD (they are
        # reached through `asyncio.to_thread` in cancellation.py), while
        # `cancel_event`/`stop()`/`_run_event`'s finally run on the EVENT LOOP
        # thread. All three sets/dicts below are therefore shared across
        # threads. A plain "GIL-safe single-key op" is NOT enough: the
        # check-then-store in `_arm_cancel` would interleave with the
        # add-then-pop in `cancel_event`, leaving a hook stored-but-never-fired
        # (the veyyon subprocess then runs to completion despite the cancel).
        # `_cancel_lock` (a threading.Lock, not asyncio — it must be held from
        # both the loop and worker threads) makes each arm/cancel/disarm/reap
        # of this state atomic. Hooks are always FIRED outside the lock so a
        # blocking subprocess kill never stalls the event loop.
        self._cancel_lock = threading.Lock()
        self._cancel_hooks: dict[str, Callable[[], None]] = {}
        self._cancelled: set[str] = set()
        # Phase B (graceful shutdown): track each spawned `_run_event` task so
        # `stop()` can drain in-flight work, and a flag the exception path
        # checks to avoid marking shutdown-interrupted rows as `failed` (we
        # want them to stay `running` so `reset_stuck_running()` requeues
        # them on next start; the agent then resumes via `--continue`).
        self._inflight_tasks: dict[asyncio.Task[None], str] = {}
        self._shutting_down: bool = False
        # Deliveries whose `_run_event` we deliberately interrupted via
        # `stop()` (either by firing the registered cancel hook or by
        # cancelling the asyncio task itself). The exception path uses
        # this — NOT `_shutting_down` — to decide whether to suppress
        # `mark_event(..., 'failed')`. Without this distinction, an
        # unrelated dispatch failure during the drain window would be
        # silently masked and requeued as if nothing went wrong.
        self._shutdown_cancelled: set[str] = set()

    def wake(self) -> None:
        """Signal that new work is available."""
        self._wakeup.set()

    async def inflight_snapshot(self) -> list[str]:
        """Return a stable, sorted snapshot of currently in-flight issue keys."""
        async with self._inflight_lock:
            return sorted(self._inflight)

    async def _reap_all_slots(self) -> None:
        if self._slot_pool is None:
            return
        await asyncio.gather(*(asyncio.to_thread(_reap_slot, uid) for uid in self._slot_pool.slot_uids))

    async def start(self) -> None:
        await self._reap_all_slots()
        recovered = self.db.reset_stuck_running()
        if recovered:
            log.info("recovered stuck events", extra={"count": recovered})
        # Single dispatcher loop is simpler than N workers; concurrency is gated by the slot pool.
        self._workers.append(asyncio.create_task(self._dispatch_loop(), name="veybot-dispatch"))
        # Periodic natives-cache GC, if enabled. Sleep-first so a freshly
        # restarted orchestrator doesn't burn CPU on a cold cache.
        if self.sandbox.natives_cache is not None and self.settings.natives_cache_gc_interval_seconds > 0:
            self._workers.append(asyncio.create_task(self._natives_cache_gc_loop(), name="veybot-natives-gc"))

    async def stop(self, *, drain_timeout: float = 25.0, kill_timeout: float = 5.0) -> None:
        """Halt the dispatcher, then drain (or kill) in-flight `_run_event` tasks.

        Cleanly interrupted tasks intentionally leave their DB row in
        `running` so the next `WorkerPool.start()` re-queues them via
        `reset_stuck_running()`. The resumed veyyon session then picks up via
        `--continue` from the persisted JSONL transcript.
        """
        self._shutting_down = True
        self._stop.set()
        self._wakeup.set()
        # 1. Halt the dispatcher (no new claims).
        for worker in self._workers:
            worker.cancel()
        for worker in self._workers:
            with suppress(asyncio.CancelledError):
                await worker
        self._workers.clear()
        # 2. Give in-flight tasks a chance to drain.
        pending = list(self._inflight_tasks)
        if not pending:
            return
        log.info("draining in-flight tasks", extra={"count": len(pending), "timeout": drain_timeout})
        _, still_running = await asyncio.wait(pending, timeout=drain_timeout)
        if not still_running:
            return
        # 3. Time's up — for every still-running task: fire its cancel hook
        #    if one was registered (kills the veyyon subprocess); otherwise
        #    cancel the asyncio task itself so a worker stuck pre-hook
        #    (e.g. waiting on the slot pool or inside RpcClient.__enter__)
        #    cannot proceed to spawn a fresh subprocess after stop()
        #    returns. Either way we record the delivery id in
        #    `_shutdown_cancelled` so `_run_event`'s exception path
        #    suppresses `mark_event(..., 'failed')` for that row only.
        log.warning("shutdown timeout; interrupting in-flight tasks", extra={"count": len(still_running)})
        for task in still_running:
            delivery_id = self._inflight_tasks.get(task)
            if delivery_id is None:
                # Task was already finalizing; nothing left to interrupt.
                task.cancel()
                continue
            # Mark + claim the hook atomically w.r.t. a worker still racing to
            # arm one via `_arm_cancel`: either we pop the armed hook here, or
            # the worker sees `_shutdown_cancelled` under the lock and fires
            # immediately. Never both, never neither.
            with self._cancel_lock:
                self._shutdown_cancelled.add(delivery_id)
                hook = self._cancel_hooks.pop(delivery_id, None)
            if hook is not None:
                try:
                    await asyncio.to_thread(hook)
                except Exception:
                    log.exception("shutdown hook raised", extra={"delivery": delivery_id})
                continue
            # No hook armed yet — the worker hasn't reached the veyyon spawn
            # point. Cancel the asyncio task directly so its body cannot
            # run past stop().
            task.cancel()
        # 4. Brief wait for the exception path / cancellation to settle.
        with suppress(TimeoutError):
            await asyncio.wait(still_running, timeout=kill_timeout)

    async def _natives_cache_gc_loop(self) -> None:
        """Periodic sweep over every per-repo cache directory.

        Each iteration sleeps the configured interval first, then runs the
        synchronous GC on a worker thread. Cancellation is the only exit;
        any per-sweep failure is logged and the loop continues.
        """
        cache = self.sandbox.natives_cache
        if cache is None:  # pragma: no cover — checked by caller
            return
        interval = self.settings.natives_cache_gc_interval_seconds
        log.info("natives_cache gc loop online", extra={"interval": interval})
        try:
            while not self._stop.is_set():
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=interval)
                    return  # stop was set during the wait
                except TimeoutError:
                    pass
                try:
                    evicted = await asyncio.to_thread(cache.gc)
                    if evicted:
                        log.info("natives_cache gc swept", extra={"evicted": evicted})
                except Exception:
                    log.exception("natives_cache gc raised")
        except asyncio.CancelledError:
            raise

    async def _dispatch_loop(self) -> None:
        log.info("dispatch loop online")
        while not self._stop.is_set():
            # Recover per iteration: a transient failure (DB hiccup, spawn
            # error) must not kill the loop — a dead dispatcher leaves the
            # webhook server enqueueing into a queue nobody drains.
            try:
                row = await self._claim_next_unique()
                if row is None:
                    self._wakeup.clear()
                    try:
                        await asyncio.wait_for(self._wakeup.wait(), timeout=_IDLE_POLL_SECONDS)
                    except TimeoutError:
                        pass
                    continue
                # Schedule the task; the slot pool caps concurrent execution.
                task = asyncio.create_task(self._run_event(row), name=f"veybot-event-{row.delivery_id[:8]}")
                self._inflight_tasks[task] = row.delivery_id
                task.add_done_callback(lambda t: self._inflight_tasks.pop(t, None))
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("dispatch iteration failed; retrying in %ss", _DISPATCH_RETRY_SECONDS)
                with suppress(TimeoutError):
                    await asyncio.wait_for(self._stop.wait(), timeout=_DISPATCH_RETRY_SECONDS)

    async def _claim_next_unique(self) -> EventRow | None:
        """Claim the next event whose issue isn't already inflight."""
        # The DB layer doesn't filter by issue_key; we peek then guard with a set.
        async with self._inflight_lock:
            # Naive but fine for v1 (small queue).
            row = await asyncio.to_thread(self.db.claim_next_event)
            if row is None:
                return None
            key = row.issue_key or row.delivery_id
            if key in self._inflight:
                # Put it back; another in-flight task is touching the same issue.
                # This claim never dispatched, so roll back its attempts bump —
                # otherwise the collision eats a real retry slot.
                await asyncio.to_thread(
                    lambda: self.db.requeue_event(
                        row.delivery_id, from_states=("running",), restore_attempt=True
                    )
                )
                # Sleep briefly so we don't spin.
                await asyncio.sleep(0.5)
                return None
            self._inflight.add(key)
        return row

    async def _release(self, row: EventRow) -> None:
        key = row.issue_key or row.delivery_id
        async with self._inflight_lock:
            self._inflight.discard(key)

    def _arm_cancel(self, delivery_id: str, hook: Callable[[], None]) -> None:
        """Worker-side: install the cancel hook.

        If cancellation (operator `cancel_event` OR a `stop()` shutdown
        interrupt) was already requested before the worker reached this point,
        fire the hook immediately instead of storing it, so the signal is never
        lost. The check-and-store is done under `_cancel_lock` so it cannot
        interleave with the add-and-pop in `cancel_event`/`stop()` running on
        the loop thread; the hook itself is fired outside the lock.
        """
        with self._cancel_lock:
            fire_now = delivery_id in self._cancelled or delivery_id in self._shutdown_cancelled
            if not fire_now:
                self._cancel_hooks[delivery_id] = hook
        if fire_now:
            try:
                hook()
            except Exception:
                log.exception("late cancel fire failed", extra={"delivery": delivery_id})

    def _disarm_cancel(self, delivery_id: str) -> None:
        """Worker-side: clear the cancel hook (the resource is gone)."""
        with self._cancel_lock:
            self._cancel_hooks.pop(delivery_id, None)

    async def cancel_event(self, delivery_id: str) -> bool:
        """Request cancellation of a running event. Returns whether a hook fired.

        Marks the delivery as cancelled regardless of whether a worker is
        currently armed, so a late-armed hook still observes the request. The
        worker thread's exception path is what eventually transitions the row
        to `failed` with a cancellation marker.

        A cancel that races a delivery's completion (the API checks the DB row
        is `running`, but that check and this call straddle an `await`) can
        leave a stale `_cancelled` entry. That is made harmless by `_run_event`
        clearing the slate at the start of every run — critical because manual
        triage reuses stable `manual-<repo>-<n>` delivery ids, so without that
        clear a stale entry would kill a later re-run of the same issue.
        """
        with self._cancel_lock:
            self._cancelled.add(delivery_id)
            hook = self._cancel_hooks.pop(delivery_id, None)
        if hook is None:
            return False
        # `hook` typically kills a subprocess; run it off the loop so its wait()
        # doesn't stall the event loop for up to the veyyon shutdown grace period.
        try:
            await asyncio.to_thread(hook)
        except Exception:
            log.exception("cancel hook raised", extra={"delivery": delivery_id})
        return True

    async def _run_event(self, row: EventRow) -> None:
        token = set_current_event(self, row.delivery_id)
        # A fresh run must begin with a clean operator-cancel slate: a delivery
        # id can be reused (manual triage reinserts a stable `manual-<repo>-<n>`
        # id), and a cancel that raced a prior run's completion may have left a
        # stale `_cancelled` entry. Clearing it here — before any hook can be
        # armed to observe it — stops that stale entry from killing this run.
        # `_shutdown_cancelled` is intentionally NOT cleared: it is only added by
        # stop() to tasks already past this point, is per-process (a re-run after
        # restart starts with an empty set), and clearing it would race the drain.
        with self._cancel_lock:
            self._cancelled.discard(row.delivery_id)
        slot_uid: int | None = None
        slot_acquired = False
        try:
            if self._slot_pool is not None:
                slot_uid = await self._slot_pool.acquire()
                slot_acquired = True
                await self._dispatch_and_mark(row, slot_uid=slot_uid)
            elif self._semaphore is not None:
                async with self._semaphore:
                    await self._dispatch_and_mark(row)
            else:
                await self._dispatch_and_mark(row)
        except Exception as exc:
            if row.delivery_id in self._shutdown_cancelled:
                # `stop()` deliberately interrupted this delivery —
                # leave the row in `running` so `reset_stuck_running()`
                # flips it back to `queued` on the next start and the
                # resumed veyyon session picks up via `--continue`.
                # Other exceptions during the drain window (which
                # would also see `_shutting_down=True`) MUST still
                # mark the row failed; otherwise a genuine bug gets
                # silently requeued.
                log.info(
                    "event interrupted by shutdown",
                    extra={"delivery": row.delivery_id, "key": row.issue_key},
                )
            elif row.delivery_id in self._cancelled:
                log.info("event cancelled", extra={"delivery": row.delivery_id})
                self.db.mark_event(row.delivery_id, "failed", error="cancelled by operator")
            else:
                tb = traceback.format_exc(limit=20)
                err = f"{exc}\n{tb}"
                max_retries = self.settings.event_max_retries
                delay = self.settings.retry_delay_seconds(row.attempts)
                if 0 < row.attempts <= max_retries and self.db.schedule_retry(
                    row.delivery_id, delay_seconds=delay, error=err
                ):
                    log.warning(
                        "event retry scheduled",
                        extra={
                            "delivery": row.delivery_id,
                            "key": row.issue_key,
                            "attempt": row.attempts,
                            "max_retries": max_retries,
                            "retry_in_seconds": round(delay, 1),
                        },
                    )
                else:
                    log.exception("event handler failed", extra={"delivery": row.delivery_id})
                    self.db.mark_event(row.delivery_id, "failed", error=err)
        finally:
            with self._cancel_lock:
                self._cancelled.discard(row.delivery_id)
                self._shutdown_cancelled.discard(row.delivery_id)
                self._cancel_hooks.pop(row.delivery_id, None)
            if slot_acquired and self._slot_pool is not None:
                try:
                    _reap_slot(slot_uid)
                finally:
                    self._slot_pool.release(slot_uid)
            await self._release(row)
            clear_current_event(token)

    async def _dispatch_and_mark(self, row: EventRow, *, slot_uid: int | None = None) -> None:
        await self._dispatch(row, slot_uid=slot_uid)
        if row.delivery_id in self._cancelled:
            self.db.mark_event(row.delivery_id, "failed", error="cancelled by operator")
        else:
            self.db.mark_event(row.delivery_id, "done")

    async def _dispatch(self, row: EventRow, *, slot_uid: int | None = None) -> None:
        event = row.event_type
        action = str(row.payload.get("action") or "")
        log.info(
            "dispatch",
            extra={
                "event": event,
                "action": action,
                "delivery": row.delivery_id,
                "key": row.issue_key,
                "attempts": row.attempts,
                "recovered": row.attempts >= 2,
            },
        )
        if event == "issues" and action == "opened":
            await tasks.triage_issue(
                settings=self.settings,
                db=self.db,
                github=self.github,
                sandbox=self.sandbox,
                git_transport=self.git_transport,
                payload=row.payload,
                delivery_id=row.delivery_id,
                attempts=row.attempts,
                slot_uid=slot_uid,
            )
        elif event == "issue_comment" and action == "created":
            issue = row.payload.get("issue") or {}
            if "pull_request" in issue:
                await tasks.handle_pr_conversation(
                    settings=self.settings,
                    db=self.db,
                    github=self.github,
                    sandbox=self.sandbox,
                    git_transport=self.git_transport,
                    payload=row.payload,
                    delivery_id=row.delivery_id,
                    attempts=row.attempts,
                    slot_uid=slot_uid,
                )
            else:
                await tasks.handle_comment(
                    settings=self.settings,
                    db=self.db,
                    github=self.github,
                    sandbox=self.sandbox,
                    git_transport=self.git_transport,
                    payload=row.payload,
                    delivery_id=row.delivery_id,
                    attempts=row.attempts,
                    slot_uid=slot_uid,
                )
        elif event == "pull_request" and action in ("opened", "reopened", "ready_for_review"):
            await tasks.review_pr(
                settings=self.settings,
                db=self.db,
                github=self.github,
                sandbox=self.sandbox,
                git_transport=self.git_transport,
                payload=row.payload,
                delivery_id=row.delivery_id,
                attempts=row.attempts,
                slot_uid=slot_uid,
            )
        elif event == "pull_request_review_comment" and action == "created":
            await tasks.handle_review(
                settings=self.settings,
                db=self.db,
                github=self.github,
                sandbox=self.sandbox,
                git_transport=self.git_transport,
                payload=row.payload,
                delivery_id=row.delivery_id,
                attempts=row.attempts,
                slot_uid=slot_uid,
            )
        elif event == "issues" and action == "closed":
            await tasks.cleanup_workspace(
                settings=self.settings,
                db=self.db,
                sandbox=self.sandbox,
                payload=row.payload,
                target_state="closed",
            )
        elif event == "pull_request" and action == "closed":
            pr = row.payload.get("pull_request") or {}
            target_state = "merged" if bool(pr.get("merged")) else "closed"
            await tasks.cleanup_workspace(
                settings=self.settings,
                db=self.db,
                sandbox=self.sandbox,
                payload=row.payload,
                target_state=target_state,
            )
        else:
            log.info("no-op dispatch", extra={"event": event, "action": action})


__all__ = ["WorkerPool"]
