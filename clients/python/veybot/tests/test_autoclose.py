"""Coverage for `AutocloseScheduler` against in-process fakes."""

from __future__ import annotations

from collections.abc import Iterable

import pytest
from pydantic import SecretStr

from veybot.autoclose import AutocloseScheduler, _utcnow_iso
from veybot.config import Settings
from veybot.db import Database, issue_key
from veybot.github_client import GitHubError, ReactionInfo


def _settings(
    *,
    enabled: bool = True,
    hours: float = 4.0,
    scan: float = 60.0,
    max_retries: int = 5,
    retry_delays: str = "30,120,600",
) -> Settings:
    return Settings.model_construct(
        github_token=None,
        github_webhook_secret=SecretStr("x"),
        bot_login="robveybot",
        git_author_email="bot@example.invalid",
        repo_allowlist_raw="octo/widget",
        gh_proxy_url="http://proxy.invalid",
        gh_proxy_hmac_key=SecretStr("k" * 32),
        question_autoclose_enabled=enabled,
        question_autoclose_hours=hours,
        question_autoclose_scan_seconds=scan,
        question_autoclose_max_retries=max_retries,
        event_retry_delays_raw=retry_delays,
    )


class _FakeGitHub:
    """Minimal GitHubBackend stand-in for the scheduler.

    Only `list_comment_reactions` and `close_issue` are exercised; everything
    else raises so a misuse here surfaces loudly instead of silently.
    """

    def __init__(
        self,
        *,
        reactions: Iterable[ReactionInfo] = (),
        close_error: GitHubError | None = None,
    ) -> None:
        self._reactions = tuple(reactions)
        self._close_error = close_error
        self.close_calls: list[tuple[str, int, str]] = []
        self.reaction_calls: list[tuple[str, int]] = []

    async def list_comment_reactions(self, repo: str, comment_id: int) -> tuple[ReactionInfo, ...]:
        self.reaction_calls.append((repo, comment_id))
        return self._reactions

    async def close_issue(self, repo: str, number: int, *, reason: str = "completed") -> None:
        self.close_calls.append((repo, number, reason))
        if self._close_error is not None:
            raise self._close_error


_KEY = issue_key("octo/widget", 42)


def _seed(db: Database, *, close_at: str = "2000-01-01T00:00:00.000000Z") -> None:
    db.upsert_pending_closure(
        issue_key=_KEY,
        repo="octo/widget",
        number=42,
        comment_id=999,
        issue_author="alice",
        close_at=close_at,
    )


async def test_tick_closes_when_no_author_downvote(db: Database) -> None:
    _seed(db)
    gh = _FakeGitHub()
    sched = AutocloseScheduler(settings=_settings(), db=db, github=gh)
    counts = await sched.tick()
    assert counts == {"closed": 1, "cancelled": 0, "retried": 0, "superseded": 0}
    assert gh.close_calls == [("octo/widget", 42, "completed")]
    row = db.get_pending_closure(_KEY)
    assert row is not None and row.state == "closed"
    assert row.cancel_reason is None


async def test_tick_cancels_when_author_downvotes(db: Database) -> None:
    _seed(db)
    gh = _FakeGitHub(
        reactions=[ReactionInfo(content="-1", user_login="Alice", user_type="User")],
    )
    sched = AutocloseScheduler(settings=_settings(), db=db, github=gh)
    counts = await sched.tick()
    assert counts == {"closed": 0, "cancelled": 1, "retried": 0, "superseded": 0}
    assert gh.close_calls == []
    row = db.get_pending_closure(_KEY)
    assert row is not None and row.state == "cancelled"
    assert row.cancel_reason == "author_downvoted"


async def test_tick_ignores_downvote_from_non_author(db: Database) -> None:
    """Watchers / drive-by 👎 from anyone other than the author do not veto."""
    _seed(db)
    gh = _FakeGitHub(
        reactions=[
            ReactionInfo(content="-1", user_login="rando", user_type="User"),
            ReactionInfo(content="-1", user_login="some-bot", user_type="Bot"),
        ],
    )
    sched = AutocloseScheduler(settings=_settings(), db=db, github=gh)
    counts = await sched.tick()
    assert counts == {"closed": 1, "cancelled": 0, "retried": 0, "superseded": 0}
    assert gh.close_calls == [("octo/widget", 42, "completed")]


async def test_tick_retries_after_transient_close_error(db: Database) -> None:
    _seed(db)
    gh = _FakeGitHub(close_error=GitHubError(502, "Bad Gateway"))
    sched = AutocloseScheduler(settings=_settings(), db=db, github=gh)
    counts = await sched.tick()
    assert counts == {"closed": 0, "cancelled": 0, "retried": 1, "superseded": 0}
    row = db.get_pending_closure(_KEY)
    # Failed attempt resets the row to `pending` so the next tick claims it again.
    assert row is not None and row.state == "pending"


async def test_tick_backoff_advances_close_at_so_row_not_immediately_due(db: Database) -> None:
    """A transient close failure must push `close_at` into the future and bump
    `attempts`. Pre-fix `requeue_claimed_closure` left both untouched, so the
    row's `close_at` stayed in the past and the next tick re-claimed it every
    scan interval — an unbounded GitHub hammer with no backoff."""
    _seed(db, close_at="2000-01-01T00:00:00.000000Z")
    gh = _FakeGitHub(close_error=GitHubError(502, "Bad Gateway"))
    sched = AutocloseScheduler(settings=_settings(), db=db, github=gh)
    await sched.tick()
    row = db.get_pending_closure(_KEY)
    assert row is not None and row.state == "pending"
    assert row.attempts == 1
    # The 30,120,600 backoff (min ~24s after jitter) must land close_at in the
    # future, NOT leave it at 2000 where the row is instantly re-claimable.
    assert row.close_at > _utcnow_iso()


async def test_tick_abandons_close_after_retry_budget_exhausted(db: Database) -> None:
    """A permanently-failing close must be bounded: retried up to the cap then
    finalized `cancelled`/`close_failed`, never re-claimed forever. Pre-fix the
    row was re-claimed on every tick with no attempt counter, so this loop would
    never terminate (close_calls would grow without bound)."""
    _seed(db)
    gh = _FakeGitHub(close_error=GitHubError(403, "Forbidden"))
    # Zero backoff keeps each retry immediately due, so the cap is exercised
    # deterministically without sleeping.
    sched = AutocloseScheduler(settings=_settings(max_retries=3, retry_delays="0"), db=db, github=gh)

    for _ in range(25):  # far more than the cap; a correct impl terminates well before this
        row = db.get_pending_closure(_KEY)
        if row is None or row.state in ("closed", "cancelled"):
            break
        await sched.tick()

    row = db.get_pending_closure(_KEY)
    assert row is not None
    assert row.state == "cancelled"
    assert row.cancel_reason == "close_failed"
    # 1 initial attempt + max_retries(3) retries == 4 bounded close attempts.
    assert len(gh.close_calls) == 4, gh.close_calls


async def test_tick_reaction_failures_also_bounded(db: Database) -> None:
    """The `list_comment_reactions` failure path shares the same retry budget,
    so a persistently-failing reactions fetch is abandoned too (never an
    infinite reaction-fetch hammer)."""
    _seed(db)

    class _ReactBoom(_FakeGitHub):
        async def list_comment_reactions(self, repo, comment_id):
            self.reaction_calls.append((repo, comment_id))
            raise GitHubError(500, "Internal Server Error")

    gh = _ReactBoom()
    sched = AutocloseScheduler(settings=_settings(max_retries=2, retry_delays="0"), db=db, github=gh)

    for _ in range(25):
        row = db.get_pending_closure(_KEY)
        if row is None or row.state in ("closed", "cancelled"):
            break
        await sched.tick()

    row = db.get_pending_closure(_KEY)
    assert row is not None and row.state == "cancelled"
    assert row.cancel_reason == "close_failed"
    # close_issue is never reached when reactions fail first.
    assert gh.close_calls == []
    # 1 initial + max_retries(2) == 3 bounded reaction fetches.
    assert len(gh.reaction_calls) == 3, gh.reaction_calls


async def test_tick_treats_404_close_as_already_closed(db: Database) -> None:
    _seed(db)
    gh = _FakeGitHub(close_error=GitHubError(404, "Not Found"))
    sched = AutocloseScheduler(settings=_settings(), db=db, github=gh)
    counts = await sched.tick()
    assert counts == {"closed": 0, "cancelled": 1, "retried": 0, "superseded": 0}
    row = db.get_pending_closure(_KEY)
    assert row is not None and row.state == "cancelled"
    assert row.cancel_reason == "already_closed"


async def test_tick_retries_when_list_reactions_fails(db: Database) -> None:
    _seed(db)

    class _ReactBoom(_FakeGitHub):
        async def list_comment_reactions(self, repo, comment_id):
            raise GitHubError(503, "Service Unavailable")

    gh = _ReactBoom()
    sched = AutocloseScheduler(settings=_settings(), db=db, github=gh)
    counts = await sched.tick()
    assert counts == {"closed": 0, "cancelled": 0, "retried": 1, "superseded": 0}
    row = db.get_pending_closure(_KEY)
    assert row is not None and row.state == "pending"


async def test_tick_abandons_close_when_fresh_answer_supersedes_claim(db: Database) -> None:
    """A fresh bot answer (`upsert_pending_closure`) that lands after the tick
    claims the row but before the GitHub close must revoke the claim: the issue
    must NOT be closed, and the newly-scheduled close must survive intact.

    The reactions fetch sits exactly in the claim→close window, so rescheduling
    from inside it reproduces the race deterministically. Pre-fix `_process_row`
    closed the issue anyway and the unguarded `finalize_closure` clobbered the
    fresh `pending` schedule to `closed` — auto-closing an issue the bot had just
    re-answered and destroying its multi-hour grace window."""
    _seed(db)

    class _RescheduleMidTick(_FakeGitHub):
        def __init__(self, database: Database, **kwargs: object) -> None:
            super().__init__(**kwargs)  # type: ignore[arg-type]
            self._database = database

        async def list_comment_reactions(self, repo: str, comment_id: int):
            out = await super().list_comment_reactions(repo, comment_id)
            # Fresh answer arrives while the tick holds the claim: reschedule far
            # out with a new watched comment. This flips `claimed -> pending`.
            self._database.upsert_pending_closure(
                issue_key=_KEY,
                repo="octo/widget",
                number=42,
                comment_id=1234,
                issue_author="alice",
                close_at="2999-01-01T00:00:00.000000Z",
            )
            return out

    gh = _RescheduleMidTick(db)
    sched = AutocloseScheduler(settings=_settings(), db=db, github=gh)
    counts = await sched.tick()

    # The issue must not have been closed on GitHub.
    assert gh.close_calls == []
    assert counts["closed"] == 0
    assert counts["superseded"] == 1
    # The freshly scheduled close survives, untouched by the abandoned tick.
    row = db.get_pending_closure(_KEY)
    assert row is not None
    assert row.state == "pending"
    assert row.comment_id == 1234
    assert row.close_at == "2999-01-01T00:00:00.000000Z"


async def test_tick_skips_future_rows(db: Database) -> None:
    """A row whose `close_at` is in the future stays pending."""
    _seed(db, close_at="2999-01-01T00:00:00.000000Z")
    gh = _FakeGitHub()
    sched = AutocloseScheduler(settings=_settings(), db=db, github=gh)
    counts = await sched.tick()
    assert counts == {"closed": 0, "cancelled": 0, "retried": 0, "superseded": 0}
    assert gh.close_calls == []
    row = db.get_pending_closure(_KEY)
    assert row is not None and row.state == "pending"


def test_scheduler_disabled_when_feature_off() -> None:
    sched = AutocloseScheduler(
        settings=_settings(enabled=False),
        db=None,  # type: ignore[arg-type]
        github=None,  # type: ignore[arg-type]
    )
    assert not sched.enabled


def test_scheduler_disabled_when_hours_zero() -> None:
    sched = AutocloseScheduler(
        settings=_settings(hours=0.0),
        db=None,  # type: ignore[arg-type]
        github=None,  # type: ignore[arg-type]
    )
    assert not sched.enabled


@pytest.mark.asyncio
async def test_start_is_noop_when_disabled(db: Database) -> None:
    sched = AutocloseScheduler(
        settings=_settings(enabled=False),
        db=db,
        github=_FakeGitHub(),
    )
    await sched.start()
    # No background task should have been created.
    assert sched._task is None  # type: ignore[attr-defined]
    await sched.stop()  # idempotent
