"""Drive a Factory CLI replay through its native JSON-RPC session boundary."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, TextIO

EXACT_MODEL = "google-antigravity/gemini-3.6-flash"
COST_UNSUPPORTED_REASON = (
    "Factory stream-jsonrpc token telemetry does not report provider cost; "
    "no price is inferred"
)


class FactoryReplayError(RuntimeError):
    """A run cannot satisfy the cross-system replay contract."""
    def __init__(self, message: str, exit_status: int = 1) -> None:
        super().__init__(message)
        self.exit_status = exit_status


class JsonRpcSession:
    def __init__(
        self,
        process: subprocess.Popen[str],
        transcript: TextIO,
        timeout_seconds: float,
    ) -> None:
        self.process = process
        self.transcript = transcript
        self.timeout_seconds = timeout_seconds
        self.next_id = 1
        self.usage_by_session: dict[str, dict[str, Any]] = {}
        self.cost_by_session: dict[str, float] = {}

    def _send(self, method: str, params: dict[str, Any]) -> str:
        request_id = str(self.next_id)
        self.next_id += 1
        message = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        }
        encoded = json.dumps(message, separators=(",", ":"))
        self.transcript.write(f"> {encoded}\n")
        self.transcript.flush()
        assert self.process.stdin is not None
        self.process.stdin.write(encoded + "\n")
        self.process.stdin.flush()
        return request_id

    def _read(self, deadline: float) -> dict[str, Any]:
        assert self.process.stdout is not None
        while time.monotonic() < deadline:
            line = self.process.stdout.readline()
            if not line:
                status = self.process.poll()
                if status is not None:
                    stderr = self.process.stderr.read() if self.process.stderr else ""
                    raise FactoryReplayError(
                        f"Factory JSON-RPC process exited with status {status}: {stderr.strip()}",
                        exit_status=status,
                    )
                time.sleep(0.01)
                continue
            self.transcript.write(f"< {line}")
            self.transcript.flush()
            try:
                message = json.loads(line)
            except json.JSONDecodeError as error:
                raise FactoryReplayError(
                    f"Factory emitted non-JSON stream-jsonrpc output: {line.rstrip()}"
                ) from error
            if not isinstance(message, dict):
                raise FactoryReplayError("Factory emitted a non-object JSON-RPC message")
            self._observe(message)
            return message
        raise FactoryReplayError("Factory JSON-RPC response timed out")

    def _observe(self, message: dict[str, Any]) -> None:
        if message.get("method") in {"droid.request_permission", "droid.ask_user"}:
            raise FactoryReplayError(
                f"Factory requested interactive input despite --skip-permissions-unsafe: "
                f"{message.get('method')}"
            )
        if message.get("method") != "droid.session_notification":
            return
        params = message.get("params")
        notification = params.get("notification") if isinstance(params, dict) else None
        if not isinstance(notification, dict):
            return
        if notification.get("type") == "error":
            raise FactoryReplayError(
                f"Factory session error: {notification.get('message', 'unknown error')}"
            )
        if notification.get("type") == "session_token_usage_changed":
            usage = notification.get("tokenUsage")
            session_id = notification.get("sessionId")
            if isinstance(usage, dict) and isinstance(session_id, str):
                self.usage_by_session[session_id] = usage
                for key in ("costUsd", "cost_usd"):
                    value = usage.get(key)
                    if isinstance(value, (int, float)) and not isinstance(value, bool):
                        self.cost_by_session[session_id] = float(value)

    def total_usage(self) -> dict[str, int | None]:
        keys = (
            "inputTokens",
            "outputTokens",
            "cacheCreationTokens",
            "cacheReadTokens",
            "thinkingTokens",
        )
        return {
            key: (
                sum(usage[key] for usage in self.usage_by_session.values())
                if self.usage_by_session
                and all(
                    isinstance(usage.get(key), int)
                    and not isinstance(usage.get(key), bool)
                    for usage in self.usage_by_session.values()
                )
                else None
            )
            for key in keys
        }

    def total_cost_usd(self) -> float | None:
        if not self.usage_by_session or len(self.cost_by_session) != len(
            self.usage_by_session
        ):
            return None
        return sum(self.cost_by_session.values())

    @staticmethod
    def _inner_notification(message: dict[str, Any]) -> dict[str, Any] | None:
        params = message.get("params")
        if message.get("method") != "droid.session_notification" or not isinstance(params, dict):
            return None
        value = params.get("notification")
        return value if isinstance(value, dict) else None

    def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = self._send(method, params)
        deadline = time.monotonic() + self.timeout_seconds
        while True:
            message = self._read(deadline)
            if str(message.get("id")) != request_id:
                continue
            if "error" in message:
                raise FactoryReplayError(
                    f"Factory rejected {method}: {json.dumps(message['error'], sort_keys=True)}"
                )
            result = message.get("result")
            if not isinstance(result, dict):
                raise FactoryReplayError(f"Factory returned no object result for {method}")
            return result

    def turn(self, text: str) -> None:
        request_id = self._send("droid.add_user_message", {"text": text})
        deadline = time.monotonic() + self.timeout_seconds
        response_seen = False
        working_seen = False
        while True:
            message = self._read(deadline)
            if str(message.get("id")) == request_id:
                if "error" in message:
                    raise FactoryReplayError(
                        "Factory rejected droid.add_user_message: "
                        + json.dumps(message["error"], sort_keys=True)
                    )
                response_seen = True
            notification = self._inner_notification(message)
            if notification and notification.get("type") == "droid_working_state_changed":
                state = notification.get("newState")
                if state != "idle":
                    working_seen = True
                elif response_seen and working_seen:
                    return


def _validate_manifest(
    manifest: Any, repo: Path, model: str
) -> tuple[list[str], int, str, str, str, list[str], dict[str, Any]]:
    if not isinstance(manifest, dict):
        raise FactoryReplayError("replay manifest must be a JSON object")
    if manifest.get("schema_version") != 1:
        raise FactoryReplayError("replay manifest schema_version must be 1")
    if manifest.get("model") != model:
        raise FactoryReplayError(
            f"replay manifest model must be the exact required selector {model}"
        )
    source_session_id = manifest.get("source_session_id")
    if not isinstance(source_session_id, str) or not source_session_id:
        raise FactoryReplayError("source_session_id must be a non-empty string")
    source_artifacts = manifest.get("source_session_artifacts")
    if (
        not isinstance(source_artifacts, list)
        or not source_artifacts
        or any(
            not isinstance(value, str) or not value.startswith("/")
            for value in source_artifacts
        )
    ):
        raise FactoryReplayError(
            "source_session_artifacts must be a non-empty array of absolute paths"
        )
    turns = manifest.get("user_turns")
    if not isinstance(turns, list) or not turns:
        raise FactoryReplayError("user_turns must be a non-empty array")
    inputs: list[str] = []
    for turn in turns:
        if not isinstance(turn, dict) or set(turn) != {"id", "content"}:
            raise FactoryReplayError("every user_turns entry must contain exactly id and content")
        if not isinstance(turn.get("id"), str) or not turn["id"]:
            raise FactoryReplayError("every user_turns entry must have a non-empty id")
        content = turn.get("content")
        if not isinstance(content, str) or not content.strip():
            raise FactoryReplayError("every user_turns entry must have non-empty content")
        inputs.append(content)
    compaction = manifest.get("compaction_checkpoint")
    required_checkpoint_keys = {
        "after_user_turn",
        "source_boundary_id",
        "source_threshold_tokens",
        "source_context_tokens",
    }
    if not isinstance(compaction, dict) or set(compaction) != required_checkpoint_keys:
        raise FactoryReplayError(
            "compaction_checkpoint must contain exactly after_user_turn, "
            "source_boundary_id, source_threshold_tokens, and source_context_tokens"
        )
    after_turn = compaction.get("after_user_turn")
    if (
        not isinstance(after_turn, int)
        or isinstance(after_turn, bool)
        or after_turn != len(inputs)
    ):
        raise FactoryReplayError(
            "compaction_checkpoint.after_user_turn must equal user_turns.length; "
            "the frozen prefix must end exactly at the source boundary"
        )
    held_out = manifest.get("held_out_continuation")
    if not isinstance(held_out, dict) or set(held_out) != {"id", "content"}:
        raise FactoryReplayError("held_out_continuation must contain exactly id and content")
    if not isinstance(held_out.get("id"), str) or not held_out["id"]:
        raise FactoryReplayError("held_out_continuation.id must be a non-empty string")
    continuation = held_out.get("content")
    if not isinstance(continuation, str) or not continuation.strip():
        raise FactoryReplayError(
            "held_out_continuation.content must be a non-empty string"
        )
    checkpoint = manifest.get("repository_checkpoint")
    if not isinstance(checkpoint, str) or not checkpoint.startswith("/"):
        raise FactoryReplayError("repository_checkpoint must be an absolute path")
    checkpoint_sha256 = manifest.get("repository_checkpoint_sha256")
    if (
        not isinstance(checkpoint_sha256, str)
        or len(checkpoint_sha256) != 64
        or any(character not in "0123456789abcdef" for character in checkpoint_sha256)
    ):
        raise FactoryReplayError(
            "repository_checkpoint_sha256 must be 64 lowercase hexadecimal characters"
        )
    completed = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=repo,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0 or completed.stdout.strip() != "true":
        raise FactoryReplayError(f"uploaded task repository is not a git worktree: {repo}")
    return (
        inputs,
        after_turn,
        continuation,
        source_session_id,
        checkpoint,
        source_artifacts,
        compaction,
    )


def _preflight(binary: Path, model: str, log_path: Path) -> str:
    version = subprocess.run(
        [str(binary), "--version"], text=True, capture_output=True, check=False
    )
    if version.returncode != 0:
        raise FactoryReplayError(
            f"Factory binary version check failed with status {version.returncode}: "
            f"{version.stderr.strip()}",
            exit_status=version.returncode,
        )
    factory_version = version.stdout.strip() or version.stderr.strip()
    probe = subprocess.run(
        [
            str(binary),
            "exec",
            "--model",
            model,
            "--list-tools",
            "--output-format",
            "json",
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    log_path.write_text(probe.stdout + probe.stderr)
    if probe.returncode != 0:
        rejection = (probe.stdout + probe.stderr).strip()
        raise FactoryReplayError(
            f"Factory CLI {factory_version} rejected required model {model} "
            f"with status {probe.returncode}. Configure that exact provider/model ID in "
            "~/.factory/settings.json or install a Factory CLI release that lists it, then "
            f"verify with `droid exec --model {model} --list-tools --output-format json`. "
            "Do not substitute gemini-3-flash-preview or another Gemini alias. "
            f"Factory said: {rejection}",
            exit_status=probe.returncode,
        )
    return factory_version


def run_replay(args: argparse.Namespace) -> dict[str, Any]:
    started_at = time.monotonic()
    binary = Path(args.binary).resolve()
    repo = Path(args.repo).resolve()
    logs = Path(args.logs).resolve()
    logs.mkdir(parents=True, exist_ok=True)
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise FactoryReplayError(
            f"Factory binary is unavailable or not executable at {binary}. Install it with "
            "`curl -fsSL https://app.factory.ai/cli | sh`, then stage the resolved droid "
            "executable in the Factory Pier assets directory."
        )
    api_key = Path(args.api_key_file).read_text().strip()
    if not api_key:
        raise FactoryReplayError(
            "Factory API key file is empty. Create a key at "
            "https://app.factory.ai/settings/api-keys and stage it as factory-api-key."
        )
    manifest_bytes = Path(args.manifest).read_bytes()
    replay_manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()
    manifest = json.loads(manifest_bytes)
    (
        prefix_inputs,
        compact_after,
        continuation,
        source_session_id,
        repository_checkpoint,
        source_session_artifacts,
        source_compaction_checkpoint,
    ) = _validate_manifest(manifest, repo, args.model)
    repository_checkpoint_sha256 = manifest["repository_checkpoint_sha256"]
    version = _preflight(binary, args.model, logs / "model-preflight.txt")

    environment = os.environ.copy()
    environment["FACTORY_API_KEY"] = api_key
    command = [
        str(binary),
        "exec",
        "--input-format",
        "stream-jsonrpc",
        "--output-format",
        "stream-jsonrpc",
        "--skip-permissions-unsafe",
        "--model",
        args.model,
        "--cwd",
        str(repo),
    ]
    transcript_path = logs / "factory-transcript.jsonl"
    with transcript_path.open("w") as transcript:
        process = subprocess.Popen(
            command,
            cwd=repo,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        rpc = JsonRpcSession(process, transcript, args.turn_timeout_seconds)
        exit_status = 1
        try:
            initialized = rpc.request(
                "droid.initialize_session",
                {
                    "machineId": "pier-factory",
                    "cwd": str(repo),
                    "modelId": args.model,
                    "interactionMode": "auto",
                    "autonomyLevel": "high",
                    "skipPermissionsUnsafe": True,
                },
            )
            settings = initialized.get("settings")
            resolved_model = settings.get("modelId") if isinstance(settings, dict) else None
            if resolved_model != args.model:
                raise FactoryReplayError(
                    f"Factory resolved model {resolved_model!r}, not required {args.model!r}"
                )
            session_id = initialized.get("sessionId")
            if not isinstance(session_id, str) or not session_id:
                raise FactoryReplayError("Factory initialize_session returned no sessionId")
            for user_input in prefix_inputs[:compact_after]:
                rpc.turn(user_input)
            before_context = rpc.request("droid.get_context_stats", {})
            compacted = rpc.request("droid.compact_session", {})
            removed_count = compacted.get("removedCount")
            compacted_session_id = compacted.get("newSessionId")
            if not isinstance(removed_count, int) or removed_count <= 0:
                raise FactoryReplayError(
                    "Factory native compaction removed no messages at the matched checkpoint; "
                    "the replay did not cross a real Factory compaction boundary"
                )
            if not isinstance(compacted_session_id, str) or not compacted_session_id:
                raise FactoryReplayError("Factory compaction returned no newSessionId")
            loaded = rpc.request(
                "droid.load_session", {"sessionId": compacted_session_id}
            )
            loaded_settings = loaded.get("settings")
            loaded_model = (
                loaded_settings.get("modelId") if isinstance(loaded_settings, dict) else None
            )
            if loaded_model != args.model:
                raise FactoryReplayError(
                    f"Factory compacted session resolved model {loaded_model!r}, "
                    f"not required {args.model!r}"
                )
            after_context = rpc.request("droid.get_context_stats", {})
            compaction_artifact = logs / "factory-compaction.json"
            compaction_artifact.write_text(
                json.dumps(
                    {
                        "native": True,
                        "method": "droid.compact_session",
                        "result": compacted,
                        "before_context": before_context,
                        "after_context": after_context,
                    },
                    indent=2,
                    sort_keys=True,
                )
                + "\n"
            )
            continuation_start = transcript.tell()
            rpc.turn(continuation)
            transcript.flush()
            continuation_artifact = logs / "factory-continuation.jsonl"
            continuation_artifact.write_text(
                transcript_path.read_text()[continuation_start:]
            )
            exit_status = 0
            usage = rpc.total_usage()
            required_usage = (
                "inputTokens",
                "outputTokens",
                "cacheCreationTokens",
                "cacheReadTokens",
            )
            if any(not isinstance(usage.get(key), int) for key in required_usage):
                raise FactoryReplayError(
                    "Factory completed without exact input/output/cache token telemetry"
                )
            if usage["inputTokens"] <= 0 or usage["outputTokens"] <= 0:
                raise FactoryReplayError(
                    "Factory completed with zero input/output tokens; rejecting infrastructure failure"
                )
            cost_usd = rpc.total_cost_usd()
            result = {
                "factory_version": version,
                "wall_time_seconds": time.monotonic() - started_at,
                "resolved_model": resolved_model,
                "initial_session_id": session_id,
                "compacted_session_id": compacted_session_id,
                "compaction_removed_count": removed_count,
                "source_session_id": source_session_id,
                "repository_checkpoint": repository_checkpoint,
                "repository_checkpoint_sha256": repository_checkpoint_sha256,
                "source_session_artifacts": source_session_artifacts,
                "source_compaction_checkpoint": source_compaction_checkpoint,
                "compaction_after_user_turn": compact_after,
                "replay_manifest_sha256": replay_manifest_sha256,
                "native_compaction": {
                    "native": True,
                    "artifact": str(compaction_artifact),
                    "before_tokens": before_context.get("used"),
                    "after_tokens": after_context.get("used"),
                },
                "prefix_turns": len(prefix_inputs),
                "input_tokens": usage.get("inputTokens"),
                "output_tokens": usage.get("outputTokens"),
                "cache_read_tokens": usage.get("cacheReadTokens"),
                "cache_write_tokens": usage.get("cacheCreationTokens"),
                "cache_tokens": (
                    usage.get("cacheReadTokens", 0) + usage.get("cacheCreationTokens", 0)
                    if isinstance(usage.get("cacheReadTokens"), int)
                    and isinstance(usage.get("cacheCreationTokens"), int)
                    else None
                ),
                "cost_usd": cost_usd,
                "provider_cost_supported": cost_usd is not None,
                "provider_cost_unsupported_reason": (
                    None if cost_usd is not None else COST_UNSUPPORTED_REASON
                ),
                "exit_status": exit_status,
                "qualitative_score": None,
                # The public Factory JSON-RPC stream does not attribute token
                # usage to individual recovery reads. Leave both unsupported
                # rather than infer them from tool names or whole-turn usage.
                "recovery_reads": None,
                "recovery_tokens": None,
                "log_path": str(logs / "factory.txt"),
                "continuation_artifact": str(continuation_artifact),
                "transcript_path": str(transcript_path),
                "patch_path": str(logs / "factory.patch"),
            }
        finally:
            if process.stdin:
                process.stdin.close()
            try:
                status = process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                status = process.wait(timeout=5)
            if exit_status == 0 and status != 0:
                raise FactoryReplayError(
                    f"Factory JSON-RPC process exited with status {status} after continuation",
                    exit_status=status,
                )
    patch = subprocess.run(
        ["git", "diff", "--binary", "HEAD"],
        cwd=repo,
        text=True,
        capture_output=True,
        check=False,
    )
    (logs / "factory.patch").write_text(patch.stdout)
    if patch.returncode != 0:
        raise FactoryReplayError(f"git diff failed with status {patch.returncode}: {patch.stderr}")
    (logs / "factory-result.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--api-key-file", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--logs", required=True)
    parser.add_argument("--model", default=EXACT_MODEL)
    parser.add_argument("--turn-timeout-seconds", type=float, default=3600)
    args = parser.parse_args()
    try:
        result = run_replay(args)
    except FactoryReplayError as error:
        print(f"factory replay failed: {error}", file=sys.stderr)
        return error.exit_status
    except (OSError, json.JSONDecodeError) as error:
        print(f"factory replay failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
