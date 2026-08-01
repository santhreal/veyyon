"""Typed webhook payload parsing + dispatch routing."""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from veybot.db import issue_key
from veybot.pragmas import parse_pragmas

log = logging.getLogger(__name__)

Decision = Literal["queue", "skip"]


@dataclass(slots=True, frozen=True)
class RouteDecision:
    decision: Decision
    task: str | None
    repo: str | None
    issue_key: str | None
    reason: str
    submitter: str | None = None
    association: str | None = None
    directive: bool = False
    directive_body: str | None = None
    directive_author: str | None = None
    directive_pragmas: tuple[tuple[str, str], ...] = ()
    directive_authorizes_impl: bool = False

    @property
    def should_queue(self) -> bool:
        return self.decision == "queue"


def verify_signature(secret: str, body: bytes, signature_header: str | None) -> bool:
    """Constant-time HMAC-SHA256 verification of `X-Hub-Signature-256`."""
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    provided = signature_header.removeprefix("sha256=")
    return hmac.compare_digest(expected, provided)


def _repo_full_name(payload: Mapping[str, Any]) -> str | None:
    repo = payload.get("repository")
    if isinstance(repo, dict):
        full = repo.get("full_name")
        if isinstance(full, str):
            return full
    return None


def _normalize_bot_login(login: str | None) -> str:
    if not isinstance(login, str):
        return ""
    cleaned = login.strip().removeprefix("@")
    if cleaned.lower().endswith("[bot]"):
        cleaned = cleaned[:-5]
    return cleaned.lower()


def _login_matches_bot(login: str | None, bot_login: str) -> bool:
    normalized_login = _normalize_bot_login(login)
    return bool(normalized_login) and normalized_login == _normalize_bot_login(bot_login)


def _login_matches_personal_repo_owner(
    login: str | None,
    repository: Mapping[str, Any] | None,
    repo: str | None,
) -> bool:
    """Return whether `login` owns this personal-account repository."""
    if not isinstance(login, str) or not login:
        return False
    owner_login: str | None = None
    owner_type: str | None = None
    if isinstance(repository, Mapping):
        owner = repository.get("owner")
        if isinstance(owner, Mapping):
            raw_login = owner.get("login")
            if isinstance(raw_login, str) and raw_login:
                owner_login = raw_login
            raw_type = owner.get("type")
            if isinstance(raw_type, str) and raw_type:
                owner_type = raw_type
    if owner_type is None or owner_type.lower() != "user":
        return False
    if not owner_login:
        return False
    return login.lower() == owner_login.lower()


def _effective_association(
    login: str | None,
    association: str | None,
    repository: Mapping[str, Any] | None,
    repo: str | None,
) -> str | None:
    if association:
        return association
    if _login_matches_personal_repo_owner(login, repository, repo):
        return "OWNER"
    return association


PrIssueResolver = Callable[[str, int], str | None] | None


def _is_bot_account(user: Mapping[str, Any] | None, bot_login: str) -> bool:
    if not isinstance(user, Mapping):
        return False
    login = str(user.get("login") or "")
    if not login:
        return False
    if _login_matches_bot(login, bot_login):
        return True
    if login.lower().endswith("[bot]"):
        return True
    if str(user.get("type") or "") == "Bot":
        return True
    return False


def _submitter_info(obj: Mapping[str, Any] | None) -> tuple[str | None, str | None]:
    """Extract `(login, author_association)` from an issue/comment object."""
    if not isinstance(obj, Mapping):
        return None, None
    user = obj.get("user")
    login: str | None = None
    if isinstance(user, Mapping):
        raw = user.get("login")
        if isinstance(raw, str) and raw:
            login = raw
    assoc = obj.get("author_association")
    return login, (str(assoc) if isinstance(assoc, str) and assoc else None)


def extract_mention(body: str | None, bot_login: str) -> str | None:
    """Return `body` with `@<bot_login>` mentions stripped, or None if no mention.

    Match is case-insensitive and word-boundary aware (hyphens in logins are
    part of the token, so `@robveybot` does NOT match `@robveybot-extra`).
    """
    if not isinstance(body, str) or not body:
        return None
    login = _normalize_bot_login(bot_login)
    if not login:
        return None
    pattern = re.compile(
        rf"(?<![A-Za-z0-9_-])@{re.escape(login)}(?:\[bot\](?![A-Za-z0-9_-])|(?![A-Za-z0-9_\[-]))",
        re.IGNORECASE,
    )
    if not pattern.search(body):
        return None
    stripped = pattern.sub("", body)
    # Collapse the whitespace the strip leaves behind without mangling the rest.
    stripped = re.sub(r"[ \t]+", " ", stripped)
    stripped = re.sub(r"\n[ \t]+", "\n", stripped)
    return stripped.strip()


def is_maintainer(
    login: str | None,
    association: str | None,
    *,
    maintainers: frozenset[str],
) -> bool:
    """A maintainer is anyone in `maintainers` or with a trusted association."""
    if isinstance(login, str) and login and login.lower() in maintainers:
        return True
    if isinstance(association, str) and association.upper() in TRUSTED_ASSOCIATIONS:
        return True
    return False


def is_implementation_authorizer(
    login: str | None,
    association: str | None,
    *,
    maintainers: frozenset[str],
) -> bool:
    """Return whether this author may authorize implementation work."""
    if isinstance(login, str) and login and login.lower() in maintainers:
        return True
    if isinstance(association, str) and association.upper() == "OWNER":
        return True
    return False


FAILING_CHECK_CONCLUSIONS: frozenset[str] = frozenset({"failure", "timed_out", "action_required", "startup_failure"})
"""`check_suite.conclusion` values that mean the candidate PR is red.

`cancelled`, `neutral`, `skipped`, `stale` and `success` are NOT failures: a
cancelled or superseded run says nothing about the code, and repairing on one
would burn an attempt against a suite that never finished judging.
"""


def _issue_label_names(payload: Mapping[str, Any]) -> tuple[str, ...]:
    """Label names on the payload's issue, tolerating every malformed shape.

    This is the only place `route` reads labels, and it runs on the webhook
    request path: a `TypeError` here would 500 the endpoint and take every
    other event down with it. Anything unexpected degrades to "no labels".
    Bare strings are accepted alongside GitHub's `{"name": ...}` objects so a
    synthesized backlog payload does not have to imitate the wire format.
    """
    issue = payload.get("issue")
    if not isinstance(issue, Mapping):
        return ()
    raw = issue.get("labels")
    if not isinstance(raw, (list, tuple)):
        return ()
    names: list[str] = []
    for entry in raw:
        name = entry.get("name") if isinstance(entry, Mapping) else entry
        if isinstance(name, str) and name:
            names.append(name)
    return tuple(names)


def _added_label_name(payload: Mapping[str, Any]) -> str | None:
    """The label an `issues.labeled` event just added, or None."""
    label = payload.get("label")
    if not isinstance(label, Mapping):
        return None
    name = label.get("name")
    return name if isinstance(name, str) and name else None


def is_port_upstream_event(payload: Mapping[str, Any], *, port_label: str) -> bool:
    """Whether this `issues` payload designates upstream-port work.

    `route` asks this to pick the task; `queue.WorkerPool._dispatch` asks it
    again to pick the handler off the stored EventRow, because the dispatcher
    re-derives from `(event_type, action)` and never sees the `RouteDecision`.
    They MUST agree — if they drift, a tracking issue gets triaged as an
    ordinary bug report — so both call this and nothing else.

    The label arrives two ways: the radar files the issue already labeled
    (`issues.opened` carries it in `issue.labels`), and a human may add it
    later (`issues.labeled` carries it in `label.name`).
    """
    if not port_label:
        return False
    action = str(payload.get("action") or "")
    if action == "opened":
        return port_label in _issue_label_names(payload)
    if action == "labeled":
        return _added_label_name(payload) == port_label
    return False


def _check_suite_bot_authored(suite: Mapping[str, Any], pr: Mapping[str, Any], bot_login: str) -> bool:
    """Whether the branch this check suite ran on belongs to the bot.

    Repairing a suite we did not author would push commits onto a
    contributor's branch nobody asked us to touch, so this fails closed.
    A `check_suite` payload carries no PR author: the usable signal is
    `head_commit.author`, which for a candidate branch is the identity veybot
    commits under. `pull_requests[].user` is checked too because replayed and
    synthesized payloads sometimes carry it.
    """
    user = pr.get("user")
    if isinstance(user, Mapping):
        return _is_bot_account(user, bot_login) or _login_matches_bot(str(user.get("login") or ""), bot_login)
    head_commit = suite.get("head_commit")
    if not isinstance(head_commit, Mapping):
        return False
    author = head_commit.get("author")
    if not isinstance(author, Mapping):
        return False
    if _is_bot_account(author, bot_login):
        return True
    for field in ("login", "username", "name"):
        if _login_matches_bot(str(author.get(field) or ""), bot_login):
            return True
    return False


def _pr_review_pr(pr: Mapping[str, Any], repo: str, action: str, bot_login: str) -> RouteDecision:
    """Build a `review_pr` decision for an incoming PR, or the matching skip."""
    if str(pr.get("state") or "open") != "open":
        return RouteDecision("skip", None, repo, None, "PR not open")
    if bool(pr.get("draft")):
        return RouteDecision("skip", None, repo, None, "draft PR")
    if _is_bot_account(pr.get("user") or {}, bot_login):
        return RouteDecision("skip", None, repo, None, "bot-authored PR")
    number = pr.get("number")
    if not isinstance(number, int):
        return RouteDecision("skip", None, repo, None, "PR missing number")
    login, assoc = _submitter_info(pr)
    return RouteDecision(
        "queue",
        "review_pr",
        repo,
        issue_key(repo, number),
        f"pull_request.{action}",
        submitter=login,
        association=assoc,
    )


def route(
    event_type: str,
    payload: Mapping[str, Any],
    *,
    allowlist: frozenset[str],
    bot_login: str,
    maintainers: frozenset[str] = frozenset(),
    reviewer_bots: frozenset[str] = frozenset(),
    resolve_issue_from_pr: PrIssueResolver = None,
    port_upstream_enabled: bool = True,
    port_label: str = "upstream-port",
    ci_repair_enabled: bool = True,
    pr_review_enabled: bool = True,
) -> RouteDecision:
    """Decide whether and how to handle a webhook event.

    `resolve_issue_from_pr(repo, pr_number)` maps a PR number back to its
    originating-issue key (e.g. `octo/widget#42`). PR-derived events prefer
    that key so follow-ups serialize with the original issue. If the mapping
    is missing, the event is still actionable and falls back to the PR's own
    issue key (`octo/widget#1080`).
    """
    repo = _repo_full_name(payload)
    if repo is None or repo.lower() not in allowlist:
        return RouteDecision("skip", None, repo, None, "repo not on allowlist")

    action = str(payload.get("action") or "")

    def _resolve_pr_key(pr_number: int) -> str:
        if resolve_issue_from_pr is not None:
            resolved = resolve_issue_from_pr(repo, pr_number)  # type: ignore[arg-type]
            if resolved:
                return resolved
        return issue_key(repo, pr_number)  # type: ignore[arg-type]

    def _reviewer_bot_login(user: Mapping[str, Any] | None) -> str | None:
        """Return the normalized login if this user is a configured reviewer bot."""
        if not isinstance(user, Mapping):
            return None
        raw_login = str(user.get("login") or "").lower()
        if not raw_login:
            return None
        login = raw_login.removesuffix("[bot]")
        if login in reviewer_bots:
            return login
        return raw_login if raw_login in reviewer_bots else None

    def _directive_kwargs(comment: Mapping[str, Any] | None, login: str | None, assoc: str | None) -> dict[str, Any]:
        """Decide whether this comment is a directive (reviewer-bot OR maintainer-mention)."""
        if not isinstance(comment, Mapping):
            return {}
        body = str(comment.get("body") or "")
        rb_login = _reviewer_bot_login(comment.get("user"))
        if rb_login is not None:
            # Reviewer bots like chatgpt-codex-connector speak authoritatively
            # already — no `@bot` mention required; pass the full body through.
            cleaned, pragmas = parse_pragmas(body)
            return {
                "directive": True,
                "directive_body": cleaned,
                "directive_author": rb_login,
                "directive_pragmas": pragmas,
                "directive_authorizes_impl": False,
            }
        if not is_maintainer(login, assoc, maintainers=maintainers):
            return {}
        stripped = extract_mention(body, bot_login)
        if stripped is None:
            return {}
        cleaned, pragmas = parse_pragmas(stripped)
        authorizes_impl = is_implementation_authorizer(login, assoc, maintainers=maintainers)
        return {
            "directive": True,
            "directive_body": cleaned,
            "directive_author": login,
            "directive_pragmas": pragmas,
            "directive_authorizes_impl": authorizes_impl,
        }

    if event_type == "issues":
        issue = payload.get("issue") or {}
        if "pull_request" in issue:
            return RouteDecision("skip", None, repo, None, "issue is a pull request")
        number = issue.get("number")
        if not isinstance(number, int):
            return RouteDecision("skip", None, repo, None, "issue missing number")
        key = issue_key(repo, number)
        # The upstream-port label reaches us two ways: the radar files the
        # issue already labeled, and a human may add the label afterwards.
        # Both land on `port_upstream`, and a labeled issue must NEVER fall
        # through to `triage_issue` — a port candidate is not a bug report.
        is_port = is_port_upstream_event(payload, port_label=port_label)
        if action == "opened":
            if is_port:
                if not port_upstream_enabled:
                    return RouteDecision("skip", None, repo, key, "upstream port disabled")
                # Backlog drain, not a user submission: no rate-limit subject,
                # or 200 tracking issues would throttle against one filer.
                return RouteDecision("queue", "port_upstream", repo, key, f"issues.opened [{port_label}]")
            login, assoc = _submitter_info(issue)
            assoc = _effective_association(login, assoc, payload.get("repository"), repo)
            return RouteDecision(
                "queue", "triage_issue", repo, key, "issues.opened", submitter=login, association=assoc
            )
        if action == "labeled":
            if not is_port:
                return RouteDecision("skip", None, repo, key, "issues.labeled with unrelated label")
            if not port_upstream_enabled:
                return RouteDecision("skip", None, repo, key, "upstream port disabled")
            return RouteDecision("queue", "port_upstream", repo, key, f"issues.labeled [{port_label}]")
        if action == "closed":
            # Cleanup is a lifecycle event, not a user submission; no rate-limit subject.
            return RouteDecision("queue", "cleanup_workspace", repo, key, "issues.closed")
        return RouteDecision("skip", None, repo, key, f"issues.{action} ignored")

    if event_type == "issue_comment" and action == "created":
        comment = payload.get("comment") or {}
        rb_login = _reviewer_bot_login(comment.get("user"))
        if rb_login is None and _is_bot_account(comment.get("user"), bot_login):
            return RouteDecision("skip", None, repo, None, "bot/self comment")
        issue = payload.get("issue") or {}
        number = issue.get("number")
        if not isinstance(number, int):
            return RouteDecision("skip", None, repo, None, "comment missing issue number")
        if "pull_request" in issue:
            # Conversation comments on incoming contributor PRs are intentionally
            # ignored for now: the one-shot review runs on open, and re-review
            # directives are not wired yet. Only bot-authored PRs resume a live
            # amend-and-push workflow.
            key = _resolve_pr_key(number)
            login, assoc = _submitter_info(comment)
            assoc = _effective_association(login, assoc, payload.get("repository"), repo)
            issue_user_raw = issue.get("user")
            issue_user = issue_user_raw if isinstance(issue_user_raw, Mapping) else {}
            if _login_matches_bot(str(issue_user.get("login") or ""), bot_login):
                return RouteDecision(
                    "queue",
                    "handle_pr_conversation",
                    repo,
                    key,
                    f"issue_comment.created on PR #{number}",
                    submitter=login,
                    association=assoc,
                    **_directive_kwargs(comment, login, assoc),
                )
            return RouteDecision("skip", None, repo, issue_key(repo, number), "incoming PR comments ignored")
        key = issue_key(repo, number)
        login, assoc = _submitter_info(comment)
        assoc = _effective_association(login, assoc, payload.get("repository"), repo)
        return RouteDecision(
            "queue",
            "handle_comment",
            repo,
            key,
            "issue_comment.created",
            submitter=login,
            association=assoc,
            **_directive_kwargs(comment, login, assoc),
        )

    if event_type == "pull_request" and action in ("opened", "reopened", "ready_for_review"):
        if not pr_review_enabled:
            return RouteDecision("skip", None, repo, None, "PR review disabled")
        pr = payload.get("pull_request") or {}
        return _pr_review_pr(pr, repo, action, bot_login)

    if event_type == "pull_request_review_comment" and action == "created":
        comment = payload.get("comment") or {}
        rb_login = _reviewer_bot_login(comment.get("user"))
        if rb_login is None and _is_bot_account(comment.get("user"), bot_login):
            return RouteDecision("skip", None, repo, None, "bot/self review comment")
        pr = payload.get("pull_request") or {}
        pr_user = pr.get("user") or {}
        if not _login_matches_bot(str(pr_user.get("login") or ""), bot_login):
            return RouteDecision("skip", None, repo, None, "PR not authored by bot")
        number = pr.get("number")
        if not isinstance(number, int):
            return RouteDecision("skip", None, repo, None, "PR missing number")
        key = _resolve_pr_key(number)
        login, assoc = _submitter_info(comment)
        assoc = _effective_association(login, assoc, payload.get("repository"), repo)
        return RouteDecision(
            "queue",
            "handle_review",
            repo,
            key,
            "pull_request_review_comment.created",
            submitter=login,
            association=assoc,
            **_directive_kwargs(comment, login, assoc),
        )

    if event_type == "pull_request" and action == "closed":
        pr = payload.get("pull_request") or {}
        number = pr.get("number")
        if not isinstance(number, int):
            return RouteDecision("skip", None, repo, None, "PR missing number")
        reason = "pull_request.merged" if bool(pr.get("merged")) else "pull_request.closed"
        return RouteDecision("queue", "cleanup_workspace", repo, _resolve_pr_key(number), reason)

    if event_type == "check_suite" and action == "completed":
        if not ci_repair_enabled:
            return RouteDecision("skip", None, repo, None, "CI repair disabled")
        suite = payload.get("check_suite")
        if not isinstance(suite, Mapping):
            return RouteDecision("skip", None, repo, None, "check_suite payload has no suite")
        conclusion = str(suite.get("conclusion") or "")
        if conclusion not in FAILING_CHECK_CONCLUSIONS:
            return RouteDecision(
                "skip", None, repo, None, f"check_suite conclusion {conclusion or '(none)'} is not a failure"
            )
        raw_prs = suite.get("pull_requests")
        prs = raw_prs if isinstance(raw_prs, (list, tuple)) else ()
        pr = prs[0] if prs and isinstance(prs[0], Mapping) else None
        if pr is None:
            return RouteDecision("skip", None, repo, None, "check_suite has no pull requests")
        number = pr.get("number")
        if not isinstance(number, int):
            return RouteDecision("skip", None, repo, None, "check_suite PR missing number")
        if not _check_suite_bot_authored(suite, pr, bot_login):
            return RouteDecision("skip", None, repo, None, f"check_suite PR #{number} not authored by bot")
        # No `_resolve_pr_key` fallback here: that invents `repo#<pr>` for a PR
        # we have no row for, and a repair needs the real tracking issue to
        # count its attempts against and to reuse the candidate's workspace.
        key = resolve_issue_from_pr(repo, number) if resolve_issue_from_pr is not None else None
        if not key:
            return RouteDecision("skip", None, repo, None, f"check_suite PR #{number} maps to no tracked issue")
        # Lifecycle event, not a user submission: no rate-limit subject, same
        # as `cleanup_workspace`.
        return RouteDecision("queue", "ci_repair", repo, key, f"check_suite.completed {conclusion} on PR #{number}")

    return RouteDecision("skip", None, repo, None, f"{event_type}.{action} not handled")


TRUSTED_ASSOCIATIONS: frozenset[str] = frozenset({"OWNER", "MEMBER", "COLLABORATOR"})
"""GitHub `author_association` values that bypass per-user rate limiting."""


def rate_limit_cap(
    login: str,
    association: str | None,
    *,
    unlimited: frozenset[str],
    default: int,
    contributor: int,
) -> int | None:
    """Return the per-window submission cap for a submitter, or `None` for unlimited.

    Precedence: explicit `unlimited` allowlist > trusted GitHub association
    (`OWNER`/`MEMBER`/`COLLABORATOR`) > `CONTRIBUTOR` tier > default tier.
    """
    if login.lower() in unlimited:
        return None
    if association:
        upper = association.upper()
        if upper in TRUSTED_ASSOCIATIONS:
            return None
        if upper == "CONTRIBUTOR":
            return contributor
    return default


__all__ = [
    "Decision",
    "FAILING_CHECK_CONCLUSIONS",
    "RouteDecision",
    "TRUSTED_ASSOCIATIONS",
    "extract_mention",
    "is_maintainer",
    "is_implementation_authorizer",
    "is_port_upstream_event",
    "rate_limit_cap",
    "route",
    "verify_signature",
]
