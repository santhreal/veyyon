"""Coverage for the upstream-port backlog drain and its prompt templates.

The radar issues predate the bot, so `enqueue_port_backlog` is the only path
that ever queues them. Each test here locks out one way the drain could give a
single issue two candidate pull requests, queue more work than the operator
asked for, or hand veyyon a prompt with a silently empty hole in it.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from click.testing import CliRunner

from veybot import cli, persona
from veybot.config import Settings, reset_settings_cache
from veybot.db import get_database, issue_key
from veybot.github_client import IssueInfo, IssueListing, IssueSummary, RepoInfo
from veybot.manual_triage import enqueue_port_backlog, port_backlog_delivery_id

_REPO = "santhreal/veyyon"
_LABEL = "upstream-port"


def _summary(number: int, *, labels: tuple[str, ...] = (_LABEL,)) -> IssueSummary:
    return IssueSummary(
        repo=_REPO,
        number=number,
        title=f"port: upstream #{number}",
        state="open",
        author="santhsecurity",
        labels=labels,
        comments=0,
        updated_at="2026-07-30T00:00:00Z",
        created_at="2026-07-30T00:00:00Z",
        html_url=f"https://github.com/{_REPO}/issues/{number}",
    )


class _FakeGitHub:
    """Hand-written `GitHubBackend` double.

    It records every per-issue fetch so `--dry-run` can prove it made none and
    so a re-run can prove it did not refetch an issue it already queued. It
    also records the `labels` filter and the scan ceiling each drain asked for,
    because filtering server side is what makes a page of results candidates.

    `honor_labels=False` stands in for a backend that dropped the filter, and
    `truncate_at` stands in for a repository deeper than the ceiling.
    """

    def __init__(
        self,
        summaries: list[IssueSummary],
        *,
        repo: str = _REPO,
        honor_labels: bool = True,
        truncate_at: int | None = None,
    ) -> None:
        self.repo = repo
        self.summaries = summaries
        self.honor_labels = honor_labels
        self.truncate_at = truncate_at
        self.issue_fetches: list[int] = []
        self.repo_fetches = 0
        self.label_filters: list[str | None] = []
        self.scan_limits: list[int] = []

    async def list_issues(
        self,
        repo: str,
        *,
        state: str = "open",
        labels: str | None = None,
        limit: int = 30,
    ) -> IssueListing:
        assert repo == self.repo
        assert state == "open"
        self.label_filters.append(labels)
        self.scan_limits.append(limit)
        if labels is None or not self.honor_labels:
            pool = list(self.summaries)
        else:
            pool = [s for s in self.summaries if labels in s.labels]
        ceiling = limit if self.truncate_at is None else min(limit, self.truncate_at)
        return IssueListing(pool[:ceiling], truncated=len(pool) > ceiling)

    async def get_issue(self, repo: str, number: int) -> IssueInfo:
        self.issue_fetches.append(number)
        return IssueInfo(
            repo=repo,
            number=number,
            title=f"port: upstream #{number}",
            body=f"upstream body of {number}",
            state="open",
            author="santhsecurity",
            labels=(_LABEL,),
            is_pull_request=False,
        )

    async def get_repo(self, repo: str) -> RepoInfo:
        self.repo_fetches += 1
        return RepoInfo(
            full_name=repo,
            default_branch="main",
            clone_url=f"https://github.com/{repo}.git",
            private=False,
        )


async def _drain(db, github, *, limit=10, dry_run=False, scan_limit=None):
    kwargs = {} if scan_limit is None else {"scan_limit": scan_limit}
    return await enqueue_port_backlog(
        db=db,
        github=github,
        repo_full=_REPO,
        label=_LABEL,
        limit=limit,
        dry_run=dry_run,
        **kwargs,
    )


# ---- CLI ----

_ALLOWED = "octo/widget"


def _invoke(monkeypatch, github, *args):
    monkeypatch.setattr(cli, "_build_github", lambda _cfg: github)
    return CliRunner().invoke(cli.main, ["port-backlog", *args])


def test_cli_queues_the_backlog_and_reports_a_count(env, monkeypatch) -> None:
    """`veybot port-backlog` is what the operator actually types tonight. An
    unregistered subcommand or a mis-parsed option means the 200 radar issues
    never reach the queue and the daemon idles forever."""
    github = _FakeGitHub([_summary(n) for n in (5, 6, 7)], repo=_ALLOWED)

    result = _invoke(monkeypatch, github, _ALLOWED, "--limit", "2")

    assert result.exit_code == 0, result.output
    assert f"queued {_ALLOWED}#5" in result.output
    assert f"queued {_ALLOWED}#6" in result.output
    assert f"queued {_ALLOWED}#7" not in result.output
    assert f"3 open {_LABEL} issue(s) match; queued 2; 0 already tracked" in result.output

    database = get_database(Settings().sqlite_path)
    assert database.get_event(port_backlog_delivery_id(_ALLOWED, 5)).state == "queued"
    assert database.get_event(port_backlog_delivery_id(_ALLOWED, 7)) is None


def test_cli_reports_the_true_total_when_limit_caps_the_run(env, monkeypatch) -> None:
    """The number queued and the number waiting are different facts, and the
    summary must print both. Reporting `queued 5 of 5` against a 200-issue
    backlog is what made a permanently-stuck drain look finished."""
    github = _FakeGitHub([_summary(n) for n in range(1, 201)], repo=_ALLOWED)

    result = _invoke(monkeypatch, github, _ALLOWED, "--limit", "5")

    assert result.exit_code == 0, result.output
    assert f"200 open {_LABEL} issue(s) match; queued 5; 0 already tracked" in result.output
    assert github.issue_fetches == [1, 2, 3, 4, 5]
    database = get_database(Settings().sqlite_path)
    assert database.get_event(port_backlog_delivery_id(_ALLOWED, 6)) is None


def test_cli_says_so_when_the_scan_ceiling_truncated_the_backlog(env, monkeypatch) -> None:
    """A ceiling that bites must reach the operator. Printing a match count
    derived from a truncated scan as if it were the total is the same silent
    short read the one-page fetch used to produce."""
    github = _FakeGitHub([_summary(n) for n in range(1, 8)], repo=_ALLOWED, truncate_at=3)

    result = _invoke(monkeypatch, github, _ALLOWED, "--limit", "1")

    assert result.exit_code == 0, result.output
    assert f"3 open {_LABEL} issue(s) match; queued 1; 0 already tracked" in result.output
    assert "ceiling" in result.output and "floor" in result.output


def test_cli_dry_run_writes_no_event_row(env, monkeypatch) -> None:
    """`--dry-run` must be safe to point at production. If it wrote rows, the
    operator's look-before-the-leap would itself start two agents."""
    github = _FakeGitHub([_summary(9)], repo=_ALLOWED)

    result = _invoke(monkeypatch, github, _ALLOWED, "--dry-run")

    assert result.exit_code == 0, result.output
    assert f"would queue {_ALLOWED}#9" in result.output
    assert get_database(Settings().sqlite_path).list_events(limit=50) == []


def test_cli_refuses_a_repo_outside_the_allowlist(env, monkeypatch) -> None:
    """`route()` drops events for a repo that is not allowlisted, so queueing
    one here would write rows that can only ever be dropped."""
    github = _FakeGitHub([_summary(1)], repo="evil/repo")

    result = _invoke(monkeypatch, github, "evil/repo")

    assert result.exit_code == 2
    assert "VEYBOT_REPO_ALLOWLIST" in result.output


def test_cli_refuses_when_the_port_kill_switch_is_off(env, monkeypatch) -> None:
    """`VEYBOT_PORT_UPSTREAM_ENABLED=false` turns the whole pipeline off. A
    drain that still queued would fill the table with work the router skips."""
    monkeypatch.setenv("VEYBOT_PORT_UPSTREAM_ENABLED", "false")
    reset_settings_cache()
    github = _FakeGitHub([_summary(1)], repo=_ALLOWED)

    result = _invoke(monkeypatch, github, _ALLOWED)

    assert result.exit_code == 2
    assert "VEYBOT_PORT_UPSTREAM_ENABLED" in result.output


# ---- enqueue ----


async def test_rerun_queues_nothing_new(db) -> None:
    """Two drains of the same backlog must produce one event row per issue.

    The delivery id is derived from the repo and the issue number precisely so
    a second run collides with the first. A run-scoped id would hand every
    issue a second candidate pull request on every invocation.
    """
    github = _FakeGitHub([_summary(n) for n in (11, 12, 13)])

    first = await _drain(db, github)
    assert [entry.number for entry in first.enqueued] == [11, 12, 13]
    assert first.skipped == 0

    second = await _drain(db, github)
    assert second.enqueued == ()
    assert second.skipped == 3
    assert github.issue_fetches == [11, 12, 13]

    states = {n: db.get_event(port_backlog_delivery_id(_REPO, n)).state for n in (11, 12, 13)}
    assert states == {11: "queued", 12: "queued", 13: "queued"}


async def test_row_is_an_issues_labeled_event_carrying_the_issue_body(db) -> None:
    """The synthetic row must look like the webhook it stands in for.

    `queue.WorkerPool._dispatch` re-derives the handler from the event type and
    the payload action, and the port prompt renders `{{issue.body}}`. A row
    missing either lands as an unroutable event or as a candidate written
    against an empty tracking issue.
    """
    github = _FakeGitHub([_summary(42)])
    await _drain(db, github, limit=1)

    row = db.get_event(port_backlog_delivery_id(_REPO, 42))
    assert row.event_type == "issues"
    assert row.repo == _REPO
    assert row.issue_key == issue_key(_REPO, 42)
    assert row.state == "queued"
    assert row.payload["action"] == "labeled"
    assert row.payload["label"]["name"] == _LABEL
    assert row.payload["issue"]["number"] == 42
    assert row.payload["issue"]["body"] == "upstream body of 42"
    assert row.payload["issue"]["labels"] == [{"name": _LABEL}]
    assert row.payload["repository"]["full_name"] == _REPO
    assert row.payload["repository"]["default_branch"] == "main"


async def test_limit_caps_the_rows_one_run_creates(db) -> None:
    """`--limit` bounds the queue depth an operator takes on in one go.

    Two lanes cannot absorb 200 issues at once, and an unbounded drain would
    also spend 200 GitHub fetches before the first candidate exists.
    """
    github = _FakeGitHub([_summary(n) for n in range(1, 6)])

    result = await _drain(db, github, limit=2)

    assert [entry.number for entry in result.enqueued] == [1, 2]
    assert github.issue_fetches == [1, 2]
    assert db.get_event(port_backlog_delivery_id(_REPO, 3)) is None


async def test_limit_counts_only_the_rows_this_run_creates(db) -> None:
    """An already-tracked issue must not spend the run's budget.

    If it did, a backlog whose first ten issues are queued and awaiting review
    would return an empty run forever and the drain would stall.
    """
    github = _FakeGitHub([_summary(n) for n in range(1, 6)])
    await _drain(db, github, limit=2)

    result = await _drain(db, github, limit=2)

    assert [entry.number for entry in result.enqueued] == [3, 4]
    assert result.skipped == 2


async def test_dry_run_writes_nothing_and_fetches_nothing(db) -> None:
    """`--dry-run` is the operator's look before the leap.

    It reports the same selection the real run would queue while leaving the
    events table empty and spending no per-issue API calls.
    """
    github = _FakeGitHub([_summary(n) for n in (7, 8)])

    result = await _drain(db, github, dry_run=True)

    assert [entry.number for entry in result.enqueued] == [7, 8]
    assert github.issue_fetches == []
    assert github.repo_fetches == 0
    assert db.list_events(limit=50) == []


async def test_issue_already_in_the_events_table_is_skipped(db) -> None:
    """A live webhook queues a port issue under GitHub's own delivery id.

    Keying the skip only on the backlog delivery id would miss that row and
    open a second candidate for an issue already being worked.
    """
    db.record_event(
        delivery_id="8f0e1c2a-4d51-4a2b-9d0f-000000000001",
        event_type="issues",
        repo=_REPO,
        issue_key=issue_key(_REPO, 21),
        payload={"action": "labeled"},
    )
    github = _FakeGitHub([_summary(21), _summary(22)])

    result = await _drain(db, github)

    assert [entry.number for entry in result.enqueued] == [22]
    assert result.skipped == 1
    assert db.get_event(port_backlog_delivery_id(_REPO, 21)) is None


async def test_issue_without_the_port_label_is_never_queued(db) -> None:
    """The label is the whole selector, and the drain must re-check it even
    when it asked the backend to filter. A backend that dropped the `labels`
    parameter would otherwise put every open bug report through the port
    workflow, which assumes a tracking issue written by the radar."""
    github = _FakeGitHub(
        [_summary(1, labels=("bug", "prio:p2")), _summary(2)],
        honor_labels=False,
    )

    result = await _drain(db, github)

    assert [entry.number for entry in result.enqueued] == [2]
    assert result.matched == 1


async def test_drain_asks_the_backend_for_the_label(db) -> None:
    """Filtering server side is what makes a page of results candidates. Fetch
    without the label and 100 rows come back holding a handful of port issues,
    which is how 110 of 200 stayed permanently out of reach."""
    github = _FakeGitHub([_summary(1), _summary(2, labels=("bug",))])

    result = await _drain(db, github)

    assert github.label_filters == [_LABEL]
    assert github.scan_limits == [2000]
    assert [entry.number for entry in result.enqueued] == [1]


async def test_limit_bounds_the_rows_not_the_count(db) -> None:
    """`--limit` is the enqueue budget, never the size of the scan. Stopping
    the walk at the budget makes `matched` report the budget back, so a
    200-issue backlog answers "5 of 5" and looks finished."""
    github = _FakeGitHub([_summary(n) for n in range(1, 21)])

    result = await _drain(db, github, limit=5)

    assert len(result.enqueued) == 5
    assert result.matched == 20
    assert result.skipped == 0
    assert result.scan_truncated is False
    assert github.issue_fetches == [1, 2, 3, 4, 5]


async def test_scan_ceiling_is_reported_not_swallowed(db) -> None:
    """A truncated scan must say so. Handing back a match count derived from a
    partial read as though it were the total is the original bug: the drain
    reported 90 of 90 while 110 more issues sat unreachable behind the page."""
    github = _FakeGitHub([_summary(n) for n in range(1, 11)], truncate_at=4)

    result = await _drain(db, github, limit=2, scan_limit=6)

    assert github.scan_limits == [6]
    assert result.scan_truncated is True
    assert result.scan_limit == 6
    assert result.matched == 4
    assert len(result.enqueued) == 2


async def test_nonpositive_scan_limit_is_rejected(db) -> None:
    """A zero ceiling would scan nothing and report an empty backlog, which is
    indistinguishable from a drained one."""
    github = _FakeGitHub([_summary(1)])

    with pytest.raises(ValueError, match="scan_limit must be positive"):
        await _drain(db, github, scan_limit=0)


async def test_nonpositive_limit_is_rejected(db) -> None:
    """`limit=0` must fail loudly. Silently queueing nothing reads as a drained
    backlog to anyone watching the final count."""
    github = _FakeGitHub([_summary(1)])

    with pytest.raises(ValueError, match="limit must be positive"):
        await _drain(db, github, limit=0)


# ---- prompt templates ----

_FIX_GUIDANCE = persona.render(persona._load("port_guidance_fix.md"), {})
_FEATURE_GUIDANCE = persona.render(persona._load("port_guidance_feature.md"), {})
_PRIOR_FAILURE = persona.render(
    persona._load("port_prior_failure.md"),
    {"prior_failure": "negative control passed on unmodified veyyon"},
)


def _port_scope(*, kind_guidance: str, prior_failure_block: str) -> dict[str, object]:
    return {
        "repo": SimpleNamespace(full_name=_REPO, default_branch="main"),
        "issue": SimpleNamespace(number=1234, title="port: gh-4471", body="UPSTREAM-BODY-MARKER"),
        "workspace": SimpleNamespace(branch="farm/deadbeef/port-gh-4471"),
        "kind_guidance": kind_guidance,
        "prior_failure_block": prior_failure_block,
    }


def test_port_kickoff_substitutes_every_variable() -> None:
    """`persona._lookup` renders an unresolvable dotted path as the empty
    string, so a renamed field ships a prompt with a hole and no error. Assert
    the substituted values landed, and that nothing is left unsubstituted.
    """
    out = persona.render(
        persona._load("kickoff_port_upstream.md"),
        _port_scope(kind_guidance=_FIX_GUIDANCE, prior_failure_block=_PRIOR_FAILURE),
    )

    assert "{{" not in out
    assert f"# Upstream port: {_REPO}#1234" in out
    assert "**Title:** port: gh-4471" in out
    assert "`farm/deadbeef/port-gh-4471`" in out
    assert "UPSTREAM-BODY-MARKER" in out
    assert "origin/main" in out
    assert "Closes #1234" in out
    assert "negative control passed on unmodified veyyon" in out


def test_port_kickoff_names_the_four_sections_gh_open_pr_requires() -> None:
    """`host_tools.gh_open_pr` rejects a body missing any of these headers or
    the close keyword. A prompt that asks for other headings would make every
    candidate unpublishable."""
    out = persona.render(
        persona._load("kickoff_port_upstream.md"),
        _port_scope(kind_guidance=_FIX_GUIDANCE, prior_failure_block=""),
    )

    for header in ("## Repro", "## Cause", "## Fix", "## Verification"):
        assert header in out
    assert "Closes #1234" in out


def test_port_kickoff_arms_carry_different_proof_requirements() -> None:
    """The fix arm demands a failing negative control and a reverted-fix
    check; the feature arm demands an off-versus-on differential. Wiring one
    file to both kinds would let a feature ship with no proof at all."""
    fix = persona.render(
        persona._load("kickoff_port_upstream.md"),
        _port_scope(kind_guidance=_FIX_GUIDANCE, prior_failure_block=""),
    )
    feature = persona.render(
        persona._load("kickoff_port_upstream.md"),
        _port_scope(kind_guidance=_FEATURE_GUIDANCE, prior_failure_block=""),
    )

    assert "negative control" in fix
    assert "temporarily reversed" in fix
    assert "off-versus-on differential" not in fix

    assert "off-versus-on differential" in feature
    assert "temporarily reversed" not in feature


def test_port_kickoff_omits_the_prior_failure_block_on_a_first_attempt() -> None:
    """A first attempt renders the block as the empty string. Leaking a
    "Previous attempt failed" heading with nothing under it would tell the
    agent to weigh evidence that does not exist."""
    out = persona.render(
        persona._load("kickoff_port_upstream.md"),
        _port_scope(kind_guidance=_FIX_GUIDANCE, prior_failure_block=""),
    )

    assert "Previous attempt failed" not in out
    assert "## Execution protocol" in out


def test_ci_repair_kickoff_substitutes_every_variable() -> None:
    """Same hole risk as the port kickoff, plus two numbers the agent needs to
    budget its effort: the attempt and the ceiling."""
    out = persona.render(
        persona._load("kickoff_ci_repair.md"),
        {
            "repo": SimpleNamespace(full_name=_REPO),
            "issue": SimpleNamespace(number=1234),
            "pr_number": 4471,
            "workspace": SimpleNamespace(branch="farm/deadbeef/port-gh-4471"),
            "attempt": 2,
            "max_attempts": 3,
            "failing_list": "- `checks / typescript-tests`",
            "log_excerpt": "CI-LOG-MARKER",
        },
    )

    assert "{{" not in out
    assert f"# CI repair: {_REPO}#4471" in out
    assert "**Attempt:** 2 of 3" in out
    assert "- `checks / typescript-tests`" in out
    assert "CI-LOG-MARKER" in out
    assert "`farm/deadbeef/port-gh-4471`" in out


def test_ci_repair_kickoff_forbids_buying_green_by_weakening_a_gate() -> None:
    """The whole point of the repair loop is that it cannot cheat. If the only
    way to pass is to weaken the gate, the prompt must say to stop and report
    rather than push."""
    out = persona.render(
        persona._load("kickoff_ci_repair.md"),
        {
            "repo": SimpleNamespace(full_name=_REPO),
            "issue": SimpleNamespace(number=1),
            "pr_number": 2,
            "workspace": SimpleNamespace(branch="farm/abc/x"),
            "attempt": 3,
            "max_attempts": 3,
            "failing_list": "- `checks / lint`",
            "log_excerpt": "boom",
        },
    )

    assert "If the only way to make the gate pass is to weaken the gate" in out
    assert "NOT MERGED, awaiting human review" in out


def test_every_port_template_is_substitution_only() -> None:
    """`persona.render` implements `{{dotted.path}}` and nothing else. A
    Handlebars section or a raw-output helper survives rendering verbatim and
    reaches the model as literal template syntax."""
    names = (
        "kickoff_port_upstream.md",
        "kickoff_ci_repair.md",
        "port_guidance_fix.md",
        "port_guidance_feature.md",
        "port_prior_failure.md",
    )

    offenders = {name: marker for name in names for marker in ("{{#", "{{&", "{{/") if marker in persona._load(name)}

    assert offenders == {}


def test_seeded_phase_plans_exist_for_both_new_task_kinds() -> None:
    """`persona.seed_phases` returns an empty list for an unknown key, so a
    block appended under the wrong table name would start the task with no
    todo plan and no error."""
    port = persona.seed_phases("port_upstream")
    repair = persona.seed_phases("ci_repair")

    assert [phase["name"] for phase in port] == ["Assess", "Prove", "Port", "Publish"]
    assert [phase["name"] for phase in repair] == ["Diagnose", "Repair", "Report"]
    assert all(phase["tasks"] for phase in port + repair)
