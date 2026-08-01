"""Coverage for the directive prompt assembly."""

from __future__ import annotations

from dataclasses import dataclass

from veybot import persona
from veybot.worker import DirectiveInfo, ThreadMessage


@dataclass(slots=True, frozen=True)
class _Repo:
    full_name: str = "octo/widget"
    default_branch: str = "main"
    clone_url: str = ""
    private: bool = False


@dataclass(slots=True, frozen=True)
class _Issue:
    repo: str = "octo/widget"
    number: int = 1080
    title: str = "broken thing"
    body: str = "the body text"
    state: str = "open"
    author: str = "alice"
    labels: tuple[str, ...] = ()
    is_pull_request: bool = False


@dataclass(slots=True, frozen=True)
class _Workspace:
    branch: str = "farm/abc/test"
    session_dir: str = "/tmp/session"
    context_dir: str = "/tmp/ctx"
    repo_dir: str = "/tmp/repo"


@dataclass(slots=True, frozen=True)
class _Pr:
    number: int = 99
    author: str = "alice"
    head_ref: str = "fix-crash"
    base_ref: str = "main"
    head_repo: str = "alice/widget"
    html_url: str = "https://github.com/octo/widget/pull/99"


@dataclass(slots=True, frozen=True)
class _Comment:
    id: int = 1
    author: str = "can1357"
    body: str = "@veybot please fix"
    created_at: str = "2026-05-14T20:00:00Z"


def test_render_thread_empty_yields_placeholder() -> None:
    assert persona._render_thread(()).startswith("(no prior")


def test_render_thread_orders_kinds_with_appropriate_headers() -> None:
    thread = (
        ThreadMessage(kind="issue_body", author="alice", body="orig report", created_at=""),
        ThreadMessage(kind="comment", author="bob", body="me too", created_at="2026-05-01T10:00:00Z"),
        ThreadMessage(
            kind="review_comment",
            author="codex",
            body="leak here",
            created_at="2026-05-02T10:00:00Z",
            path="src/foo.py",
            line=42,
        ),
        ThreadMessage(
            kind="review",
            author="codex",
            body="two issues",
            created_at="2026-05-02T10:01:00Z",
            state="CHANGES_REQUESTED",
        ),
    )
    out = persona._render_thread(thread)
    # Issue body header (no timestamp).
    assert "### @alice — issue body" in out
    assert "orig report" in out
    # Comment header with timestamp.
    assert "### @bob — comment *(2026-05-01T10:00:00Z)*" in out
    assert "me too" in out
    # Review comment with file:line anchor.
    assert "### @codex — review comment on `src/foo.py`:L42" in out
    assert "leak here" in out
    # Review with state badge.
    assert "### @codex — review (CHANGES_REQUESTED)" in out
    assert "two issues" in out


def test_directive_prompt_embeds_thread_and_directive_body() -> None:
    thread = (
        ThreadMessage(kind="comment", author="alice", body="follow up please", created_at="2026-05-01T10:00:00Z"),
    )
    out = persona.directive(
        repo=_Repo(),
        issue=_Issue(),
        comment=_Comment(),
        workspace=_Workspace(),
        directive=DirectiveInfo(body="apply fix Y", author="can1357", thread=thread),
        pr_status="PR #1080 is open",
    )
    assert "Directive on octo/widget#1080" in out
    assert "@can1357" in out
    assert "apply fix Y" in out
    assert "follow up please" in out
    assert "PR #1080 is open" in out


def test_followup_comment_prompt_embeds_thread_context() -> None:
    thread = (
        ThreadMessage(kind="pr_body", author="veybot", body="PR body", created_at=""),
        ThreadMessage(kind="comment", author="can1357", body="prior request", created_at="2026-05-01T10:00:00Z"),
    )
    out = persona.followup_comment(
        repo=_Repo(),
        issue=_Issue(),
        comment=_Comment(body="current request"),
        workspace=_Workspace(),
        pr_status="PR #1080 is open",
        pr_number=1080,
        thread=thread,
    )

    assert "Prior conversation" in out
    assert "PR body" in out
    assert "prior request" in out
    assert "current request" in out


def test_kickoff_directive_prompt_embeds_thread_and_classify_instruction() -> None:
    thread = (ThreadMessage(kind="issue_body", author="alice", body="failing on macos", created_at=""),)
    out = persona.kickoff_directive(
        repo=_Repo(),
        issue=_Issue(),
        workspace=_Workspace(),
        directive=DirectiveInfo(body="reproduce + fix", author="can1357", thread=thread),
    )
    assert "Maintainer directive on octo/widget#1080" in out
    assert "failing on macos" in out
    assert "reproduce + fix" in out
    # The kickoff variant must still tell the agent to classify first.
    assert "Classify first" in out


def test_resume_triage_renders_branch_and_issue() -> None:
    out = persona.resume_triage(
        repo=_Repo(),
        issue=_Issue(),
        workspace=_Workspace(),
    )
    # Working branch surfaces literally so the agent sees what it's on.
    assert "farm/abc/test" in out
    # Issue identity surfaces with the title.
    assert "octo/widget#1080" in out
    assert "broken thing" in out
    # The prompt instructs the agent to reconcile drift via fetch_issue_thread.
    assert "fetch_issue_thread" in out


def test_kickoff_pr_review_formats_head_repo_and_origin_base() -> None:
    out = persona.kickoff_pr_review(
        repo=_Repo(),
        pr=_Pr(),
        workspace=_Workspace(),
    )
    assert "`fix-crash` from `alice/widget`" in out
    assert "git diff origin/main...HEAD" in out


def test_review_completion_reminder_mentions_submit_only() -> None:
    out = persona.review_completion_reminder(
        repo=_Repo(),
        issue=_Issue(number=99, title="Fix parser"),
        workspace=_Workspace(branch="review/pr-99"),
    )
    assert "submit_pr_review" in out
    assert "gh_open_pr" not in out


def test_completion_reminder_limits_mark_unable_to_reporter_details() -> None:
    out = persona.completion_reminder(
        repo=_Repo(),
        issue=_Issue(),
        workspace=_Workspace(),
    )
    assert "reporter-provided reproduction details" in out
    assert "maintainer input" not in out


def test_system_append_renders_configured_bot_login() -> None:
    out = persona.system_append(
        repo=_Repo(),
        issue=_Issue(),
        workspace=_Workspace(),
        bot_login="Svitter",
    )
    # The hardcoded persona name MUST be replaced by the configured login so
    # the agent self-mentions the account that actually receives webhooks.
    assert "You are **@Svitter**" in out
    assert "**veybot**" not in out


def test_system_append_routes_push_refusal_to_maintainer_comment_only() -> None:
    out = persona.system_append(
        repo=_Repo(),
        issue=_Issue(),
        workspace=_Workspace(),
        bot_login="Svitter",
    )
    assert "Push refused for reasons you cannot resolve? Ask the maintainer via `gh_post_comment`." in out
    assert "or use `mark_unable_to_reproduce`" not in out


def test_system_append_pr_review_renders_configured_bot_login() -> None:
    out = persona.system_append_pr_review(
        repo=_Repo(),
        issue=_Issue(),
        workspace=_Workspace(),
        bot_login="Svitter",
    )
    assert "You are **@Svitter**" in out
    assert "**veybot**" not in out


# ---- upstream-port / CI-repair prompts ----

_PORT_BODY_FIX = "<!-- upstream-port-kind: fix -->\nUpstream merged PR: https://example.invalid/9"
_PORT_BODY_FEATURE = "<!-- upstream-port-kind: clean-feature -->\nUpstream merged PR: https://example.invalid/9"


def test_port_candidate_kind_reads_the_radar_marker() -> None:
    """`scripts/upstream-radar.ts` stamps the kind into the issue body as an
    HTML comment; that marker is the ONLY trustworthy source for the fix/feature
    branch (the issue prose is untrusted evidence). Misreading it hands a fix a
    feature protocol, which has no failing-negative-control requirement."""
    assert persona.port_candidate_kind(_PORT_BODY_FEATURE) == "clean-feature"
    assert persona.port_candidate_kind(_PORT_BODY_FIX) == "fix"
    # A hand-filed tracking issue with no marker must still render, as a fix.
    assert persona.port_candidate_kind("no marker here") == "fix"
    assert persona.port_candidate_kind(None) == "fix"


def test_port_kickoff_fix_and_feature_guidance_actually_differ() -> None:
    """The template engine has no conditionals, so the branch is resolved in
    Python. If both kinds rendered the same block the whole fix/feature
    distinction would be silently inert while still looking wired."""
    fix = persona.kickoff_port_upstream(
        repo=_Repo(), issue=_Issue(body=_PORT_BODY_FIX), workspace=_Workspace(), kind="fix", prior_failure=None
    )
    feature = persona.kickoff_port_upstream(
        repo=_Repo(),
        issue=_Issue(body=_PORT_BODY_FEATURE),
        workspace=_Workspace(),
        kind="clean-feature",
        prior_failure=None,
    )
    assert fix != feature
    # The fix path demands a failing negative control; the feature path demands
    # an off-versus-on differential. Neither may leak into the other.
    assert "negative control" in fix
    assert "off-versus-on differential" not in fix
    assert "off-versus-on differential" in feature


def test_port_kickoff_unknown_kind_falls_back_to_fix_guidance() -> None:
    """A prompt that fails to render loses the whole task, so an unrecognized
    marker must degrade to the stricter path rather than raise."""
    unknown = persona.kickoff_port_upstream(
        repo=_Repo(), issue=_Issue(body=_PORT_BODY_FIX), workspace=_Workspace(), kind="mystery", prior_failure=None
    )
    fix = persona.kickoff_port_upstream(
        repo=_Repo(), issue=_Issue(body=_PORT_BODY_FIX), workspace=_Workspace(), kind="fix", prior_failure=None
    )
    assert unknown == fix


def test_port_kickoff_without_prior_failure_leaves_no_placeholder_text() -> None:
    """`prior_failure_block` is substituted unconditionally. If the empty case
    leaked the raw `{{...}}` token, or the retry heading with nothing under it,
    the agent would read a truncated instruction as its kickoff."""
    out = persona.kickoff_port_upstream(
        repo=_Repo(), issue=_Issue(body=_PORT_BODY_FIX), workspace=_Workspace(), kind="fix", prior_failure=None
    )
    assert "{{" not in out
    assert "}}" not in out
    assert "Previous attempt failed" not in out
    assert "prior_failure" not in out


def test_port_kickoff_with_prior_failure_renders_the_retry_preamble() -> None:
    """The retry needs the previous failure verbatim, above the protocol."""
    out = persona.kickoff_port_upstream(
        repo=_Repo(),
        issue=_Issue(body=_PORT_BODY_FIX),
        workspace=_Workspace(),
        kind="fix",
        prior_failure="GitCommandError: rebase conflict in packages/tui/src/render.ts",
    )
    assert "Previous attempt failed" in out
    assert "rebase conflict in packages/tui/src/render.ts" in out
    assert out.index("Previous attempt failed") < out.index("## Execution protocol")


def test_port_kickoff_caps_a_runaway_prior_failure() -> None:
    """One pathological traceback must not crowd the instructions out of the
    context window; the tail is kept because that is where the cause is."""
    tail = "FINAL LINE: the real cause"
    out = persona.kickoff_port_upstream(
        repo=_Repo(),
        issue=_Issue(body=_PORT_BODY_FIX),
        workspace=_Workspace(),
        kind="fix",
        prior_failure="\n".join(["noise line"] * 20_000) + "\n" + tail,
    )
    assert tail in out
    assert "earlier lines omitted" in out
    assert out.count("noise line") < 20_000


def test_ci_repair_kickoff_renders_failing_checks_as_a_bullet_list() -> None:
    """`_lookup` joins a sequence with ", ", which would collapse the check
    names onto one line under a heading that promises a list. The names are
    what the agent greps the log for, so they must stay individually legible."""
    out = persona.kickoff_ci_repair(
        repo=_Repo(),
        issue=_Issue(),
        workspace=_Workspace(),
        pr_number=90,
        attempt=2,
        max_attempts=3,
        failing=("Lint & type check", "TypeScript tests"),
        log_excerpt="error TS2345: nope",
    )
    assert "- `Lint & type check`\n- `TypeScript tests`" in out
    assert "Lint & type check, TypeScript tests" not in out
    assert "2 of 3" in out
    assert "error TS2345: nope" in out
    assert "{{" not in out


def test_ci_repair_kickoff_caps_a_runaway_log_excerpt() -> None:
    """A CI log is unbounded and untrusted; the prompt keeps its tail only."""
    out = persona.kickoff_ci_repair(
        repo=_Repo(),
        issue=_Issue(),
        workspace=_Workspace(),
        pr_number=90,
        attempt=1,
        max_attempts=3,
        failing=("Tests",),
        log_excerpt="\n".join(["filler"] * 50_000) + "\nAssertionError: expected 3, got 4",
    )
    assert "AssertionError: expected 3, got 4" in out
    assert len(out) < 40_000


def test_ci_repair_exhausted_comment_names_the_attempt_budget() -> None:
    """The hand-off comment is the only signal a human gets that automation
    stopped; without the count it reads as a transient failure to wait out."""
    out = persona.ci_repair_exhausted_comment(attempts=3)
    assert "3" in out
    assert "{{" not in out
