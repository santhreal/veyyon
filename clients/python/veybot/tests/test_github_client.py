"""GitHub REST client tests against httpx.MockTransport."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from veybot.github_client import GitHubClient, GitHubError


def _run_async(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_4xx_maps_to_github_error_with_message() -> None:
    transport = httpx.MockTransport(lambda req: httpx.Response(404, json={"message": "Not Found"}))
    client = GitHubClient("tok", transport=transport)
    with pytest.raises(GitHubError) as exc:
        asyncio.new_event_loop().run_until_complete(client.get_repo("o/r"))
    assert exc.value.status == 404
    assert "Not Found" in str(exc.value)


def test_rate_limit_retry_after_parsed() -> None:
    transport = httpx.MockTransport(
        lambda req: httpx.Response(
            403,
            json={"message": "rate limited"},
            headers={"retry-after": "42"},
        )
    )
    client = GitHubClient("tok", transport=transport)
    with pytest.raises(GitHubError) as exc:
        asyncio.new_event_loop().run_until_complete(client.get_repo("o/r"))
    assert exc.value.retry_after == 42.0


def test_redirect_without_follow_raises_github_error() -> None:
    """If a moved repo returns 301 and the redirect target is unreachable,
    we must raise a clean GitHubError instead of parsing the response body."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        # First request: simulate a 301 redirect that the client cannot follow
        # because the new location resolves to a 410 Gone.
        if len(calls) == 1:
            return httpx.Response(
                301,
                headers={"location": "https://api.github.com/repositories/12345"},
            )
        return httpx.Response(410, json={"message": "Gone"})

    transport = httpx.MockTransport(handler)
    client = GitHubClient("tok", transport=transport)
    with pytest.raises(GitHubError) as exc:
        asyncio.new_event_loop().run_until_complete(client.get_repo("old-owner/old-repo"))
    # Either we end up at 410 after following, or we surface the redirect itself
    # — both are GitHubError, not an internal exception.
    assert exc.value.status in (301, 410)


def test_redirect_target_succeeds_when_followable() -> None:
    """A 301 → 200 chain should resolve to the followed payload."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/old/repo":
            return httpx.Response(
                301,
                headers={"location": "https://api.github.com/repos/new/repo"},
            )
        return httpx.Response(
            200,
            json={
                "full_name": "new/repo",
                "default_branch": "main",
                "clone_url": "https://github.com/new/repo.git",
                "private": False,
            },
        )

    transport = httpx.MockTransport(handler)
    client = GitHubClient("tok", transport=transport)
    repo = asyncio.new_event_loop().run_until_complete(client.get_repo("old/repo"))
    assert repo.full_name == "new/repo"


def test_get_pull_request_parses_head_repo_and_author() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/octo/widget/pulls/9"
        return httpx.Response(
            200,
            json={
                "number": 9,
                "html_url": "https://github.com/octo/widget/pull/9",
                "head": {"ref": "farm/abc12345/fix", "repo": {"full_name": "octo/widget"}},
                "base": {"ref": "main"},
                "state": "open",
                "user": {"login": "robveybot"},
            },
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    pr = _run_async(client.get_pull_request("octo/widget", 9))
    assert pr.head_ref == "farm/abc12345/fix"
    assert pr.head_repo == "octo/widget"
    assert pr.author == "robveybot"


def test_get_pull_request_parses_title_and_body() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/octo/widget/pulls/9"
        return httpx.Response(
            200,
            json={
                "number": 9,
                "html_url": "https://github.com/octo/widget/pull/9",
                "title": "Fix crash",
                "body": "Fixes #1",
                "head": {"ref": "fix", "repo": {"full_name": "fork/widget"}},
                "base": {"ref": "main"},
                "state": "open",
                "user": {"login": "alice"},
            },
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    pr = _run_async(client.get_pull_request("octo/widget", 9))
    assert pr.title == "Fix crash"
    assert pr.body == "Fixes #1"


def test_list_pr_files_parses_changed_file_summary() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/octo/widget/pulls/9/files"
        assert request.url.params.get("per_page") == "100"
        return httpx.Response(
            200,
            json=[{"filename": "src/app.py", "status": "modified", "additions": 5, "deletions": 2}],
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    files = _run_async(client.list_pr_files("octo/widget", 9))
    assert len(files) == 1
    assert files[0].path == "src/app.py"
    assert files[0].additions == 5
    assert files[0].deletions == 2


def test_list_pr_files_paginates_past_first_page() -> None:
    """The first request carries no `page` (GitHub defaults it to 1), and a full
    page must be followed by the next one or the newest changed files vanish."""
    seen_pages: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/octo/widget/pulls/9/files"
        page = request.url.params.get("page")
        seen_pages.append(page)
        if page is None:
            return httpx.Response(
                200,
                json=[
                    {
                        "filename": f"src/file-{idx}.py",
                        "status": "modified",
                        "additions": 1,
                        "deletions": 0,
                    }
                    for idx in range(100)
                ],
            )
        assert page == "2"
        return httpx.Response(
            200,
            json=[{"filename": "src/final.py", "status": "added", "additions": 2, "deletions": 0}],
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    files = _run_async(client.list_pr_files("octo/widget", 9))
    assert seen_pages == [None, "2"]
    assert len(files) == 101
    assert files[-1].path == "src/final.py"


def _issue_page(numbers: range | list[int], *, label: str = "upstream-port") -> list[dict]:
    return [
        {
            "number": n,
            "title": f"port: upstream #{n}",
            "state": "open",
            "user": {"login": "santhsecurity"},
            "labels": [{"name": label}],
            "comments": 0,
            "updated_at": "2026-07-30T00:00:00Z",
            "created_at": "2026-07-30T00:00:00Z",
            "html_url": f"https://github.com/octo/widget/issues/{n}",
        }
        for n in numbers
    ]


def _paged_issues_transport(seen: list[dict[str, str | None]]) -> httpx.MockTransport:
    """240 labeled issues across three pages of 100/100/40."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/octo/widget/issues"
        params = request.url.params
        page = params.get("page")
        seen.append({"page": page, "labels": params.get("labels"), "per_page": params.get("per_page")})
        index = int(page or 1)
        assert index <= 3, f"page {index} must never be requested"
        start = 1 + (index - 1) * 100
        stop = min(start + 100, 241)
        return httpx.Response(200, json=_issue_page(range(start, stop)))

    return httpx.MockTransport(handler)


def test_list_issues_walks_every_page_with_the_label_filter() -> None:
    """Locks out the one-page scan that made a 240-issue labeled backlog report
    itself as 100 issues: every page is fetched, in order, the server-side
    `labels` filter rides along on each one, and the walk stops at the short
    page instead of asking for a fourth."""
    seen: list[dict[str, str | None]] = []
    client = GitHubClient("tok", transport=_paged_issues_transport(seen))

    issues = _run_async(client.list_issues("octo/widget", labels="upstream-port", limit=500))

    assert [i.number for i in issues] == list(range(1, 241))
    assert [entry["page"] for entry in seen] == [None, "2", "3"]
    assert {entry["labels"] for entry in seen} == {"upstream-port"}
    assert {entry["per_page"] for entry in seen} == {"100"}
    assert issues.truncated is False


def test_list_issues_reports_a_ceiling_that_cut_the_scan_short() -> None:
    """A ceiling that bites must be visible. Silently handing back exactly
    `limit` issues is indistinguishable from a complete listing, which is the
    failure that let a 200-issue backlog look fully drained."""
    seen: list[dict[str, str | None]] = []
    client = GitHubClient("tok", transport=_paged_issues_transport(seen))

    issues = _run_async(client.list_issues("octo/widget", labels="upstream-port", limit=150))

    assert issues.truncated is True
    assert [i.number for i in issues] == list(range(1, 151))
    assert [entry["page"] for entry in seen] == [None, "2"]


def test_list_issues_omits_the_labels_filter_when_unset() -> None:
    """The dashboard browse view lists everything; an empty `labels` must not
    reach GitHub as a filter that matches nothing."""
    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.params.get("labels"))
        return httpx.Response(200, json=_issue_page([1]))

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    issues = _run_async(client.list_issues("octo/widget", limit=30))
    assert seen == [None]
    assert len(issues) == 1 and issues.truncated is False


def test_submit_pr_review_posts_comment_event_and_inline_comments() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "id": 44,
                "user": {"login": "robveybot"},
                "body": "summary",
                "state": "COMMENTED",
                "submitted_at": "t",
            },
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    review = _run_async(
        client.submit_pr_review(
            repo="octo/widget",
            pr_number=9,
            body="summary",
            event="COMMENT",
            comments=[{"path": "src/app.py", "line": 12, "side": "RIGHT", "body": "finding"}],
        )
    )
    assert review.id == 44
    assert captured["path"] == "/repos/octo/widget/pulls/9/reviews"
    assert captured["body"] == {
        "body": "summary",
        "event": "COMMENT",
        "comments": [{"path": "src/app.py", "line": 12, "side": "RIGHT", "body": "finding"}],
    }


def test_204_no_content_returns_none() -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(204))
    client = GitHubClient("tok", transport=transport)
    # add_assignees with empty list short-circuits without a request; pass one to force the call.
    asyncio.new_event_loop().run_until_complete(client.add_assignees("o/r", 1, ["alice"]))


def test_list_closing_pull_requests_filters_disconnected_and_closed() -> None:
    """Net connected−disconnected open PRs only."""
    captured: dict[str, str] = {}

    timeline = [
        # PR #100 connected and still open → included
        {
            "event": "connected",
            "source": {"issue": {"number": 100, "state": "open", "pull_request": {"url": "..."}}},
        },
        # PR #200 connected then disconnected → excluded
        {
            "event": "connected",
            "source": {"issue": {"number": 200, "state": "open", "pull_request": {"url": "..."}}},
        },
        {
            "event": "disconnected",
            "source": {"issue": {"number": 200, "state": "open", "pull_request": {"url": "..."}}},
        },
        # PR #300 connected but currently closed (e.g. rejected) → excluded
        {
            "event": "connected",
            "source": {"issue": {"number": 300, "state": "closed", "pull_request": {"url": "..."}}},
        },
        # Cross-referenced (not connected) — not a closing link → excluded
        {
            "event": "cross-referenced",
            "source": {"issue": {"number": 400, "state": "open", "pull_request": {"url": "..."}}},
        },
        # Plain issue cross-ref (no pull_request) → excluded
        {
            "event": "connected",
            "source": {"issue": {"number": 500, "state": "open"}},
        },
        # Unrelated timeline events → ignored
        {"event": "labeled", "label": {"name": "bug"}},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["per_page"] = request.url.params.get("per_page", "")
        return httpx.Response(200, json=timeline)

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    prs = _run_async(client.list_closing_pull_requests("octo/widget", 42))
    assert prs == (100,)
    assert captured["path"] == "/repos/octo/widget/issues/42/timeline"
    assert captured["per_page"] == "100"


def test_list_closing_pull_requests_empty_timeline() -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json=[]))
    client = GitHubClient("tok", transport=transport)
    assert _run_async(client.list_closing_pull_requests("octo/widget", 7)) == ()


def test_list_comment_reactions_filters_to_thumbs_down() -> None:
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["content"] = request.url.params.get("content", "")
        captured["per_page"] = request.url.params.get("per_page", "")
        return httpx.Response(
            200,
            json=[
                {"content": "-1", "user": {"login": "Alice", "type": "User"}},
                {"content": "-1", "user": {"login": "rando", "type": "User"}},
            ],
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    reactions = _run_async(client.list_comment_reactions("octo/widget", 999))
    assert captured["path"] == "/repos/octo/widget/issues/comments/999/reactions"
    assert captured["content"] == "-1"
    assert captured["per_page"] == "100"
    assert tuple(r.user_login for r in reactions) == ("Alice", "rando")
    assert all(r.content == "-1" for r in reactions)


def test_close_issue_sends_completed_state_reason() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={})

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    assert _run_async(client.close_issue("octo/widget", 42)) is None
    assert captured["method"] == "PATCH"
    assert captured["path"] == "/repos/octo/widget/issues/42"
    assert captured["body"] == {"state": "closed", "state_reason": "completed"}


def test_close_issue_propagates_error() -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(404, json={"message": "Not Found"}))
    client = GitHubClient("tok", transport=transport)
    with pytest.raises(GitHubError) as exc:
        _run_async(client.close_issue("octo/widget", 42))
    assert exc.value.status == 404


def _two_page_handler(path: str, page2_item: dict) -> "callable":
    """A MockTransport handler serving 100 items on page 1 and one distinctive
    item on page 2 for `path`, recording the pages requested."""
    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == path, request.url.path
        page = request.url.params.get("page")
        seen.append(page)
        if page == "1" or page is None:
            base = {**page2_item}
            return httpx.Response(200, json=[{**base, "id": idx, "body": f"c{idx}"} for idx in range(100)])
        assert page == "2"
        return httpx.Response(200, json=[page2_item])

    handler.seen = seen  # type: ignore[attr-defined]
    return handler


def test_list_comments_paginates_to_capture_newest() -> None:
    """Issue comments arrive oldest-first; a >100-comment thread must not drop
    the newest page (the maintainer's latest directive lives there)."""
    handler = _two_page_handler(
        "/repos/octo/widget/issues/7/comments",
        {"id": 9999, "body": "LATEST DIRECTIVE", "user": {"login": "maint"}, "created_at": "2026-07-17T00:00:00Z"},
    )
    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    comments = _run_async(client.list_comments("octo/widget", 7))
    assert handler.seen == [None, "2"]  # type: ignore[attr-defined]
    assert len(comments) == 101
    assert any(c.body == "LATEST DIRECTIVE" for c in comments)


def test_list_review_comments_paginates_to_capture_newest() -> None:
    handler = _two_page_handler(
        "/repos/octo/widget/pulls/7/comments",
        {"id": 9999, "body": "LATEST INLINE", "user": {"login": "maint"}, "path": "a.py", "line": 3},
    )
    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    comments = _run_async(client.list_review_comments("octo/widget", 7))
    assert handler.seen == [None, "2"]  # type: ignore[attr-defined]
    assert len(comments) == 101
    assert any(c.body == "LATEST INLINE" for c in comments)


def test_list_pr_reviews_paginates_to_capture_newest() -> None:
    handler = _two_page_handler(
        "/repos/octo/widget/pulls/7/reviews",
        {"id": 9999, "body": "LATEST REVIEW", "user": {"login": "maint"}, "state": "COMMENTED", "submitted_at": "2026-07-17T00:00:00Z"},
    )
    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    reviews = _run_async(client.list_pr_reviews("octo/widget", 7))
    assert handler.seen == [None, "2"]  # type: ignore[attr-defined]
    assert any(r.body == "LATEST REVIEW" for r in reviews)


# ---- retry idempotency: writes must not duplicate on a read/write timeout ----


def test_is_transient_retryable_write_vs_read() -> None:
    from veybot.github_client import is_transient_retryable

    read_timeout = httpx.ReadTimeout("slow")
    connect_err = httpx.ConnectError("refused")
    connect_timeout = httpx.ConnectTimeout("no connect")
    pool_timeout = httpx.PoolTimeout("pool")
    not_transient = httpx.DecodingError("bad body")

    # Idempotent reads retry through any transient connect/timeout error.
    for exc in (read_timeout, connect_err, connect_timeout, pool_timeout):
        assert is_transient_retryable(exc, "GET") is True
    # Non-idempotent writes retry ONLY on connection-establishment failures.
    assert is_transient_retryable(read_timeout, "POST") is False
    assert is_transient_retryable(connect_err, "POST") is True
    assert is_transient_retryable(connect_timeout, "POST") is True
    assert is_transient_retryable(pool_timeout, "POST") is True
    # A non-transport error is never retryable.
    assert is_transient_retryable(not_transient, "GET") is False


def test_post_comment_not_retried_on_read_timeout() -> None:
    """A read timeout may have already posted the comment on GitHub's side, so
    the write must not retry — retrying would create a duplicate comment."""
    calls = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("simulated slow response")

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    client._TRANSIENT_RETRY_DELAYS = (0.0, 0.0, 0.0)  # type: ignore[attr-defined]
    with pytest.raises(httpx.ReadTimeout):
        _run_async(client.post_comment("octo/widget", 1, "hi"))
    assert calls == 1


def test_get_repo_retried_on_read_timeout() -> None:
    """Contrast: an idempotent GET DOES retry a read timeout and then succeeds."""
    calls = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ReadTimeout("simulated slow response")
        return httpx.Response(
            200,
            json={"full_name": "octo/widget", "default_branch": "main", "clone_url": "https://x/y.git"},
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    client._TRANSIENT_RETRY_DELAYS = (0.0, 0.0, 0.0)  # type: ignore[attr-defined]
    repo = _run_async(client.get_repo("octo/widget"))
    assert repo.full_name == "octo/widget"
    assert calls == 2


# ---------------------------------------------------------------------------
# CI state reads
# ---------------------------------------------------------------------------

_SHA = "0123456789abcdef0123456789abcdef01234567"


def test_list_check_runs_reads_envelope_and_preserves_nulls() -> None:
    """The Checks API wraps its list in `{"check_runs": [...]}`, and an
    in-flight run has null `conclusion`/`started_at`.

    Locks out parsing the response as a bare array (which yields nothing) and
    coercing the nulls to `""`, which would make an unstarted run sort as if it
    had a timestamp and a conclusion the summarizer could misread.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == f"/repos/octo/widget/commits/{_SHA}/check-runs"
        assert request.url.params.get("per_page") == "100"
        return httpx.Response(
            200,
            json={
                "total_count": 2,
                "check_runs": [
                    {
                        "id": 11,
                        "name": "build",
                        "status": "completed",
                        "conclusion": "failure",
                        "started_at": "2026-01-01T00:00:00Z",
                        "details_url": "https://example/run/11",
                    },
                    {"id": 12, "name": "lint", "status": "queued", "conclusion": None, "started_at": None},
                ],
            },
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    runs = _run_async(client.list_check_runs("octo/widget", _SHA))
    assert [r.name for r in runs] == ["build", "lint"]
    assert runs[0].conclusion == "failure"
    assert runs[0].details_url == "https://example/run/11"
    assert runs[1].conclusion is None
    assert runs[1].started_at is None
    assert runs[1].details_url is None


def test_list_check_runs_paginates_past_first_page() -> None:
    """A full page of check runs must not be mistaken for the whole set.

    A matrix build easily exceeds 100 runs. Locks out stopping at page 1, which
    would drop later failures and report a red commit as having nothing wrong.
    """
    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        page = request.url.params.get("page")
        seen.append(page)
        if page == "1":
            runs = [{"id": i, "name": f"shard-{i}", "status": "completed", "conclusion": "success"} for i in range(100)]
            return httpx.Response(200, json={"total_count": 101, "check_runs": runs})
        assert page == "2"
        return httpx.Response(
            200,
            json={
                "total_count": 101,
                "check_runs": [{"id": 999, "name": "final-gate", "status": "completed", "conclusion": "failure"}],
            },
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    runs = _run_async(client.list_check_runs("octo/widget", _SHA))
    assert seen == ["1", "2"]
    assert len(runs) == 101
    assert runs[-1].name == "final-gate"
    assert runs[-1].conclusion == "failure"


def test_list_check_runs_error_raises_instead_of_returning_empty() -> None:
    """A failed fetch must raise, never degrade to an empty list.

    An empty check-run list is indistinguishable from a commit with nothing
    wrong, so swallowing the error would mark a red PR green and hand it to a
    reviewer as verified.
    """
    transport = httpx.MockTransport(lambda r: httpx.Response(500, json={"message": "Server Error"}))
    client = GitHubClient("tok", transport=transport)
    with pytest.raises(GitHubError) as exc:
        _run_async(client.list_check_runs("octo/widget", _SHA))
    assert exc.value.status == 500


def test_list_commit_statuses_reads_combined_status_envelope() -> None:
    """Legacy statuses live under `statuses` in the combined-status object.

    Locks out reading the envelope's own top-level `state` field (a single
    rolled-up string) instead of the per-context rows the summarizer needs.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == f"/repos/octo/widget/commits/{_SHA}/status"
        return httpx.Response(
            200,
            json={
                "state": "failure",
                "total_count": 2,
                "statuses": [
                    {"context": "ci/travis", "state": "failure"},
                    {"context": "ci/jenkins", "state": "success"},
                ],
            },
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    statuses = _run_async(client.list_commit_statuses("octo/widget", _SHA))
    assert [(s.context, s.state) for s in statuses] == [("ci/travis", "failure"), ("ci/jenkins", "success")]


def test_list_commit_statuses_error_raises_instead_of_returning_empty() -> None:
    """Same reasoning as the check-run fetch: no silent green on failure."""
    transport = httpx.MockTransport(lambda r: httpx.Response(403, json={"message": "Forbidden"}))
    client = GitHubClient("tok", transport=transport)
    with pytest.raises(GitHubError) as exc:
        _run_async(client.list_commit_statuses("octo/widget", _SHA))
    assert exc.value.status == 403


def test_list_workflow_runs_for_sha_filters_by_head_sha() -> None:
    """The runs listing must be scoped to the commit, not the whole repo.

    Locks out dropping the `head_sha` filter, which would return every recent
    run in the repository and send the repair agent to read another PR's logs.
    """
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["head_sha"] = request.url.params.get("head_sha")
        return httpx.Response(
            200,
            json={
                "total_count": 1,
                "workflow_runs": [
                    {"id": 555, "name": "checks", "status": "completed", "conclusion": "failure"},
                ],
            },
        )

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    runs = _run_async(client.list_workflow_runs_for_sha("octo/widget", _SHA))
    assert captured == {"path": "/repos/octo/widget/actions/runs", "head_sha": _SHA}
    assert len(runs) == 1
    assert runs[0].id == 555
    assert runs[0].conclusion == "failure"


def _jobs_response(jobs: list[dict]) -> httpx.Response:
    return httpx.Response(200, json={"total_count": len(jobs), "jobs": jobs})


def test_get_failed_job_logs_fetches_only_failed_jobs() -> None:
    """Only jobs whose conclusion is a failure contribute log text.

    Passing, skipped and still-running jobs are noise that would crowd the real
    error out of the agent's context. Locks out fetching every job's log, and
    locks out dropping non-`failure` failures such as `timed_out`.
    """
    fetched: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/repos/octo/widget/actions/runs/555/jobs":
            return _jobs_response(
                [
                    {"id": 1, "name": "unit", "conclusion": "success"},
                    {"id": 2, "name": "lint", "conclusion": "failure"},
                    {"id": 3, "name": "optional", "conclusion": "skipped"},
                    {"id": 4, "name": "e2e", "conclusion": "timed_out"},
                    {"id": 5, "name": "still-going", "conclusion": None},
                    {"id": 6, "name": "superseded", "conclusion": "stale"},
                ]
            )
        if path.startswith("/repos/octo/widget/actions/jobs/"):
            job_id = int(path.rsplit("/", 2)[1])
            fetched.append(job_id)
            return httpx.Response(200, text=f"log for job {job_id}\n")
        return httpx.Response(404, json={"message": f"unrouted {path}"})

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    logs = _run_async(client.get_failed_job_logs("octo/widget", 555))
    assert fetched == [2, 4]
    assert logs == "=== lint ===\nlog for job 2\n\n=== e2e ===\nlog for job 4\n"


def test_get_failed_job_logs_follows_redirect_and_drops_authorization() -> None:
    """The per-job log endpoint 302s to a signed storage URL.

    The redirect must be followed (otherwise the "log" is an empty redirect
    body) and the `Authorization` header must not travel to the other origin —
    the signed URL rejects requests that carry one, and it would leak the PAT.
    """
    followed: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/actions/runs/7/jobs":
            return _jobs_response([{"id": 42, "name": "build", "conclusion": "failure"}])
        if request.url.path == "/repos/octo/widget/actions/jobs/42/logs":
            return httpx.Response(302, headers={"location": "https://pipelines.example/blob/42?sig=abc"})
        followed["host"] = request.url.host
        followed["auth"] = request.headers.get("authorization")
        return httpx.Response(200, text="the real failure output\n")

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    logs = _run_async(client.get_failed_job_logs("octo/widget", 7))
    assert followed == {"host": "pipelines.example", "auth": None}
    assert logs == "=== build ===\nthe real failure output\n"


def test_get_failed_job_logs_caps_total_bytes_across_jobs() -> None:
    """One runaway job cannot exhaust memory, and later jobs get what is left.

    Locks out reading each job's log in full: a matrix of multi-hundred-megabyte
    logs would otherwise be buffered in the orchestrator process.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/actions/runs/9/jobs":
            return _jobs_response(
                [
                    {"id": 1, "name": "job-a", "conclusion": "failure"},
                    {"id": 2, "name": "job-b", "conclusion": "failure"},
                ]
            )
        fill = "a" if request.url.path.endswith("/jobs/1/logs") else "b"
        return httpx.Response(200, text=fill * 700_000)

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    logs = _run_async(client.get_failed_job_logs("octo/widget", 9))
    first, second = logs.split("=== job-b ===\n")
    assert first == "=== job-a ===\n" + "a" * 700_000 + "\n"
    # 1_000_000-byte run budget, 700_000 already spent by job-a.
    assert second == "b" * 300_000


def test_get_failed_job_logs_error_raises_instead_of_empty_text() -> None:
    """A log fetch that fails raises rather than returning "".

    Empty log text reads as "the job printed nothing", which would send the
    repair agent in with no evidence and let it invent a cause.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/actions/runs/3/jobs":
            return _jobs_response([{"id": 8, "name": "build", "conclusion": "failure"}])
        return httpx.Response(410, json={"message": "log expired"})

    client = GitHubClient("tok", transport=httpx.MockTransport(handler))
    with pytest.raises(GitHubError) as exc:
        _run_async(client.get_failed_job_logs("octo/widget", 3))
    assert exc.value.status == 410
