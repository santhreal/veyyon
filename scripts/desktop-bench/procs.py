"""Process trees of the app under test: spawn, find, account, stop.

Every process an app starts inherits `BENCH_TAG=<tag>` from the launch, so a
host that detaches from the window that started it still carries the marker.
Chromium starts its zygotes with a rewritten environment, so the tree is the
tagged processes plus every descendant of one. Processes are read from /proc,
which only shows the environment of the current user's own processes; the
bench never needs another user's.
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

TAG_ENV = "BENCH_TAG"
CLOCK_TICKS = os.sysconf("SC_CLK_TCK")
PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")


def _read(path: str) -> bytes | None:
	try:
		with open(path, "rb") as handle:
			return handle.read()
	except OSError:
		return None


def _stat_fields(pid: str) -> tuple[str, int] | None:
	"""(state, ppid) of one process, or None once it is gone."""
	stat = _read(f"/proc/{pid}/stat")
	if not stat:
		return None
	fields = stat[stat.rindex(b")") + 2 :].split()
	return fields[0].decode(), int(fields[1])


def tagged_pids(tag: str) -> list[int]:
	"""Live processes whose environment holds `BENCH_TAG=<tag>`, and their descendants."""
	marker = f"{TAG_ENV}={tag}".encode()
	parents: dict[int, int] = {}
	tree: set[int] = set()
	for entry in os.listdir("/proc"):
		if not entry.isdigit():
			continue
		fields = _stat_fields(entry)
		# A zombie has released its memory and holds no CPU; it is not part of the tree.
		if fields is None or fields[0] == "Z":
			continue
		parents[int(entry)] = fields[1]
		environ = _read(f"/proc/{entry}/environ")
		if environ and marker in environ.split(b"\0"):
			tree.add(int(entry))
	grew = True
	while grew:
		grew = False
		for pid, ppid in parents.items():
			if pid not in tree and ppid in tree:
				tree.add(pid)
				grew = True
	return sorted(tree)


def comm(pid: int) -> str:
	raw = _read(f"/proc/{pid}/comm")
	return raw.decode(errors="replace").strip() if raw else "?"


def cmdline(pid: int) -> str:
	raw = _read(f"/proc/{pid}/cmdline")
	return raw.replace(b"\0", b" ").decode(errors="replace").strip() if raw else ""


def cpu_ticks(pid: int) -> int | None:
	"""utime + stime of one process, in clock ticks."""
	stat = _read(f"/proc/{pid}/stat")
	if not stat:
		return None
	fields = stat[stat.rindex(b")") + 2 :].split()
	return int(fields[11]) + int(fields[12])


def cpu_ns(pid: int, thread: int | None = None) -> int | None:
	"""Time on CPU in ns from schedstat: of thread `thread` of `pid`, else summed over its live threads."""
	if thread is not None:
		raw = _read(f"/proc/{pid}/task/{thread}/schedstat")
		return int(raw.split()[0]) if raw else None
	try:
		tasks = os.listdir(f"/proc/{pid}/task")
	except OSError:
		return None
	total = 0
	for task in tasks:
		raw = _read(f"/proc/{pid}/task/{task}/schedstat")
		if raw:
			total += int(raw.split()[0])
	return total


@dataclass(frozen=True)
class Memory:
	rss_kib: int
	pss_kib: int


def memory(pid: int) -> Memory | None:
	raw = _read(f"/proc/{pid}/smaps_rollup")
	if not raw:
		return None
	values: dict[str, int] = {}
	for line in raw.decode().splitlines():
		parts = line.split()
		if len(parts) >= 3 and parts[0] in ("Rss:", "Pss:"):
			values[parts[0][:-1]] = int(parts[1])
	if "Rss" not in values or "Pss" not in values:
		return None
	return Memory(rss_kib=values["Rss"], pss_kib=values["Pss"])


def render_nodes(pid: int) -> set[str]:
	"""The /dev/dri nodes a process holds open, which name the GPU it renders on."""
	nodes: set[str] = set()
	try:
		fds = os.listdir(f"/proc/{pid}/fd")
	except OSError:
		return nodes
	for fd in fds:
		try:
			target = os.readlink(f"/proc/{pid}/fd/{fd}")
		except OSError:
			continue
		if target.startswith("/dev/dri/"):
			nodes.add(target)
	return nodes


class AppProcess:
	"""One launch of an app under test, and every process it started."""

	def __init__(self, argv: list[str], env: dict[str, str], cwd: Path, tag: str, log_path: Path) -> None:
		self.tag = tag
		self.log_path = log_path
		self._log = open(log_path, "ab")
		full_env = dict(env)
		full_env[TAG_ENV] = tag
		self.spawned_ns = time.monotonic_ns()
		self.popen = subprocess.Popen(
			argv,
			env=full_env,
			cwd=cwd,
			stdin=subprocess.DEVNULL,
			stdout=self._log,
			stderr=subprocess.STDOUT,
			start_new_session=True,
		)

	@property
	def pid(self) -> int:
		return self.popen.pid

	def alive(self) -> bool:
		return self.popen.poll() is None

	def pids(self) -> list[int]:
		return tagged_pids(self.tag)

	def stop(self, grace_s: float = 5.0) -> None:
		"""SIGTERM every tagged process, then SIGKILL what is left after `grace_s`."""
		deadline = time.monotonic() + grace_s
		for pid in self.pids():
			try:
				os.kill(pid, signal.SIGTERM)
			except ProcessLookupError:
				pass
		while time.monotonic() < deadline:
			self.popen.poll()
			if not self.pids():
				break
			time.sleep(0.05)
		for pid in self.pids():
			try:
				os.kill(pid, signal.SIGKILL)
			except ProcessLookupError:
				pass
		kill_deadline = time.monotonic() + 5.0
		while self.pids():
			self.popen.poll()
			if time.monotonic() > kill_deadline:
				raise RuntimeError(f"processes tagged {self.tag} survived SIGKILL: {self.pids()}")
			time.sleep(0.05)
		self.popen.wait(timeout=5)
		self._log.close()
