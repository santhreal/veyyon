#!/usr/bin/env python3
"""Ease a recording into a region, pan, and ease back out.

    proof/zoom.py take.mp4 zoomed.mp4 --at 184.5
    proof/zoom.py take.mp4 zoomed.mp4 --cues take-cues.txt --fps 60

A landing-page clip is 1920 wide and the recorder captures 2560. The hero camera
is a 2x crop of the composer: zoom in on `/secret`, pan right as the rest of the
line is typed, hold readable, zoom out. Cue rows name that path in capture frames:

    zoom-in FRAME x,y,w,h
    pan FRAME x,y,w,h
    zoom-out FRAME

A missing rect on zoom-in still means "measure motion". The stage runs on the
take before the cut, so frame count and rate are unchanged and the cadence gate
reads the capture interval.
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
HOLD = 2.0
# How much larger a glyph is than in the published wide shot. 2.0 crops at most
# half the capture width and scales it to the published frame, which is an
# upscale of the crop and is the camera move the hero take needs: the secret
# line has to be readable at 1080p, not merely a few cells in a wide terminal.
MAGNIFY = 2.0
CUE_FPS = 60
# Seconds of sideways travel between the zoom-in crop and the pan crop.
PAN_EASE = 1.0


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


def path_filter(
	left: Rect,
	right: Rect,
	*,
	width: int,
	height: int,
	t_in: float,
	t_pan: float,
	t_out: float,
	ease: float,
	pan_ease: float,
	fps: str,
) -> str:
	"""Zoom into `left`, pan to `right`, hold, zoom out.

	Registers (evaluated in `z`, read in `x`/`y`):
	  1  zoom progress 0→1→0 (raw)
	  11 smoothstep of 1
	  2  pan progress 0→1 (raw)
	  22 smoothstep of 2
	"""
	t1 = t_in + ease
	t2 = max(t_pan, t1)
	t3 = t2 + pan_ease
	t4 = max(t_out, t3)
	t5 = t4 + ease
	zoom = width / left.w
	zprog = (
		f"if(lt(time,{t_in:.3f}),0,"
		f"if(lt(time,{t1:.3f}),(time-{t_in:.3f})/{ease:.3f},"
		f"if(lt(time,{t4:.3f}),1,"
		f"if(lt(time,{t5:.3f}),1-(time-{t4:.3f})/{ease:.3f},0))))"
	)
	pprog = (
		f"if(lt(time,{t2:.3f}),0,"
		f"if(lt(time,{t3:.3f}),(time-{t2:.3f})/{pan_ease:.3f},1))"
	)
	factor = (
		f"st(1,{zprog});st(11,ld(1)*ld(1)*(3-2*ld(1)));"
		f"st(2,{pprog});st(22,ld(2)*ld(2)*(3-2*ld(2)));"
		f"1+{zoom - 1:.6f}*ld(11)"
	)
	cx_full = width / 2
	cy_full = height / 2
	cx = (
		f"if(lt(time,{t2:.3f}),{cx_full:.1f}+({left.cx:.1f}-{cx_full:.1f})*ld(11),"
		f"if(lt(time,{t4:.3f}),{left.cx:.1f}+({right.cx:.1f}-{left.cx:.1f})*ld(22),"
		f"{right.cx:.1f}+({cx_full:.1f}-{right.cx:.1f})*(1-ld(11))))"
	)
	cy = (
		f"if(lt(time,{t2:.3f}),{cy_full:.1f}+({left.cy:.1f}-{cy_full:.1f})*ld(11),"
		f"if(lt(time,{t4:.3f}),{left.cy:.1f}+({right.cy:.1f}-{left.cy:.1f})*ld(22),"
		f"{right.cy:.1f}+({cy_full:.1f}-{right.cy:.1f})*(1-ld(11))))"
	)
	pan_x = f"clip(({cx})-(iw/zoom)/2,0,iw-iw/zoom)"
	pan_y = f"clip(({cy})-(ih/zoom)/2,0,ih-ih/zoom)"
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


def _fit_magnify(rect: Rect, *, width: int, height: int, magnify: float) -> Rect:
	"""Pin a crop to at least `magnify` so a full-frame box cannot collapse the camera to 1x."""
	floor_w = _even(width / magnify)
	floor_h = _even(height / magnify)
	if rect.w <= floor_w and rect.h <= floor_h:
		return rect
	cx = rect.x + rect.w / 2
	cy = rect.y + rect.h / 2
	return Rect(
		x=_clamp(round(cx - floor_w / 2), 0, width - floor_w),
		y=_clamp(round(cy - floor_h / 2), 0, height - floor_h),
		w=floor_w,
		h=floor_h,
	)


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
	magnify: float = MAGNIFY,
	forced_rect: tuple[int, int, int, int] | None = None,
	pan_rect: tuple[int, int, int, int] | None = None,
	at_pan: float | None = None,
) -> Rect:
	width, height = size(take)
	ceiling = zoom if zoom is not None else width / PUBLISH_WIDTH
	if magnify > 1.0:
		ceiling = max(ceiling, magnify)
	if ceiling <= 1.0:
		raise ValueError(f"a zoom of {ceiling:.2f}x is not a zoom; the capture is {width} wide")
	# The search frames are an intermediate of this take, so they live beside the file
	# being written rather than in a system temp directory a run does not own.
	out.parent.mkdir(parents=True, exist_ok=True)
	box = None
	if forced_rect is None:
		with tempfile.TemporaryDirectory(prefix=".zoom-", dir=out.parent) as scratch:
			frames = sample(take, at - SEARCH_LEAD, SEARCH_LEAD + hold, Path(scratch))
			if len(frames) < 2:
				raise ValueError(f"{take}: {at:.1f}s is outside the recording")
			box = motion_box(frames)
	if forced_rect is not None:
		rect = Rect(x=forced_rect[0], y=forced_rect[1], w=forced_rect[2], h=forced_rect[3])
	else:
		if box is None:
			raise ValueError(f"{take}: nothing changed around {at:.1f}s, so there is no region to zoom into")
		rect = frame_rect(box, width=width, height=height, zoom=ceiling, pad=pad)
	rect = _fit_magnify(rect, width=width, height=height, magnify=magnify)
	right = None
	if pan_rect is not None:
		right = _fit_magnify(
			Rect(x=pan_rect[0], y=pan_rect[1], w=pan_rect[2], h=pan_rect[3]),
			width=width,
			height=height,
			magnify=magnify,
		)
		# The pan keeps the same crop size as the zoom-in so the camera slides, it does not re-crop.
		right = Rect(x=right.x, y=right.y, w=rect.w, h=rect.h)
	if report:
		move = f" pan {right.x},{right.y}" if right is not None else ""
		print(
			f"{take}: {rect.w}x{rect.h} at {rect.x},{rect.y}{move}"
			f" -> {width / rect.w:.2f}x held {hold:.1f}s from {at:.1f}s"
		)
	if right is not None:
		t_out = at + hold
		t_pan = at_pan if at_pan is not None else at
		expression = path_filter(
			rect,
			right,
			width=width,
			height=height,
			t_in=max(at - ease, 0.0),
			t_pan=t_pan,
			t_out=t_out,
			ease=ease,
			pan_ease=PAN_EASE,
			fps=rate(take),
		)
	else:
		expression = zoom_filter(rect, width=width, height=height, at=at, hold=hold, ease=ease, fps=rate(take))
	render(take, out, expression, crf=crf)
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
		rect = zoom_into(take, out, at=1.5, hold=1.0, ease=0.4, zoom=None, pad=PAD, crf=18, report=False, magnify=1.0)

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

		cues_path = root / "cues.txt"
		cues_path.write_text("zoom-in 45\nzoom-out 150\n")
		at, hold = cues_to_window(parse_cues(cues_path), fps=30, ease=0.5)
		if abs(at - 1.5) > 1e-9:
			failures.append(f"cue zoom-in 45 at 30fps should be 1.5s, got {at}")
		if hold < HOLD:
			failures.append(f"cue hold {hold} is under the 2s floor")
		cues_path.write_text("zoom-in 30\nzoom-out 60\n")
		try:
			cues_to_window(parse_cues(cues_path), fps=30, ease=0.5)
			failures.append("a 1s cue pair was accepted; the secret hold is 2s")
		except ValueError:
			pass
		cues_path.write_text("zoom-in 60 0,720,1280,720\npan 120 1280,720,1280,720\nzoom-out 240\n")
		path_cues = parse_cues(cues_path)
		at, hold = cues_to_window(path_cues, fps=60, ease=0.5)
		if abs(at - 1.0) > 1e-9:
			failures.append(f"60fps zoom-in 60 should be 1.0s, got {at}")
		if first_pan(path_cues) is None or first_pan(path_cues).rect != (1280, 720, 1280, 720):
			failures.append("pan cue was not parsed")
		if hold < HOLD:
			failures.append(f"pan path hold {hold} is under the 2s floor")
	for failure in failures:
		print(f"zoom self-check: {failure}", file=sys.stderr)
	print(f"zoom self-check: {'FAILED' if failures else 'ok'}")
	return 1 if failures else 0



@dataclass(frozen=True)
class Cue:
	"""One camera move. Frame numbers are in the take's capture rate."""

	kind: str
	frame: int
	rect: tuple[int, int, int, int] | None = None


def parse_cues(path: Path) -> list[Cue]:
	"""Read `zoom-in FRAME [x,y,w,h]` / `zoom-out FRAME` rows."""
	cues: list[Cue] = []
	for raw in path.read_text().splitlines():
		line = raw.strip()
		if not line or line.startswith("#"):
			continue
		parts = line.split()
		if parts[0] in ("zoom-in", "pan"):
			if len(parts) not in (2, 3):
				raise ValueError(f"{path}: bad {parts[0]} row: {raw}")
			rect = None
			if len(parts) == 3:
				nums = [int(n) for n in parts[2].split(",")]
				if len(nums) != 4:
					raise ValueError(f"{path}: {parts[0]} rect must be x,y,w,h")
				rect = (nums[0], nums[1], nums[2], nums[3])
			kind = "in" if parts[0] == "zoom-in" else "pan"
			cues.append(Cue(kind, int(parts[1]), rect))
		elif parts[0] == "zoom-out":
			if len(parts) != 2:
				raise ValueError(f"{path}: bad zoom-out row: {raw}")
			cues.append(Cue("out", int(parts[1])))
		else:
			raise ValueError(f"{path}: unknown cue {parts[0]!r}")
	if not cues:
		raise ValueError(f"{path}: no cues")
	return cues


def cues_to_window(cues: list[Cue], *, fps: float, ease: float) -> tuple[float, float]:
	"""The first zoom-in / zoom-out pair, as take-seconds and hold length."""
	ins = [c for c in cues if c.kind == "in"]
	outs = [c for c in cues if c.kind == "out"]
	if len(ins) != 1 or len(outs) != 1:
		raise ValueError("cues must name exactly one zoom-in and one zoom-out")
	at = ins[0].frame / fps
	out_at = outs[0].frame / fps
	hold = out_at - at - 2 * ease
	if hold < HOLD - 1e-9:
		raise ValueError(f"cue hold is {hold:.2f}s; the secret must stay readable for {HOLD:.1f}s")
	return at, hold


def first_in_rect(cues: list[Cue]) -> tuple[int, int, int, int] | None:
	for cue in cues:
		if cue.kind == "in":
			return cue.rect
	return None


def first_pan(cues: list[Cue]) -> Cue | None:
	for cue in cues:
		if cue.kind == "pan":
			return cue
	return None


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
	parser.add_argument("--cues", type=Path, help="camera cue file the scene emitted")
	parser.add_argument("--fps", type=float, default=CUE_FPS, help="capture rate used to turn cue frames into seconds")
	parser.add_argument(
		"--magnify",
		type=float,
		default=MAGNIFY,
		help=f"glyph size relative to the published wide shot (default {MAGNIFY})",
	)
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
	named = [args.at is not None, args.mark is not None, args.cues is not None]
	if sum(named) != 1:
		parser.error("pass exactly one of --at, --mark, and --cues")
	if args.hold <= 0 or args.ease <= 0:
		parser.error("--hold and --ease must be greater than zero")
	if args.magnify < 2.0:
		parser.error("--magnify must be at least 2 so the secret line is readable at 1080p")

	try:
		rect = None
		pan_rect = None
		at_pan = None
		if args.cues is not None:
			cues = parse_cues(args.cues)
			at, hold = cues_to_window(cues, fps=args.fps, ease=args.ease)
			rect = first_in_rect(cues)
			pan = first_pan(cues)
			if pan is not None:
				if pan.rect is None:
					raise ValueError("a pan cue needs an x,y,w,h crop")
				pan_rect = pan.rect
				at_pan = pan.frame / args.fps
		else:
			at = args.at if args.at is not None else mark_time(args.marks, args.mark)
			hold = args.hold
		zoom_into(
			args.take,
			args.out,
			at=at,
			hold=hold,
			ease=args.ease,
			zoom=args.zoom,
			pad=args.pad,
			crf=args.crf,
			magnify=args.magnify,
			forced_rect=rect,
			pan_rect=pan_rect,
			at_pan=at_pan,
		)
	except ValueError as error:
		print(f"zoom.py: {error}", file=sys.stderr)
		return 1
	print(f"wrote {args.out} ({args.out.stat().st_size} bytes)")
	return 0


if __name__ == "__main__":
	sys.exit(main())
