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

The published form is an animated WebP, not a GIF: 24 seconds of 900px terminal
text is 18 MB as a GIF and 5 MB as WebP, at better quality, and every browser
that renders the README renders it.
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


def events(path: Path) -> list[tuple[float, float, int]]:
	"""Windows where the screen changed a lot, as (start, end, frame count)."""
	log = run(
		[
			"ffmpeg",
			"-v",
			"error",
			"-i",
			str(path),
			"-vf",
			f"scale=480:-2,select='gt(scene,{SCENE_SCORE})',metadata=print:file=-",
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
	return [(c[0], c[-1], len(c)) for c in clustered if len(c) >= MIN_FRAMES]


def segments(path: Path) -> list[tuple[float, float]]:
	total = duration(path)
	spans: list[tuple[float, float]] = []
	for start, end, _frames in events(path):
		lo = max(0.0, start - LEAD)
		hi = min(total, end + HOLD)
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
	parser.add_argument("--width", type=int, default=1000)
	parser.add_argument("--fps", type=int, default=15)
	parser.add_argument("--speed", type=float, default=2.0)
	parser.add_argument("--webp-width", type=int, default=900)
	parser.add_argument("--webp-fps", type=int, default=12)
	parser.add_argument("--webp-quality", type=int, default=62)
	parser.add_argument("--dry-run", action="store_true", help="print the windows, write nothing")
	args = parser.parse_args()

	spans = segments(args.take)
	if not spans:
		print(f"{args.take}: no change events found; nothing to cut", file=sys.stderr)
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
