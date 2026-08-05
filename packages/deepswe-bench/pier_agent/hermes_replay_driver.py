"""Hermes-native replay driver used inside Pier task containers.

Only USER turns are replayed. Hermes owns every assistant/tool response, its
SQLite session, resume behavior, and the compaction itself.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import re
import sys
import time
from pathlib import Path
from typing import Any

EXACT_MODEL = "google-antigravity/gemini-3.6-flash"
EXACT_PROVIDER = "google-antigravity"
SCHEMA_VERSION = 1


class ReplayFailure(RuntimeError):
    """A replay infrastructure or fidelity requirement was not satisfied."""


def load_replay_manifest(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReplayFailure(f"cannot read replay manifest {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ReplayFailure("replay manifest must be a JSON object")

    required = {
        "schema_version",
        "model",
        "source_session_id",
        "source_session_artifacts",
        "repository_checkpoint",
        "repository_checkpoint_sha256",
        "compaction_checkpoint",
        "user_turns",
        "held_out_continuation",
    }
    unknown = set(value) - required
    missing = required - set(value)
    if missing or unknown:
        raise ReplayFailure(
            f"replay manifest keys mismatch: missing={sorted(missing)} unknown={sorted(unknown)}"
        )
    if value["schema_version"] != SCHEMA_VERSION:
        raise ReplayFailure(f"unsupported replay schema_version: {value['schema_version']!r}")
    if value["model"] != EXACT_MODEL:
        raise ReplayFailure(f"replay model must be exactly {EXACT_MODEL!r}")
    if not isinstance(value["source_session_id"], str) or not value["source_session_id"].strip():
        raise ReplayFailure("source_session_id must be a non-empty string")
    artifacts = value["source_session_artifacts"]
    if not isinstance(artifacts, list) or not artifacts or not all(
        isinstance(item, str) and Path(item).is_absolute() for item in artifacts
    ):
        raise ReplayFailure("source_session_artifacts must be a non-empty list of absolute paths")
    checkpoint_path = value["repository_checkpoint"]
    if not isinstance(checkpoint_path, str) or not Path(checkpoint_path).is_absolute():
        raise ReplayFailure("repository_checkpoint must be an absolute path")
    checkpoint_sha = value["repository_checkpoint_sha256"]
    if not isinstance(checkpoint_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", checkpoint_sha):
        raise ReplayFailure("repository_checkpoint_sha256 must be 64 lowercase hex characters")

    boundary = value["compaction_checkpoint"]
    boundary_keys = {
        "after_user_turn",
        "source_boundary_id",
        "source_threshold_tokens",
        "source_context_tokens",
    }
    if not isinstance(boundary, dict) or set(boundary) != boundary_keys:
        raise ReplayFailure("compaction_checkpoint has invalid keys")
    if not isinstance(boundary["after_user_turn"], int) or isinstance(
        boundary["after_user_turn"], bool
    ):
        raise ReplayFailure("compaction_checkpoint.after_user_turn must be an integer")
    if not isinstance(boundary["source_boundary_id"], str) or not boundary[
        "source_boundary_id"
    ].strip():
        raise ReplayFailure("compaction_checkpoint.source_boundary_id must be non-empty")
    for key in ("source_threshold_tokens", "source_context_tokens"):
        if not isinstance(boundary[key], int) or isinstance(boundary[key], bool) or boundary[key] <= 0:
            raise ReplayFailure(f"compaction_checkpoint.{key} must be a positive integer")

    turns = value["user_turns"]
    if not isinstance(turns, list) or not turns:
        raise ReplayFailure("user_turns must be a non-empty list")
    ids: set[str] = set()
    for row in turns:
        if not isinstance(row, dict) or set(row) != {"id", "content"}:
            raise ReplayFailure("each user_turn must contain exactly id and content")
        if not isinstance(row["id"], str) or not row["id"].strip() or row["id"] in ids:
            raise ReplayFailure("user_turn ids must be non-empty and unique")
        if not isinstance(row["content"], str) or not row["content"].strip():
            raise ReplayFailure("user_turn content must be non-empty")
        ids.add(row["id"])
    if boundary["after_user_turn"] != len(turns):
        raise ReplayFailure(
            "compaction checkpoint must follow the final replayed user turn "
            f"({len(turns)}), got {boundary['after_user_turn']}"
        )

    held_out = value["held_out_continuation"]
    if not isinstance(held_out, dict) or set(held_out) != {"id", "content"}:
        raise ReplayFailure("held_out_continuation must contain exactly id and content")
    if not isinstance(held_out["id"], str) or not held_out["id"].strip():
        raise ReplayFailure("held_out_continuation.id must be non-empty")
    if held_out["id"] in ids:
        raise ReplayFailure("held_out_continuation.id must be distinct from replay turn ids")
    if not isinstance(held_out["content"], str) or not held_out["content"].strip():
        raise ReplayFailure("held_out_continuation.content must be non-empty")
    return value


def _write_config(home: Path, *, compression_enabled: bool) -> None:
    home.mkdir(parents=True, exist_ok=True)
    # threshold_tokens=1 requests the earliest boundary Hermes permits. Hermes
    # still applies its own context-window/output-reservation safety floor and
    # runs its real summarizer; this does not synthesize a compacted transcript.
    (home / "config.yaml").write_text(
        "compression:\n"
        f"  enabled: {'true' if compression_enabled else 'false'}\n"
        "  threshold_tokens: 1\n"
        "  in_place: true\n"
        "  abort_on_summary_failure: true\n"
        "  protect_first_n: 0\n"
        "  protect_last_n: 1\n",
        encoding="utf-8",
    )


def _run_logged(
    argv: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    log_path: Path,
    timeout_seconds: int,
) -> subprocess.CompletedProcess[str]:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            argv,
            cwd=cwd,
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        log_path.write_text(
            (exc.stdout or "") + (exc.stderr or "") + f"\nTIMEOUT after {timeout_seconds}s\n",
            encoding="utf-8",
        )
        raise ReplayFailure(f"Hermes command timed out after {timeout_seconds}s: {argv[:3]}") from exc
    log_path.write_text(completed.stdout + completed.stderr, encoding="utf-8")
    if completed.returncode != 0:
        raise ReplayFailure(
            f"Hermes command failed with exit {completed.returncode}; see {log_path}"
        )
    completed.wall_time_seconds = time.monotonic() - started  # type: ignore[attr-defined]
    return completed


def _session_rows(db_path: Path, source: str) -> list[sqlite3.Row]:
    if not db_path.is_file():
        raise ReplayFailure(f"Hermes did not create its native session DB: {db_path}")
    with sqlite3.connect(db_path) as db:
        db.row_factory = sqlite3.Row
        return db.execute(
            "SELECT * FROM sessions WHERE source = ? ORDER BY started_at, id", (source,)
        ).fetchall()


def _session_tip(db_path: Path, source: str) -> str:
    rows = _session_rows(db_path, source)
    if not rows:
        raise ReplayFailure(f"Hermes created no native session for source {source!r}")
    ids = {str(row["id"]) for row in rows}
    parents = {str(row["parent_session_id"]) for row in rows if row["parent_session_id"]}
    tips = sorted(ids - parents)
    return tips[-1] if tips else str(rows[-1]["id"])


def _compression_evidence(db_path: Path, source: str) -> dict[str, Any]:
    rows = _session_rows(db_path, source)
    ids = [str(row["id"]) for row in rows]
    placeholders = ",".join("?" for _ in ids)
    with sqlite3.connect(db_path) as db:
        inactive, compacted = db.execute(
            f"SELECT COALESCE(SUM(active = 0), 0), COALESCE(SUM(compacted = 1), 0) "
            f"FROM messages WHERE session_id IN ({placeholders})",
            ids,
        ).fetchone()
    return {
        "native_session_ids": ids,
        "inactive_message_rows": int(inactive),
        "compacted_message_rows": int(compacted),
        "in_place": len(ids) == 1,
        "crossed": int(inactive) > 0 and int(compacted) > 0,
    }


def _collect_accounting(db_path: Path, source: str) -> dict[str, Any]:
    rows = _session_rows(db_path, source)
    ids = [str(row["id"]) for row in rows]
    placeholders = ",".join("?" for _ in ids)
    with sqlite3.connect(db_path) as db:
        db.row_factory = sqlite3.Row
        usage_exists = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_model_usage'"
        ).fetchone()
        usage_rows = []
        if usage_exists:
            usage_rows = db.execute(
                f"SELECT * FROM session_model_usage WHERE session_id IN ({placeholders})",
                ids,
            ).fetchall()

    if usage_rows:
        input_tokens = sum(int(row["input_tokens"] or 0) for row in usage_rows)
        output_tokens = sum(int(row["output_tokens"] or 0) for row in usage_rows)
        cache_read_tokens = sum(int(row["cache_read_tokens"] or 0) for row in usage_rows)
        cache_write_tokens = sum(int(row["cache_write_tokens"] or 0) for row in usage_rows)
        api_calls = sum(int(row["api_call_count"] or 0) for row in usage_rows)
        main_rows = [row for row in usage_rows if not str(row["task"] or "")]
        models = sorted({str(row["model"]) for row in main_rows if row["model"]})
        providers = sorted(
            {str(row["billing_provider"]) for row in main_rows if row["billing_provider"]}
        )
    else:
        input_tokens = sum(int(row["input_tokens"] or 0) for row in rows)
        output_tokens = sum(int(row["output_tokens"] or 0) for row in rows)
        cache_read_tokens = sum(int(row["cache_read_tokens"] or 0) for row in rows)
        cache_write_tokens = sum(int(row["cache_write_tokens"] or 0) for row in rows)
        api_calls = sum(int(row["api_call_count"] or 0) for row in rows)
        models = sorted({str(row["model"]) for row in rows if row["model"]})
        providers = sorted(
            {str(row["billing_provider"]) for row in rows if row["billing_provider"]}
        )

    actual_costs = [float(row["actual_cost_usd"]) for row in rows if row["actual_cost_usd"] is not None]
    estimated_costs = [
        float(row["estimated_cost_usd"]) for row in rows if row["estimated_cost_usd"] is not None
    ]
    if models != [EXACT_MODEL]:
        raise ReplayFailure(f"Hermes resolved model mismatch: expected {EXACT_MODEL!r}, got {models!r}")
    if providers != [EXACT_PROVIDER]:
        raise ReplayFailure(
            f"Hermes resolved provider mismatch: expected {EXACT_PROVIDER!r}, got {providers!r}"
        )
    if input_tokens + output_tokens <= 0:
        raise ReplayFailure("Hermes completed with zero accounted model tokens")
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read_tokens,
        "cache_write_tokens": cache_write_tokens,
        "api_calls": api_calls,
        "resolved_model": models[0],
        "resolved_provider": providers[0],
        "provider_cost_supported": bool(actual_costs),
        "provider_cost_usd": sum(actual_costs) if actual_costs else None,
        "estimated_cost_usd": sum(estimated_costs) if estimated_costs else None,
    }


def _write_transcript(db_path: Path, source: str, output: Path) -> None:
    rows = _session_rows(db_path, source)
    ids = [str(row["id"]) for row in rows]
    placeholders = ",".join("?" for _ in ids)
    with sqlite3.connect(db_path) as db:
        db.row_factory = sqlite3.Row
        messages = db.execute(
            f"SELECT * FROM messages WHERE session_id IN ({placeholders}) ORDER BY id", ids
        ).fetchall()
    with output.open("w", encoding="utf-8") as handle:
        for row in messages:
            handle.write(json.dumps(dict(row), ensure_ascii=False, sort_keys=True) + "\n")


def _write_patch(cwd: Path, output: Path) -> None:
    tracked = subprocess.run(
        ["git", "diff", "--binary", "HEAD", "--"],
        cwd=cwd,
        text=True,
        capture_output=True,
        check=False,
    )
    if tracked.returncode != 0:
        raise ReplayFailure(f"cannot capture final git patch: {tracked.stderr.strip()}")
    chunks = [tracked.stdout]
    untracked = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard", "-z"],
        cwd=cwd,
        capture_output=True,
        check=False,
    )
    if untracked.returncode != 0:
        raise ReplayFailure("cannot enumerate untracked files for final patch")
    for raw_path in untracked.stdout.split(b"\0"):
        if not raw_path:
            continue
        path = os.fsdecode(raw_path)
        diff = subprocess.run(
            ["git", "diff", "--binary", "--no-index", "--", "/dev/null", path],
            cwd=cwd,
            text=True,
            capture_output=True,
            check=False,
        )
        if diff.returncode not in (0, 1):
            raise ReplayFailure(f"cannot capture untracked file in patch: {path}")
        chunks.append(diff.stdout)
    output.write_text("".join(chunks), encoding="utf-8")


def run_replay(
    *,
    hermes: Path,
    auth_path: Path,
    replay_path: Path,
    cwd: Path,
    logs_dir: Path,
    timeout_seconds: int,
) -> dict[str, Any]:
    started = time.monotonic()
    logs_dir.mkdir(parents=True, exist_ok=True)
    result_path = logs_dir / "hermes-result.json"
    result: dict[str, Any] = {"completed": False, "failed": True}
    try:
        manifest = load_replay_manifest(replay_path)
        replay_manifest_sha256 = hashlib.sha256(replay_path.read_bytes()).hexdigest()
        if not auth_path.is_file() or auth_path.stat().st_size == 0:
            raise ReplayFailure(f"Hermes auth path is unavailable or empty: {auth_path}")
        if not hermes.is_file() or not os.access(hermes, os.X_OK):
            raise ReplayFailure(f"Hermes executable is unavailable: {hermes}")

        home = logs_dir / "hermes-home"
        home.mkdir(parents=True, exist_ok=True)
        (home / ".env").write_bytes(auth_path.read_bytes())
        os.chmod(home / ".env", 0o600)
        env = dict(os.environ)
        env["HERMES_HOME"] = str(home)
        source_hash = hashlib.sha256(manifest["source_session_id"].encode()).hexdigest()[:16]
        source = f"deepswe-hermes-{source_hash}"

        version = _run_logged(
            [str(hermes), "--version"],
            cwd=cwd,
            env=env,
            log_path=logs_dir / "version.txt",
            timeout_seconds=30,
        ).stdout.strip()
        help_result = _run_logged(
            [str(hermes), "chat", "--help"],
            cwd=cwd,
            env=env,
            log_path=logs_dir / "capabilities.txt",
            timeout_seconds=30,
        )
        help_text = help_result.stdout + help_result.stderr
        required_help = ("--provider", "--model", "--resume", "--query", EXACT_PROVIDER)
        missing_help = [item for item in required_help if item not in help_text]
        if missing_help:
            raise ReplayFailure(
                "Hermes cannot prove the exact model/provider/resume path; "
                f"chat --help is missing {missing_help!r}"
            )

        _write_config(home, compression_enabled=False)
        db_path = home / "state.db"
        session_id: str | None = None
        phase_timings: list[dict[str, Any]] = []
        boundary_turn = manifest["compaction_checkpoint"]["after_user_turn"]
        for index, turn in enumerate(manifest["user_turns"], start=1):
            if index == boundary_turn:
                _write_config(home, compression_enabled=True)
            argv = [
                str(hermes),
                "chat",
                "--quiet",
                "--yolo",
                "--provider",
                EXACT_PROVIDER,
                "--model",
                EXACT_MODEL,
                "--source",
                source,
                "--query",
                turn["content"],
            ]
            if session_id:
                argv.extend(["--resume", session_id])
            phase_started = time.monotonic()
            _run_logged(
                argv,
                cwd=cwd,
                env=env,
                log_path=logs_dir / f"replay-{index:04d}.txt",
                timeout_seconds=timeout_seconds,
            )
            session_id = _session_tip(db_path, source)
            phase_timings.append(
                {"kind": "replay", "turn_id": turn["id"], "wall_time_seconds": time.monotonic() - phase_started}
            )

        compaction = _compression_evidence(db_path, source)
        if not compaction["crossed"]:
            raise ReplayFailure(
                "Hermes did not cross its native compaction boundary at the matched checkpoint"
            )
        # The boundary is crossed exactly once for the comparison. The held-out
        # continuation resumes the compacted native session without forcing a
        # second boundary.
        _write_config(home, compression_enabled=False)
        held_out = manifest["held_out_continuation"]
        continuation_argv = [
            str(hermes),
            "chat",
            "--quiet",
            "--yolo",
            "--provider",
            EXACT_PROVIDER,
            "--model",
            EXACT_MODEL,
            "--source",
            source,
            "--query",
            held_out["content"],
            "--resume",
            session_id or "",
        ]
        continuation_started = time.monotonic()
        continuation = _run_logged(
            continuation_argv,
            cwd=cwd,
            env=env,
            log_path=logs_dir / "continuation.txt",
            timeout_seconds=timeout_seconds,
        )
        phase_timings.append(
            {"kind": "continuation", "turn_id": held_out["id"], "wall_time_seconds": time.monotonic() - continuation_started}
        )

        accounting = _collect_accounting(db_path, source)
        transcript_path = logs_dir / "transcript.jsonl"
        patch_path = logs_dir / "final.patch"
        _write_transcript(db_path, source, transcript_path)
        _write_patch(cwd, patch_path)
        combined_log_path = logs_dir / "hermes.log"
        log_parts = []
        for phase_log in (
            [logs_dir / "version.txt", logs_dir / "capabilities.txt"]
            + sorted(logs_dir.glob("replay-*.txt"))
            + [logs_dir / "continuation.txt"]
        ):
            log_parts.append(f"===== {phase_log.name} =====\n")
            log_parts.append(phase_log.read_text(encoding="utf-8", errors="replace"))
            if not log_parts[-1].endswith("\n"):
                log_parts.append("\n")
        combined_log_path.write_text("".join(log_parts), encoding="utf-8")
        result = {
            "completed": True,
            "failed": False,
            "hermes_version": version,
            **accounting,
            "wall_time_seconds": time.monotonic() - started,
            "phase_timings": phase_timings,
            "source_session_id": manifest["source_session_id"],
            "source_session_artifacts": manifest["source_session_artifacts"],
            "repository_checkpoint": manifest["repository_checkpoint"],
            "repository_checkpoint_sha256": manifest["repository_checkpoint_sha256"],
            "replay_manifest_sha256": replay_manifest_sha256,
            "compaction_checkpoint": manifest["compaction_checkpoint"],
            "replayed_user_turn_ids": [turn["id"] for turn in manifest["user_turns"]],
            "held_out_continuation_id": held_out["id"],
            "compaction_evidence": compaction,
            "native_compaction": {
                "native": True,
                "artifact": str(transcript_path),
                "before_tokens": None,
                "after_tokens": None,
            },
            "forced_threshold_tokens": 1,
            "patch_path": str(patch_path),
            "transcript_path": str(transcript_path),
            "log_path": str(combined_log_path),
            "continuation_artifact": str(logs_dir / "continuation.txt"),
            "qualitative_score": None,
            "recovery_reads": None,
            "recovery_tokens": None,
            "final_response": continuation.stdout,
            "artifacts": {
                "transcript": str(transcript_path),
                "patch": str(patch_path),
                "result": str(result_path),
                "capabilities": str(logs_dir / "capabilities.txt"),
                "version": str(logs_dir / "version.txt"),
                "log": str(combined_log_path),
                "continuation": str(logs_dir / "continuation.txt"),
                "hermes_home": str(home),
            },
        }
        return result
    except Exception as exc:
        result.update(
            {
                "error_type": type(exc).__name__,
                "error": str(exc),
                "wall_time_seconds": time.monotonic() - started,
            }
        )
        raise
    finally:
        result_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes", type=Path, required=True)
    parser.add_argument("--auth", type=Path, required=True)
    parser.add_argument("--replay", type=Path, required=True)
    parser.add_argument("--cwd", type=Path, required=True)
    parser.add_argument("--logs", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=int, required=True)
    args = parser.parse_args(argv)
    try:
        result = run_replay(
            hermes=args.hermes,
            auth_path=args.auth,
            replay_path=args.replay,
            cwd=args.cwd,
            logs_dir=args.logs,
            timeout_seconds=args.timeout_seconds,
        )
    except Exception as exc:
        print(f"Hermes replay failed: {exc}", file=sys.stderr)
        return 1
    sys.stdout.write(result["final_response"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
