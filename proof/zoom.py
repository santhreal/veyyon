#!/usr/bin/env python3
"""Ease a recording into one region of the screen and back out.

    proof/zoom.py take.mp4 zoomed.mp4 --at 184.5
    proof/zoom.py take.mp4 zoomed.mp4 --marks take-marks.tsv --mark todo-board

A landing-page clip is 1920 wide and the recorder captures 2560, so a 1920-wide
crop out of the take is a 1.33x zoom with no upscale: the extra 640 columns of
capture width are the whole zoom budget, and `--zoom` above that resamples text
the surface never drew.

The region is measured, not typed in. A rect on a 2560x1440 screen would have to
be found by hand for every scene and would move the next time a block changed
height, so the stage diffs the frames around the moment and zooms to the bounding
box of what changed there. A moment with nothing moving in it produces no rect and
no file.

The stage runs on the take, before the cut, so it changes no timing: same frame
count, same rate, and the cadence gate downstream still reads 33 ms.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageChops

# The scale the motion search works at. The detector in hero-cut.py reads 480-wide
# frames for the same reason: a cursor and a repainted row both clear a threshold
# there, and a full-resolution diff of a minute of frames costs minutes.
SEARCH_WIDTH = 480
# Frames per second sampled for the search. A block landing spans several frames at
# 30 fps, so six is enough to catch it and cheap enough to run over a few seconds.
SEARCH_FPS = 6
# A channel difference below this is compression noise, not a repaint.
SEARCH_THRESHOLD = 24
# What the published frame is. The zoom ceiling is this over the capture width.
PUBLISH_WIDTH = 1920
# Seconds searched before the moment. A block lands over a beat, and the frame the
# moment names is the one after it settled.
SEARCH_LEAD = 1.0
# How much of the region's own size is added around it, so the zoom does not clip
# the thing it is pointing at.
PAD = 0.25
EASE = 0.5
HOLD = 1.6


@dataclass(frozen=True)
class Rect:
	"""A crop in source pixels."""

	x: int
	y: int
	w: int
	h: int

	@property
	def cx(self) -> float:
		return self.x + self.w / 2

	@property
	def cy(self) -> float:
		return self.y + self.h / 2


def probe(path: Path, fields: str) -> list[str]:
	out = subprocess.run(
		[
			"ffprobe",
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			fields,
			"-of",
			"default=noprint_wrappers=1:nokey=1",
			str(path),
		],
		capture_output=True,
		text=True,
		check=True,
	)
	return [line for line in out.stdout.splitlines() if line]


def size(path: Path) -> tuple[int, int]:
	width, height = probe(path, "stream=width,height")[:2]
	return int(width), int(height)


def frame_count(path: Path) -> int:
	out = subprocess.run(
		[
			"ffprobe",
			"-v",
			"error",
			"-count_frames",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=nb_read_frames",
			"-of",
			"default=noprint_wrappers=1:nokey=1",
			str(path),
		],
		capture_output=True,
		text=True,
		check=True,
	)
	return int(out.stdout.strip())


def rate(path: Path) -> str:
	return probe(path, "stream=r_frame_rate")[0]


def sample(take: Path, start: float, span: float, into: Path) -> list[Path]:
	"""Write the search frames for a window, smallest size that still shows a repaint."""
	subprocess.run(
		[
			"ffmpeg",
			"-loglevel",
			"error",
			"-y",
			"-ss",
			f"{max(start, 0):.3f}",
			"-t",
			f"{span:.3f}",
			"-i",
			str(take),
			"-vf",
			f"fps={SEARCH_FPS},scale={SEARCH_WIDTH}:-2:flags=bilinear",
			str(into / "f%04d.png"),
		],
		check=True,
	)
	return sorted(into.glob("f*.png"))


def motion_box(frames: list[Path]) -> tuple[int, int, int, int] | None:
	"""The bounding box, in search pixels, of every pixel that changed across the window."""
	box: tuple[int, int, int, int] | None = None
	previous: Image.Image | None = None
	for frame in frames:
		current = Image.open(frame).convert("L")
		if previous is not None:
			changed = ImageChops.difference(current, previous).point(
				lambda value: 255 if value >= SEARCH_THRESHOLD else 0
			)
			found = changed.getbbox()
			if found is not None:
				box = found if box is None else (
					min(box[0], found[0]),
					min(box[1], found[1]),
					max(box[2], found[2]),
					max(box[3], found[3]),
				)
		previous = current
	return box


def frame_rect(box: tuple[int, int, int, int], *, width: int, height: int, zoom: float, pad: float) -> Rect:
	"""Turn a search-scale box into the source-pixel crop the zoom holds.

	The crop keeps the source aspect ratio, so the scale back to full size never
	stretches, and it is clamped inside the frame: a region against an edge moves the
	crop rather than shrinking the zoom.
	"""
	scale = width / SEARCH_WIDTH
	x0, y0, x1, y1 = (value * scale for value in box)
	box_w = max(x1 - x0, 1.0) * (1 + 2 * pad)
	box_h = max(y1 - y0, 1.0) * (1 + 2 * pad)
	cx = (x0 + x1) / 2
	cy = (y0 + y1) / 2
	# The zoom the region asks for, never past the ceiling the caller allows.
	held = min(zoom, width / min(box_w, width), height / min(box_h, height))
	held = max(held, 1.0)
	crop_w = _even(width / held)
	crop_h = _even(height / held)
	x = _clamp(round(cx - crop_w / 2), 0, width - crop_w)
	y = _clamp(round(cy - crop_h / 2), 0, height - crop_h)
	return Rect(x=x, y=y, w=crop_w, h=crop_h)


def _even(value: float) -> int:
	return max(2, int(round(value / 2)) * 2)


def _clamp(value: int, low: int, high: int) -> int:
	return max(low, min(high, value))


def zoom_filter(rect: Rect, *, width: int, height: int, at: float, hold: float, ease: float, fps: str) -> str:
	"""The zoom expression, evaluated per frame.

	`time` runs over the take, so one filter covers the ease in, the hold and the ease
	out. Smoothstep on the progress keeps the move off a constant velocity, which reads
	as a camera rather than a jump cut.

	`crop` cannot express this: ffmpeg 7 evaluates a crop width once at configuration,
	and the `eval` option that used to make it per-frame is gone. `zoompan` evaluates
	all three of z, x and y per frame, and `d=1` at the source rate emits one frame per
	frame in, which is what keeps the cadence the recorder captured.
	"""
	zoom = width / rect.w
	t0 = max(at - ease, 0.0)
	t1 = t0 + ease
	t2 = t1 + hold
	t3 = t2 + ease
	progress = (
		f"if(lt(time,{t0:.3f}),0,"
		f"if(lt(time,{t1:.3f}),(time-{t0:.3f})/{ease:.3f},"
		f"if(lt(time,{t2:.3f}),1,"
		f"if(lt(time,{t3:.3f}),1-(time-{t2:.3f})/{ease:.3f},0))))"
	)
	smooth = f"st(1,{progress});ld(1)*ld(1)*(3-2*ld(1))"
	factor = f"1+{zoom - 1:.6f}*({smooth})"
	pan_x = f"clip({rect.cx:.1f}-(iw/zoom)/2,0,iw-iw/zoom)"
	pan_y = f"clip({rect.cy:.1f}-(ih/zoom)/2,0,ih-ih/zoom)"
	return f"zoompan=z='{factor}':x='{pan_x}':y='{pan_y}':d=1:s={width}x{height}:fps={fps}"


def render(take: Path, out: Path, expression: str, *, crf: int) -> None:
	"""Re-encode the take through the zoom, keeping every frame it recorded.

	The output feeds the cut, which encodes the published clip, so this stage is an
	intermediate: a low crf and a fast preset, with `-fps_mode passthrough` so the
	frame count and the rate reach the cut unchanged.
	"""
	subprocess.run(
		[
			"ffmpeg",
			"-loglevel",
			"error",
			"-y",
			"-i",
			str(take),
			"-vf",
			expression,
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			str(crf),
			"-pix_fmt",
			"yuv420p",
			"-fps_mode",
			"passthrough",
			"-an",
			str(out),
		],
		check=True,
	)


def mark_time(marks: Path, name: str) -> float:
	"""The recorded time of a mark the scene took, by name."""
	for line in marks.read_text().splitlines():
		row = line.split("\t")
		if len(row) >= 2 and row[0] == name:
			return float(row[1])
	raise ValueError(f"{marks}: no mark named '{name}'")


def zoom_into(
	take: Path,
	out: Path,
	*,
	at: float,
	hold: float,
	ease: float,
	zoom: float | None,
	pad: float,
	crf: int,
	report: bool = True,
) -> Rect:
	width, height = size(take)
	ceiling = zoom if zoom is not None else width / PUBLISH_WIDTH
	if ceiling <= 1.0:
		raise ValueError(f"a zoom of {ceiling:.2f}x is not a zoom; the capture is {width} wide")
	# The search frames are an intermediate of this take, so they live beside the file
	# being written rather than in a system temp directory a run does not own.
	out.parent.mkdir(parents=True, exist_ok=True)
	with tempfile.TemporaryDirectory(prefix=".zoom-", dir=out.parent) as scratch:
		frames = sample(take, at - SEARCH_LEAD, SEARCH_LEAD + hold, Path(scratch))
		if len(frames) < 2:
			raise ValueError(f"{take}: {at:.1f}s is outside the recording")
		box = motion_box(frames)
	if box is None:
		raise ValueError(f"{take}: nothing changed around {at:.1f}s, so there is no region to zoom into")
	rect = frame_rect(box, width=width, height=height, zoom=ceiling, pad=pad)
	if report:
		print(
			f"{take}: {rect.w}x{rect.h} at {rect.x},{rect.y}"
			f" -> {width / rect.w:.2f}x held {hold:.1f}s from {at:.1f}s"
		)
	render(
		take,
		out,
		zoom_filter(rect, width=width, height=height, at=at, hold=hold, ease=ease, fps=rate(take)),
		crf=crf,
	)
	return rect


def white_fraction(video: Path, at: float, scratch: Path) -> float:
	"""The share of a frame that is bright, used by the self-check."""
	still = scratch / f"probe-{at:.2f}.png"
	subprocess.run(
		["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{at:.3f}", "-i", str(video), "-frames:v", "1", str(still)],
		check=True,
	)
	image = Image.open(still).convert("L")
	bright = sum(count for value, count in enumerate(image.histogram()) if value >= 200)
	return bright / (image.width * image.height)


def self_check() -> int:
	"""Prove the stage on a clip whose moving region is known.

	The recorder host runs this before it trusts the stage: an ffmpeg whose zoom filter
	evaluates once instead of per frame writes a file with the move silently missing, and
	a take is too expensive to be where that is discovered.
	"""
	failures: list[str] = []
	# The clip and its probe frames are this run's own work, so they stay under the
	# directory the run was started in and are removed with it.
	with tempfile.TemporaryDirectory(prefix=".zoom-check-", dir=Path.cwd()) as scratch:
		root = Path(scratch)
		take = root / "take.mp4"
		# A dark screen with one bright block that appears at 1s, at a known place. It sits
		# near a corner on purpose: a crop that ignored the region and centred itself in the
		# frame would still contain a block near the middle, and the check would pass.
		block = {"x": 2380, "y": 1330, "w": 160, "h": 90}
		subprocess.run(
			[
				"ffmpeg",
				"-loglevel",
				"error",
				"-y",
				"-f",
				"lavfi",
				"-i",
				"color=c=0x171b22:s=2560x1440:r=30:d=4",
				"-vf",
				f"drawbox=x={block['x']}:y={block['y']}:w={block['w']}:h={block['h']}"
				":color=0xd3dae6:t=fill:enable='gte(t,1)'",
				"-c:v",
				"libx264",
				"-preset",
				"veryfast",
				"-crf",
				"18",
				"-pix_fmt",
				"yuv420p",
				str(take),
			],
			check=True,
		)
		out = root / "zoomed.mp4"
		rect = zoom_into(take, out, at=1.5, hold=1.0, ease=0.4, zoom=None, pad=PAD, crf=18, report=False)

		if not (
			rect.x <= block["x"]
			and rect.y <= block["y"]
			and rect.x + rect.w >= block["x"] + block["w"]
			and rect.y + rect.h >= block["y"] + block["h"]
		):
			failures.append(f"the measured rect {rect} does not contain the block that moved {block}")
		if rect.x < 0 or rect.y < 0 or rect.x + rect.w > 2560 or rect.y + rect.h > 1440:
			failures.append(f"the measured rect {rect} leaves the frame")
		if abs(rect.w / rect.h - 2560 / 1440) > 0.01:
			failures.append(f"the measured rect {rect} is not the source aspect ratio")

		if frame_count(out) != frame_count(take):
			failures.append(f"the zoom changed the frame count: {frame_count(take)} -> {frame_count(out)}")
		if rate(out) != rate(take):
			failures.append(f"the zoom changed the rate: {rate(take)} -> {rate(out)}")

		before = white_fraction(take, 1.5, root)
		after = white_fraction(out, 2.0, root)
		grew = after / before if before > 0 else 0.0
		expected = (2560 / rect.w) ** 2
		if grew < expected * 0.85:
			failures.append(f"the held frame grew the region {grew:.2f}x, short of the {expected:.2f}x the crop asks for")
		# The frame before the ease starts is the frame the recorder took.
		opening = white_fraction(out, 1.05, root)
		if opening > before * 1.3:
			failures.append(f"the clip opens already zoomed ({opening:.4f} against {before:.4f})")

	for failure in failures:
		print(f"zoom self-check: {failure}", file=sys.stderr)
	print(f"zoom self-check: {'FAILED' if failures else 'ok'}")
	return 1 if failures else 0


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument("take", type=Path, nargs="?", help="the recording to zoom")
	parser.add_argument("out", type=Path, nargs="?", help="where to write the zoomed recording")
	parser.add_argument("--at", type=float, help="the moment to zoom into, in take seconds")
	parser.add_argument("--marks", type=Path, help="the marks file a scene wrote")
	parser.add_argument("--mark", help="the name of the mark to zoom into")
	parser.add_argument("--hold", type=float, default=HOLD, help=f"seconds held at full zoom (default {HOLD})")
	parser.add_argument("--ease", type=float, default=EASE, help=f"seconds of move each way (default {EASE})")
	parser.add_argument(
		"--zoom",
		type=float,
		help=f"zoom ceiling; defaults to the capture width over the published {PUBLISH_WIDTH}",
	)
	parser.add_argument("--pad", type=float, default=PAD, help=f"region padding as a share of its size (default {PAD})")
	parser.add_argument("--crf", type=int, default=18, help="x264 quality of the intermediate")
	parser.add_argument("--self-check", action="store_true", help="prove the stage on a synthetic clip")
	args = parser.parse_args()

	if args.self_check:
		return self_check()
	for tool in ("ffmpeg", "ffprobe"):
		if shutil.which(tool) is None:
			print(f"zoom.py: {tool} is not installed", file=sys.stderr)
			return 2
	if args.take is None or args.out is None:
		parser.error("take and out are required")
	if args.mark and not args.marks:
		parser.error("--mark requires --marks")
	if (args.at is None) == (args.mark is None):
		parser.error("pass exactly one of --at and --mark")
	if args.hold <= 0 or args.ease <= 0:
		parser.error("--hold and --ease must be greater than zero")

	try:
		at = args.at if args.at is not None else mark_time(args.marks, args.mark)
		zoom_into(
			args.take,
			args.out,
			at=at,
			hold=args.hold,
			ease=args.ease,
			zoom=args.zoom,
			pad=args.pad,
			crf=args.crf,
		)
	except ValueError as error:
		print(f"zoom.py: {error}", file=sys.stderr)
		return 1
	print(f"wrote {args.out} ({args.out.stat().st_size} bytes)")
	return 0


if __name__ == "__main__":
	sys.exit(main())
