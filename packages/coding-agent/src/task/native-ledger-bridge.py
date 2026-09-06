#!/usr/bin/env python3
"""
native-ledger-bridge.py - Isolated host adapter bridge for native topic replenishment.

Enforces cross-process mutual exclusion via OS-level advisory locking (msvcrt on Windows,
fcntl on POSIX) matching ~/.veyyon/workflows/ledger.py FileLock.

Integrates with portable WorkerBackend (prepare_native -> record_native_dispatch -> complete_native)
so canonical result validation governs stage progression without duplicate completion logic.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
import time
from typing import Any, Dict, List, Optional, Sequence, Set

workflows_dir = os.environ.get("VEYYON_WORKFLOWS_DIR") or os.path.expanduser("~/.veyyon/workflows")
if os.path.isdir(workflows_dir) and workflows_dir not in sys.path:
    sys.path.insert(0, workflows_dir)

# Import FileLock
FileLock = None
try:
    from ledger import FileLock as _WorkflowsFileLock
    FileLock = _WorkflowsFileLock
except Exception:
    FileLock = None

if FileLock is None:
    import threading

    class FileLock:
        _tls = threading.local()

        def __init__(self, lock_path: str, timeout: float = 15.0, retry_interval: float = 0.05):
            self.lock_path = os.path.abspath(lock_path)
            self.timeout = timeout
            self.retry_interval = retry_interval
            self.fd = None

        def acquire(self):
            depth = getattr(self._tls, f"depth_{self.lock_path}", 0)
            if depth > 0:
                setattr(self._tls, f"depth_{self.lock_path}", depth + 1)
                self.fd = getattr(self._tls, f"fd_{self.lock_path}", None)
                return self

            os.makedirs(os.path.dirname(self.lock_path) or ".", exist_ok=True)
            start_time = time.time()
            while True:
                try:
                    self.fd = open(self.lock_path, "a+b")
                    self.fd.seek(0, os.SEEK_END)
                    if self.fd.tell() == 0:
                        self.fd.write(b"L")
                        self.fd.flush()

                    self.fd.seek(0)
                    if sys.platform == "win32":
                        import msvcrt
                        msvcrt.locking(self.fd.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(self.fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

                    setattr(self._tls, f"depth_{self.lock_path}", 1)
                    setattr(self._tls, f"fd_{self.lock_path}", self.fd)
                    return self
                except (OSError, IOError):
                    if self.fd:
                        try:
                            self.fd.close()
                        except Exception:
                            pass
                        self.fd = None
                    if time.time() - start_time >= self.timeout:
                        raise TimeoutError(
                            f"Timed out after {self.timeout}s waiting for lock: {self.lock_path}"
                        )
                    time.sleep(self.retry_interval)

        def release(self):
            depth = getattr(self._tls, f"depth_{self.lock_path}", 0)
            if depth > 1:
                setattr(self._tls, f"depth_{self.lock_path}", depth - 1)
                return

            fd = getattr(self._tls, f"fd_{self.lock_path}", self.fd)
            if fd:
                try:
                    fd.seek(0)
                    if sys.platform == "win32":
                        import msvcrt
                        msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(fd.fileno(), fcntl.LOCK_UN)
                except Exception:
                    pass
                finally:
                    try:
                        fd.close()
                    except Exception:
                        pass

            setattr(self._tls, f"depth_{self.lock_path}", 0)
            setattr(self._tls, f"fd_{self.lock_path}", None)
            self.fd = None

        def __enter__(self):
            return self.acquire()

        def __exit__(self, exc_type, exc_val, exc_tb):
            self.release()

# Import WorkerBackend
WorkerBackend = None
WorkerRequest = None
try:
    from worker_backend import WorkerBackend as _WB, WorkerRequest as _WR
    WorkerBackend = _WB
    WorkerRequest = _WR
except Exception:
    WorkerBackend = None
    WorkerRequest = None


EXPLICITLY_CANCELLED_TASKS = {
    "record operator choice a for ci connectivity": (
        "Explicitly dropped per live operator clarification (example choice, not confirmed decision); "
        "preserved as historical cancellation."
    ),
}

TOPIC_KEYWORDS_MAP = {
    "gui": "Desktop GUI",
    "desktop": "Desktop GUI",
    "webprovider": "Desktop GUI",
    "chatgpt": "Desktop GUI",
    "design": "UX/design",
    "conversion": "UX/design",
    "motion": "Motion",
    "telegram": "Telegram",
    "decision": "Decisions",
    "staging": "Staging",
    "pooler": "Staging",
    "workflow": "Workflow",
    "gate": "Workflow",
    "concurrent": "Workflow",
    "todo": "Workflow",
    "scheduler": "Workflow",
    "issue": "Preserved GitHub issue inventory",
    "migration": "Preserved GitHub issue inventory",
    "dedicated": "Preserved GitHub issue inventory",
    "inventory": "Preserved GitHub issue inventory",
    "operator": "Operator accountability",
    "accountability": "Operator accountability",
    "live": "Live operator corrections",
    "recovered": "Recovered authorized work",
    "authorized": "Recovered authorized work",
    "agent": "Agent system change",
    "replenish": "Agent system change",
    "system": "Agent system change",
}

RUNNABLE_TOPIC_NAMES = [
    "Desktop GUI",
    "UX/design",
    "Motion",
    "Telegram",
    "Decisions",
    "Staging",
    "Workflow",
    "Preserved GitHub issue inventory",
    "Operator accountability",
    "Live operator corrections",
    "Recovered authorized work",
    "Agent system change",
]


def resolve_topic(item_id: str, prompt: str, explicit_topic: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> str:
    if explicit_topic and explicit_topic in RUNNABLE_TOPIC_NAMES:
        return explicit_topic
    search_space = f"{item_id} {prompt} {json.dumps(metadata or {})}".lower()
    for kw, topic in TOPIC_KEYWORDS_MAP.items():
        if re.search(rf"\b{kw}\b", search_space, re.IGNORECASE):
            return topic
    for kw, topic in TOPIC_KEYWORDS_MAP.items():
        if kw in search_space:
            return topic
    return "Workflow"


def is_valid_authorization(auth: Any) -> bool:
    """Fail closed on empty or invalid authorizations."""
    if isinstance(auth, str):
        cleaned = auth.strip().lower()
        if not cleaned:
            return False
        if cleaned in ("false", "none", "null", "unauthorized", "denied", "rejected", "no"):
            return False
        return True
    if isinstance(auth, dict):
        if not auth:
            return False
        ts = str(auth.get("timestamp") or "").strip()
        scope = str(auth.get("scope") or "").strip()
        by = str(auth.get("authorized_by") or "").strip()
        status = str(auth.get("status") or "").strip().lower()
        if status == "authorized":
            return True
        return bool(ts or scope or by)
    return False


def is_forbidden_target(req: Dict[str, Any]) -> bool:
    """
    Structured repository and environment authorization check.
    Never inspects bare prompt words so legitimate references to agent 'Main'
    or authorized super-board@main are never falsely blocked.
    """
    repo = str(req.get("repo") or (req.get("github") or {}).get("repo") or "").strip().lower()
    project = str(req.get("project") or "").strip().lower()
    target = str(req.get("target") or req.get("target_branch") or req.get("branch") or req.get("base") or "").strip().lower()
    env = str(req.get("environment") or "").strip().lower()
    prompt = str(req.get("prompt") or "").strip().lower()

    # Extract target / branch if specified as key in prompt
    if not target:
        m_target = re.search(r"\btarget:\s*(\S+)", prompt)
        if m_target:
            target = m_target.group(1).lower()
        else:
            m_branch = re.search(r"\bbranch\s+(\S+)", prompt)
            if m_branch:
                target = m_branch.group(1).lower()
    if "super-board" in repo or "super-board" in project or "wt-portable-workflow-core" in project:
        if env in ("production", "prod", "zaraprptkegxqpvnsubu", "akamai-iad-prod"):
            return True
        return False

    # 2. PolySimulator production (zaraprptkegxqpvnsubu, akamai-iad-prod, main/master/production) is strictly denied
    is_polysimulator = (
        not repo
        or "polysimulator" in repo
        or "polysimulator" in project
        or project in ("zaraprptkegxqpvnsubu", "akamai-iad-prod")
    )
    if is_polysimulator:
        if target in ("main", "master", "production", "prod"):
            return True
        if env in ("zaraprptkegxqpvnsubu", "akamai-iad-prod", "production", "prod"):
            return True
        if project in ("zaraprptkegxqpvnsubu", "akamai-iad-prod"):
            return True

    return False


def get_iso_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def cmd_claim(args: argparse.Namespace) -> int:
    ledger_path = os.path.abspath(args.ledger)
    lock_path = ledger_path + ".lock"
    worker_id = args.worker_id or f"native-replenish-{int(time.time()*1000)}"
    covered_topics = set(args.covered_topics.split(",") if args.covered_topics else [])
    timeout = float(args.timeout)

    with FileLock(lock_path, timeout=timeout):
        if not os.path.exists(ledger_path):
            res = {"claimed": False, "reason": f"Ledger file does not exist at {ledger_path}", "blockedTopics": [], "blocked_topics": []}
            print(json.dumps(res))
            return 0

        with open(ledger_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        requests = data.get("requests", {})
        drivable_states = {"pending", "implementation", "qa", "review"}
        candidates = []
        blocked_topics = []

        for req_id, req in requests.items():
            prompt = req.get("prompt", "")
            canonical_prompt = " ".join(prompt.strip().lower().split())

            # 1. Skip explicitly cancelled/dropped tasks
            if canonical_prompt in EXPLICITLY_CANCELLED_TASKS:
                continue
            if req.get("state") in ("cancelled", "dropped"):
                continue

            # 2. Production target guard across structured repo/project/target fields
            if is_forbidden_target(req):
                continue

            # 3. Fail-closed authorization check
            if not is_valid_authorization(req.get("authorization")):
                continue

            # 4. Check for ungranted merge authorization
            if req.get("state") == "awaiting authorization":
                continue

            state = str(req.get("state") or "pending").lower()

            # Skip if claimed and in progress by an active owner
            owner = str(req.get("owner") or "").strip()
            if owner and state != "pending":
                continue

            # 5. Check decision blockers
            dec_blockers = req.get("decision_blockers")
            if isinstance(dec_blockers, list) and len(dec_blockers) > 0:
                topic = resolve_topic(req_id, prompt, req.get("topic"), req.get("metadata"))
                blocked_topics.append({
                    "topic": topic,
                    "ticketId": req_id,
                    "reason": f"Awaiting human decision on: {', '.join(dec_blockers)}",
                })
                continue

            # 6. Check general blockers
            blocker = req.get("blocker") or req.get("blocker_reason")
            if blocker or state == "blocked":
                topic = resolve_topic(req_id, prompt, req.get("topic"), req.get("metadata"))
                blocked_topics.append({
                    "topic": topic,
                    "ticketId": req_id,
                    "reason": blocker or "Task marked blocked",
                })
                continue

            # 7. Check drivable state
            if state not in drivable_states:
                continue

            # 8. Check dependencies
            deps = req.get("dependencies")
            if isinstance(deps, list) and len(deps) > 0:
                terminal_states = {"done", "live verification", "integration", "awaiting authorization"}
                unmet = [d for d in deps if d not in requests or str(requests[d].get("state", "")).lower() not in terminal_states]
                if unmet:
                    topic = resolve_topic(req_id, prompt, req.get("topic"), req.get("metadata"))
                    blocked_topics.append({
                        "topic": topic,
                        "ticketId": req_id,
                        "reason": f"Dependencies unfulfilled: {', '.join(unmet)}",
                        "dependencies": unmet,
                    })
                    continue

            topic = resolve_topic(req_id, prompt, req.get("topic"), req.get("metadata"))
            priority = 1 if topic not in covered_topics else 2
            candidates.append((priority, req_id, topic, req))

        if not candidates:
            res = {
                "claimed": False,
                "reason": "No eligible authorized tickets found",
                "blockedTopics": blocked_topics,
                "blocked_topics": blocked_topics,
            }
            print(json.dumps(res))
            return 0

        # Sort candidate by priority (uncovered first), then id
        candidates.sort(key=lambda c: (c[0], c[1]))
        _, chosen_id, chosen_topic, chosen_req = candidates[0]

        now_iso = get_iso_now()
        from_state = chosen_req.get("state") or "pending"
        to_state = "implementation" if from_state.lower() == "pending" else chosen_req.get("state")
        chosen_req["state"] = to_state
        chosen_req["owner"] = worker_id
        chosen_req["claimed_at"] = now_iso
        chosen_req["updated_at"] = now_iso

        history = chosen_req.setdefault("history", [])
        history.append({
            "actor": "TopicReplenishmentEngine",
            "timestamp": now_iso,
            "from_state": from_state,
            "to_state": to_state,
            "reason": "Claimed for native replenishment",
        })
        data["updated_at"] = now_iso

        # Prepare native ticket via WorkerBackend if available
        run_id = None
        result_schema = None
        prepared_prompt = chosen_req.get("prompt", "")
        stage = str(chosen_req.get("stage") or ("qa" if str(from_state).lower() == "qa" else "review" if str(from_state).lower() == "review" else "build"))
        repo_root = str(chosen_req.get("repo_root") or os.getcwd())
        head_sha = chosen_req.get("head")

        if WorkerBackend is not None:
            try:
                backend = WorkerBackend(state_dir=workflows_dir)
                wb_req = WorkerRequest(
                    request_id=chosen_id,
                    stage=stage,
                    repo_root=repo_root,
                    head_sha=head_sha,
                    model=str(chosen_req.get("model") or "google-antigravity/gemini-3.8-flash:high"),
                    agent_role=str(chosen_req.get("agent_role") or "worker"),
                    prompt=prepared_prompt,
                    criteria=chosen_req.get("criteria", []),
                    task_type=str(chosen_req.get("task_type") or "feature"),
                )
                native_ticket = backend.prepare_native(wb_req)
                if not native_ticket.blocked_reason:
                    run_id = native_ticket.run_id
                    result_schema = native_ticket.result_schema
                    if native_ticket.prompt:
                        prepared_prompt = native_ticket.prompt
            except Exception:
                pass

        if not run_id:
            run_id = f"native_{chosen_id}_{int(time.time()*1000)}"

        # Write file atomically inside FileLock
        temp_path = f"{ledger_path}.tmp.{os.getpid()}.{int(time.time()*1000)}"
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(temp_path, ledger_path)

        ticket = {
            "id": chosen_id,
            "topic": chosen_topic,
            "prompt": prepared_prompt,
            "task": prepared_prompt,
            "state": to_state,
            "owner": worker_id,
            "role": "fast",
            "criteria": chosen_req.get("criteria", []),
            "dependencies": chosen_req.get("dependencies", []),
            "head": head_sha,
            "authorization": json.dumps(chosen_req.get("authorization")) if isinstance(chosen_req.get("authorization"), dict) else str(chosen_req.get("authorization")),
            "claimedAt": now_iso,
            "runId": run_id,
            "resultSchema": result_schema,
            "stage": stage,
            "repoRoot": repo_root,
        }

        res = {
            "claimed": True,
            "ticket": ticket,
            "blockedTopics": blocked_topics,
            "blocked_topics": blocked_topics,
        }
        print(json.dumps(res))
        return 0


def cmd_record_dispatch(args: argparse.Namespace) -> int:
    run_id = args.run_id
    task_handle = args.task_handle
    if WorkerBackend is not None:
        try:
            backend = WorkerBackend(state_dir=workflows_dir)
            ticket = backend.record_native_dispatch(run_id, task_handle)
            print(json.dumps({"recorded": True, "run_id": run_id, "task_handle": task_handle, "state": ticket.state}))
            return 0
        except Exception as e:
            print(json.dumps({"recorded": False, "error": str(e)}))
            return 1
    print(json.dumps({"recorded": True, "run_id": run_id, "task_handle": task_handle}))
    return 0


def cmd_rollback(args: argparse.Namespace) -> int:
    ledger_path = os.path.abspath(args.ledger)
    lock_path = ledger_path + ".lock"
    ticket_id = args.ticket_id
    reason = args.reason or "Dispatch failed"
    timeout = float(args.timeout)

    with FileLock(lock_path, timeout=timeout):
        if not os.path.exists(ledger_path):
            print(json.dumps({"rolled_back": False, "error": "Ledger not found"}))
            return 0

        with open(ledger_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        req = data.get("requests", {}).get(ticket_id)
        if not req:
            print(json.dumps({"rolled_back": False, "error": f"Ticket {ticket_id} not found"}))
            return 0

        now_iso = get_iso_now()
        from_state = req.get("state") or "implementation"
        req["state"] = "pending"
        req["owner"] = ""
        req["blocker"] = f"Dispatch failed: {reason}"
        req["updated_at"] = now_iso

        history = req.setdefault("history", [])
        history.append({
            "actor": "TopicReplenishmentEngine",
            "timestamp": now_iso,
            "from_state": from_state,
            "to_state": "pending",
            "reason": f"Rollback: {reason}",
        })
        data["updated_at"] = now_iso

        temp_path = f"{ledger_path}.tmp.{os.getpid()}.{int(time.time()*1000)}"
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(temp_path, ledger_path)

        print(json.dumps({"rolled_back": True, "ticket_id": ticket_id}))
        return 0


def cmd_complete(args: argparse.Namespace) -> int:
    ledger_path = os.path.abspath(args.ledger)
    lock_path = ledger_path + ".lock"
    ticket_id = args.ticket_id
    run_id = args.run_id
    task_handle = args.task_handle or f"agent://{args.agent_id or 'unknown'}"
    timeout = float(args.timeout)

    structured_result = {}
    if args.result_json:
        try:
            structured_result = json.loads(args.result_json)
        except Exception as e:
            structured_result = {"error": f"Invalid JSON: {e}"}
    elif args.result_file and os.path.exists(args.result_file):
        try:
            with open(args.result_file, "r", encoding="utf-8") as rf:
                structured_result = json.load(rf)
        except Exception as e:
            structured_result = {"error": f"Invalid file: {e}"}

    # 1. Validate through WorkerBackend.complete_native if available
    outcome_dict = None
    if WorkerBackend is not None and run_id:
        try:
            backend = WorkerBackend(state_dir=workflows_dir)
            outcome = backend.complete_native(run_id, task_handle, structured_result)
            outcome_dict = outcome.to_dict()
        except Exception:
            outcome_dict = None

    if args.error:
        outcome_dict = {
            "ok": False,
            "stage": structured_result.get("stage", "unknown"),
            "exit_code": args.exit_code,
            "command": [],
            "head_sha": structured_result.get("head_sha"),
            "evidence": structured_result,
            "artifacts": [],
            "blocked_reason": args.error,
        }
    elif outcome_dict is None:
        # Canonical validation rules if WorkerBackend is uninstantiated
        verdict = structured_result.get("verdict")
        checks = structured_result.get("checks", [])
        has_verifications = any(
            isinstance(c, dict) and c.get("purpose") == "verification" and c.get("exit_code") == 0
            for c in checks
        )
        ok = bool(
            verdict == "pass"
            and len(checks) > 0
            and has_verifications
            and not args.error
            and int(args.exit_code or 0) == 0
        )
        blocked_reason = None
        if not ok:
            if verdict != "pass":
                blocked_reason = f"Worker returned verdict '{verdict}'"
            elif len(checks) == 0:
                blocked_reason = "Worker returned verdict 'pass' with no executed checks"
            elif not has_verifications:
                blocked_reason = "Worker checks contain no successful verification check"
            elif args.error or int(args.exit_code or 0) != 0:
                blocked_reason = args.error or f"Worker exited with code {args.exit_code}"

        outcome_dict = {
            "ok": ok,
            "stage": structured_result.get("stage", "unknown"),
            "exit_code": args.exit_code,
            "command": [],
            "head_sha": structured_result.get("head_sha"),
            "evidence": structured_result,
            "artifacts": [a.get("path") for a in structured_result.get("artifacts", []) if isinstance(a, dict)],
            "blocked_reason": blocked_reason,
        }

    # 2. Update ledger request under FileLock based on canonical outcome
    with FileLock(lock_path, timeout=timeout):
        if not os.path.exists(ledger_path):
            print(json.dumps({"completed": False, "error": "Ledger not found"}))
            return 0

        with open(ledger_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        req = data.get("requests", {}).get(ticket_id)
        if not req:
            print(json.dumps({"completed": False, "error": f"Ticket {ticket_id} not found"}))
            return 0

        now_iso = get_iso_now()
        from_state = req.get("state") or "implementation"
        history = req.setdefault("history", [])

        if outcome_dict["ok"]:
            # Advance state only on validated canonical success
            next_state = from_state
            if from_state.lower() in ("pending", "implementation", "build"):
                next_state = "QA"
            elif from_state.lower() == "qa":
                next_state = "review"
            elif from_state.lower() == "review":
                next_state = "awaiting authorization"

            req["state"] = next_state
            if outcome_dict.get("head_sha"):
                req["head"] = outcome_dict["head_sha"]
            req["blocker"] = None
            req["updated_at"] = now_iso

            evidence_list = req.setdefault("evidence", [])
            if outcome_dict.get("evidence"):
                evidence_list.append(outcome_dict["evidence"])

            history.append({
                "actor": "WorkerBackend",
                "timestamp": now_iso,
                "from_state": from_state,
                "to_state": next_state,
                "reason": f"Stage {outcome_dict.get('stage')} validated successfully",
            })
        else:
            # State remains unadvanced on blocked/refused/failed outcome
            reason = outcome_dict.get("blocked_reason") or "Worker verification failed"
            req["blocker"] = reason
            req["updated_at"] = now_iso
            history.append({
                "actor": "WorkerBackend",
                "timestamp": now_iso,
                "from_state": from_state,
                "to_state": from_state,
                "reason": f"Stage {outcome_dict.get('stage')} refused/blocked: {reason}",
            })

        data["updated_at"] = now_iso
        temp_path = f"{ledger_path}.tmp.{os.getpid()}.{int(time.time()*1000)}"
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(temp_path, ledger_path)

        print(json.dumps({
            "completed": True,
            "ok": outcome_dict["ok"],
            "stage": outcome_dict.get("stage"),
            "state": req["state"],
            "blocked_reason": outcome_dict.get("blocked_reason"),
            "head_sha": outcome_dict.get("head_sha"),
        }))
        return 0


def cmd_hold_lock(args: argparse.Namespace) -> int:
    """Acquire the lock, signal readiness, hold for duration, then release (for contention testing)."""
    lock_path = os.path.abspath(args.lock_path)
    duration = float(args.duration)
    ready_signal = args.ready_signal or "LOCKED"

    with FileLock(lock_path, timeout=float(args.timeout)):
        print(ready_signal, flush=True)
        time.sleep(duration)
    return 0


def main():
    parser = argparse.ArgumentParser(description="Host adapter bridge for native topic replenishment")
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    p_claim = subparsers.add_parser("claim", help="Claim next ready authorized ticket under FileLock")
    p_claim.add_argument("--ledger", required=True, help="Path to ledger.json")
    p_claim.add_argument("--worker-id", default="", help="Worker ID")
    p_claim.add_argument("--covered-topics", default="", help="Comma-separated covered topic names")
    p_claim.add_argument("--timeout", default="15.0", help="Lock timeout in seconds")

    p_record = subparsers.add_parser("record-dispatch", help="Record native dispatch binding in WorkerBackend")
    p_record.add_argument("--run-id", required=True, help="Native run ID")
    p_record.add_argument("--task-handle", required=True, help="Native task handle (agent://...)")

    p_rollback = subparsers.add_parser("rollback", help="Roll back claimed ticket on dispatch failure under FileLock")
    p_rollback.add_argument("--ledger", required=True, help="Path to ledger.json")
    p_rollback.add_argument("--ticket-id", required=True, help="Ticket ID")
    p_rollback.add_argument("--reason", default="Dispatch failed", help="Failure reason")
    p_rollback.add_argument("--timeout", default="15.0", help="Lock timeout in seconds")

    p_complete = subparsers.add_parser("complete", help="Complete ticket on worker finish through canonical validation")
    p_complete.add_argument("--ledger", required=True, help="Path to ledger.json")
    p_complete.add_argument("--ticket-id", required=True, help="Ticket ID")
    p_complete.add_argument("--run-id", default="", help="Native run ID")
    p_complete.add_argument("--task-handle", default="", help="Native task handle (agent://...)")
    p_complete.add_argument("--agent-id", default="", help="Agent ID fallback")
    p_complete.add_argument("--result-json", default="", help="Structured result JSON string")
    p_complete.add_argument("--result-file", default="", help="Path to structured result file")
    p_complete.add_argument("--exit-code", type=int, default=0)
    p_complete.add_argument("--error", default="")
    p_complete.add_argument("--timeout", default="15.0", help="Lock timeout in seconds")

    p_hold = subparsers.add_parser("hold-lock", help="Hold lock for testing contention")
    p_hold.add_argument("--lock-path", required=True, help="Lock file path")
    p_hold.add_argument("--duration", default="1.0", help="Duration to hold in seconds")
    p_hold.add_argument("--timeout", default="15.0", help="Lock timeout in seconds")
    p_hold.add_argument("--ready-signal", default="LOCKED", help="Signal printed when acquired")

    args = parser.parse_args()
    if args.subcommand == "claim":
        sys.exit(cmd_claim(args))
    elif args.subcommand == "record-dispatch":
        sys.exit(cmd_record_dispatch(args))
    elif args.subcommand == "rollback":
        sys.exit(cmd_rollback(args))
    elif args.subcommand == "complete":
        sys.exit(cmd_complete(args))
    elif args.subcommand == "hold-lock":
        sys.exit(cmd_hold_lock(args))


if __name__ == "__main__":
    main()
