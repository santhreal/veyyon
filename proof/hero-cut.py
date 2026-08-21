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
# The ceiling on a lead a scene measured for itself, and it defaults to the flat lead
# so that a measured one is something a caller ASKS for. Every scene writes the third
# column now, so a permissive default would silently relengthen nine other recipes --
# each of which published its clip at a window somebody chose for that surface -- the
# moment this file changed. The hero raises it, because its subject is work that runs
# for minutes; a row whose subject is one card opening does not want a minute of the
# turn that opened it.
MARK_LEAD_MAX = MARK_LEAD
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


def mark_spans(
	path: Path, marks: Path, *, lead: float = MARK_LEAD, lead_max: float = MARK_LEAD_MAX, hold: float = HOLD
) -> list[tuple[float, float]]:
	"""Windows around the instants the scene itself declared.

	A scene takes a still at every moment it exists to show, and the run writes each
	one down with the second it happened, so those timestamps are the cut and they
	come from the recording rather than from somebody watching it. Change magnitude
	cannot stand in for them in a session against a reasoning model: the largest
	changes on screen are pages of thinking scrolling past, so a magnitude cut of a
	plan scene is thirty seconds of streamed text and two frames of the plan.

	The lead is longer than an event's, because the still is taken once the thing has
	arrived: the interesting stretch is the seconds BEFORE the mark.

	HOW LONG THAT STRETCH IS COMES FROM THE RECORDING TOO. A flat lead is a guess,
	and at 1.2s it was the wrong one: it kept the result and cut the work that
	produced it, so a take whose session spent two minutes searching, fanning out
	and running a suite published as a slideshow of outcomes. A scene that writes a
	third column has measured the stretch between the end of the request and the
	frame -- the work, and nothing but the work, since input ends where it starts --
	and that becomes this mark's lead, capped by `lead_max` so one very long turn
	cannot dominate the clip. Two columns still mean the flat lead, so an older
	marks file cuts exactly as it did.
	"""
	total = duration(path)
	spans: list[tuple[float, float]] = []
	for line in marks.read_text().splitlines():
		fields = line.split("\t")
		if len(fields) < 2 or not fields[1].strip():
			continue
		mark = float(fields[1])
		own = lead
		if len(fields) > 2 and fields[2].strip():
			own = min(float(fields[2]), lead_max)
		lo = max(0.0, mark - max(own, lead))
		hi = min(total, mark + hold)
		if spans and lo <= spans[-1][1]:
			spans[-1] = (spans[-1][0], max(spans[-1][1], hi))
		else:
			spans.append((lo, hi))
	return spans


def mark_window(
	marks: Path, name: str, *, lead: float = MARK_LEAD, lead_max: float = MARK_LEAD_MAX, hold: float = HOLD
) -> tuple[float, float]:
	"""Return the source-time window owned by one named mark."""
	for line in marks.read_text().splitlines():
		fields = line.split("\t")
		if len(fields) < 2 or fields[0] != name:
			continue
		mark = float(fields[1])
		own = lead
		if len(fields) > 2 and fields[2].strip():
			own = min(float(fields[2]), lead_max)
		return (max(0.0, mark - max(own, lead)), mark + hold)
	raise ValueError(f"mark {name!r} is not present in {marks}")


def apply_edge_speed(
	spans: list[tuple[float, float]],
	*,
	middle_speed: float,
	edge_speed: float,
	real_through: float | None,
	real_from: float | None,
) -> list[tuple[float, float, float]]:
	"""Split source spans where the normal-speed opening or finale begins."""
	boundaries = [point for point in (real_through, real_from) if point is not None]
	rated: list[tuple[float, float, float]] = []
	for lo, hi in spans:
		points = [lo, *(point for point in boundaries if lo < point < hi), hi]
		for start, end in zip(points, points[1:], strict=True):
			at_edge = (real_through is not None and end <= real_through) or (
				real_from is not None and start >= real_from
			)
			rated.append((start, end, edge_speed if at_edge else middle_speed))
	return rated


def still_stretches(path: Path, *, floor: float = NOISE_SCORE, min_still: float) -> list[tuple[float, float]]:
	"""Stretches where nothing above the noise floor happened at all.

	A clip that plays at real speed and reaches back over the work is the right
	shape, and measuring one found the other half of the problem: 79% of a 379s
	hero was a still image, 299 seconds of it. Looking at the frozen frames said
	why. Every freeze is a FINISHED screen -- the splash before the first
	keystroke, or a completed turn sitting there with a check and an elapsed time
	in the footer and no spinner. A scene settles after each turn, twice as long
	under SETTLE_SCALE, and it takes the still at the END of that settle, so the
	settle tail lands inside the mark's measured lead. Nothing rendered there.

	The floor is the one this file already calibrated, and it is the right
	instrument by measurement rather than by preference: across one such freeze
	two frames 8.5s apart differ by 251 pixels, every one of them below 6%
	intensity, which is h264 quantization and not a screen doing something. A
	WebP encoder merges only byte-identical frames, so the same freeze read to it
	as three 8.3s holds instead of one of 25s -- which is why the published
	cadence looked like a stalling product while every gate on it passed.

	WHAT SEPARATES WAITING FROM WORKING, at this floor, was measured in both
	directions on a real take rather than assumed. Four seconds of a SETTLED
	screen -- the turn finished, a check and an elapsed time in the footer -- put
	0 of its 120 frames above the floor, so it merges into one long stretch and
	is trimmed. Four seconds of an IN-TURN screen, with a spinner turning and a
	live status line counting, put 1 to 2 of 120 above it: one change every two
	to four seconds. So a turn in flight arrives here as a chain of stretches
	about as long as `min_still`, and since only a stretch LONGER than the
	caller's keep is cut at all, a keep of four seconds leaves a turn in flight
	intact and takes only the screens where the turn is over. That is the whole
	reason the number is four and not a rounder guess.
	"""
	total = duration(path)
	stills: list[tuple[float, float]] = []
	at = 0.0
	for start, end, _frames in events(path, score=floor, min_frames=1):
		if start - at >= min_still:
			stills.append((at, start))
		at = max(at, end)
	if total - at >= min_still:
		stills.append((at, total))
	return stills


def squeeze(
	spans: list[tuple[float, float]], stills: list[tuple[float, float]], *, keep: float
) -> list[tuple[float, float]]:
	"""Every span, with the part of any still stretch past `keep` seconds removed.

	The head that is kept is what makes a result readable: the screen stops
	changing exactly when the thing a frame exists for has arrived, so the seconds
	right after a change are the ones worth holding. What follows them is a
	recorder waiting. A span that OPENS inside a freeze skips to where the screen
	changes next, because its readable pause was already shown by whatever span
	covered the change.

	This is not a speed-up. Every retained second plays at the rate it was
	recorded; what leaves is time in which nothing was drawn.
	"""
	cuts = [(lo + keep, hi) for lo, hi in stills if hi - lo > keep]
	out: list[tuple[float, float]] = []
	for lo, hi in spans:
		pieces = [(lo, hi)]
		for clo, chi in cuts:
			narrowed: list[tuple[float, float]] = []
			for plo, phi in pieces:
				if chi <= plo or clo >= phi:
					narrowed.append((plo, phi))
					continue
				if plo < clo:
					narrowed.append((plo, min(clo, phi)))
				if phi > chi:
					narrowed.append((max(chi, plo), phi))
			pieces = narrowed
		# A remnant shorter than a frame is not a cut, it is a rounding artefact.
		out.extend(p for p in pieces if p[1] - p[0] > 0.05)
	return out


def cut(
	path: Path,
	out: Path,
	spans: list[tuple[float, float, float]],
	*,
	width: int,
	fps: int,
	crf: int = 22,
) -> None:
	inputs: list[str] = []
	chains: list[str] = []
	labels = ""
	for i, (lo, hi, speed) in enumerate(spans):
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
			str(crf),
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
	# THE SOURCE IS 30 FPS, on both display servers (`SCENE_FPS` for wf-recorder, `FPS` for x11grab),
	# and every number below used to throw part of it away twice: the cut resampled 30 to 15 and the
	# WebP then resampled 15 to 12. Neither ratio is an integer division of a 2x speedup, so frames
	# landed unevenly — a scroll advanced 2 rows, then 3, then 2 — and the published animation read as
	# a laggy product rather than a fast one. It is one cadence now, the source's own, and the WebP
	# never resamples the clip it is made from: `--webp-fps` exists so a gesture row can be lighter,
	# not so the hero can be choppy.
	parser.add_argument("--fps", type=int, default=30)
	parser.add_argument("--speed", type=float, default=2.0)
	parser.add_argument(
		"--edge-speed",
		type=float,
		help="speed for the opening and finale selected by named marks; defaults to --speed",
	)
	parser.add_argument(
		"--real-through-mark",
		help="keep normal speed through this named mark's hold window",
	)
	parser.add_argument(
		"--real-from-mark",
		help="resume normal speed at the start of this named mark's measured window",
	)
	parser.add_argument(
		"--mark-lead",
		type=float,
		default=MARK_LEAD,
		help="seconds kept before a mark that carries no measured lead, and the floor for one that does",
	)
	parser.add_argument(
		"--mark-lead-max",
		type=float,
		default=MARK_LEAD_MAX,
		help="ceiling on a lead the scene measured for itself",
	)
	parser.add_argument("--hold", type=float, default=HOLD, help="seconds kept after a mark or event")
	parser.add_argument("--crf", type=int, default=22, help="x264 quality; higher is smaller")
	# OFF unless a caller asks for it. A stretch of screen nobody is touching is dead
	# air in a hero that runs at real speed, and it is the whole clip in a gesture row
	# whose subject is a pointer barely clearing the noise floor, so the trim cannot be
	# a default without deciding for every caller at once.
	parser.add_argument(
		"--still-keep",
		type=float,
		default=0.0,
		help="seconds of an untouched stretch to keep; 0 keeps all of it",
	)
	parser.add_argument(
		"--still-min",
		type=float,
		default=4.0,
		help="an untouched stretch shorter than this is left alone",
	)
	parser.add_argument("--webp-width", type=int, default=1280)
	parser.add_argument("--webp-fps", type=int, default=30)
	parser.add_argument("--webp-quality", type=int, default=62)
	parser.add_argument("--dry-run", action="store_true", help="print the windows, write nothing")
	args = parser.parse_args()

	if (args.real_through_mark or args.real_from_mark) and not args.marks:
		parser.error("--real-through-mark and --real-from-mark require --marks")
	if args.speed <= 0 or (args.edge_speed is not None and args.edge_speed <= 0):
		parser.error("speeds must be greater than zero")

	if args.marks:
		spans = mark_spans(
			args.take, args.marks, lead=args.mark_lead, lead_max=args.mark_lead_max, hold=args.hold
		)
	elif args.single:
		spans = single_span(args.take, score=args.scene_score)
	else:
		spans = segments(args.take, score=args.scene_score)
	if not spans:
		print(f"{args.take}: nothing to cut", file=sys.stderr)
		return 1
	if args.still_keep > 0:
		stills = still_stretches(args.take, min_still=args.still_min)
		before = sum(hi - lo for lo, hi in spans)
		spans = squeeze(spans, stills, keep=args.still_keep)
		after = sum(hi - lo for lo, hi in spans)
		print(
			f"  {len(stills)} untouched stretches of {args.still_min}s or more:"
			f" removed {before - after:.1f}s of screen nobody was touching"
		)
		if not spans:
			print(f"{args.take}: the whole cut was untouched screen", file=sys.stderr)
			return 1

	edge_speed = args.edge_speed if args.edge_speed is not None else args.speed
	try:
		real_through = (
			mark_window(
				args.marks,
				args.real_through_mark,
				lead=args.mark_lead,
				lead_max=args.mark_lead_max,
				hold=args.hold,
			)[1]
			if args.marks and args.real_through_mark
			else None
		)
		real_from = (
			mark_window(
				args.marks,
				args.real_from_mark,
				lead=args.mark_lead,
				lead_max=args.mark_lead_max,
				hold=args.hold,
			)[0]
			if args.marks and args.real_from_mark
			else None
		)
	except ValueError as error:
		print(str(error), file=sys.stderr)
		return 2
	rated_spans = apply_edge_speed(
		spans,
		middle_speed=args.speed,
		edge_speed=edge_speed,
		real_through=real_through,
		real_from=real_from,
	)
	kept = sum((hi - lo) / speed for lo, hi, speed in rated_spans)
	print(f"{args.take}: {duration(args.take):.1f}s -> {kept:.1f}s in {len(rated_spans)} segments")
	for lo, hi, speed in rated_spans:
		print(f"  {lo:8.1f} -> {hi:8.1f}  ({hi - lo:.1f}s at {speed:.2f}x)")
	if args.dry_run:
		return 0

	cut(args.take, args.mp4, rated_spans, width=args.width, fps=args.fps, crf=args.crf)
	print(f"wrote {args.mp4} ({args.mp4.stat().st_size} bytes, {duration(args.mp4):.1f}s)")
	if args.webp:
		webp(args.mp4, args.webp, width=args.webp_width, fps=args.webp_fps, quality=args.webp_quality)
		print(f"wrote {args.webp} ({args.webp.stat().st_size} bytes)")
	return 0


if __name__ == "__main__":
	sys.exit(main())
