"""Drive a real Veyyon print-mode session across a native compaction boundary."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

EXACT_MODEL = "google-antigravity/gemini-3.6-flash"
ROOT_KEYS = {
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
CHECKPOINT_KEYS = {
    "after_user_turn",
    "source_boundary_id",
    "source_threshold_tokens",
    "source_context_tokens",
}
TURN_KEYS = {"id", "content"}


class VeyyonReplayError(RuntimeError):
    """The replay cannot satisfy the cross-system comparison contract."""

    def __init__(self, message: str, exit_status: int = 1) -> None:
        super().__init__(message)
        self.exit_status = exit_status


def _positive_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _validate_turn(value: Any, label: str) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != TURN_KEYS:
        raise VeyyonReplayError(f"{label} must contain exactly id and content")
    turn_id = value.get("id")
    content = value.get("content")
    if not isinstance(turn_id, str) or not turn_id.strip():
        raise VeyyonReplayError(f"{label}.id must be non-empty text")
    if not isinstance(content, str) or not content.strip():
        raise VeyyonReplayError(f"{label}.content must be non-empty text")
    return {"id": turn_id, "content": content}


def load_replay_manifest(path: Path, model: str = EXACT_MODEL) -> tuple[dict[str, Any], bytes, str]:
    """Load the exact shared manifest bytes and enforce its closed schema."""

    manifest_bytes = path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if not isinstance(manifest, dict) or set(manifest) != ROOT_KEYS:
        raise VeyyonReplayError(
            "replay manifest must be an object containing exactly the shared replay schema keys"
        )
    if manifest.get("schema_version") != 1:
        raise VeyyonReplayError("replay manifest schema_version must be 1")
    if model != EXACT_MODEL or manifest.get("model") != EXACT_MODEL:
        raise VeyyonReplayError(
            f"replay model must be exactly {EXACT_MODEL}; aliases and fallback are not permitted"
        )
    source_session_id = manifest.get("source_session_id")
    if not isinstance(source_session_id, str) or not source_session_id.strip():
        raise VeyyonReplayError("source_session_id must be non-empty text")
    source_artifacts = manifest.get("source_session_artifacts")
    if (
        not isinstance(source_artifacts, list)
        or not source_artifacts
        or any(not isinstance(item, str) or not item.strip() or not Path(item).is_absolute() for item in source_artifacts)
    ):
        raise VeyyonReplayError(
            "source_session_artifacts must be a non-empty list of absolute paths"
        )
    repository_checkpoint = manifest.get("repository_checkpoint")
    if not isinstance(repository_checkpoint, str) or not Path(repository_checkpoint).is_absolute():
        raise VeyyonReplayError("repository_checkpoint must be an absolute path")
    checkpoint_sha = manifest.get("repository_checkpoint_sha256")
    if (
        not isinstance(checkpoint_sha, str)
        or len(checkpoint_sha) != 64
        or any(character not in "0123456789abcdef" for character in checkpoint_sha)
    ):
        raise VeyyonReplayError(
            "repository_checkpoint_sha256 must be 64 lowercase hexadecimal characters"
        )
    checkpoint = manifest.get("compaction_checkpoint")
    if not isinstance(checkpoint, dict) or set(checkpoint) != CHECKPOINT_KEYS:
        raise VeyyonReplayError(
            "compaction_checkpoint must contain exactly after_user_turn, source_boundary_id, "
            "source_threshold_tokens, and source_context_tokens"
        )
    for key in ("after_user_turn", "source_threshold_tokens", "source_context_tokens"):
        if not _positive_integer(checkpoint.get(key)):
            raise VeyyonReplayError(f"compaction_checkpoint.{key} must be a positive integer")
    boundary_id = checkpoint.get("source_boundary_id")
    if not isinstance(boundary_id, str) or not boundary_id.strip():
        raise VeyyonReplayError("compaction_checkpoint.source_boundary_id must be non-empty text")
    if checkpoint["source_context_tokens"] < checkpoint["source_threshold_tokens"]:
        raise VeyyonReplayError(
            "source_context_tokens must meet or exceed the source compaction threshold"
        )
    turns = manifest.get("user_turns")
    if not isinstance(turns, list) or not turns:
        raise VeyyonReplayError("user_turns must contain ordered source user turns")
    validated_turns = [_validate_turn(turn, f"user_turns[{index}]") for index, turn in enumerate(turns)]
    turn_ids = [turn["id"] for turn in validated_turns]
    if len(set(turn_ids)) != len(turn_ids):
        raise VeyyonReplayError("user_turns ids must be unique")
    if checkpoint["after_user_turn"] != len(validated_turns):
        raise VeyyonReplayError(
            "compaction_checkpoint.after_user_turn must equal the frozen replay prefix length"
        )
    held_out = _validate_turn(manifest.get("held_out_continuation"), "held_out_continuation")
    manifest["user_turns"] = validated_turns
    manifest["held_out_continuation"] = held_out
    return manifest, manifest_bytes, hashlib.sha256(manifest_bytes).hexdigest()


def _process_status(returncode: int) -> int:
    return returncode if returncode >= 0 else 128 - returncode


def _run_print_mode(
    binary: Path,
    config: Path,
    model: str,
    session_dir: Path,
    repo: Path,
    messages: list[str],
    timeout_seconds: float,
    resume: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    command = [
        str(binary),
        "--model",
        model,
        "--compaction-model",
        model,
        "--subagent-model",
        model,
        "--auto-approve",
        "--config",
        str(config),
        "--session-dir",
        str(session_dir),
        "--mode",
        "json",
        "--print",
    ]
    if resume is not None:
        command.extend(["--resume", str(resume)])
    command.append("--")
    command.extend(messages)
    try:
        return subprocess.run(
            command,
            cwd=repo,
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as error:
        raise VeyyonReplayError(
            f"Veyyon print-mode phase timed out after {timeout_seconds:g} seconds", 124
        ) from error


def _read_session(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    raw_lines = path.read_text(encoding="utf-8").splitlines()
    entries: list[dict[str, Any]] = []
    for index, line in enumerate(raw_lines, start=1):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as error:
            raise VeyyonReplayError(
                f"persisted Veyyon session contains invalid JSON on line {index}: {path}"
            ) from error
        if not isinstance(entry, dict):
            raise VeyyonReplayError(
                f"persisted Veyyon session contains a non-object entry on line {index}: {path}"
            )
        entries.append(entry)
    if not entries or entries[0].get("type") != "session":
        raise VeyyonReplayError(f"persisted Veyyon session has no session header: {path}")
    return entries, raw_lines


def _message_text(message: dict[str, Any]) -> str | None:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "".join(parts)


def _ordered_user_messages(entries: list[dict[str, Any]]) -> list[tuple[int, str]]:
    values: list[tuple[int, str]] = []
    for index, entry in enumerate(entries):
        message = entry.get("message") if entry.get("type") == "message" else None
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        text = _message_text(message)
        if text is None:
            raise VeyyonReplayError("persisted source user message has no textual content")
        values.append((index, text))
    return values


def _assistant_messages(session_root: Path) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    for session_file in sorted(session_root.rglob("*.jsonl")):
        entries, _ = _read_session(session_file)
        for entry in entries:
            message = entry.get("message") if entry.get("type") == "message" else None
            if isinstance(message, dict) and message.get("role") == "assistant":
                messages.append(message)
    return messages


def _usage_number(usage: dict[str, Any], key: str) -> int:
    value = usage.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise VeyyonReplayError(
            f"persisted Veyyon assistant usage is missing exact non-negative {key} telemetry"
        )
    return value


def _collect_accounting(session_root: Path, model: str) -> dict[str, Any]:
    messages = _assistant_messages(session_root)
    if not messages:
        raise VeyyonReplayError("Veyyon persisted no assistant messages or token telemetry")
    input_tokens = output_tokens = cache_read_tokens = cache_write_tokens = 0
    cost_usd = 0.0
    for message in messages:
        resolved = f"{message.get('provider')}/{message.get('model')}"
        if resolved != model:
            raise VeyyonReplayError(
                f"Veyyon persisted resolved model {resolved!r}, not required {model!r}; "
                "aliases and fallback are not permitted"
            )
        usage = message.get("usage")
        if not isinstance(usage, dict):
            raise VeyyonReplayError("persisted Veyyon assistant message has no usage telemetry")
        input_tokens += _usage_number(usage, "input")
        output_tokens += _usage_number(usage, "output")
        cache_read_tokens += _usage_number(usage, "cacheRead")
        cache_write_tokens += _usage_number(usage, "cacheWrite")
        cost = usage.get("cost")
        total = cost.get("total") if isinstance(cost, dict) else None
        if not isinstance(total, (int, float)) or isinstance(total, bool) or total < 0:
            raise VeyyonReplayError(
                "persisted Veyyon assistant usage is missing exact non-negative cost.total telemetry"
            )
        cost_usd += float(total)
    if input_tokens <= 0 or output_tokens <= 0:
        raise VeyyonReplayError(
            "Veyyon completed with zero input/output tokens; rejecting infrastructure failure"
        )
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read_tokens,
        "cache_write_tokens": cache_write_tokens,
        "cache_tokens": cache_read_tokens + cache_write_tokens,
        "cost_usd": cost_usd,
        "provider_cost_usd": cost_usd,
        "provider_cost_supported": True,
        "provider_cost_unsupported_reason": None,
        "estimated_cost_usd": None,
        "api_calls": len(messages),
    }


def _continuation_prompt_tokens(entries: list[dict[str, Any]], continuation_index: int) -> int:
    for entry in entries[continuation_index + 1 :]:
        message = entry.get("message") if entry.get("type") == "message" else None
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        usage = message.get("usage")
        if not isinstance(usage, dict):
            raise VeyyonReplayError("continuation assistant message has no exact usage telemetry")
        return sum(_usage_number(usage, key) for key in ("input", "cacheRead", "cacheWrite"))
    raise VeyyonReplayError("held-out continuation produced no persisted assistant response")


def _write_patch(repo: Path, path: Path) -> None:
    patch = subprocess.run(
        ["git", "diff", "--binary", "HEAD"],
        cwd=repo,
        text=True,
        capture_output=True,
        check=False,
    )
    path.write_text(patch.stdout, encoding="utf-8")
    if patch.returncode != 0:
        raise VeyyonReplayError(
            f"git diff failed with status {patch.returncode}: {patch.stderr.strip()}",
            _process_status(patch.returncode),
        )


def run_replay(args: argparse.Namespace) -> dict[str, Any]:
    started = time.monotonic()
    binary = Path(args.binary).resolve()
    config = Path(args.config).resolve()
    manifest_path = Path(args.manifest).resolve()
    repo = Path(args.repo).resolve()
    logs = Path(args.logs).resolve()
    logs.mkdir(parents=True, exist_ok=True)
    if args.model != EXACT_MODEL:
        raise VeyyonReplayError(
            f"Veyyon replay requires exactly {EXACT_MODEL}; got {args.model!r}"
        )
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise VeyyonReplayError(f"Veyyon binary is unavailable or not executable: {binary}")
    if not config.is_file():
        raise VeyyonReplayError(f"Veyyon config overlay is unavailable: {config}")
    manifest, manifest_bytes, manifest_sha = load_replay_manifest(manifest_path, args.model)
    worktree = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=repo,
        text=True,
        capture_output=True,
        check=False,
    )
    if worktree.returncode != 0 or worktree.stdout.strip() != "true":
        raise VeyyonReplayError(f"uploaded task repository is not a git worktree: {repo}")
    version = subprocess.run(
        [str(binary), "--version"], text=True, capture_output=True, check=False
    )
    if version.returncode != 0:
        raise VeyyonReplayError(
            f"Veyyon binary version check failed with status {version.returncode}: {version.stderr.strip()}",
            _process_status(version.returncode),
        )
    veyyon_version = version.stdout.strip() or version.stderr.strip()

    session_root = logs / "veyyon-sessions"
    if session_root.exists() and any(session_root.iterdir()):
        raise VeyyonReplayError(
            f"Veyyon replay session directory must start empty: {session_root}"
        )
    session_root.mkdir(parents=True, exist_ok=True)
    prefix_turns = manifest["user_turns"]
    prefix_messages = [turn["content"] for turn in prefix_turns]
    prefix_started = time.monotonic()
    prefix = _run_print_mode(
        binary,
        config,
        args.model,
        session_root,
        repo,
        [*prefix_messages, "/compact summary"],
        args.turn_timeout_seconds,
    )
    prefix_elapsed = time.monotonic() - prefix_started
    sys.stdout.write(prefix.stdout)
    sys.stderr.write(prefix.stderr)
    if prefix.returncode != 0:
        status = _process_status(prefix.returncode)
        raise VeyyonReplayError(
            f"Veyyon frozen-prefix/compaction process exited with status {status}", status
        )
    main_sessions = sorted(session_root.glob("*.jsonl"))
    if len(main_sessions) != 1:
        raise VeyyonReplayError(
            f"Veyyon replay expected exactly one persisted main session, found {len(main_sessions)}"
        )
    session_path = main_sessions[0]
    before_entries, _ = _read_session(session_path)
    initial_session_id = before_entries[0].get("id")
    if not isinstance(initial_session_id, str) or not initial_session_id:
        raise VeyyonReplayError("persisted Veyyon session header has no session id")
    persisted_prefix = _ordered_user_messages(before_entries)
    if [text for _, text in persisted_prefix] != prefix_messages:
        raise VeyyonReplayError(
            "persisted Veyyon prefix is not the manifest's ordered USER-only turn sequence"
        )
    compactions = [
        (index, entry)
        for index, entry in enumerate(before_entries)
        if entry.get("type") == "compaction"
    ]
    if len(compactions) != 1:
        raise VeyyonReplayError(
            f"/compact summary did not persist exactly one new native compaction entry; found {len(compactions)}"
        )
    compaction_index, compaction_entry = compactions[0]
    if persisted_prefix[-1][0] >= compaction_index:
        raise VeyyonReplayError("native compaction was not persisted after the frozen prefix")
    tokens_before = compaction_entry.get("tokensBefore")
    if not _positive_integer(tokens_before):
        raise VeyyonReplayError(
            "native compaction entry has no measurable positive tokensBefore context"
        )
    for key in ("id", "summary", "firstKeptEntryId"):
        if not isinstance(compaction_entry.get(key), str) or not compaction_entry[key]:
            raise VeyyonReplayError(f"native compaction entry is missing {key}")

    continuation = manifest["held_out_continuation"]
    continuation_offset = session_path.stat().st_size
    continuation_started = time.monotonic()
    continued = _run_print_mode(
        binary,
        config,
        args.model,
        session_root,
        repo,
        [continuation["content"]],
        args.turn_timeout_seconds,
        resume=session_path,
    )
    continuation_elapsed = time.monotonic() - continuation_started
    sys.stdout.write(continued.stdout)
    sys.stderr.write(continued.stderr)
    if continued.returncode != 0:
        status = _process_status(continued.returncode)
        raise VeyyonReplayError(
            f"Veyyon held-out continuation process exited with status {status}", status
        )
    after_entries, _ = _read_session(session_path)
    if after_entries[0].get("id") != initial_session_id:
        raise VeyyonReplayError("held-out continuation did not resume the original Veyyon session")
    after_main_sessions = sorted(session_root.glob("*.jsonl"))
    if after_main_sessions != [session_path]:
        raise VeyyonReplayError("held-out continuation created a second Veyyon main session")
    persisted_users = _ordered_user_messages(after_entries)
    expected_users = [*prefix_messages, continuation["content"]]
    if [text for _, text in persisted_users] != expected_users:
        raise VeyyonReplayError(
            "persisted Veyyon session does not preserve prefix/compaction/continuation ordering"
        )
    continuation_index = persisted_users[-1][0]
    if continuation_index <= compaction_index:
        raise VeyyonReplayError("held-out continuation was not persisted after native compaction")
    final_compactions = [entry for entry in after_entries if entry.get("type") == "compaction"]
    if len(final_compactions) != 1 or final_compactions[0].get("id") != compaction_entry["id"]:
        raise VeyyonReplayError("native compaction entry changed or disappeared after resume")
    tokens_after = _continuation_prompt_tokens(after_entries, continuation_index)
    if tokens_after <= 0 or tokens_after >= tokens_before:
        raise VeyyonReplayError(
            f"native compaction did not measurably reduce context: before={tokens_before}, after={tokens_after}"
        )

    transcript_path = logs / "veyyon-transcript.jsonl"
    transcript_path.write_bytes(session_path.read_bytes())
    continuation_artifact = logs / "veyyon-continuation.jsonl"
    session_bytes = session_path.read_bytes()
    if len(session_bytes) <= continuation_offset:
        raise VeyyonReplayError("held-out continuation produced no persisted session slice")
    continuation_artifact.write_bytes(session_bytes[continuation_offset:])
    stdout_transcript = logs / "veyyon-print-events.jsonl"
    stdout_transcript.write_text(prefix.stdout + continued.stdout, encoding="utf-8")
    compaction_artifact = logs / "veyyon-compaction.json"
    compaction_evidence = {
        "native": True,
        "method": "/compact summary",
        "session_id": initial_session_id,
        "entry": compaction_entry,
        "before_tokens": tokens_before,
        "after_tokens": tokens_after,
    }
    compaction_artifact.write_text(
        json.dumps(compaction_evidence, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    patch_path = logs / "veyyon.patch"
    _write_patch(repo, patch_path)
    accounting = _collect_accounting(session_root, args.model)
    result_path = logs / "veyyon-result.json"
    result = {
        "completed": True,
        "failed": False,
        "veyyon_version": veyyon_version,
        "wall_time_seconds": time.monotonic() - started,
        "phase_timings": [
            {"kind": "prefix_and_native_compaction", "wall_time_seconds": prefix_elapsed},
            {
                "kind": "continuation",
                "turn_id": continuation["id"],
                "wall_time_seconds": continuation_elapsed,
            },
        ],
        "resolved_model": args.model,
        "resolved_provider": "google-antigravity",
        "initial_session_id": initial_session_id,
        "source_session_id": manifest["source_session_id"],
        "source_session_artifacts": manifest["source_session_artifacts"],
        "repository_checkpoint": manifest["repository_checkpoint"],
        "repository_checkpoint_sha256": manifest["repository_checkpoint_sha256"],
        "replay_manifest_sha256": manifest_sha,
        "replay_manifest_size_bytes": len(manifest_bytes),
        "compaction_checkpoint": manifest["compaction_checkpoint"],
        "source_compaction_checkpoint": manifest["compaction_checkpoint"],
        "compaction_after_user_turn": manifest["compaction_checkpoint"]["after_user_turn"],
        "prefix_turns": len(prefix_turns),
        "replayed_user_turn_ids": [turn["id"] for turn in prefix_turns],
        "held_out_continuation_id": continuation["id"],
        "native_compaction": {
            "native": True,
            "artifact": str(compaction_artifact),
            "entry_id": compaction_entry["id"],
            "before_tokens": tokens_before,
            "after_tokens": tokens_after,
        },
        "compaction_evidence": compaction_evidence,
        **accounting,
        "exit_status": continued.returncode,
        "prefix_exit_status": prefix.returncode,
        "continuation_exit_status": continued.returncode,
        "qualitative_score": None,
        "recovery_reads": None,
        "recovery_tokens": None,
        "recovery_attribution_supported": False,
        "recovery_attribution_unsupported_reason": (
            "persisted Veyyon usage is exact per assistant call but does not attribute tokens "
            "to individual recovery reads"
        ),
        "patch_path": str(patch_path),
        "transcript_path": str(transcript_path),
        "log_path": str(logs / "veyyon.txt"),
        "continuation_artifact": str(continuation_artifact),
        "artifacts": {
            "result": str(result_path),
            "native_compaction": str(compaction_artifact),
            "transcript": str(transcript_path),
            "continuation": str(continuation_artifact),
            "print_events": str(stdout_transcript),
            "patch": str(patch_path),
            "sessions": str(session_root),
            "log": str(logs / "veyyon.txt"),
        },
    }
    result_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--logs", required=True)
    parser.add_argument("--model", default=EXACT_MODEL)
    parser.add_argument("--turn-timeout-seconds", type=float, default=3600)
    args = parser.parse_args()
    try:
        result = run_replay(args)
    except VeyyonReplayError as error:
        print(f"veyyon replay failed: {error}", file=sys.stderr)
        return error.exit_status
    except (OSError, json.JSONDecodeError) as error:
        print(f"veyyon replay failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
