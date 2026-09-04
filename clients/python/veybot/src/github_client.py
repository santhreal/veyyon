"""Minimal typed GitHub REST client (PAT auth, httpx)."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

log = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"
ACCEPT = "application/vnd.github+json"
API_VERSION = "2022-11-28"


class GitHubError(RuntimeError):
    """Raised on non-2xx responses from GitHub."""

    def __init__(self, status: int, message: str, *, retry_after: float | None = None) -> None:
        super().__init__(f"GitHub {status}: {message}")
        self.status = status
        self.message = message
        self.retry_after = retry_after


@dataclass(slots=True, frozen=True)
class IssueInfo:
    repo: str
    number: int
    title: str
    body: str
    state: str
    author: str
    labels: tuple[str, ...]
    is_pull_request: bool


@dataclass(slots=True, frozen=True)
class CommentInfo:
    id: int
    author: str
    body: str
    created_at: str


@dataclass(slots=True, frozen=True)
class RepoInfo:
    full_name: str
    default_branch: str
    clone_url: str
    private: bool


@dataclass(slots=True, frozen=True)
class PullRequestInfo:
    repo: str
    number: int
    html_url: str
    head_ref: str
    base_ref: str
    state: str
    author: str = ""
    head_repo: str = ""
    title: str = ""
    body: str = ""


@dataclass(slots=True, frozen=True)
class PullRequestFileInfo:
    path: str
    status: str
    additions: int
    deletions: int


@dataclass(slots=True, frozen=True)
class ReviewCommentInfo:
    """In-line PR review comment (attached to a file/line)."""

    id: int
    author: str
    body: str
    path: str
    line: int | None
    created_at: str


@dataclass(slots=True, frozen=True)
class PullRequestReviewInfo:
    """Top-level PR review (the summary block, not the inline comments)."""

    id: int
    author: str
    body: str
    state: str  # APPROVED / CHANGES_REQUESTED / COMMENTED
    submitted_at: str


@dataclass(slots=True, frozen=True)
class IssueSummary:
    """Lightweight projection of an issue for list views (no body)."""

    repo: str
    number: int
    title: str
    state: str
    author: str
    labels: tuple[str, ...]
    comments: int
    updated_at: str
    created_at: str
    html_url: str


class IssueListing(list[IssueSummary]):
    """Everything one `list_issues` scan reached, plus whether it saw the end.

    This is a plain list, so every caller that just iterates keeps working. The
    one extra fact is `truncated`: True when the caller's ceiling stopped the
    page walk before GitHub reported a short page. Without that flag a capped
    scan looks exactly like a complete one, which is how a backlog drain comes
    to believe a 200-issue repository holds 90 issues.
    """

    __slots__ = ("truncated",)

    def __init__(self, items: Iterable[IssueSummary] = (), *, truncated: bool = False) -> None:
        super().__init__(items)
        self.truncated = truncated


@dataclass(slots=True, frozen=True)
class ReactionInfo:
    """A reaction on an issue/comment.

    `content` is GitHub's reaction string: `+1`, `-1`, `laugh`, `hooray`,
    `confused`, `heart`, `rocket`, `eyes`. The auto-close scheduler only
    looks at `-1` (👎) reactions from the issue's original author.
    """

    content: str
    user_login: str
    user_type: str


@dataclass(slots=True, frozen=True)
class CheckRunInfo:
    """One entry from `GET /repos/{repo}/commits/{sha}/check-runs`.

    `status` is `queued` / `in_progress` / `completed`; `conclusion` only
    carries meaning once `status == "completed"`. GitHub reports a rerun as a
    *separate* record with the same `name`, so consumers must de-duplicate by
    name and keep the newest — see `ci_state.summarize_checks`.
    """

    name: str
    status: str
    conclusion: str | None
    started_at: str | None
    id: int
    details_url: str | None


@dataclass(slots=True, frozen=True)
class CommitStatusInfo:
    """One entry from the legacy combined-status endpoint.

    `state` is `success` / `pending` / `failure` / `error`. Third-party CI that
    predates the Checks API still reports only here.
    """

    context: str
    state: str


@dataclass(slots=True, frozen=True)
class WorkflowRunInfo:
    """One entry from `GET /repos/{repo}/actions/runs?head_sha=…`."""

    id: int
    name: str
    status: str
    conclusion: str | None


# GitHub's check-run conclusion vocabulary. It lives here beside `CheckRunInfo`
# because it is the REST API's enum, not veybot policy — `ci_state` imports it
# and decides from it what "green" means.
PASSING_CHECK_CONCLUSIONS = frozenset({"success", "neutral", "skipped"})
"""Conclusions that clear a check. `neutral` and `skipped` never block a merge."""

IGNORED_CHECK_CONCLUSIONS = frozenset({"stale"})
"""`stale` means GitHub superseded the run before it reported. It carries no
verdict either way, so it must not count for or against the commit."""

_JOB_LOG_MAX_BYTES = 1_000_000
"""Ceiling on the bytes `get_failed_job_logs` will hold in memory per run."""


def _is_failed_conclusion(conclusion: str | None) -> bool:
    """Whether a workflow *job* conclusion counts as a failure.

    A `None` conclusion means the job has not finished, which is not a failure.
    (`ci_state` treats a *completed* check run with no conclusion as failing —
    a different question about a different record.)
    """
    if conclusion is None:
        return False
    return conclusion not in PASSING_CHECK_CONCLUSIONS and conclusion not in IGNORED_CHECK_CONCLUSIONS


def _parse_retry_after(resp: httpx.Response) -> float | None:
    ra = resp.headers.get("retry-after")
    if ra:
        try:
            return float(ra)
        except ValueError:
            pass
    reset = resp.headers.get("x-ratelimit-reset")
    if reset:
        try:
            return max(0.0, float(reset) - time.time())
        except ValueError:
            pass
    return None


# Connection-establishment failures prove the request never reached the server
# (no bytes were processed), so retrying them cannot duplicate a side effect.
# A read/write timeout, by contrast, may have already been delivered AND applied
# — the response was merely slow or lost — so retrying a non-idempotent write
# there would double-apply it (a duplicate issue comment / PR review).
_CONNECT_FAILURE_ERRORS = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout)
_IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})


def is_transient_retryable(exc: BaseException, method: str) -> bool:
    """Whether `exc` is a transient transport error safe to retry for `method`.

    The single owner of the retry-safety decision shared by `GitHubClient`
    and `GitHubProxyClient`. Idempotent reads retry through any transient
    connect/timeout error; non-idempotent writes retry ONLY on
    connection-establishment failures, never a read/write timeout that may
    have already applied the effect.
    """
    if not isinstance(exc, (httpx.ConnectError, httpx.TimeoutException)):
        return False
    if method.upper() in _IDEMPOTENT_METHODS:
        return True
    return isinstance(exc, _CONNECT_FAILURE_ERRORS)


class GitHubClient:
    """Async + sync facades over a small slice of the GitHub REST API."""

    def __init__(self, token: str, *, transport: httpx.BaseTransport | None = None) -> None:
        self._token = token
        self._headers = {
            "Authorization": f"Bearer {token}",
            "Accept": ACCEPT,
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "veybot/0.1",
        }
        self._transport = transport

    def _client(self) -> httpx.Client:
        return httpx.Client(
            base_url=GITHUB_API,
            headers=self._headers,
            transport=self._transport,
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=True,
        )

    def _async_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=GITHUB_API,
            headers=self._headers,
            transport=self._transport,  # type: ignore[arg-type]
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=True,
        )

    # ---- request helpers ----
    def _check(self, resp: httpx.Response) -> Any:
        if resp.status_code >= 400:
            retry_after = _parse_retry_after(resp)
            try:
                msg = resp.json().get("message", resp.text)
            except Exception:
                msg = resp.text
            raise GitHubError(resp.status_code, str(msg), retry_after=retry_after)
        if resp.status_code >= 300:
            # Redirect we couldn't (or weren't asked to) follow. GitHub uses 301
            # for transferred repos / issues. Surface as a normal error so host
            # tools map it to RpcCommandError instead of mis-parsing the body.
            location = resp.headers.get("location", "")
            raise GitHubError(
                resp.status_code,
                f"unexpected redirect to {location!r}; resource may have moved",
            )
        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()

    _TRANSIENT_RETRY_DELAYS = (1.0, 3.0, 10.0)
    """Backoff schedule for transient connection/timeout errors."""

    def request_sync(
        self, method: str, path: str, *, json: Mapping[str, Any] | None = None, params: Mapping[str, Any] | None = None
    ) -> Any:
        last_exc: Exception | None = None
        for attempt, delay in enumerate((*self._TRANSIENT_RETRY_DELAYS, None)):
            try:
                with self._client() as client:
                    resp = client.request(method, path, json=json, params=params)
                    return self._check(resp)
            except (httpx.ConnectError, httpx.TimeoutException) as exc:
                if not is_transient_retryable(exc, method):
                    raise
                last_exc = exc
                if delay is None:
                    break
                log.warning(
                    "transient error, retrying",
                    extra={"method": method, "path": path, "attempt": attempt + 1, "delay": delay, "error": str(exc)},
                )
                time.sleep(delay)
        raise last_exc  # type: ignore[misc]

    async def request(
        self, method: str, path: str, *, json: Mapping[str, Any] | None = None, params: Mapping[str, Any] | None = None
    ) -> Any:
        last_exc: Exception | None = None
        for attempt, delay in enumerate((*self._TRANSIENT_RETRY_DELAYS, None)):
            try:
                async with self._async_client() as client:
                    resp = await client.request(method, path, json=json, params=params)
                    return self._check(resp)
            except (httpx.ConnectError, httpx.TimeoutException) as exc:
                if not is_transient_retryable(exc, method):
                    raise
                last_exc = exc
                if delay is None:
                    break
                log.warning(
                    "transient error, retrying",
                    extra={"method": method, "path": path, "attempt": attempt + 1, "delay": delay, "error": str(exc)},
                )
                await asyncio.sleep(delay)
        raise last_exc  # type: ignore[misc]

    # ---- repos / issues / comments / PRs ----
    async def get_repo(self, repo: str) -> RepoInfo:
        data = await self.request("GET", f"/repos/{repo}")
        return _repo_from_payload(data)

    async def get_issue(self, repo: str, number: int) -> IssueInfo:
        data = await self.request("GET", f"/repos/{repo}/issues/{number}")
        return _issue_from_payload(repo, data)

    async def list_closing_pull_requests(self, repo: str, number: int) -> tuple[int, ...]:
        """Return PR numbers currently linked to issue ``number`` via "Closes"/"Fixes"
        keywords or the Development panel.

        Walks ``GET /repos/{repo}/issues/{N}/timeline`` and computes net
        ``connected`` − ``disconnected`` events for sources that are pull
        requests. Only PRs whose timeline source carries ``state == "open"``
        are returned — a merged or closed PR no longer needs the bot's work.

        Pagination intentionally skipped: a just-opened issue has at most a
        handful of timeline entries, and the bot only consults this on
        ``issues.opened`` triage.
        """
        data = await self.request(
            "GET",
            f"/repos/{repo}/issues/{number}/timeline",
            params={"per_page": 100},
        )
        linked: set[int] = set()
        states: dict[int, str] = {}
        for event in data or []:
            if not isinstance(event, Mapping):
                continue
            ev = event.get("event")
            source = event.get("source") or {}
            src_issue = source.get("issue") if isinstance(source, Mapping) else None
            if not isinstance(src_issue, Mapping) or "pull_request" not in src_issue:
                continue
            pr_number = src_issue.get("number")
            if not isinstance(pr_number, int):
                continue
            states[pr_number] = str(src_issue.get("state") or "open")
            if ev == "connected":
                linked.add(pr_number)
            elif ev == "disconnected":
                linked.discard(pr_number)
        return tuple(sorted(n for n in linked if states.get(n, "open") == "open"))

    async def get_pull_request(self, repo: str, number: int) -> PullRequestInfo:
        data = await self.request("GET", f"/repos/{repo}/pulls/{number}")
        return _pr_from_payload(repo, data)

    async def _get_paginated(
        self, path: str, *, params: Mapping[str, Any] | None = None, page_size: int = 100
    ) -> list[Any]:
        """GET every page of a list endpoint until a short (`< page_size`) page
        signals the end. The single home for full-list pagination.

        The issue timeline intentionally returns only a recent slice and
        deliberately does NOT use this — see its docstring. Everything that
        feeds the agent's thread context (comments, review comments, reviews,
        changed files) MUST, so a >`page_size` thread never silently drops its
        newest page.
        """
        items, _ = await self._get_paginated_capped(path, params=params, page_size=page_size, max_items=None)
        return items

    async def _get_paginated_capped(
        self,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        page_size: int = 100,
        max_items: int | None,
    ) -> tuple[list[Any], bool]:
        """The page walk itself, bounded by `max_items` when the caller sets one.

        Returns the items and whether the ceiling cut the walk short. Truncation
        has to travel back out: a caller that only ever sees `max_items` items
        cannot distinguish "that is the whole list" from "there was more and we
        stopped", and guessing the first is how a partial scan gets reported as
        a complete one.

        `page` is omitted on the first request because GitHub defaults it to 1,
        so a list that fits on one page costs exactly the same request it did
        before pagination existed.
        """
        items: list[Any] = []
        base = dict(params or {})
        base["per_page"] = page_size
        page = 1
        while True:
            query = base if page == 1 else {**base, "page": page}
            data = await self.request("GET", path, params=query)
            batch = list(data or [])
            items.extend(batch)
            if max_items is not None and len(items) >= max_items:
                # More left over than asked for, or a full page that may well
                # have a successor: either way the walk stopped early.
                return items[:max_items], len(items) > max_items or len(batch) == page_size
            if len(batch) < page_size:
                return items, False
            page += 1

    async def _get_paginated_envelope(
        self, path: str, *, key: str, params: Mapping[str, Any] | None = None, page_size: int = 100
    ) -> list[Any]:
        """`_get_paginated` for endpoints that wrap their list in an object.

        The Checks and Actions APIs answer `{"total_count": N, "<key>": [...]}`
        rather than a bare array, so the short-page terminator has to look inside
        the envelope. Same full-walk guarantee, and it matters more here: a page
        of check runs that was never fetched is indistinguishable from a commit
        with nothing failing.
        """
        items: list[Any] = []
        base = dict(params or {})
        base["per_page"] = page_size
        page = 1
        while True:
            data = await self.request("GET", path, params={**base, "page": page})
            batch = list(data.get(key) or []) if isinstance(data, Mapping) else []
            items.extend(batch)
            if len(batch) < page_size:
                return items
            page += 1

    async def _fetch_bytes_capped(self, path: str, *, max_bytes: int) -> bytes:
        """Stream a non-JSON GET, stopping once `max_bytes` have been read.

        `request()` buffers the whole body and parses it as JSON. Workflow job
        logs are plain text and routinely run to tens of megabytes, so this
        streams and stops at the cap instead of materializing the whole thing.
        Non-2xx (and any redirect left unfollowed) maps to `GitHubError` through
        the same `_check` every other call uses, so a failed log fetch can never
        be mistaken for an empty log.
        """
        last_exc: Exception | None = None
        for attempt, delay in enumerate((*self._TRANSIENT_RETRY_DELAYS, None)):
            try:
                async with self._async_client() as client, client.stream("GET", path) as resp:
                    if resp.status_code >= 300:
                        await resp.aread()
                        self._check(resp)  # always raises at >= 300
                    chunks: list[bytes] = []
                    total = 0
                    async for chunk in resp.aiter_bytes():
                        room = max_bytes - total
                        if room <= 0:
                            break
                        chunks.append(chunk[:room])
                        total += min(len(chunk), room)
                    return b"".join(chunks)
            except (httpx.ConnectError, httpx.TimeoutException) as exc:
                if not is_transient_retryable(exc, "GET"):
                    raise
                last_exc = exc
                if delay is None:
                    break
                log.warning(
                    "transient error, retrying",
                    extra={"method": "GET", "path": path, "attempt": attempt + 1, "delay": delay, "error": str(exc)},
                )
                await asyncio.sleep(delay)
        raise last_exc  # type: ignore[misc]

    async def list_pr_files(self, repo: str, pr_number: int) -> list[PullRequestFileInfo]:
        data = await self._get_paginated(f"/repos/{repo}/pulls/{pr_number}/files")
        return [_pr_file_from_payload(item) for item in data]

    async def list_issues(
        self,
        repo: str,
        *,
        state: str = "open",
        labels: str | None = None,
        limit: int = 30,
    ) -> IssueListing:
        """List issues for `repo`, newest-updated first. Excludes pull requests.

        `state` is one of `open`, `closed`, `all`. `labels` is GitHub's
        comma-separated label filter and is applied server side, so a caller
        after one label spends its whole page budget on candidates instead of
        on whatever happened to be updated most recently.

        `limit` is the ceiling on how many issues the scan may pull, across as
        many pages of 100 as that takes. It exists so an unbounded repository
        cannot spin forever, and the returned `IssueListing.truncated` says
        whether it bit. Read that flag: a truncated listing is a floor on what
        the repository holds, never the total.
        """
        if state not in ("open", "closed", "all"):
            raise ValueError(f"invalid state: {state!r}")
        ceiling = max(1, int(limit))
        params: dict[str, Any] = {"state": state, "sort": "updated", "direction": "desc"}
        if labels:
            params["labels"] = labels
        data, truncated = await self._get_paginated_capped(
            f"/repos/{repo}/issues",
            params=params,
            page_size=min(ceiling, 100),
            max_items=ceiling,
        )
        out: list[IssueSummary] = []
        for item in data or []:
            if "pull_request" in item:
                continue  # GitHub's /issues endpoint also returns PRs; skip them.
            user = item.get("user") or {}
            labels_raw = item.get("labels") or []
            out.append(
                IssueSummary(
                    repo=repo,
                    number=int(item["number"]),
                    title=str(item.get("title") or ""),
                    state=str(item.get("state") or "open"),
                    author=str(user.get("login") or ""),
                    labels=tuple(str(lbl["name"]) if isinstance(lbl, dict) else str(lbl) for lbl in labels_raw),
                    comments=int(item.get("comments") or 0),
                    updated_at=str(item.get("updated_at") or ""),
                    created_at=str(item.get("created_at") or ""),
                    html_url=str(item.get("html_url") or ""),
                )
            )
        return IssueListing(out, truncated=truncated)

    async def list_comments(self, repo: str, number: int) -> list[CommentInfo]:
        # Fully paginated: comments arrive oldest-first, so a partial fetch would
        # drop the NEWEST comments — the maintainer's latest directive lives there.
        data = await self._get_paginated(f"/repos/{repo}/issues/{number}/comments")
        return [_comment_from_payload(item) for item in data]

    async def list_review_comments(self, repo: str, pr_number: int) -> list[ReviewCommentInfo]:
        """List inline review comments on a PR (the ones attached to a path:line)."""
        data = await self._get_paginated(f"/repos/{repo}/pulls/{pr_number}/comments")
        out: list[ReviewCommentInfo] = []
        for item in data or []:
            user = item.get("user") or {}
            line = item.get("line")
            if not isinstance(line, int):
                orig = item.get("original_line")
                line = orig if isinstance(orig, int) else None
            out.append(
                ReviewCommentInfo(
                    id=int(item.get("id") or 0),
                    author=str(user.get("login") or ""),
                    body=str(item.get("body") or ""),
                    path=str(item.get("path") or ""),
                    line=line,
                    created_at=str(item.get("created_at") or ""),
                )
            )
        return out

    async def list_pr_reviews(self, repo: str, pr_number: int) -> list[PullRequestReviewInfo]:
        """List top-level reviews on a PR. Empty-body reviews are skipped — they
        carry no novel text beyond what the inline comments + merge state convey."""
        data = await self._get_paginated(f"/repos/{repo}/pulls/{pr_number}/reviews")
        out: list[PullRequestReviewInfo] = []
        for item in data or []:
            user = item.get("user") or {}
            body = str(item.get("body") or "").strip()
            if not body:
                continue
            out.append(
                PullRequestReviewInfo(
                    id=int(item.get("id") or 0),
                    author=str(user.get("login") or ""),
                    body=body,
                    state=str(item.get("state") or ""),
                    submitted_at=str(item.get("submitted_at") or item.get("created_at") or ""),
                )
            )
        return out

    # ---- CI state (read-only: there is deliberately no merge/approve path) ----
    async def list_check_runs(self, repo: str, sha: str) -> list[CheckRunInfo]:
        """Every check run reported against `sha`, reruns included.

        Fully paginated — a matrix build easily exceeds one page, and a page of
        failing checks that never got fetched reads exactly like a green commit.
        """
        data = await self._get_paginated_envelope(f"/repos/{repo}/commits/{sha}/check-runs", key="check_runs")
        out: list[CheckRunInfo] = []
        for item in data:
            if not isinstance(item, Mapping):
                continue
            conclusion = item.get("conclusion")
            started_at = item.get("started_at")
            details_url = item.get("details_url")
            out.append(
                CheckRunInfo(
                    name=str(item.get("name") or ""),
                    status=str(item.get("status") or ""),
                    conclusion=str(conclusion) if conclusion is not None else None,
                    started_at=str(started_at) if started_at is not None else None,
                    id=int(item.get("id") or 0),
                    details_url=str(details_url) if details_url is not None else None,
                )
            )
        return out

    async def list_commit_statuses(self, repo: str, sha: str) -> list[CommitStatusInfo]:
        """Legacy combined commit statuses for `sha`.

        The combined endpoint already collapses to the newest status per
        context; we still page it so a commit with many contexts comes back
        whole.
        """
        data = await self._get_paginated_envelope(f"/repos/{repo}/commits/{sha}/status", key="statuses")
        out: list[CommitStatusInfo] = []
        for item in data:
            if not isinstance(item, Mapping):
                continue
            out.append(
                CommitStatusInfo(
                    context=str(item.get("context") or ""),
                    state=str(item.get("state") or ""),
                )
            )
        return out

    async def list_workflow_runs_for_sha(self, repo: str, sha: str) -> list[WorkflowRunInfo]:
        """Actions runs whose head commit is `sha`.

        This is the bridge from a failing check run to the `run_id` whose job
        logs explain it.
        """
        data = await self._get_paginated_envelope(
            f"/repos/{repo}/actions/runs", key="workflow_runs", params={"head_sha": sha}
        )
        out: list[WorkflowRunInfo] = []
        for item in data:
            if not isinstance(item, Mapping):
                continue
            conclusion = item.get("conclusion")
            out.append(
                WorkflowRunInfo(
                    id=int(item.get("id") or 0),
                    name=str(item.get("name") or ""),
                    status=str(item.get("status") or ""),
                    conclusion=str(conclusion) if conclusion is not None else None,
                )
            )
        return out

    async def get_failed_job_logs(self, repo: str, run_id: int) -> str:
        """Plain-text logs of every failed job in workflow run `run_id`.

        Deliberately not `GET /actions/runs/{id}/logs`: that redirects to a ZIP
        of the *whole* run, so reaching the handful of lines that matter would
        mean unzipping tens of megabytes of passing-job noise. Instead we list
        the run's jobs, keep the ones whose conclusion is a failure, and fetch
        `GET /actions/jobs/{job_id}/logs` per job — that endpoint 302s to plain
        text on a storage host, which httpx follows (dropping `Authorization`
        on the cross-origin hop, which the signed URL requires anyway).

        Jobs are concatenated under one `=== <job name> ===` header each. The
        run total is capped at `_JOB_LOG_MAX_BYTES` and every job is handed only
        the budget still left, so one runaway job cannot exhaust memory.
        """
        jobs = await self._get_paginated_envelope(f"/repos/{repo}/actions/runs/{run_id}/jobs", key="jobs")
        sections: list[str] = []
        remaining = _JOB_LOG_MAX_BYTES
        for job in jobs:
            if not isinstance(job, Mapping):
                continue
            conclusion = job.get("conclusion")
            if not _is_failed_conclusion(str(conclusion) if conclusion is not None else None):
                continue
            if remaining <= 0:
                break
            job_id = int(job.get("id") or 0)
            name = str(job.get("name") or f"job {job_id}")
            raw = await self._fetch_bytes_capped(f"/repos/{repo}/actions/jobs/{job_id}/logs", max_bytes=remaining)
            remaining -= len(raw)
            sections.append(f"=== {name} ===\n{raw.decode('utf-8', 'replace')}")
        return "\n".join(sections)

    async def post_comment(self, repo: str, number: int, body: str) -> CommentInfo:
        data = await self.request(
            "POST",
            f"/repos/{repo}/issues/{number}/comments",
            json={"body": body},
        )
        return _comment_from_payload(data)

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
    ) -> PullRequestInfo:
        data = await self.request(
            "POST",
            f"/repos/{repo}/pulls",
            json={
                "title": title,
                "body": body,
                "head": head,
                "base": base,
                "draft": draft,
                "maintainer_can_modify": maintainer_can_modify,
            },
        )
        return _pr_from_payload(repo, data)

    async def request_reviewers(
        self,
        *,
        repo: str,
        pr_number: int,
        reviewers: list[str] | None = None,
        team_reviewers: list[str] | None = None,
    ) -> None:
        payload: dict[str, Any] = {}
        if reviewers:
            payload["reviewers"] = reviewers
        if team_reviewers:
            payload["team_reviewers"] = team_reviewers
        if not payload:
            return
        await self.request(
            "POST",
            f"/repos/{repo}/pulls/{pr_number}/requested_reviewers",
            json=payload,
        )

    async def add_issue_labels(self, repo: str, number: int, labels: list[str]) -> tuple[str, ...]:
        """Append labels to an issue (or PR). Returns the full label set after the add.

        Uses `POST /repos/{owner}/{repo}/issues/{n}/labels` which is *additive* —
        we never remove or overwrite existing labels.
        """
        if not labels:
            return ()
        data = await self.request(
            "POST",
            f"/repos/{repo}/issues/{number}/labels",
            json={"labels": labels},
        )
        return tuple(str(lbl["name"]) if isinstance(lbl, dict) else str(lbl) for lbl in (data or []))

    async def remove_issue_label(self, repo: str, number: int, label: str) -> None:
        """Remove one label from an issue (or PR)."""
        if not label:
            return
        encoded = quote(label, safe="")
        await self.request(
            "DELETE",
            f"/repos/{repo}/issues/{number}/labels/{encoded}",
        )

    async def submit_pr_review(
        self,
        *,
        repo: str,
        pr_number: int,
        body: str,
        event: str,
        comments: list[Mapping[str, Any]],
    ) -> PullRequestReviewInfo:
        data = await self.request(
            "POST",
            f"/repos/{repo}/pulls/{pr_number}/reviews",
            json={"body": body, "event": event, "comments": comments},
        )
        return _pr_review_from_payload(data)

    async def add_assignees(self, repo: str, number: int, assignees: list[str]) -> None:
        if not assignees:
            return
        await self.request(
            "POST",
            f"/repos/{repo}/issues/{number}/assignees",
            json={"assignees": assignees},
        )

    async def list_comment_reactions(self, repo: str, comment_id: int) -> tuple[ReactionInfo, ...]:
        """Reactions on an issue comment, filtered server-side to 👎 (`content=-1`).

        The auto-close scheduler only consults 👎 reactions; filtering server-side
        keeps payloads small even on noisy threads. Returns reactions in the
        order GitHub provides (creation order).
        """
        data = await self.request(
            "GET",
            f"/repos/{repo}/issues/comments/{comment_id}/reactions",
            params={"content": "-1", "per_page": 100},
        )
        return tuple(_reaction_from_payload(item) for item in (data or []))

    async def close_issue(self, repo: str, number: int, *, reason: str = "completed") -> None:
        """Close an issue with `state_reason` (`completed`/`not_planned`/`reopened`)."""
        await self.request(
            "PATCH",
            f"/repos/{repo}/issues/{number}",
            json={"state": "closed", "state_reason": reason},
        )

    async def get_authenticated_login(self) -> str:
        data = await self.request("GET", "/user")
        return str(data["login"])


def _repo_from_payload(data: Mapping[str, Any]) -> RepoInfo:
    return RepoInfo(
        full_name=str(data["full_name"]),
        default_branch=str(data["default_branch"]),
        clone_url=str(data["clone_url"]),
        private=bool(data.get("private", False)),
    )


def _issue_from_payload(repo: str, data: Mapping[str, Any]) -> IssueInfo:
    labels_raw = data.get("labels") or []
    labels = tuple(str(lbl["name"]) if isinstance(lbl, dict) else str(lbl) for lbl in labels_raw)
    user = data.get("user") or {}
    return IssueInfo(
        repo=repo,
        number=int(data["number"]),
        title=str(data.get("title") or ""),
        body=str(data.get("body") or ""),
        state=str(data.get("state") or "open"),
        author=str(user.get("login") or ""),
        labels=labels,
        is_pull_request="pull_request" in data,
    )


def _pr_review_from_payload(data: Mapping[str, Any]) -> PullRequestReviewInfo:
    user = data.get("user") or {}
    body = str(data.get("body") or "").strip()
    return PullRequestReviewInfo(
        id=int(data.get("id") or 0),
        author=str(user.get("login") or "") if isinstance(user, Mapping) else "",
        body=body,
        state=str(data.get("state") or ""),
        submitted_at=str(data.get("submitted_at") or data.get("created_at") or ""),
    )


def _pr_file_from_payload(data: Mapping[str, Any]) -> PullRequestFileInfo:
    return PullRequestFileInfo(
        path=str(data.get("filename") or data.get("path") or ""),
        status=str(data.get("status") or ""),
        additions=int(data.get("additions") or 0),
        deletions=int(data.get("deletions") or 0),
    )


def _pr_from_payload(repo: str, data: Mapping[str, Any]) -> PullRequestInfo:
    head = data.get("head") or {}
    base = data.get("base") or {}
    user = data.get("user") or {}
    head_repo = head.get("repo") if isinstance(head, Mapping) else None
    return PullRequestInfo(
        repo=repo,
        number=int(data["number"]),
        html_url=str(data["html_url"]),
        head_ref=str(head.get("ref") or "") if isinstance(head, Mapping) else "",
        base_ref=str(base.get("ref") or "") if isinstance(base, Mapping) else "",
        state=str(data.get("state") or "open"),
        author=str(user.get("login") or "") if isinstance(user, Mapping) else "",
        head_repo=str(head_repo.get("full_name") or "") if isinstance(head_repo, Mapping) else "",
        title=str(data.get("title") or ""),
        body=str(data.get("body") or ""),
    )


def _comment_from_payload(data: Mapping[str, Any]) -> CommentInfo:
    user = data.get("user") or {}
    return CommentInfo(
        id=int(data["id"]),
        author=str(user.get("login") or ""),
        body=str(data.get("body") or ""),
        created_at=str(data.get("created_at") or ""),
    )


def _reaction_from_payload(data: Mapping[str, Any]) -> ReactionInfo:
    user = data.get("user") or {}
    return ReactionInfo(
        content=str(data.get("content") or ""),
        user_login=str(user.get("login") or "") if isinstance(user, Mapping) else "",
        user_type=str(user.get("type") or "") if isinstance(user, Mapping) else "",
    )


def parse_issue_payload(payload: Mapping[str, Any]) -> tuple[RepoInfo, IssueInfo]:
    """Build typed records from a webhook payload (issues.opened, etc.)."""
    repo_payload = payload["repository"]
    repo = _repo_from_payload(repo_payload)
    issue = _issue_from_payload(repo.full_name, payload["issue"])
    return repo, issue


__all__ = [
    "ACCEPT",
    "API_VERSION",
    "CheckRunInfo",
    "CommentInfo",
    "CommitStatusInfo",
    "GitHubClient",
    "GitHubError",
    "IGNORED_CHECK_CONCLUSIONS",
    "IssueInfo",
    "IssueListing",
    "IssueSummary",
    "PASSING_CHECK_CONCLUSIONS",
    "PullRequestFileInfo",
    "PullRequestInfo",
    "PullRequestReviewInfo",
    "ReactionInfo",
    "RepoInfo",
    "ReviewCommentInfo",
    "WorkflowRunInfo",
    "parse_issue_payload",
]
