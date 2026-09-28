#!/usr/bin/env python3
"""Desktop bench probes: prepare one app, measure it, write its report.

run.sh starts the private display this script draws on and calls it:

  probes.py --app veyyon|t3 --binary PATH --display :N --out DIR [--samples N]
            [--name NAME] [--probes cold_launch,keystroke,switch,token,steady]
            [--survey [X,Y ...]]

Every probe reads the app window's pixels through XShm and drives the app
through XTest, so both apps are measured by one method. Times are
CLOCK_MONOTONIC nanoseconds, the clock fake_llm.py stamps each token with.
Window coordinates come from layout-<app>.json; `--survey` launches the app
once, clicks the given points, relaunches it, and writes a screenshot after
every step, which is how a layout file is derived.
"""

from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import math
import os
import platform
import random
import re
import shutil
import statistics
import struct
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

import apps
import corpus
import procs
from imaging import write_png
from xdisplay import Capture, Display, Rect, WindowInfo

BENCH_DIR = Path(__file__).resolve().parent
REPO_ROOT = BENCH_DIR.parents[1]
RGB = np.uint32(0x00FFFFFF)

# A change narrower than CARET_WIDTH and smaller than CARET_PIXELS is a text
# caret blinking, not content.
CARET_WIDTH = 6
CARET_PIXELS = 60
QUIET_MS = 400
TOKEN_SPACING_MS = 250
FIRST_TOKEN_DELAY_MS = 1500
WHEEL_HZ = 60
SCROLL_S = 5
IDLE_S = 30
# Glyphs at least 6 px wide at the composer's size, so every keystroke clears
# the caret filter.
KEYS = ("m", "o", "w", "s", "e", "k", "a", "n", "d", "h", "x", "b")
PROMPT = "bench token probe"
PROBES = ("cold_launch", "keystroke", "switch", "token", "steady")


def now() -> int:
	return time.monotonic_ns()


def significant(count: int, bbox: tuple[int, int, int, int] | None) -> bool:
	return count >= CARET_PIXELS or (bbox is not None and bbox[2] >= CARET_WIDTH)


def p95(values: list[float]) -> float:
	ordered = sorted(values)
	return ordered[max(1, math.ceil(0.95 * len(ordered))) - 1]


def probe(samples: list[float], unit: str, notes: str, **extra: object) -> dict[str, object]:
	result: dict[str, object] = {
		"samples": [round(float(v), 3) for v in samples],
		"median": round(float(statistics.median(samples)), 3) if samples else None,
		"p95": round(float(p95(samples)), 3) if samples else None,
		"unit": unit,
		"notes": notes,
	}
	result.update(extra)
	return result


def rect_of(layout: dict, name: str) -> Rect:
	r = layout[name]
	return Rect(int(r["x"]), int(r["y"]), int(r["w"]), int(r["h"]))


def load_layout(app: str, required: bool) -> dict:
	path = BENCH_DIR / f"layout-{app}.json"
	if not path.exists():
		if required:
			raise SystemExit(f"probes.py: {path} is missing; derive it from `run.sh {app} --survey`")
		return {}
	return json.loads(path.read_text(encoding="utf-8"))


class Region:
	"""One rectangle of the app window, polled for changes between successive grabs."""

	def __init__(self, display: Display, window: WindowInfo, rect: Rect) -> None:
		self.rect = rect
		self.cap = Capture(display, window, rect)
		self.prev = self.cap.grab() & RGB
		self.cur = np.empty_like(self.prev)
		self.polls = 0
		self.poll_ns = 0

	def poll(self) -> tuple[int, int, tuple[int, int, int, int] | None]:
		"""Grabs once: (grab midpoint, changed pixels, changed bbox) against the previous grab."""
		t0 = now()
		frame = self.cap.grab()
		t1 = now()
		np.bitwise_and(frame, RGB, out=self.cur)
		diff = self.cur != self.prev
		self.diff = diff
		count = int(np.count_nonzero(diff))
		bbox = None
		if count:
			rows = np.flatnonzero(diff.any(axis=1))
			cols = np.flatnonzero(diff.any(axis=0))
			bbox = (int(cols[0]), int(rows[0]), int(cols[-1] - cols[0] + 1), int(rows[-1] - rows[0] + 1))
		self.prev, self.cur = self.cur, self.prev
		self.polls += 1
		self.poll_ns += now() - t0
		return (t0 + t1) // 2, count, bbox

	def frame(self) -> np.ndarray:
		return self.prev.copy()

	def poll_ms(self) -> float:
		return self.poll_ns / self.polls / 1e6 if self.polls else float("nan")

	def close(self) -> None:
		self.cap.close()


def settle(
	region: Region, quiet_ms: int, timeout_s: float, pause_s: float = 0.0, need_change: bool = False
) -> tuple[int | None, int | None, bool]:
	"""Polls until no significant change for `quiet_ms`: (first change, last change, settled).

	With `need_change` the quiet period starts at the first change, so a change
	that begins more than `quiet_ms` after the call is still waited for.
	"""
	start = now()
	first = last = None
	quiet = quiet_ms * 1_000_000
	limit = start + int(timeout_s * 1e9)
	while True:
		t, count, bbox = region.poll()
		if significant(count, bbox):
			if first is None:
				first = t
			last = t
		if (last is not None or not need_change) and t - (last if last is not None else start) >= quiet:
			return first, last, True
		if t >= limit:
			return first, last, False
		if pause_s:
			time.sleep(pause_s)


def first_change(region: Region, timeout_s: float) -> int | None:
	limit = now() + int(timeout_s * 1e9)
	while True:
		t, count, bbox = region.poll()
		if significant(count, bbox):
			return t
		if t >= limit:
			return None


class Tail:
	"""New JSON lines appended to a file since it was opened."""

	def __init__(self, path: Path) -> None:
		self.handle = open(path, encoding="utf-8")
		self.handle.seek(0, os.SEEK_END)
		self.partial = ""

	def read(self) -> list[dict]:
		chunk = self.handle.read()
		if not chunk:
			return []
		lines = (self.partial + chunk).split("\n")
		self.partial = lines.pop()
		return [json.loads(line) for line in lines if line.strip()]

	def close(self) -> None:
		self.handle.close()


def _run(argv: list[str]) -> str:
	try:
		done = subprocess.run(argv, capture_output=True, text=True, timeout=10)
	except (OSError, subprocess.TimeoutExpired) as error:
		return f"unavailable ({error})"
	return (done.stdout + done.stderr).strip()


def _asar_version(asar: Path) -> str | None:
	with open(asar, "rb") as handle:
		_, header_size, _, json_len = struct.unpack("<4I", handle.read(16))
		entry = json.loads(handle.read(json_len))["files"]["package.json"]
		handle.seek(8 + header_size + int(entry["offset"]))
		return json.loads(handle.read(int(entry["size"]))).get("version")


def app_version(cfg: argparse.Namespace) -> str:
	binary: Path = cfg.binary
	if cfg.app == "veyyon":
		digest = hashlib.sha256(binary.read_bytes()).hexdigest()[:12]
		return f"{binary.name} (sha256 {digest}, assets {cfg.assets_revision})"
	for desktop in sorted(binary.parent.glob("*.desktop")):
		match = re.search(r"^X-AppImage-Version=(.+)$", desktop.read_text(errors="replace"), re.M)
		if match:
			return f"T3 Code {match.group(1).strip()}"
	for asar in (binary.parent / "resources" / "app.asar",):
		try:
			version = _asar_version(asar)
		except (OSError, ValueError, KeyError, struct.error):
			version = None
		if version:
			return f"T3 Code {version}"
	return f"T3 Code (version unknown, {binary.name})"


def environment(cfg: argparse.Namespace) -> dict[str, object]:
	pci = apps.DRM_PCI_TAG.removeprefix("pci-").split("_")
	cpu = "unknown"
	for line in Path("/proc/cpuinfo").read_text().splitlines():
		if line.startswith("model name"):
			cpu = line.split(":", 1)[1].strip()
			break
	output: dict[str, object] = {}
	refresh_hz = 60.0
	if cfg.swaysock:
		try:
			outputs = json.loads(_run(["swaymsg", "-s", cfg.swaysock, "-t", "get_outputs", "-r"]))
			mode = outputs[0]["current_mode"]
			refresh_hz = mode["refresh"] / 1000.0
			output = {"name": outputs[0]["name"], "width": mode["width"], "height": mode["height"], "refresh_hz": refresh_hz}
		except (ValueError, KeyError, IndexError):
			output = {"error": "swaymsg get_outputs failed"}
	xwayland = next((line for line in _run(["Xwayland", "-version"]).splitlines() if "ersion" in line), "unknown")
	env: dict[str, object] = {
		"kernel": platform.release(),
		"cpu": cpu,
		"gpu": _run(["lspci", "-s", f"{pci[0]}:{pci[1]}:{pci[2]}.{pci[3]}"]),
		"display_server": f"{_run(['sway', '--version'])}, headless backend, {xwayland.strip()}",
		"x_display": cfg.display,
		"output": output,
		"refresh_hz": refresh_hz,
		"app_version": app_version(cfg),
	}
	if cfg.app == "t3":
		env["codex"] = _run([str(cfg.codex), "--version"])
	else:
		env["bun"] = _run([str(cfg.bun), "--version"])
	return env


class Bench:
	def __init__(self, cfg: argparse.Namespace, layout: dict) -> None:
		self.cfg = cfg
		self.layout = layout
		self.work = REPO_ROOT / ".internal" / "bench" / "work" / cfg.name
		if self.work.exists():
			shutil.rmtree(self.work)
		self.logs = self.work / "logs"
		self.logs.mkdir(parents=True)
		self.display = Display(cfg.display)
		self.tokens = max(40, 2 * cfg.samples)
		self.llm_log = self.work / "llm.jsonl"
		self.llm: subprocess.Popen | None = None
		self.llm_out = None
		self.spec: apps.Launch | None = None
		self.pristine = self.work / "pristine-home"
		self.reference: np.ndarray | None = None
		self.launches = 0
		self.refresh_hz = 60.0
		self.render_nodes: dict[str, list[str]] = {}

	# Setup -------------------------------------------------------------------

	def start_llm(self) -> int:
		port_file = self.work / "llm.port"
		self.llm_out = open(self.logs / "llm.out", "ab")
		self.llm = subprocess.Popen(
			[
				sys.executable,
				str(BENCH_DIR / "fake_llm.py"),
				"--port-file",
				str(port_file),
				"--log",
				str(self.llm_log),
				"--tokens",
				str(self.tokens),
				"--rate-ms",
				str(TOKEN_SPACING_MS),
				"--first-token-delay-ms",
				str(FIRST_TOKEN_DELAY_MS),
			],
			stdin=subprocess.DEVNULL,
			stdout=self.llm_out,
			stderr=subprocess.STDOUT,
			start_new_session=True,
		)
		deadline = time.monotonic() + 15
		while not port_file.exists():
			if self.llm.poll() is not None:
				raise RuntimeError(f"fake_llm.py exited; see {self.logs / 'llm.out'}")
			if time.monotonic() > deadline:
				raise TimeoutError("fake_llm.py did not report its port within 15 s")
			time.sleep(0.02)
		return int(port_file.read_text().strip())

	def prepare(self, port: int) -> None:
		cfg = self.cfg
		run_dir = self.work / "run"
		if cfg.app == "veyyon":
			self.spec = apps.prepare_veyyon(
				run_dir, port, cfg.display, cfg.runtime_dir, cfg.binary, cfg.bun, cfg.assets_revision
			)
		else:
			self.spec = apps.prepare_t3(run_dir, port, cfg.display, cfg.runtime_dir, cfg.binary, cfg.codex, cfg.node)

	def close(self) -> None:
		if self.llm is not None and self.llm.poll() is None:
			self.llm.terminate()
			try:
				self.llm.wait(timeout=5)
			except subprocess.TimeoutExpired:
				self.llm.kill()
		if self.llm_out is not None:
			self.llm_out.close()
		self.display.close()

	# Launch ------------------------------------------------------------------

	def park_pointer(self) -> None:
		x, y = self.layout.get("idle_pointer", [1590, 500])
		self.display.move(int(x), int(y))
		self.display.sync()

	def click(self, window: WindowInfo, x: int, y: int) -> None:
		self.display.click(window.x + int(x), window.y + int(y))

	def row(self, key: str) -> tuple[int, int]:
		x, y = self.layout["rows"][key]
		return int(x), int(y)

	def shot(self, window: WindowInfo, name: str) -> None:
		"""A full-window PNG in the work directory, to check the layout a probe used."""
		with Capture(self.display, window, Rect(0, 0, window.width, window.height)) as cap:
			write_png(str(self.work / f"{name}.png"), cap.snapshot())

	def scrub_home(self) -> None:
		assert self.spec is not None
		leftover = self.spec.home / ".t3" / "userdata" / "server-runtime.json"
		if leftover.exists():
			leftover.unlink()

	def restore(self) -> None:
		assert self.spec is not None
		if self.spec.home.exists():
			shutil.rmtree(self.spec.home)
		shutil.copytree(self.pristine, self.spec.home, symlinks=True)

	def start(self, label: str) -> procs.AppProcess:
		assert self.spec is not None
		self.launches += 1
		self.park_pointer()
		tag = f"bench-{self.cfg.name}-{self.launches}-{label}"
		return self.spec.start(tag, self.logs / f"{self.launches:03d}-{label}.log")

	def wait_window(self, proc: procs.AppProcess, limit: int) -> WindowInfo:
		need_w, need_h = self.layout.get("window", [400, 300])
		while True:
			window = self.display.app_window()
			if window is not None and window.width >= need_w and window.height >= need_h:
				return window
			if not proc.alive():
				raise RuntimeError(f"the app exited with {proc.popen.returncode}; see {proc.log_path}")
			if now() >= limit:
				raise TimeoutError(f"no {need_w}x{need_h} window appeared; see {proc.log_path}")
			time.sleep(0.002)

	def wait_ready(self, proc: procs.AppProcess, timeout_s: float = 120) -> tuple[int, int, WindowInfo]:
		"""(first frame whose sidebar matches the settled reference, window mapped, window)."""
		assert self.reference is not None
		limit = now() + int(timeout_s * 1e9)
		window = self.wait_window(proc, limit)
		mapped = now()
		rect = rect_of(self.layout, "sidebar")
		tolerance = max(50, self.reference.size // 1000)
		cap: Capture | None = None
		closest: int | None = None
		try:
			while True:
				if cap is None:
					try:
						cap = Capture(self.display, window, rect)
					except (ValueError, RuntimeError):
						time.sleep(0.002)
						window = self.wait_window(proc, limit)
						continue
				t0 = now()
				try:
					frame = cap.grab()
				except RuntimeError:
					cap.close()
					cap = None
					window = self.wait_window(proc, limit)
					continue
				t1 = now()
				mismatch = int(np.count_nonzero((frame & RGB) != self.reference))
				closest = mismatch if closest is None else min(closest, mismatch)
				if mismatch <= tolerance:
					return (t0 + t1) // 2, mapped, window
				if t1 >= limit:
					raise TimeoutError(
						f"the sidebar did not match the settled reference within {timeout_s:.0f} s; "
						f"the closest frame differed in {closest} pixels"
					)
		finally:
			if cap is not None:
				cap.close()

	def launch_ready(self, label: str) -> tuple[procs.AppProcess, WindowInfo]:
		self.restore()
		proc = self.start(label)
		try:
			_, _, window = self.wait_ready(proc)
			for x, y in self.layout.get("launch_clicks", []):
				self.click(window, x, y)
				time.sleep(0.8)
		except BaseException:
			proc.stop()
			raise
		return proc, window

	def warm_up(self) -> None:
		"""One launch that fills the shader and font caches; its home becomes the pristine home."""
		assert self.spec is not None
		proc = self.start("warmup")
		try:
			window = self.wait_window(proc, now() + int(180e9))
			full = Region(self.display, window, Rect(0, 0, window.width, window.height))
			try:
				settle(full, 3000, 60, 0.005)
				for x, y in self.layout.get("setup_clicks", []):
					self.click(window, x, y)
					settle(full, 1500, 30, 0.005)
				write_png(str(self.work / "warmup.png"), full.frame())
			finally:
				full.close()
		finally:
			proc.stop()
		self.scrub_home()
		shutil.copytree(self.spec.home, self.pristine, symlinks=True)

	def make_reference(self) -> None:
		"""The settled sidebar of a launch from the pristine home: the cold-launch finish line."""
		self.restore()
		proc = self.start("reference")
		try:
			window = self.wait_window(proc, now() + int(120e9))
			full = Region(self.display, window, Rect(0, 0, window.width, window.height))
			try:
				settle(full, 3000, 90, 0.005)
				time.sleep(5)
				_, _, quiet = settle(full, 3000, 60, 0.005)
				if not quiet:
					raise RuntimeError("the window never held still for 3 s; there is no ready reference")
				frame = full.frame()
			finally:
				full.close()
		finally:
			proc.stop()
		r = rect_of(self.layout, "sidebar")
		self.reference = frame[r.y : r.y + r.h, r.x : r.x + r.w].copy()
		write_png(str(self.work / "ready.png"), frame)
		write_png(str(self.work / "ready-sidebar.png"), self.reference)

	def survey(self, clicks: list[tuple[int, int]]) -> list[Path]:
		"""Screenshots of a first launch, of each click, and of a relaunch on the same home."""
		shots: list[Path] = []
		for launch in (0, 1):
			proc = self.start("survey")
			try:
				window = self.wait_window(proc, now() + int(180e9))
				full = Region(self.display, window, Rect(0, 0, window.width, window.height))
				try:
					settle(full, 3000, 60, 0.005)
					steps = clicks if launch == 0 else []
					for step in range(len(steps) + 1):
						if step:
							self.click(window, *steps[step - 1])
							settle(full, 1500, 30, 0.005)
						path = self.work / f"survey-{launch}-{step}.png"
						write_png(str(path), full.frame())
						shots.append(path)
				finally:
					full.close()
			finally:
				proc.stop()
		return shots

	# Probes ------------------------------------------------------------------

	def cold_launch(self) -> dict[str, object]:
		ready: list[float] = []
		mapped: list[float] = []
		for _ in range(self.cfg.samples):
			self.restore()
			time.sleep(0.5)
			proc = self.start("cold")
			try:
				t_ready, t_mapped, _ = self.wait_ready(proc)
			finally:
				proc.stop()
			ready.append((t_ready - proc.spawned_ns) / 1e6)
			mapped.append((t_mapped - proc.spawned_ns) / 1e6)
		return {
			"cold_launch_ms": probe(
				ready,
				"ms",
				"exec to the first frame whose sidebar matches the settled reference (at most 0.1% of its pixels differ); "
				"home restored from the post-warm-up snapshot before each launch",
			),
			"cold_launch_window_ms": probe(mapped, "ms", "exec to the first mapped window at full size"),
		}

	def keystroke(self) -> dict[str, object]:
		proc, window = self.launch_ready("keystroke")
		region: Region | None = None
		try:
			self.click(window, *self.row(corpus.SWITCH_THREAD_KEYS[0]))
			time.sleep(1.5)
			self.click(window, *self.layout["composer_click"])
			region = Region(self.display, window, rect_of(self.layout, "composer"))
			settle(region, 1200, 10)
			# The first character replaces the placeholder; it is not a sample.
			self.display.tap(KEYS[0])
			settle(region, 500, 5)
			rng = random.Random(corpus.SEED)
			samples: list[float] = []
			misses = 0
			region.polls = region.poll_ns = 0
			for i in range(self.cfg.samples):
				key = KEYS[(i + 1) % len(KEYS)]
				time.sleep(0.2 + rng.random() * 0.1)
				region.poll()
				t0 = now()
				self.display.key(key, True)
				hit = first_change(region, 2.0)
				self.display.key(key, False)
				if hit is None:
					misses += 1
				else:
					samples.append((hit - t0) / 1e6)
				settle(region, 150, 3)
			self.shot(window, "keystroke")
			return {
				"keystroke_ms": probe(
					samples,
					"ms",
					f"XTest key press into the focused composer of an open thread to the first composer change at least "
					f"{CARET_WIDTH} px wide or {CARET_PIXELS} px large; poll period {region.poll_ms():.2f} ms; "
					f"{misses} keys drew nothing within 2 s",
				)
			}
		finally:
			if region is not None:
				region.close()
			proc.stop()

	def switch(self) -> dict[str, object]:
		proc, window = self.launch_ready("switch")
		region: Region | None = None
		try:
			keys = corpus.SWITCH_THREAD_KEYS
			region = Region(self.display, window, rect_of(self.layout, "transcript"))
			self.click(window, *self.row(keys[0]))
			settle(region, 1000, 20)
			first_ms: list[float] = []
			settle_ms: list[float] = []
			frames: dict[str, set[str]] = {key: set() for key in keys}
			misses = 0
			region.polls = region.poll_ns = 0
			for i in range(self.cfg.samples):
				key = keys[(i + 1) % 2]
				x, y = self.row(key)
				self.display.move(window.x + x, window.y + y)
				self.display.sync()
				time.sleep(0.15)
				region.poll()
				t0 = now()
				self.display.button(1, True)
				self.display.button(1, False)
				first, last, quiet = settle(region, QUIET_MS, 10, need_change=True)
				if first is None or last is None or not quiet:
					misses += 1
					continue
				first_ms.append((first - t0) / 1e6)
				settle_ms.append((last - t0) / 1e6)
				frames[key].add(hashlib.sha1(region.frame().tobytes()).hexdigest()[:12])
				time.sleep(0.2)
			distinct = ", ".join(f"{key}: {len(hashes)}" for key, hashes in frames.items())
			shared = len(frames[keys[0]] & frames[keys[1]])
			notes = (
				f"click on a sidebar row, alternating {keys[0]} and {keys[1]}; transcript region; poll period "
				f"{region.poll_ms():.2f} ms; distinct settled frames per thread {distinct}; frames shared by both "
				f"threads {shared}; {misses} clicks drew nothing or never settled"
			)
			self.shot(window, "switch")
			return {
				"switch_first_ms": probe(first_ms, "ms", "to the first transcript change; " + notes),
				"switch_settle_ms": probe(settle_ms, "ms", f"to the last change before {QUIET_MS} ms of quiet; " + notes),
			}
		finally:
			if region is not None:
				region.close()
			proc.stop()

	def token(self) -> dict[str, object]:
		proc, window = self.launch_ready("token")
		region: Region | None = None
		tail = Tail(self.llm_log)
		try:
			self.click(window, *self.row(corpus.SWITCH_THREAD_KEYS[0]))
			time.sleep(1.5)
			self.click(window, *self.layout["composer_click"])
			time.sleep(0.3)
			self.display.type_text(PROMPT)
			time.sleep(0.5)
			region = Region(self.display, window, rect_of(self.layout, "stream"))
			tail.read()
			region.poll()
			t_send = now()
			self.display.tap("Return")
			# (time, changed pixels, bbox, packed change mask) of every grab that changed.
			events: list[tuple[int, int, tuple[int, int, int, int] | None, np.ndarray]] = []
			records: list[dict] = []
			done: dict | None = None
			next_read = t_send
			limit = t_send + int(120e9)
			while True:
				t, count, bbox = region.poll()
				if count:
					events.append((t, count, bbox, np.packbits(region.diff)))
				if t >= next_read:
					next_read = t + 200_000_000
					for record in tail.read():
						records.append(record)
						if record.get("event") == "done" and record.get("tokens") == self.tokens and done is None:
							done = record
				if done is not None and t >= done["t_ns"] + 2_000_000_000:
					break
				if t >= limit:
					raise TimeoutError(f"no {self.tokens}-token turn finished within 120 s of pressing Return")
			tokens = sorted(
				(r for r in records if r.get("event") == "token" and r.get("req") == done["req"]), key=lambda r: r["i"]
			)
			if not tokens:
				raise RuntimeError("the turn finished without logged tokens")
			first_token = tokens[0]["t_ns"]
			shape = region.prev.shape

			def unpack(packed: np.ndarray) -> np.ndarray:
				return np.unpackbits(packed, count=shape[0] * shape[1]).reshape(shape).astype(bool)

			# Pixels that changed in the 800 ms before the first token (a spinner,
			# a shimmer, a timer) are animation; a later change counts as a token
			# paint only on the pixels outside that mask.
			animated = np.zeros(shape, dtype=bool)
			for t, count, bbox, packed in events:
				if first_token - 800_000_000 <= t < first_token and significant(count, bbox):
					animated |= unpack(packed)
			paints: list[int] = []
			for t, count, bbox, packed in events:
				if t < first_token:
					continue
				content = unpack(packed) & ~animated
				n = int(np.count_nonzero(content))
				box = None
				if n:
					cols = np.flatnonzero(content.any(axis=0))
					box = (int(cols[0]), 0, int(cols[-1] - cols[0] + 1), 0)
				if significant(n, box):
					paints.append(t)
			latencies: list[float] = []
			matched: list[int] = []
			for record in tokens:
				j = bisect.bisect_left(paints, record["t_ns"])
				if j < len(paints):
					latencies.append((paints[j] - record["t_ns"]) / 1e6)
					matched.append(j)
			coalesced = len(matched) - len(set(matched))
			after = sum(1 for t in paints if t >= done["t_ns"] + 500_000_000)
			animated_pct = 100.0 * np.count_nonzero(animated) / animated.size
			self.shot(window, "token")
			return {
				"token_to_paint_ms": probe(
					latencies,
					"ms",
					f"{len(tokens)} tokens {TOKEN_SPACING_MS} ms apart; each token's send time to the first stream-region "
					f"change at or after it; {len(tokens) - len(latencies)} tokens without a later paint; {coalesced} tokens "
					f"coalesced into another token's paint; {animated_pct:.1f}% of the region masked as animation; "
					f"{after} paints later than 500 ms after the last token; poll period {region.poll_ms():.2f} ms",
					first_token_delay_ms=round((first_token - t_send) / 1e6, 3),
				)
			}
		finally:
			tail.close()
			if region is not None:
				region.close()
			proc.stop()

	def ui_pids(self, proc: procs.AppProcess) -> list[int]:
		if self.cfg.app == "veyyon":
			return [proc.pid]
		return [pid for pid in proc.pids() if "--type=renderer" in procs.cmdline(pid)]

	def idle_cpu(self, proc: procs.AppProcess) -> dict[str, object]:
		ui = set(self.ui_pids(proc))
		ui_pct: list[float] = []
		tree_pct: list[float] = []
		prev_t = time.monotonic()
		prev = {pid: procs.cpu_ticks(pid) for pid in proc.pids()}
		for _ in range(IDLE_S):
			time.sleep(1.0)
			cur_t = time.monotonic()
			cur = {pid: procs.cpu_ticks(pid) for pid in proc.pids()}
			span = cur_t - prev_t

			def delta(pids: object) -> int:
				return sum(
					cur[pid] - prev[pid] for pid in pids if cur.get(pid) is not None and prev.get(pid) is not None
				)

			tree_pct.append(100.0 * delta(cur.keys()) / procs.CLOCK_TICKS / span)
			ui_pct.append(100.0 * delta(ui) / procs.CLOCK_TICKS / span)
			prev, prev_t = cur, cur_t
		names = ", ".join(sorted({procs.comm(pid) for pid in ui}))
		note = f"{IDLE_S} one-second samples with an open, settled thread and the pointer parked; % of one core"
		return {
			"idle_cpu_ui_pct": probe(ui_pct, "% core", f"UI process ({names}); " + note, mean=round(statistics.fmean(ui_pct), 3)),
			"idle_cpu_tree_pct": probe(tree_pct, "% core", "whole process tree; " + note, mean=round(statistics.fmean(tree_pct), 3)),
		}

	def memory(self, proc: procs.AppProcess) -> dict[str, object]:
		pids = proc.pids()
		ui = set(self.ui_pids(proc))
		mems = {pid: procs.memory(pid) for pid in pids}
		live = {pid: m for pid, m in mems.items() if m is not None}
		rss = sum(m.rss_kib for m in live.values()) / 1024
		pss = sum(m.pss_kib for m in live.values()) / 1024
		ui_pss = sum(m.pss_kib for pid, m in live.items() if pid in ui) / 1024
		for pid in pids:
			nodes = procs.render_nodes(pid)
			if nodes:
				self.render_nodes[f"{pid} {procs.comm(pid)}"] = sorted(nodes)
		note = f"{len(live)} processes after opening the {corpus.LONG_THREAD_ENTRIES}-entry thread; UI process PSS {ui_pss:.1f} MiB"
		return {
			"memory_tree_rss_mib": probe([rss], "MiB", "sum of per-process RSS (counts shared pages once per process); " + note),
			"memory_tree_pss_mib": probe([pss], "MiB", "sum of per-process PSS; " + note),
		}

	def scroll(self, window: WindowInfo) -> dict[str, object]:
		rect = rect_of(self.layout, "scroll")
		region = Region(self.display, window, rect)
		try:
			self.display.move(window.x + rect.x + rect.w // 2, window.y + rect.y + rect.h // 2)
			self.display.sync()
			time.sleep(0.5)
			settle(region, 500, 5)
			# Wheel up from the bottom of the thread; wheel down when the thread opened at its top.
			button = 4
			self.display.button(button, True)
			self.display.button(button, False)
			if first_change(region, 0.5) is None:
				button = 5
			settle(region, 500, 5)
			region.polls = region.poll_ns = 0
			period = int(1e9 / WHEEL_HZ)
			start = now()
			end = start + SCROLL_S * 1_000_000_000
			next_wheel = start
			wheels = 0
			changes: list[int] = []
			while True:
				t = now()
				if t >= end:
					break
				if t >= next_wheel:
					self.display.button(button, True)
					self.display.button(button, False)
					wheels += 1
					next_wheel += period
				tf, count, _ = region.poll()
				if count:
					changes.append(tf)
		finally:
			region.close()
		refresh_ms = 1000.0 / self.refresh_hz
		intervals = [(b - a) / 1e6 for a, b in zip(changes, changes[1:])]
		gaps = sum(1 for v in intervals if v > 1.5 * refresh_ms)
		per_second = [sum(1 for c in changes if start + k * 1_000_000_000 <= c < start + (k + 1) * 1_000_000_000) for k in range(SCROLL_S)]
		direction = "up" if button == 4 else "down"
		note = (
			f"{wheels} wheel-{direction} clicks at {WHEEL_HZ} Hz for {SCROLL_S} s over the {corpus.LONG_THREAD_ENTRIES}-entry "
			f"thread; a frame is a grab that differs from the previous one; output refresh {self.refresh_hz:.2f} Hz; "
			f"poll period {region.poll_ms():.2f} ms"
		)
		return {
			"scroll_fps": probe(per_second, "frames/s", "distinct frames in each second; " + note, frames=len(changes)),
			"scroll_frame_interval_ms": probe(intervals, "ms", "interval between distinct frames; " + note),
			"scroll_gaps": probe(
				[gaps],
				"count",
				f"inter-frame intervals over {1.5 * refresh_ms:.2f} ms (1.5x the refresh interval); " + note,
				longest_gap_ms=round(max(intervals), 3) if intervals else None,
			),
		}

	def steady(self) -> dict[str, object]:
		"""Idle CPU with a short thread open, then memory and scrolling with the long thread open."""
		proc, window = self.launch_ready("steady")
		results: dict[str, object] = {}
		try:
			transcript = Region(self.display, window, rect_of(self.layout, "transcript"))
			try:
				self.click(window, *self.row(corpus.SWITCH_THREAD_KEYS[0]))
				settle(transcript, 1000, 20, 0.002)
				self.park_pointer()
				settle(transcript, 2000, 20, 0.002)
				results.update(self.idle_cpu(proc))
				x, y = self.row(corpus.LONG_THREAD_KEY)
				self.display.move(window.x + x, window.y + y)
				self.display.sync()
				time.sleep(0.15)
				transcript.poll()
				t0 = now()
				self.display.button(1, True)
				self.display.button(1, False)
				_, last, quiet = settle(transcript, 1000, 180, 0.002, need_change=True)
			finally:
				transcript.close()
			if last is not None:
				results["long_thread_open_ms"] = probe(
					[(last - t0) / 1e6],
					"ms",
					f"click on the {corpus.LONG_THREAD_ENTRIES}-entry thread to the last transcript change before 1 s of quiet"
					+ ("" if quiet else "; the transcript never went quiet within 180 s"),
				)
			time.sleep(2)
			self.shot(window, "long-thread")
			results.update(self.memory(proc))
			results.update(self.scroll(window))
		finally:
			proc.stop()
		return results


def markdown(report: dict) -> str:
	lines = [
		f"# {report['name']}: {report['environment'].get('app_version', report['app'])}",
		"",
		f"Run started {report['started']}; {report['samples_requested']} samples requested per repeatable probe.",
		"",
		"| probe | unit | n | median | p95 | notes |",
		"|---|---|---:|---:|---:|---|",
	]
	for name, result in report["probes"].items():
		lines.append(
			f"| {name} | {result['unit']} | {len(result['samples'])} | {result['median']} | {result['p95']} | {result['notes']} |"
		)
	if report["failed"]:
		lines += ["", "Probes that did not run:", ""]
		lines += [f"- {name}: {reason}" for name, reason in report["failed"].items()]
	lines += ["", "Environment:", ""]
	lines += [f"- {key}: {value}" for key, value in report["environment"].items()]
	return "\n".join(lines) + "\n"


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("--app", choices=("veyyon", "t3"), required=True)
	parser.add_argument("--binary", type=Path, required=True)
	parser.add_argument("--display", required=True)
	parser.add_argument("--runtime-dir", default=os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"))
	parser.add_argument("--swaysock", default=os.environ.get("SWAYSOCK", ""))
	parser.add_argument("--out", type=Path, required=True)
	parser.add_argument("--name")
	parser.add_argument("--samples", type=int, default=20)
	parser.add_argument("--probes", default=",".join(PROBES))
	parser.add_argument("--bun", type=Path)
	parser.add_argument("--codex", type=Path)
	parser.add_argument("--node", type=Path)
	parser.add_argument("--assets-revision")
	parser.add_argument("--survey", nargs="*", metavar="X,Y")
	cfg = parser.parse_args()
	if cfg.display.split(".")[0] in ("", ":0", ":1"):
		parser.error(f"display {cfg.display!r} is not a private bench display")
	cfg.binary = cfg.binary.resolve()
	cfg.name = cfg.name or cfg.app
	selected = [p for p in cfg.probes.split(",") if p]
	unknown = sorted(set(selected) - set(PROBES))
	if unknown:
		parser.error(f"unknown probes {unknown}; choose from {', '.join(PROBES)}")
	if cfg.app == "veyyon":
		if cfg.bun is None:
			parser.error("--bun is required for veyyon")
		if cfg.assets_revision is None:
			match = re.search(r"-([0-9a-f]{7,40})$", cfg.binary.name)
			cfg.assets_revision = match.group(1) if match else "HEAD"
	elif cfg.codex is None or cfg.node is None:
		parser.error("--codex and --node are required for t3")

	layout = load_layout(cfg.app, required=cfg.survey is None)
	started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
	env = environment(cfg)
	bench = Bench(cfg, layout)
	bench.refresh_hz = float(env["refresh_hz"])  # type: ignore[arg-type]
	results: dict[str, object] = {}
	failed: dict[str, str] = {}
	try:
		bench.prepare(bench.start_llm())
		if cfg.survey is not None:
			clicks = [tuple(int(v) for v in point.split(",")) for point in cfg.survey]
			for path in bench.survey(clicks):  # type: ignore[arg-type]
				print(path)
			return 0
		bench.warm_up()
		bench.make_reference()
		for name in selected:
			started_probe = time.monotonic()
			try:
				results.update(getattr(bench, name)())
			except Exception as error:  # noqa: BLE001 - a failed probe is reported, the rest still run
				failed[name] = f"{type(error).__name__}: {error}"
			print(f"{name}: {time.monotonic() - started_probe:.0f} s{' FAILED ' + failed[name] if name in failed else ''}", flush=True)
	finally:
		bench.close()
	env["render_nodes"] = bench.render_nodes
	report = {
		"app": cfg.app,
		"name": cfg.name,
		"binary": cfg.binary.name,
		"started": started,
		"samples_requested": cfg.samples,
		"corpus": {
			"seed": corpus.SEED,
			"projects": len(corpus.PROJECTS),
			"threads": len(corpus.PROJECTS) * corpus.THREADS_PER_PROJECT,
			"long_thread_entries": corpus.LONG_THREAD_ENTRIES,
			"short_thread_entries": corpus.SHORT_THREAD_ENTRIES,
		},
		"environment": env,
		"probes": results,
		"failed": failed,
	}
	cfg.out.mkdir(parents=True, exist_ok=True)
	(cfg.out / f"{cfg.name}.json").write_text(json.dumps(report, indent="\t") + "\n", encoding="utf-8")
	(cfg.out / f"{cfg.name}.md").write_text(markdown(report), encoding="utf-8")
	print(cfg.out / f"{cfg.name}.json")
	return 1 if failed else 0


if __name__ == "__main__":
	sys.exit(main())
