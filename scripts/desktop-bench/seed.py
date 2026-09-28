"""Seed the bench corpus into a scratch veyyon home or a scratch T3 Code state database.

	python3 seed.py veyyon --home <scratch-home>
	python3 seed.py t3 --home <scratch-home>

Both write the threads `corpus.build()` returns, and nothing else: veyyon gets
one session file per thread under `<home>/.veyyon/profiles/default/agent/
sessions`, T3 Code gets one event stream per project and thread appended to the
`orchestration_events` table of `<home>/.t3/userdata/state.sqlite`, which its
projection pipeline projects on the next launch. Project directories are
created under `<home>/projects/<name>` as git repositories, so neither app
resolves a project to a repository around the scratch home.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import uuid
from pathlib import Path

import corpus

PROFILE = "default"
MODEL_PROVIDER = "bench"
MODEL_ID = "bench-model"
T3_MODEL_SELECTION = {"instanceId": "codex", "model": MODEL_ID}
TITLE_SLOT_BYTES = 256


def stable_uuid(*parts: str) -> str:
	return str(uuid.UUID(bytes=hashlib.sha256("/".join(parts).encode()).digest()[:16], version=4))


def stable_hex(*parts: str, length: int = 8) -> str:
	return hashlib.sha256("/".join(parts).encode()).hexdigest()[:length]


def dumps(value: object) -> str:
	return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def project_dir(home: Path, project: str) -> Path:
	return home / "projects" / project


def make_projects(home: Path) -> None:
	for project in corpus.PROJECTS:
		root = project_dir(home, project)
		root.mkdir(parents=True, exist_ok=True)
		readme = root / "README.md"
		if not readme.exists():
			readme.write_text(f"# {project}\n\nBench project.\n", encoding="utf-8")
		if not (root / ".git").exists():
			env = {
				**os.environ,
				"GIT_AUTHOR_NAME": "bench",
				"GIT_AUTHOR_EMAIL": "bench@localhost",
				"GIT_COMMITTER_NAME": "bench",
				"GIT_COMMITTER_EMAIL": "bench@localhost",
				"GIT_AUTHOR_DATE": "2026-09-01T09:00:00Z",
				"GIT_COMMITTER_DATE": "2026-09-01T09:00:00Z",
			}
			for args in (["init", "-q", "-b", "main"], ["add", "README.md"], ["commit", "-q", "-m", "init"]):
				subprocess.run(["git", *args], cwd=root, env=env, check=True)


# veyyon ---------------------------------------------------------------------


def veyyon_session_dir(home: Path, cwd: Path) -> Path:
	"""The session directory veyyon computes for a cwd under its home."""
	relative = cwd.relative_to(home).as_posix().replace("/", "-")
	return home / ".veyyon" / "profiles" / PROFILE / "agent" / "sessions" / f"-{relative}"


def title_slot(title: str, updated_at: str) -> str:
	def line(pad: str) -> str:
		slot = {"type": "title", "v": 1, "title": title, "source": "user", "updatedAt": updated_at, "pad": pad}
		return dumps(slot) + "\n"

	pad = TITLE_SLOT_BYTES - len(line("").encode())
	if pad < 0:
		raise ValueError(f"title {title!r} does not fit the {TITLE_SLOT_BYTES}-byte slot")
	return line(" " * pad)


def veyyon_session_lines(thread: corpus.Thread, cwd: Path) -> list[str]:
	session_id = stable_uuid("veyyon-session", thread.key)
	created = corpus.iso_ms(thread.created_at)
	lines = [
		title_slot(thread.title, corpus.iso_ms(thread.updated_at)),
		dumps({"type": "session", "version": 3, "id": session_id, "timestamp": created, "cwd": str(cwd)}) + "\n",
	]
	parent = stable_hex(thread.key, "model")
	lines.append(
		dumps(
			{
				"type": "model_change",
				"id": parent,
				"parentId": None,
				"timestamp": created,
				"model": f"{MODEL_PROVIDER}/{MODEL_ID}",
			}
		)
		+ "\n"
	)
	for n, message in enumerate(thread.messages):
		entry_id = stable_hex(thread.key, str(n))
		stamp = corpus.epoch_ms(message.at)
		content = [{"type": "text", "text": message.text}]
		if message.role == "user":
			body = {"role": "user", "content": content, "attribution": "user", "timestamp": stamp}
		else:
			body = {
				"role": "assistant",
				"content": content,
				"api": "openai-completions",
				"provider": MODEL_PROVIDER,
				"model": MODEL_ID,
				"usage": {
					"input": 0,
					"output": 0,
					"cacheRead": 0,
					"cacheWrite": 0,
					"totalTokens": 0,
					"cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
				},
				"stopReason": "stop",
				"timestamp": stamp,
			}
		entry = {
			"type": "message",
			"id": entry_id,
			"parentId": parent,
			"timestamp": corpus.iso_ms(message.at),
			"message": body,
		}
		lines.append(dumps(entry) + "\n")
		parent = entry_id
	return lines


def seed_veyyon(home: Path) -> dict[str, str]:
	"""Writes every thread as a session file; returns thread key -> session file."""
	make_projects(home)
	files: dict[str, str] = {}
	for thread in corpus.build():
		cwd = project_dir(home, thread.project)
		directory = veyyon_session_dir(home, cwd)
		directory.mkdir(parents=True, exist_ok=True)
		session_id = stable_uuid("veyyon-session", thread.key)
		stamp = corpus.iso_ms(thread.created_at).replace(":", "-").replace(".", "-")
		path = directory / f"{stamp}_{session_id}.jsonl"
		path.write_text("".join(veyyon_session_lines(thread, cwd)), encoding="utf-8")
		os.utime(path, (thread.updated_at.timestamp(), thread.updated_at.timestamp()))
		files[thread.key] = str(path)
	return files


# T3 Code --------------------------------------------------------------------


def t3_database(home: Path) -> Path:
	return home / ".t3" / "userdata" / "state.sqlite"


def seed_t3(home: Path) -> dict[str, str]:
	"""Appends the corpus as orchestration events; returns thread key -> thread id.

	The database must exist: T3 Code creates and migrates it on its first
	launch. Seeding a database that already holds events fails, so a corpus is
	never appended twice.
	"""
	make_projects(home)
	db_path = t3_database(home)
	if not db_path.exists():
		raise SystemExit(f"{db_path} does not exist; launch T3 Code once on this home to create it")
	db = sqlite3.connect(db_path)
	try:
		(existing,) = db.execute("select count(*) from orchestration_events").fetchone()
		if existing:
			raise SystemExit(f"{db_path} already holds {existing} events; seed a fresh home")
		rows: list[tuple] = []
		ids: dict[str, str] = {}
		threads = corpus.build()
		project_ids = {project: stable_uuid("t3-project", project) for project in corpus.PROJECTS}
		for project in corpus.PROJECTS:
			first = next(t for t in threads if t.project == project)
			at = corpus.iso_ms(first.created_at)
			payload = {
				"projectId": project_ids[project],
				"title": project,
				"workspaceRoot": str(project_dir(home, project)),
				"defaultModelSelection": None,
				"faviconPath": None,
				"projectIcon": None,
				"scripts": [],
				"createdAt": at,
				"updatedAt": at,
			}
			rows.append(("project", project_ids[project], 0, "project.created", at, "client", payload, {}))
		for thread in threads:
			thread_id = stable_uuid("t3-thread", thread.key)
			ids[thread.key] = thread_id
			at = corpus.iso_ms(thread.created_at)
			created = {
				"threadId": thread_id,
				"projectId": project_ids[thread.project],
				"title": thread.title,
				"modelSelection": T3_MODEL_SELECTION,
				"runtimeMode": "full-access",
				"interactionMode": "default",
				"branch": "main",
				"worktreePath": None,
				"createdAt": at,
				"updatedAt": at,
			}
			rows.append(("thread", thread_id, 0, "thread.created", at, "server", created, {}))
			for n, message in enumerate(thread.messages):
				when = corpus.iso_ms(message.at)
				sent = {
					"threadId": thread_id,
					"messageId": stable_uuid("t3-message", thread.key, str(n)),
					"role": message.role,
					"text": message.text,
					"turnId": None,
					"streaming": False,
					"createdAt": when,
					"updatedAt": when,
				}
				if message.role == "user":
					sent["attachments"] = []
				actor = "server" if message.role == "user" else "provider"
				rows.append(("thread", thread_id, n + 1, "thread.message-sent", when, actor, sent, {}))
		db.executemany(
			"insert into orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type,"
			" occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)"
			" values (?, ?, ?, ?, ?, ?, null, null, null, ?, ?, ?)",
			(
				(
					stable_uuid("t3-event", stream, str(version)),
					kind,
					stream,
					version,
					event_type,
					at,
					actor,
					dumps(payload),
					dumps(metadata),
				)
				for kind, stream, version, event_type, at, actor, payload, metadata in rows
			),
		)
		db.commit()
		return ids
	finally:
		db.close()


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("app", choices=("veyyon", "t3"))
	parser.add_argument("--home", required=True, type=Path)
	args = parser.parse_args()
	home = args.home.resolve()
	result = seed_veyyon(home) if args.app == "veyyon" else seed_t3(home)
	json.dump(result, sys.stdout, indent=1)
	sys.stdout.write("\n")
	return 0


if __name__ == "__main__":
	sys.exit(main())
