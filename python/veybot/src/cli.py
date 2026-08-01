"""Command-line interface."""

from __future__ import annotations

import asyncio
import json
import re
import sys

import click
import uvicorn

from veybot.config import Settings, get_settings
from veybot.db import INACTIVE_EVENT_STATES, get_database
from veybot.logging_config import configure_logging
from veybot.manual_triage import (
    InvalidIssueRef,
    ManualTriageError,
    ManualTriageTimeout,
    await_terminal_state,
    enqueue_manual_triage,
    enqueue_port_backlog,
    parse_issue_ref,
)
from veybot.proxy_client import GitHubProxyClient
from veybot.sandbox import SandboxManager
from veybot.server import create_app


def _settings_or_die() -> Settings:
    try:
        return get_settings()
    except Exception as exc:
        click.echo(f"configuration error: {exc}", err=True)
        sys.exit(2)


def _require_proxy_mode(cfg: Settings) -> tuple[str, bytes]:
    if cfg.github_token is not None:
        raise SystemExit(
            "veybot orchestrator refuses to start with GITHUB_TOKEN set in env. "
            "The PAT must live only in the gh-proxy container."
        )
    if cfg.gh_proxy_url is None or cfg.gh_proxy_hmac_key is None:
        raise SystemExit(
            "veybot orchestrator requires VEYBOT_GH_PROXY_URL and "
            "VEYBOT_GH_PROXY_HMAC_KEY (run gh-proxy in a sibling container)."
        )
    return cfg.gh_proxy_url, cfg.gh_proxy_hmac_key.get_secret_value().encode("utf-8")


def _build_github(cfg: Settings) -> GitHubProxyClient:
    base_url, key = _require_proxy_mode(cfg)
    return GitHubProxyClient(base_url=base_url, hmac_key=key)


def _default_wait_timeout(cfg: Settings) -> float:
    return cfg.task_timeout_seconds + cfg.task_timeout_hard_grace_seconds + 30.0


@click.group()
def main() -> None:
    """veybot control surface."""


@main.command()
def serve() -> None:
    """Run the webhook receiver + worker pool."""
    cfg = _settings_or_die()
    configure_logging(cfg.log_dir)
    cfg.ensure_paths()
    app = create_app(cfg)
    uvicorn.run(app, host=cfg.bind_host, port=cfg.bind_port, log_config=None)


@main.command()
@click.argument("issue_ref")
@click.option(
    "--wait-timeout",
    type=click.FloatRange(min=0.1),
    default=None,
    help="Seconds to wait for a terminal state before returning non-zero (default: task timeout + hard grace + 30).",
)
def triage(issue_ref: str, wait_timeout: float | None) -> None:
    """Fetch a live issue and queue it as if a webhook arrived.

    ISSUE_REF is `owner/repo#NN`.
    """
    cfg = _settings_or_die()
    configure_logging(cfg.log_dir)
    cfg.ensure_paths()
    try:
        repo_full, number = parse_issue_ref(issue_ref)
    except InvalidIssueRef as exc:
        click.echo(str(exc), err=True)
        sys.exit(2)
    if not cfg.allows(repo_full):
        click.echo(f"refusing: {repo_full} not in VEYBOT_REPO_ALLOWLIST", err=True)
        sys.exit(2)

    async def _go() -> None:
        github = _build_github(cfg)
        db = get_database(cfg.sqlite_path)
        try:
            delivery = await enqueue_manual_triage(
                db=db,
                github=github,
                repo_full=repo_full,
                number=number,
            )
        except ManualTriageError as exc:
            click.echo(f"refusing: {exc}", err=True)
            sys.exit(2)
        # The dispatcher loop lives in the long-running `serve` process; we
        # only watch the row land in a terminal state. Wake latency is
        # bounded by `WorkerPool._dispatch_loop`'s 10s `_wakeup.wait()` fallback.
        click.echo(json.dumps({"delivery": delivery, "state": "queued"}, indent=2))
        timeout = wait_timeout if wait_timeout is not None else _default_wait_timeout(cfg)
        try:
            final = await await_terminal_state(db, delivery, timeout=timeout)
        except ManualTriageTimeout as exc:
            click.echo(
                json.dumps(
                    {"delivery": delivery, "state": exc.state, "timed_out": True, "error": str(exc)},
                    indent=2,
                ),
                err=True,
            )
            sys.exit(1)
        if final is None:
            click.echo(json.dumps({"delivery": delivery, "state": "missing"}, indent=2))
            return
        click.echo(
            json.dumps(
                {"delivery": delivery, "state": final.state, "error": final.last_error},
                indent=2,
            )
        )

    asyncio.run(_go())


_REPO_FULL = re.compile(r"^[^/\s#]+/[^/\s#]+$")


@main.command("port-backlog")
@click.argument("repo_full")
@click.option(
    "--limit",
    type=click.IntRange(min=1),
    default=10,
    show_default=True,
    help="Maximum number of issues this run may queue.",
)
@click.option(
    "--dry-run",
    is_flag=True,
    help="List what would be queued and write nothing.",
)
def port_backlog(repo_full: str, limit: int, dry_run: bool) -> None:
    """Queue the open upstream-port issues that predate the webhook.

    REPO_FULL is `owner/repo`. The label comes from VEYBOT_PORT_LABEL.
    Re-running is safe: an issue already in the events table is skipped.
    """
    cfg = _settings_or_die()
    configure_logging(cfg.log_dir)
    cfg.ensure_paths()
    repo_full = repo_full.strip()
    if _REPO_FULL.match(repo_full) is None:
        click.echo(f"expected owner/repo, got {repo_full!r}", err=True)
        sys.exit(2)
    if not cfg.allows(repo_full):
        click.echo(f"refusing: {repo_full} not in VEYBOT_REPO_ALLOWLIST", err=True)
        sys.exit(2)
    if not cfg.port_upstream_enabled:
        click.echo("refusing: VEYBOT_PORT_UPSTREAM_ENABLED is off", err=True)
        sys.exit(2)

    async def _go() -> None:
        github = _build_github(cfg)
        db = get_database(cfg.sqlite_path)
        result = await enqueue_port_backlog(
            db=db,
            github=github,
            repo_full=repo_full,
            label=cfg.port_label,
            limit=limit,
            dry_run=dry_run,
        )
        verb = "would queue" if dry_run else "queued"
        for entry in result.enqueued:
            click.echo(f"{verb} {repo_full}#{entry.number} [{entry.delivery_id}] {entry.title}")
        # Three separate numbers. `matched` is what the repository holds,
        # `enqueued` is what --limit allowed this run, `skipped` is what earlier
        # runs already own. Printing one of them as all three is how a 200-issue
        # backlog looked drained at 90.
        line = (
            f"{result.matched} open {cfg.port_label} issue(s) match; "
            f"{verb} {len(result.enqueued)}; {result.skipped} already tracked"
        )
        if result.scan_truncated:
            line += (
                f"; scan stopped at the {result.scan_limit}-issue ceiling, "
                "so the match count is a floor and more remain unseen"
            )
        click.echo(line)

    asyncio.run(_go())


@main.command()
@click.argument("delivery_id")
@click.option(
    "--wait-timeout",
    type=click.FloatRange(min=0.1),
    default=None,
    help="Seconds to wait for a terminal state before returning non-zero (default: task timeout + hard grace + 30).",
)
def replay(delivery_id: str, wait_timeout: float | None) -> None:
    """Re-enqueue a stored event so the running `serve` pool can pick it up."""
    cfg = _settings_or_die()
    configure_logging(cfg.log_dir)
    cfg.ensure_paths()
    db = get_database(cfg.sqlite_path)
    row = db.get_event(delivery_id)
    if row is None:
        click.echo(f"unknown delivery: {delivery_id}", err=True)
        sys.exit(2)
    if not db.requeue_event(delivery_id, from_states=INACTIVE_EVENT_STATES):
        click.echo(
            f"delivery {delivery_id} is {row.state}; only inactive events can be replayed",
            err=True,
        )
        sys.exit(2)

    async def _wait() -> None:
        timeout = wait_timeout if wait_timeout is not None else _default_wait_timeout(cfg)
        try:
            final = await await_terminal_state(db, delivery_id, timeout=timeout)
        except ManualTriageTimeout as exc:
            click.echo(
                json.dumps(
                    {"delivery": delivery_id, "state": exc.state, "timed_out": True, "error": str(exc)},
                    indent=2,
                ),
                err=True,
            )
            sys.exit(1)
        if final is None:
            click.echo(json.dumps({"delivery": delivery_id, "state": "missing"}, indent=2))
            return
        click.echo(
            json.dumps(
                {"delivery": delivery_id, "state": final.state, "error": final.last_error},
                indent=2,
            )
        )

    asyncio.run(_wait())


@main.command()
def status() -> None:
    """Dump the issue table."""
    cfg = _settings_or_die()
    cfg.ensure_paths()
    db = get_database(cfg.sqlite_path)
    rows = db.list_issues()
    for r in rows:
        click.echo(
            f"{r.key:<40} state={r.state:<12} pr={r.pr_number or '-'} branch={r.branch or '-'} updated={r.updated_at}"
        )


@main.command()
@click.argument("issue_key")
def cleanup(issue_key: str) -> None:
    """Force-remove the workspace for an issue (does not touch the remote)."""
    cfg = _settings_or_die()
    cfg.ensure_paths()
    db = get_database(cfg.sqlite_path)
    row = db.get_issue(issue_key)
    if row is None:
        click.echo(f"unknown issue: {issue_key}", err=True)
        sys.exit(2)
    sandbox = SandboxManager(cfg.workspace_root)
    sandbox.remove_workspace(repo=row.repo, number=row.number)
    db.set_issue_state(issue_key, "abandoned")
    click.echo(f"cleaned up {issue_key}")


if __name__ == "__main__":
    main()
