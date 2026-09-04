"""Structural protocol shared by `GitHubClient` and `GitHubProxyClient`.

Callers (worker, host tools, tasks, server, CLI) reference `GitHubBackend`
so they accept either the direct PAT-bearing REST client or the HMAC-RPC
proxy client without changing signatures. Both impls return the same typed
dataclasses (`IssueInfo`, `RepoInfo`, …) defined in `github_client`.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

from veybot.github_client import (
    CheckRunInfo,
    CommentInfo,
    CommitStatusInfo,
    IssueInfo,
    IssueListing,
    PullRequestFileInfo,
    PullRequestInfo,
    PullRequestReviewInfo,
    ReactionInfo,
    RepoInfo,
    ReviewCommentInfo,
    WorkflowRunInfo,
)


class GitHubBackend(Protocol):
    """Methods every caller in veybot uses against GitHub."""

    # ---- reads ----
    async def get_repo(self, repo: str) -> RepoInfo: ...

    async def get_issue(self, repo: str, number: int) -> IssueInfo: ...

    async def list_closing_pull_requests(self, repo: str, number: int) -> tuple[int, ...]: ...

    async def get_pull_request(self, repo: str, number: int) -> PullRequestInfo: ...

    async def list_pr_files(self, repo: str, pr_number: int) -> list[PullRequestFileInfo]: ...

    async def list_issues(
        self,
        repo: str,
        *,
        state: str = "open",
        labels: str | None = None,
        limit: int = 30,
    ) -> IssueListing: ...

    async def list_comments(self, repo: str, number: int) -> list[CommentInfo]: ...

    async def list_review_comments(self, repo: str, pr_number: int) -> list[ReviewCommentInfo]: ...

    async def list_pr_reviews(self, repo: str, pr_number: int) -> list[PullRequestReviewInfo]: ...

    async def get_authenticated_login(self) -> str: ...

    # ---- CI state ----
    # Read-only by construction. There is no merge, auto-merge, approve, or
    # review-submit-approval method on this protocol and there must never be
    # one: a candidate PR is handed to a human, never landed by the bot.
    async def list_check_runs(self, repo: str, sha: str) -> list[CheckRunInfo]: ...

    async def list_commit_statuses(self, repo: str, sha: str) -> list[CommitStatusInfo]: ...

    async def list_workflow_runs_for_sha(self, repo: str, sha: str) -> list[WorkflowRunInfo]: ...

    async def get_failed_job_logs(self, repo: str, run_id: int) -> str: ...

    # ---- writes ----
    async def post_comment(self, repo: str, number: int, body: str) -> CommentInfo: ...

    async def open_pull_request(
        self,
        *,
        repo: str,
        head: str,
        base: str,
        title: str,
        body: str,
        draft: bool = False,
        maintainer_can_modify: bool = True,
    ) -> PullRequestInfo: ...

    async def request_reviewers(
        self,
        *,
        repo: str,
        pr_number: int,
        reviewers: list[str] | None = None,
        team_reviewers: list[str] | None = None,
    ) -> None: ...

    async def add_issue_labels(self, repo: str, number: int, labels: list[str]) -> tuple[str, ...]: ...
    async def remove_issue_label(self, repo: str, number: int, label: str) -> None: ...

    async def submit_pr_review(
        self,
        *,
        repo: str,
        pr_number: int,
        body: str,
        event: str,
        comments: list[Mapping[str, Any]],
    ) -> PullRequestReviewInfo: ...

    async def add_assignees(self, repo: str, number: int, assignees: list[str]) -> None: ...

    async def list_comment_reactions(self, repo: str, comment_id: int) -> tuple[ReactionInfo, ...]: ...

    async def close_issue(self, repo: str, number: int, *, reason: str = "completed") -> None: ...


__all__ = [
    "CheckRunInfo",
    "CommitStatusInfo",
    "GitHubBackend",
    "WorkflowRunInfo",
]
