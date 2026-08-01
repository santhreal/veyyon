"""Pure reduction of a commit's CI records into one verdict.

No IO. Everything here is a function of the records `GitHubBackend` already
fetched, so the CI-repair task can be reasoned about (and tested) without a
network. The only judgement calls encoded here:

* an unknown terminal state is a failure, never a pass;
* a superseded run never speaks for its check name;
* a commit with no checks at all is not green.

Each of those exists because the opposite reading would hand a human an
unverified candidate PR and call it reviewed.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from veybot.github_client import IGNORED_CHECK_CONCLUSIONS, PASSING_CHECK_CONCLUSIONS

if TYPE_CHECKING:
    from veybot.github_client import CheckRunInfo, CommitStatusInfo


@dataclass(slots=True, frozen=True)
class CheckSummary:
    """One commit's CI state, collapsed to counts plus the names that failed.

    `total` counts distinct signals that carry a verdict: one per check-run
    name after de-duplication, plus every legacy status context that no check
    run already speaks for. Runs GitHub marked `stale` are in none of the
    counts — they were superseded before reporting.
    """

    total: int
    pending: int
    failing: tuple[str, ...]
    succeeded: int


# The oldest possible instant, used as the sort key for a record whose
# `started_at` is missing or unparseable. Timezone-aware so it never collides
# with the aware timestamps GitHub sends.
_EPOCH = datetime.min.replace(tzinfo=UTC)


def _started_at_key(started_at: str | None) -> datetime:
    if not started_at:
        return _EPOCH
    try:
        parsed = datetime.fromisoformat(started_at)
    except ValueError:
        return _EPOCH
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _run_is_pending(run: CheckRunInfo) -> bool:
    """A run that has not reached `completed` has not reported yet.

    `queued` and `in_progress` are the documented values, but anything that is
    not literally `completed` is treated the same way: it has no conclusion to
    trust.
    """
    return run.status != "completed"


def summarize_checks(
    runs: Sequence[CheckRunInfo],
    statuses: Sequence[CommitStatusInfo],
) -> CheckSummary:
    """Collapse the Checks API and legacy-status views of one commit.

    De-duplicates check runs by `name`, keeping the newest record. GitHub
    returns a rerun as a separate row alongside the attempt it replaced, so
    without this a fixed job still reads as failing and the repair agent gets
    sent after a job that is already green. Recency is `started_at` (parsed as
    a datetime, not string-compared), then `id`, then position in `runs`.

    A legacy status whose `context` matches a check-run name that already
    counted is dropped: it is the same signal reported twice.
    """
    latest: dict[str, tuple[tuple[datetime, int, int], CheckRunInfo]] = {}
    order: list[str] = []
    for index, run in enumerate(runs):
        rank = (_started_at_key(run.started_at), run.id, index)
        prior = latest.get(run.name)
        if prior is None:
            order.append(run.name)
            latest[run.name] = (rank, run)
        elif rank > prior[0]:
            latest[run.name] = (rank, run)

    total = 0
    pending = 0
    succeeded = 0
    failing: list[str] = []
    counted: set[str] = set()

    for name in order:
        run = latest[name][1]
        if not _run_is_pending(run) and run.conclusion in IGNORED_CHECK_CONCLUSIONS:
            continue
        counted.add(name)
        total += 1
        if _run_is_pending(run):
            pending += 1
        elif run.conclusion in PASSING_CHECK_CONCLUSIONS:
            succeeded += 1
        else:
            # Every other completed conclusion — `failure`, `timed_out`,
            # `action_required`, `cancelled`, and anything GitHub adds later
            # such as `startup_failure`. Guessing "pass" for a state we do not
            # recognize is how a red build reaches a reviewer as green.
            failing.append(name)

    seen_contexts: set[str] = set()
    for status in statuses:
        if status.context in counted or status.context in seen_contexts:
            continue
        seen_contexts.add(status.context)
        total += 1
        if status.state == "pending":
            pending += 1
        elif status.state == "success":
            succeeded += 1
        else:
            failing.append(status.context)

    return CheckSummary(total=total, pending=pending, failing=tuple(failing), succeeded=succeeded)


def is_green(summary: CheckSummary) -> bool:
    """Whether the commit is safe to describe to a human as passing.

    `total == 0` is deliberately not green. A pull request whose workflows
    never started has proved nothing, and calling it green would hand over an
    unverified candidate under a passing label.
    """
    return summary.total > 0 and summary.pending == 0 and not summary.failing


_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]")
"""CSI sequences plus the two-byte escapes runners emit for cursor moves."""

_LOG_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ")
"""The ISO-8601 stamp the Actions log API prefixes to every single line."""


def trim_failure_log(raw: str, max_chars: int = 12000) -> str:
    """Reduce a job log to the tail an agent can actually read.

    Keeps the LAST `max_chars`, cut at a line boundary, because a failure's
    explanation is at the end of the log, not the start. When anything was
    dropped the result opens with `[... N earlier lines omitted ...]` so the
    reader knows the head is missing rather than assuming the job began here.

    Each line is stripped of ANSI escapes and of the per-line ISO-8601 stamp
    the Actions log API prepends; both are pure noise that would otherwise eat
    a large share of the agent's context window. A log that is already short
    and already clean comes back byte-identical.
    """
    lines = raw.split("\n")
    cleaned = "\n".join(_LOG_TIMESTAMP_RE.sub("", _ANSI_RE.sub("", line)) for line in lines)
    if len(cleaned) <= max_chars:
        return cleaned

    # Slice by computed offset rather than `cleaned[-max_chars:]`: a
    # `max_chars` of 0 would make the negative form return the whole string.
    start = max(0, len(cleaned) - max_chars)
    tail = cleaned[start:]
    boundary = tail.find("\n")
    if boundary != -1:
        tail = tail[boundary + 1 :]
    omitted = cleaned[: len(cleaned) - len(tail)].count("\n")
    return f"[... {omitted} earlier lines omitted ...]\n{tail}"


__all__ = ["CheckSummary", "is_green", "summarize_checks", "trim_failure_log"]
