"""Pure CI-verdict reduction: every rule that decides red vs green vs unknown."""

from __future__ import annotations

from veybot.ci_state import CheckSummary, is_green, summarize_checks, trim_failure_log
from veybot.github_client import CheckRunInfo, CommitStatusInfo


def _run(
    name: str,
    *,
    status: str = "completed",
    conclusion: str | None = "success",
    started_at: str | None = "2026-01-01T00:00:00Z",
    run_id: int = 1,
) -> CheckRunInfo:
    return CheckRunInfo(
        name=name,
        status=status,
        conclusion=conclusion,
        started_at=started_at,
        id=run_id,
        details_url=None,
    )


# ---------------------------------------------------------------------------
# status / conclusion classification
# ---------------------------------------------------------------------------


def test_incomplete_run_counts_as_pending() -> None:
    """A run that has not reached `completed` has reported nothing yet.

    Locks out reading `conclusion is None` on an in-flight run as "no failure",
    which would declare a PR green while its build is still running.
    """
    summary = summarize_checks([_run("build", status="in_progress", conclusion=None)], [])
    assert summary == CheckSummary(total=1, pending=1, failing=(), succeeded=0)
    assert is_green(summary) is False


def test_success_neutral_and_skipped_conclusions_pass() -> None:
    """`neutral` and `skipped` are non-blocking on GitHub and must count as passes.

    Locks out treating "not success" as failure, which would send the repair
    agent after a skipped optional job forever.
    """
    runs = [
        _run("build", conclusion="success", run_id=1),
        _run("docs", conclusion="neutral", run_id=2),
        _run("optional", conclusion="skipped", run_id=3),
    ]
    summary = summarize_checks(runs, [])
    assert summary == CheckSummary(total=3, pending=0, failing=(), succeeded=3)
    assert is_green(summary) is True


def test_blocking_conclusions_count_as_failing() -> None:
    """`failure`, `timed_out`, `action_required` and `cancelled` each fail the commit.

    Locks out narrowing the failure set to `failure` alone, which would report a
    timed-out or cancelled build as passing.
    """
    for conclusion in ("failure", "timed_out", "action_required", "cancelled"):
        summary = summarize_checks([_run("build", conclusion=conclusion)], [])
        assert summary == CheckSummary(total=1, pending=0, failing=("build",), succeeded=0), conclusion
        assert is_green(summary) is False, conclusion


def test_stale_run_is_ignored_entirely() -> None:
    """`stale` means GitHub superseded the run before it reported a verdict.

    Locks out counting it either way: as a failure it would trigger a pointless
    repair, and as a pass it would inflate `succeeded` with a run that never
    finished. It must not appear in `total` at all.
    """
    only_stale = summarize_checks([_run("flaky", conclusion="stale")], [])
    assert only_stale == CheckSummary(total=0, pending=0, failing=(), succeeded=0)
    assert is_green(only_stale) is False

    alongside = summarize_checks(
        [_run("flaky", conclusion="stale", run_id=1), _run("build", conclusion="success", run_id=2)],
        [],
    )
    assert alongside == CheckSummary(total=1, pending=0, failing=(), succeeded=1)


def test_unknown_conclusion_counts_as_failing() -> None:
    """An unrecognized terminal conclusion is a failure, never a pass.

    GitHub adds conclusion values over time (`startup_failure` among them).
    Locks out a default-to-pass fallthrough, which would silently mark a red PR
    green the day GitHub ships a new value.
    """
    summary = summarize_checks([_run("build", conclusion="startup_failure")], [])
    assert summary == CheckSummary(total=1, pending=0, failing=("build",), succeeded=0)
    assert is_green(summary) is False


def test_completed_run_without_conclusion_counts_as_failing() -> None:
    """`completed` with a null conclusion is an unknown terminal state, so it fails.

    Locks out the `conclusion is None -> pending` shortcut, which would leave a
    finished-but-unreadable run stuck as pending forever instead of surfacing it.
    """
    summary = summarize_checks([_run("build", status="completed", conclusion=None)], [])
    assert summary == CheckSummary(total=1, pending=0, failing=("build",), succeeded=0)


# ---------------------------------------------------------------------------
# rerun de-duplication
# ---------------------------------------------------------------------------


def test_rerun_supersedes_earlier_failure_for_same_name() -> None:
    """A rerun is a separate record with the same name; only the newest counts.

    Locks out counting the superseded attempt, which would send the repair agent
    to fix a job that is already green — and would keep it red forever, since no
    amount of fixing deletes the old record.
    """
    older = _run("build", conclusion="failure", started_at="2026-01-01T00:00:00Z", run_id=1)
    newer = _run("build", conclusion="success", started_at="2026-01-01T01:00:00Z", run_id=2)

    summary = summarize_checks([older, newer], [])
    assert summary == CheckSummary(total=1, pending=0, failing=(), succeeded=1)
    assert is_green(summary) is True
    # Recency, not position: GitHub does not promise an order.
    assert summarize_checks([newer, older], []) == summary


def test_rerun_ranked_by_timestamp_not_string_order() -> None:
    """`started_at` is compared as a datetime, not as text.

    Locks out lexicographic comparison, which orders `2026-01-02T09:00:00Z`
    before `2026-01-02T10:00:00+02:00` even though the latter is earlier in
    absolute time — picking the wrong attempt as authoritative.
    """
    earlier_absolute = _run("build", conclusion="failure", started_at="2026-01-02T10:00:00+02:00", run_id=5)
    later_absolute = _run("build", conclusion="success", started_at="2026-01-02T09:00:00Z", run_id=4)
    summary = summarize_checks([earlier_absolute, later_absolute], [])
    assert summary == CheckSummary(total=1, pending=0, failing=(), succeeded=1)


def test_missing_or_unparseable_started_at_ranks_oldest() -> None:
    """A run with no usable `started_at` sorts oldest instead of crashing or winning.

    Locks out two bugs: comparing `None` against a datetime (TypeError, which
    would take down the whole repair task) and letting a timestampless record
    outrank a real one because its `id` happens to be larger.
    """
    for missing in (None, "not-a-timestamp"):
        runs = [
            _run("build", conclusion="success", started_at=missing, run_id=9),
            _run("build", conclusion="failure", started_at="2026-01-01T00:00:00Z", run_id=1),
        ]
        summary = summarize_checks(runs, [])
        assert summary == CheckSummary(total=1, pending=0, failing=("build",), succeeded=0), missing


def test_identical_timestamps_break_ties_on_run_id() -> None:
    """Two attempts stamped the same second are ordered by `id`, not by input order.

    Locks out "last one in the list wins", which makes the verdict depend on
    GitHub's page ordering rather than on which run actually happened later.
    """
    stamp = "2026-01-01T00:00:00Z"
    newer_id_failed = [
        _run("build", conclusion="success", started_at=stamp, run_id=2),
        _run("build", conclusion="failure", started_at=stamp, run_id=7),
    ]
    assert summarize_checks(newer_id_failed, []).failing == ("build",)
    assert summarize_checks(list(reversed(newer_id_failed)), []).failing == ("build",)


# ---------------------------------------------------------------------------
# legacy commit statuses
# ---------------------------------------------------------------------------


def test_legacy_status_duplicating_check_name_is_not_double_counted() -> None:
    """One signal reported through both APIs must count once.

    Locks out inflating `total`/`succeeded` (and, worse, appending a phantom
    failure) when a check run and a legacy status share a name.
    """
    runs = [_run("lint", conclusion="success")]
    statuses = [
        CommitStatusInfo(context="lint", state="success"),
        CommitStatusInfo(context="coverage", state="success"),
    ]
    assert summarize_checks(runs, statuses) == CheckSummary(total=2, pending=0, failing=(), succeeded=2)

    contradicting = [CommitStatusInfo(context="lint", state="failure")]
    assert summarize_checks(runs, contradicting) == CheckSummary(total=1, pending=0, failing=(), succeeded=1)


def test_legacy_status_still_counts_when_its_check_run_was_stale() -> None:
    """A name whose only check run was superseded leaves the status as the
    sole signal for that context.

    Locks out de-duplicating against every check-run name instead of the ones
    that actually contributed: a `stale` run carries no verdict, so dropping
    the status alongside it would leave the commit with zero signals and report
    "nothing ran" in place of the failure the status is reporting.
    """
    summary = summarize_checks(
        [_run("lint", conclusion="stale")],
        [CommitStatusInfo(context="lint", state="failure")],
    )
    assert summary == CheckSummary(total=1, pending=0, failing=("lint",), succeeded=0)


def test_legacy_status_states_map_to_pending_pass_and_fail() -> None:
    """Third-party CI that only posts commit statuses still produces a verdict.

    Locks out ignoring the legacy surface entirely, which would report a commit
    whose only signal is a failing Travis status as having nothing wrong.
    """
    statuses = [
        CommitStatusInfo(context="ci/travis", state="failure"),
        CommitStatusInfo(context="ci/circle", state="pending"),
        CommitStatusInfo(context="ci/appveyor", state="error"),
        CommitStatusInfo(context="ci/jenkins", state="success"),
    ]
    summary = summarize_checks([], statuses)
    assert summary == CheckSummary(
        total=4,
        pending=1,
        failing=("ci/travis", "ci/appveyor"),
        succeeded=1,
    )


# ---------------------------------------------------------------------------
# is_green
# ---------------------------------------------------------------------------


def test_is_green_false_when_no_checks_ran() -> None:
    """A commit with zero signals is not passing.

    Locks out the vacuous-truth reading (`not failing` -> green), which would
    hand a reviewer a candidate PR whose workflows never started and label it
    verified.
    """
    summary = summarize_checks([], [])
    assert summary == CheckSummary(total=0, pending=0, failing=(), succeeded=0)
    assert is_green(summary) is False


def test_is_green_false_while_any_check_is_pending() -> None:
    """Green means every signal reported and every one passed.

    Locks out concluding on a partial picture, which would report a PR green in
    the window before its slowest job finishes.
    """
    summary = summarize_checks(
        [_run("fast", conclusion="success", run_id=1), _run("slow", status="queued", conclusion=None, run_id=2)],
        [],
    )
    assert summary == CheckSummary(total=2, pending=1, failing=(), succeeded=1)
    assert is_green(summary) is False


# ---------------------------------------------------------------------------
# trim_failure_log
# ---------------------------------------------------------------------------


def test_short_clean_log_passes_through_byte_identical() -> None:
    """A log that needs neither cleaning nor trimming comes back unchanged.

    Locks out gratuitous rewriting — a stray added or stripped trailing newline
    changes what the agent reads and breaks byte-level comparisons downstream.
    """
    raw = "step 1\nstep 2\nboom\n"
    assert trim_failure_log(raw) == raw


def test_trim_strips_ansi_and_leading_iso_timestamps() -> None:
    """Runner colour codes and the per-line Actions timestamp are dropped.

    Both are pure noise; at ~30 wasted characters per line they crowd real
    output out of the agent's context window. Locks out passing them through.
    """
    raw = "2026-01-01T00:00:00.1234567Z \x1b[31mFAILED\x1b[0m tests/test_a.py\n2026-01-01T00:00:01Z   assert 1 == 2\n"
    assert trim_failure_log(raw) == "FAILED tests/test_a.py\n  assert 1 == 2\n"


def test_trim_keeps_tail_on_a_line_boundary_and_reports_the_omission() -> None:
    """Truncation keeps the END of the log, cut whole-line, and says so.

    The failure's explanation is at the end, so keeping the head would discard
    exactly the part that matters. Locks out a head-biased cut, a mid-line cut
    that hands the agent a fragment, and a silent one that lets the agent
    believe the job started at the first line it can see.
    """
    raw = "\n".join(f"line {i}" for i in range(1000))
    out = trim_failure_log(raw, max_chars=100)

    header, _, body = out.partition("\n")
    kept = body.count("\n") + 1
    assert header == f"[... {1000 - kept} earlier lines omitted ...]"
    assert len(body) <= 100
    assert body.endswith("line 999")
    # The kept text is a suffix of the input starting right after a newline.
    assert raw.endswith(body)
    assert raw[len(raw) - len(body) - 1] == "\n"


def test_trim_does_not_truncate_when_cleaning_brought_it_under_the_cap() -> None:
    """The cap applies to the cleaned text, not the raw bytes.

    Locks out measuring before stripping, which would drop real output to make
    room for timestamps and escape codes that are about to be deleted anyway.
    """
    line = "2026-01-01T00:00:00.1234567Z payload\n"
    raw = line * 10
    out = trim_failure_log(raw, max_chars=len("payload\n") * 10)
    assert out == "payload\n" * 10
