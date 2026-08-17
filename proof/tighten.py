#!/usr/bin/env python3
"""Collapse dead space in the commit recordings.

A commit recording of a paged diff is a slideshow: the pager draws a page, holds it
for seconds, scrolls, holds again. The holds are most of the runtime and none of the
information -- 178 clips summed to 2328s (39 minutes), and one of them
(d4d2a4290-before) was 171.6s carrying exactly one distinct frame.

`trim` keeps EVERY frame that differs from the one before it, at its recorded rate,
and clamps the still gap that follows each one to a readable beat: a long gap at the
very start (nothing drawn yet) shrinks to LEAD, an interior gap to CAP, the final
gap to TAIL. A clip that never changed at all collapses to its one frame. Because
the spans come from the distinct frames themselves, no animation can be mistaken for
a hold -- an earlier version judged by `freezedetect` and cut `sidebar-crossfade`
from 165 distinct frames to 44.

`audit` is the record: it writes captures/clip-audit.tsv with each clip's size,
runtime, distinct-frame count and last-frame ink, and the page build refuses a clip
that is missing from it, whose size no longer matches, or that shows nothing at all.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

# One instrument for the whole script: a frame is dead space if mpdecimate calls it a
# duplicate of the one before it. `audit` reports the same measure, so a trim can be
# checked against it afterwards -- and no threshold in here can mistake a slow fade
# for a still screen, which is what freezedetect did.
MPDECIMATE = "hi=200:lo=100:frac=0.02"
PTS_TIME = re.compile(r"pts_time:([0-9.]+)")

# How long a still gap after a distinct frame survives the trim. The trailing hold is
# deliberately the longest: on a test arm the last frame is the tally, which is the
# whole point of the clip, and 0.6s of it is a blink. An interior gap only has to
# register that the screen changed, and a long gap at t=0 is the terminal before it
# drew anything.
LEAD = 0.25
CAP = 0.90
TAIL = 1.20
STILL = 1.20  # a clip that never changed is nothing but its one frame


def run(cmd: list[str]) -> str:
	proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
	return proc.stdout + proc.stderr


def duration(path: Path) -> float:
	out = run(
		[
			"ffprobe",
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"csv=p=0",
			str(path),
		]
	).strip()
	try:
		return float(out.splitlines()[0])
	except (ValueError, IndexError):
		return 0.0


def frame_rate(path: Path) -> float:
	out = run(
		[
			"ffprobe",
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=r_frame_rate",
			"-of",
			"csv=p=0",
			str(path),
		]
	).strip()
	if "/" in out:
		num, _, den = out.partition("/")
		try:
			return float(num) / float(den)
		except (ValueError, ZeroDivisionError):
			return 30.0
	try:
		return float(out)
	except ValueError:
		return 30.0


def distinct_times(path: Path) -> list[float]:
	"""Timestamps of the frames that DIFFER from the frame before them.

	This replaces `freezedetect`, which was the wrong instrument and destroyed
	evidence. freezedetect judges a whole frame against a noise floor, so a slow
	crossfade reads as frozen: clamping its "freezes" took `sidebar-crossfade` from
	165 distinct frames to 44 and `mouse-probe` from 43 to 4 -- the animation the
	clips exist to prove, gone. mpdecimate answers the question actually being
	asked, which is whether the next frame is a DUPLICATE, and it is the same
	measure `audit` reports, so a trim can be checked against it afterwards.
	"""
	log = run(
		[
			"ffmpeg",
			"-hide_banner",
			"-nostdin",
			"-i",
			str(path),
			"-vf",
			f"mpdecimate={MPDECIMATE},showinfo",
			"-vsync",
			"0",
			"-f",
			"null",
			"-",
		]
	)
	return [float(m.group(1)) for m in PTS_TIME.finditer(log)]


def keep_intervals(total: float, times: list[float]) -> list[tuple[float, float]]:
	"""Every distinct frame kept; the still gap after each one clamped to a beat.

	`times` are the moments the terminal changed. The dead space is what sits
	between them, so each frame keeps its own gap up to CAP and no distinct frame
	can ever be dropped -- which is the property freezedetect could not offer.
	"""
	if not times:
		return [(0.0, total)]
	keeps: list[tuple[float, float]] = []
	for i, start in enumerate(times):
		nxt = times[i + 1] if i + 1 < len(times) else total
		gap = nxt - start
		if i == 0 and len(times) == 1:
			budget = STILL  # nothing ever changed: the clip is its one frame
		elif i == len(times) - 1:
			budget = TAIL  # the last thing drawn is the payload
		elif i == 0 and gap > CAP:
			budget = LEAD  # the terminal before it had drawn anything
		else:
			budget = CAP
		keeps.append((start, start + min(gap, budget)))
	merged: list[tuple[float, float]] = []
	for a, b in keeps:
		if b - a <= 0.0005:
			continue
		if merged and a - merged[-1][1] <= 0.0005:
			merged[-1] = (merged[-1][0], b)
		else:
			merged.append((a, b))
	return merged


def select_expr(keeps: list[tuple[float, float]]) -> str:
	"""ffmpeg `select` windows, opened just below each frame's own timestamp.

	The epsilon is load-bearing. Printed at three decimals a start time ROUNDS UP --
	a frame at 10.0667 becomes between(t,10.067,...) and is excluded by a hair, which
	silently dropped 50 of settings-pointer's 250 distinct frames. Six decimals plus a
	millisecond of slack opens the window below the frame it exists to keep.
	"""
	terms = [f"between(t,{max(0.0, a - 0.001):.6f},{b:.6f})" for a, b in keeps]
	return "+".join(terms)


@dataclass
class Result:
	path: Path
	before: float
	after: float
	frames: int  # distinct frames found; every one of them survives the trim
	note: str


def trim(path: Path, *, dry_run: bool = False, crf: int = 23) -> Result:
	before = duration(path)
	if before <= 0.0:
		return Result(path, before, before, 0, "unreadable")
	times = distinct_times(path)
	keeps = keep_intervals(before, times)
	kept = sum(b - a for a, b in keeps)
	if not times or kept >= before - 0.10:
		return Result(path, before, before, len(times), "no dead space")
	if dry_run:
		return Result(path, before, kept, len(times), "dry-run")

	fps = frame_rate(path)
	out = path.with_suffix(".trim.mp4")
	cmd = [
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-i",
		str(path),
		"-vf",
		f"select='{select_expr(keeps)}',setpts=N/FRAME_RATE/TB",
		"-r",
		f"{fps:.4f}",
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		# A terminal capture is a slideshow of text, which is what this tune is for.
		# Dropping the held frames removes exactly the cheap ones, so the trimmed clip
		# can be BIGGER than the untrimmed original: at crf 20 the campaign came out
		# 12% heavier. crf 23 with this tune is 20% smaller than crf 20 and the text
		# stays crisp at 1:1 (checked on a 640x300 crop of a real diff frame).
		"-tune",
		"stillimage",
		"-crf",
		str(crf),
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
		"-an",
		str(out),
	]
	log = run(cmd)
	if not out.exists() or out.stat().st_size == 0:
		if out.exists():
			out.unlink()
		return Result(path, before, before, len(times), f"encode failed: {log.strip()[:160]}")
	after = duration(out)
	if after <= 0.05 or after > before + 0.05:
		out.unlink()
		return Result(path, before, before, len(times), f"rejected: {after:.2f}s")
	os.replace(out, path)
	return Result(path, before, after, len(times), "trimmed")


AUDIT_NAME = "clip-audit.tsv"
# A blank capture is not a short capture. `d4d2a4290-before` was 171.6s carrying one
# distinct frame at 720 std-dev: an empty terminal with a cursor, filed under a
# commit as though it showed the commit.
#
# What proves a terminal drew something is that the terminal CHANGED, so the frame
# count carries the rule and ink is only the tie-breaker. Ink alone is not a
# blankness signal and must never be used as one: `x11/tallhud-*` is a real capture
# of a tall HUD with sparse text at ink 660, and `x11/mouse-probe` sits at 394 over
# 43 distinct frames. Both would have been condemned by an ink threshold. Ink
# decides only among clips that barely changed at all, where a cursor blinking on an
# empty screen is otherwise indistinguishable from a screen with text on it.
BLANK_FRAMES = 1  # a clip that never changed at all
BARELY_FRAMES = 4  # a clip that changed this little needs ink to vouch for it
BLANK_INK = 1200.0  # std-dev of a terminal holding no text


def distinct_frames(path: Path) -> int:
	"""How many frames differ from the one before them. The same probe `trim` uses."""
	return len(distinct_times(path))


def last_frame_ink(path: Path, seconds: float | None = None) -> float:
	"""Standard deviation of the final frame: how much is drawn on it.

	Seeks by duration, never `-sseof -1`: after the trim a clip can be under a
	second long, and a one-second seek from the end of a 0.9s clip lands on the
	FIRST frame -- the terminal before it drew anything. That mis-measurement
	flagged seven perfectly good captures as blank.
	"""
	total = duration(path) if seconds is None else seconds
	# A temp directory, not a sibling PNG: a probe interrupted mid-run must not
	# leave an artifact inside a capture directory that the page then references.
	handle, name = tempfile.mkstemp(prefix="ink-", suffix=".png")
	os.close(handle)
	png = Path(name)
	run(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-nostdin",
			"-y",
			"-ss",
			f"{max(0.0, total - 0.10):.3f}",
			"-i",
			str(path),
			"-frames:v",
			"1",
			str(png),
		]
	)
	try:
		if png.stat().st_size == 0:
			return 0.0
		out = run(["identify", "-format", "%[standard-deviation]", str(png)]).strip()
	finally:
		png.unlink(missing_ok=True)
	try:
		return float(out.split()[0])
	except (ValueError, IndexError):
		return 0.0


@dataclass
class Audit:
	name: str
	size: int
	seconds: float
	frames: int
	ink: float

	@property
	def blank(self) -> bool:
		if self.frames <= BLANK_FRAMES:
			return True
		return self.frames <= BARELY_FRAMES and self.ink < BLANK_INK

	def row(self) -> str:
		return f"{self.name}\t{self.size}\t{self.seconds:.2f}\t{self.frames}\t{self.ink:.1f}"


def audit_clip(path: Path, base: Path) -> Audit:
	seconds = duration(path)
	return Audit(
		path.relative_to(base).as_posix(),
		path.stat().st_size,
		seconds,
		distinct_frames(path),
		last_frame_ink(path, seconds),
	)


def cmd_audit(args: argparse.Namespace) -> int:
	# Every clip the proof page can reference, not just the commit campaign: the
	# page also carries scene recordings from captures/x11 and its subdirectories,
	# and a blank one of those is the same defect as a blank commit arm.
	base = Path(args.base)
	targets = sorted(p for p in base.rglob("*.mp4") if p.is_file())
	if not targets:
		print(f"no clips under {base}", file=sys.stderr)
		return 1
	workers = args.jobs or min(24, os.cpu_count() or 4)
	found: list[Audit] = []
	with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
		for entry in pool.map(lambda p: audit_clip(p, base), targets):
			# A zero-length file is a recorder mid-write, not a recording: the scene
			# writes hold.mp4 inside the arm directory and the arm script moves it out
			# afterwards. Auditing one would file an in-flight artifact as a blank
			# clip. It cannot hide a real defect: a clip the PAGE references and the
			# audit skipped is missing from the audit, which fails the page build.
			if entry.seconds <= 0.0:
				continue
			found.append(entry)
	found.sort(key=lambda a: a.name)
	blank = [a for a in found if a.blank]
	lines = ["clip\tbytes\tseconds\tdistinct-frames\tlast-frame-ink"]
	lines += [a.row() for a in found]
	(base / AUDIT_NAME).write_text("\n".join(lines) + "\n", encoding="utf-8")
	for a in blank:
		print(f"BLANK {a.name}: {a.seconds:.1f}s, {a.frames} distinct frames, ink {a.ink:.0f}", file=sys.stderr)
	total = sum(a.seconds for a in found)
	print(
		f"{len(found)} clips, {total:.0f}s ({total / 60:.1f} min), {len(blank)} blank"
		f" -> wrote {base / AUDIT_NAME}"
	)
	return 1 if blank else 0


def clips(root: Path) -> list[Path]:
	return sorted(p for p in root.glob("*.mp4") if p.is_file())


def cmd_trim(args: argparse.Namespace) -> int:
	root = Path(args.root)
	# Named clips only: a parallel recorder trims the one arm it just produced, so
	# two encoders can never meet on the same file (and the shared manifest is not
	# rewritten from six containers at once).
	if args.clips:
		targets = [Path(c) for c in args.clips]
		missing = [p for p in targets if not p.is_file()]
		if missing:
			print(f"no such clip: {missing[0]}", file=sys.stderr)
			return 1
	else:
		targets = clips(root)
	if not targets:
		print(f"no clips under {root}", file=sys.stderr)
		return 1
	workers = args.jobs or min(24, os.cpu_count() or 4)
	results: list[Result] = []
	with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
		futures = {pool.submit(trim, p, dry_run=args.dry_run, crf=args.crf): p for p in targets}
		for fut in concurrent.futures.as_completed(futures):
			results.append(fut.result())
	results.sort(key=lambda r: r.before - r.after, reverse=True)

	before_total = sum(r.before for r in results)
	after_total = sum(r.after for r in results)
	for r in results[: args.show]:
		print(f"{r.before:8.1f}s -> {r.after:6.1f}s  {r.frames:5d} frames  {r.path.name}  {r.note}")
	failed = [r for r in results if "failed" in r.note or "rejected" in r.note]
	for r in failed:
		print(f"FAILED {r.path.name}: {r.note}", file=sys.stderr)
	print(
		f"\n{len(results)} clips: {before_total:.0f}s ({before_total / 60:.1f} min)"
		f" -> {after_total:.0f}s ({after_total / 60:.1f} min)"
	)

	# No manifest is written. A second file recording what a past run removed can
	# only drift from the clips themselves -- re-record one arm and it is already
	# wrong -- and the page's gate depends on captures/clip-audit.tsv, which
	# describes what the clips ARE right now and is refused when it goes stale.
	# One artifact that must stay true beats two that can disagree.
	return 1 if failed else 0


def cmd_report(args: argparse.Namespace) -> int:
	root = Path(args.root)
	rows = [(duration(p), p.name) for p in clips(root)]
	rows.sort(reverse=True)
	for dur, name in rows[: args.show]:
		print(f"{dur:8.1f}s  {name}")
	total = sum(d for d, _ in rows)
	print(f"\n{len(rows)} clips, {total:.0f}s ({total / 60:.1f} min)")
	return 0


def cmd_selftest(_args: argparse.Namespace) -> int:
	"""The two decisions this script makes, checked without touching a video.

	Both were wrong once. The blankness rule was ink-only, and it condemned real
	captures of sparse surfaces; the ink probe seeked with `-sseof -1`, which on a
	sub-second clip reads the FIRST frame and reported seven good clips as blank.
	Neither mistake is visible in the output of a run -- a blank verdict looks the
	same whichever way it was reached -- so the rules are pinned here instead.
	"""
	failures: list[str] = []

	def check(name: str, got: object, want: object) -> None:
		if got != want:
			failures.append(f"{name}: got {got!r}, want {want!r}")

	# A clip that never changed is blank whatever its ink says.
	check("never changed", Audit("a", 1, 10.0, 1, 9999.0).blank, True)
	# Ink is a tie-breaker among clips that barely changed, never a rule of its own:
	# x11/tallhud-* really is a tall HUD at ink 660 over 8 frames, and x11/mouse-probe
	# is 43 frames at ink 394. An ink threshold alone condemns both.
	check("sparse but moving", Audit("tallhud", 1, 19.6, 8, 660.0).blank, False)
	check("very sparse but moving", Audit("mouse-probe", 1, 8.5, 43, 394.0).blank, False)
	# A cursor blinking on an empty screen changes a little and shows nothing.
	check("cursor blink only", Audit("blink", 1, 30.0, 3, 700.0).blank, True)
	check("barely changed with text", Audit("short", 1, 2.0, 3, 6000.0).blank, False)

	# The property that matters most: every distinct frame survives. A frame is kept
	# by definition here, so the check is that the count of kept intervals never drops
	# below the count of frames handed in.
	for times in ([0.0], [0.0, 3.0, 4.0, 9.0], [0.0, 2.0, 6.0], [1.0, 1.1, 1.2, 8.0]):
		kept = keep_intervals(10.0, times)
		covered = sum(1 for t in times if any(a - 1e-9 <= t < b + 1e-9 for a, b in kept))
		check(f"every frame kept {times}", covered, len(times))

	# A clip that never changed is its one frame, held long enough to read.
	check("never changed", keep_intervals(171.6, [0.0]), [(0.0, STILL)])
	# A long gap at t=0 is the terminal before it drew anything.
	lead = keep_intervals(10.0, [0.0, 5.0, 9.5])
	check("dead lead clamped", lead[0], (0.0, LEAD))
	# An interior gap is clamped to CAP; the frame after it still appears.
	check("interior gap clamped", lead[1], (5.0, 5.0 + CAP))
	# The last frame is the payload and keeps TAIL, never the whole remainder.
	check("tail clamped", lead[-1], (9.5, 9.5 + min(TAIL, 0.5)))
	# Frames closer together than the beat are NOT stretched: real motion plays at the
	# rate it was recorded, so a 15fps animation stays a 15fps animation.
	motion = keep_intervals(1.0, [0.0, 0.0667, 0.1333, 0.2])
	check("motion not stretched", motion, [(0.0, 0.2 + min(TAIL, 0.8))])
	# No frames at all (an unreadable probe) means keep the clip untouched rather than
	# silently emitting a one-frame stub.
	check("no measurement", keep_intervals(5.0, []), [(0.0, 5.0)])
	# A trim can only ever shorten a clip.
	for times in ([0.0], [0.0, 3.0, 4.0, 9.0], [0.0, 2.0, 6.0], []):
		check(
			f"never lengthens {times}",
			sum(b - a for a, b in keep_intervals(10.0, times)) <= 10.0 + 1e-9,
			True,
		)

	for line in failures:
		print(f"FAIL {line}", file=sys.stderr)
	print(f"{'FAILED' if failures else 'ok'}: {len(failures)} failures")
	return 1 if failures else 0


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument(
		"--root",
		default="proof/captures/x11/commits",
		help="directory of recordings (default: proof/captures/x11/commits)",
	)
	sub = parser.add_subparsers(dest="command", required=True)

	p_trim = sub.add_parser("trim", help="clamp frozen spans in every clip, in place")
	p_trim.add_argument("--dry-run", action="store_true", help="measure only, write nothing")
	p_trim.add_argument("--jobs", type=int, default=0, help="parallel encodes")
	p_trim.add_argument("--show", type=int, default=12, help="rows of detail to print")
	p_trim.add_argument(
		"--crf",
		type=int,
		default=23,
		help="x264 quality; 23 for text captures, lower where the evidence is subtle motion",
	)
	p_trim.add_argument(
		"clips",
		nargs="*",
		help="trim only these clips (a recorder trims the arm it just produced)",
	)
	p_trim.set_defaults(func=cmd_trim)

	p_report = sub.add_parser("report", help="print clip runtimes, longest first")
	p_report.add_argument("--show", type=int, default=12)
	p_report.set_defaults(func=cmd_report)

	p_audit = sub.add_parser(
		"audit",
		help="record each clip's distinct-frame count and ink; nonzero exit if any is blank",
	)
	p_audit.add_argument("--jobs", type=int, default=0, help="parallel probes")
	p_audit.add_argument(
		"--base",
		default="proof/captures",
		help="tree of recordings to audit, recursively (default: proof/captures)",
	)
	p_self = sub.add_parser("selftest", help="check the trim and blankness rules, no video needed")
	p_self.set_defaults(func=cmd_selftest)

	p_audit.set_defaults(func=cmd_audit)

	args = parser.parse_args()
	return int(args.func(args))


if __name__ == "__main__":
	sys.exit(main())
