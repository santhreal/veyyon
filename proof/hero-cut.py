#!/usr/bin/env python3
"""Cut a landing-page clip out of a long session recording.

A session recording is mostly a screen waiting on a model. `tighten.py` cannot
find that dead space here, and the reason is worth writing down: it judges a
frame dead when mpdecimate calls it a duplicate of the one before it, and a
veyyon session always has a spinner turning and an elapsed clock ticking. 88% of
the frames in a 428s take were "distinct" while the transcript itself had not
changed for a minute.

What DOES separate work from waiting is the magnitude of the change: a block
landing, a diff arriving, a card opening. ffmpeg's `scene` score measures exactly
that, so the windows below are derived from the recording rather than typed in,
and the same command produces the same clip from a different take.

    proof/hero-cut.py take.mp4 --mp4 hero.mp4 --webp hero.webp

A gesture scene is the other shape, and it needs `--single`. A pointer travelling
a sidebar is a few pixels of cursor and one repainted row, so its magnitudes sit
two orders below a tool block landing and no threshold separates the gesture from
the noise. What magnitude CAN still see in such a clip is where the idle settle at
its head ends, so `--single` keeps one span from just before the first change to
the end of the take, and `--scene-score` is what lets a caller point the detector
at that smaller scale.

A feature scene against a reasoning model is the third shape, and it needs
`--marks`. Magnitude does find the biggest changes there, and they are pages of
thinking scrolling past: a magnitude cut of the plan scene was thirty seconds of
streamed reasoning and two frames of the plan card. The scene already knows better,
because it takes a still at each moment it exists to show, so the run writes those
instants to `<name>-marks.tsv` and the cut is the window around each one.

    proof/hero-cut.py take.mp4 --marks take-marks.tsv --mp4 row.mp4 --webp row.webp

The published form is an animated WebP, not a GIF: 24 seconds of terminal text is
18 MB as a GIF and a fraction of that as WebP, at better quality, and every browser
that renders the README renders it.

It is published at 1280x720 from a 1920x1080 capture, because 900px was not
readable: a 13px cell downscaled by 2.1 turns a context report into grey texture,
and the whole point of a feature row is that the numbers on it can be read. The
same clip is 950 KB at 1280 and 510 KB at 900, so the cost of the readable one is
half a megabyte.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

PTS_TIME = re.compile(r"pts_time:([0-9.]+)")

# A change big enough to be the screen doing something, rather than a spinner
# frame or one more streamed word.
SCENE_SCORE = 0.06
# Events closer together than this are one event: a tool block landing produces a
# burst of large frames, not one.
EVENT_GAP = 2.0
# What to keep around an event. The lead-in is short (the screen before it is
# what the previous segment already showed) and the hold after it is what makes
# the result readable.
LEAD = 1.2
HOLD = 2.4
# An event carrying fewer distinct frames than this is a cursor artefact, not a
# transition worth a segment of its own.
MIN_FRAMES = 3
# What to keep before a mark the scene declared. Short on purpose. A four-second
# lead-in reached back past the arrival of the thing the still names and into the
# recorder typing the request, so every row opened on characters appearing one at a
# time. The still is taken once the result is on screen, so the second before it is
# the result landing, which is the frame the row exists for.
MARK_LEAD = 1.2
# The floor below which a frame is the same screen as the one before it. A cursor
# is one 13x29 cell and a hover band repaints one row, and both clear this at the
# 480px scale the detector works on, so a stretch with nothing above it is a
# screen nobody is doing anything to.
NOISE_SCORE = 0.0005


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
	)
	try:
		return float(out.strip().splitlines()[0])
	except (IndexError, ValueError):
		return 0.0


def events(path: Path, *, score: float, min_frames: int = MIN_FRAMES) -> list[tuple[float, float, int]]:
	"""Windows where the screen changed a lot, as (start, end, frame count)."""
	log = run(
		[
			"ffmpeg",
			"-v",
			"error",
			"-i",
			str(path),
			"-vf",
			f"scale=480:-2,select='gt(scene,{score})',metadata=print:file=-",
			"-f",
			"null",
			"-",
		]
	)
	times = [float(m.group(1)) for m in PTS_TIME.finditer(log)]
	clustered: list[list[float]] = []
	for t in times:
		if not clustered or t - clustered[-1][-1] > EVENT_GAP:
			clustered.append([t])
		else:
			clustered[-1].append(t)
	return [(c[0], c[-1], len(c)) for c in clustered if len(c) >= min_frames]


def segments(path: Path, *, score: float) -> list[tuple[float, float]]:
	total = duration(path)
	spans: list[tuple[float, float]] = []
	for start, end, _frames in events(path, score=score):
		lo = max(0.0, start - LEAD)
		hi = min(total, end + HOLD)
		if spans and lo <= spans[-1][1]:
			spans[-1] = (spans[-1][0], max(spans[-1][1], hi))
		else:
			spans.append((lo, hi))
	return spans


def single_span(path: Path, *, score: float) -> list[tuple[float, float]]:
	"""One span: the stretch of the take where the screen is being touched at all.

	For a scene whose subject is a gesture rather than a transition. Cutting such a
	clip into event windows drops the gesture itself, because the cursor and the
	row it lands on are too small for a scene score to see. The ends of the clip are
	a different matter, and both of them are idle by construction: a scene settles
	for many seconds before it types anything, and it settles again before the
	recorder stops. So the span runs from the first change at the caller's scale to
	the last frame that clears the noise floor, which is where the pointer stopped
	moving rather than where the recording stopped.
	"""
	total = duration(path)
	found = events(path, score=score)
	first = found[0][0] if found else 0.0
	touched = events(path, score=NOISE_SCORE, min_frames=1)
	last = touched[-1][1] if touched else total
	return [(max(0.0, first - LEAD), min(total, last + HOLD))]


def mark_spans(path: Path, marks: Path) -> list[tuple[float, float]]:
	"""Windows around the instants the scene itself declared.

	A scene takes a still at every moment it exists to show, and the run writes each
	one down with the second it happened, so those timestamps are the cut and they
	come from the recording rather than from somebody watching it. Change magnitude
	cannot stand in for them in a session against a reasoning model: the largest
	changes on screen are pages of thinking scrolling past, so a magnitude cut of a
	plan scene is thirty seconds of streamed text and two frames of the plan.

	The lead is longer than an event's, because the still is taken once the thing has
	arrived: the interesting stretch is the seconds BEFORE the mark.
	"""
	total = duration(path)
	spans: list[tuple[float, float]] = []
	for line in marks.read_text().splitlines():
		_, _, at = line.partition("\t")
		if not at.strip():
			continue
		mark = float(at)
		lo = max(0.0, mark - MARK_LEAD)
		hi = min(total, mark + HOLD)
		if spans and lo <= spans[-1][1]:
			spans[-1] = (spans[-1][0], max(spans[-1][1], hi))
		else:
			spans.append((lo, hi))
	return spans


def cut(path: Path, out: Path, spans: list[tuple[float, float]], *, width: int, fps: int, speed: float) -> None:
	inputs: list[str] = []
	chains: list[str] = []
	labels = ""
	for i, (lo, hi) in enumerate(spans):
		inputs += ["-ss", f"{lo:.3f}", "-t", f"{hi - lo:.3f}", "-i", str(path)]
		chains.append(
			f"[{i}:v]setpts=PTS/{speed},scale={width}:-2:flags=lanczos,fps={fps},setpts=N/{fps}/TB[v{i}]"
		)
		labels += f"[v{i}]"
	graph = ";".join(chains) + f";{labels}concat=n={len(spans)}:v=1:a=0[v]"
	subprocess.run(
		[
			"ffmpeg",
			"-loglevel",
			"error",
			"-y",
			*inputs,
			"-filter_complex",
			graph,
			"-map",
			"[v]",
			"-c:v",
			"libx264",
			"-preset",
			"slow",
			"-crf",
			"22",
			"-pix_fmt",
			"yuv420p",
			"-an",
			str(out),
		],
		check=True,
	)


def webp(src: Path, out: Path, *, width: int, fps: int, quality: int) -> None:
	subprocess.run(
		[
			"ffmpeg",
			"-loglevel",
			"error",
			"-y",
			"-i",
			str(src),
			"-vf",
			f"fps={fps},scale={width}:-2:flags=lanczos",
			"-c:v",
			"libwebp_anim",
			"-lossless",
			"0",
			"-q:v",
			str(quality),
			"-preset",
			"text",
			"-loop",
			"0",
			"-an",
			str(out),
		],
		check=True,
	)


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("take", type=Path, help="the full session recording")
	parser.add_argument("--mp4", type=Path, required=True, help="where to write the cut clip")
	parser.add_argument("--webp", type=Path, help="also write an animated WebP of the cut")
	parser.add_argument("--width", type=int, default=1920)
	parser.add_argument(
		"--scene-score",
		type=float,
		default=SCENE_SCORE,
		help=f"change magnitude that counts as an event (default {SCENE_SCORE})",
	)
	parser.add_argument(
		"--single",
		action="store_true",
		help="keep one span from the first change to the end, for a gesture scene",
	)
	parser.add_argument(
		"--marks",
		type=Path,
		help="cut around the marks a scene wrote, instead of by change magnitude",
	)
	parser.add_argument("--fps", type=int, default=15)
	parser.add_argument("--speed", type=float, default=2.0)
	parser.add_argument("--webp-width", type=int, default=1280)
	parser.add_argument("--webp-fps", type=int, default=12)
	parser.add_argument("--webp-quality", type=int, default=62)
	parser.add_argument("--dry-run", action="store_true", help="print the windows, write nothing")
	args = parser.parse_args()

	if args.marks:
		spans = mark_spans(args.take, args.marks)
	elif args.single:
		spans = single_span(args.take, score=args.scene_score)
	else:
		spans = segments(args.take, score=args.scene_score)
	if not spans:
		print(f"{args.take}: nothing to cut", file=sys.stderr)
		return 1
	kept = sum(hi - lo for lo, hi in spans)
	print(f"{args.take}: {duration(args.take):.1f}s -> {kept / args.speed:.1f}s in {len(spans)} segments")
	for lo, hi in spans:
		print(f"  {lo:8.1f} -> {hi:8.1f}  ({hi - lo:.1f}s)")
	if args.dry_run:
		return 0

	cut(args.take, args.mp4, spans, width=args.width, fps=args.fps, speed=args.speed)
	print(f"wrote {args.mp4} ({args.mp4.stat().st_size} bytes, {duration(args.mp4):.1f}s)")
	if args.webp:
		webp(args.mp4, args.webp, width=args.webp_width, fps=args.webp_fps, quality=args.webp_quality)
		print(f"wrote {args.webp} ({args.webp.stat().st_size} bytes)")
	return 0


if __name__ == "__main__":
	sys.exit(main())
