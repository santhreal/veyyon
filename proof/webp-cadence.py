#!/usr/bin/env python3
"""Read the per-frame timing out of an animated WebP.

WHY THIS EXISTS. The proof page claims the published clip carries the cadence the
recorder captured, and that claim was wrong for every asset published before it was
checked: both display servers record at 30 fps, and the publish path resampled twice
-- 30 to 15 in the cut, then 15 to 12 in the WebP -- so the hero played at a 7.7 fps
average with fifteen frames held for a quarter of a second each. It read as a laggy
product rather than as a resampled file.

Nothing on this machine could see it. `ffprobe` and `webpinfo` are not installed, and
Pillow answers `None` for `info["duration"]` on an animated WebP, so the only place the
timing exists is the file: each frame is an ANMF chunk whose payload carries its own
duration in milliseconds at offset 12, three bytes, little endian. This walks the RIFF
container and reports them.

    python3 proof/webp-cadence.py assets/demo-hd.webp
    python3 proof/webp-cadence.py assets/demo-hd.webp --expect-ms 33

With `--expect-ms` it is a gate, and it asks two questions about two different
failures.

THE TYPICAL FRAME must be that value give or take a millisecond, which is the rounding
a 30 fps source allows (33ms and 34ms alternate). That catches a RESAMPLE: the old
asset's typical frame was 83ms, and every frame in the file had been rewritten.

THE MOVING PORTION must average close to the capture rate. That catches the other
failure, which the typical-frame check cannot see: a file whose most common duration is
correct and whose wall clock is mostly slower than it. The hero published at 14.2 fps
against a 30 fps capture with 33ms as its most common frame at 44%; the other 56% held
for 66ms and 100ms, so a third of the clip played at 10 to 15 fps and the gate passed.
A criterion that reads the most common value cannot see a file that is mostly slower
than the most common value.

A WebP encoder merges byte-identical frames, so a stretch where the screen is genuinely
still becomes one long hold, and that is compression rather than lag. Holds at or past
`--still-ms` (default ten times the expected interval) are counted as stills, reported,
and left out of the moving average. Everything shorter counts against it: a frame held
for two or three intervals in the middle of a scroll is the product drawing slowly,
which is what a viewer reads as lag.
"""

import argparse
import collections
import pathlib
import struct
import sys

ANMF_DURATION_OFFSET = 12


def frame_durations(data: bytes) -> list[int]:
	"""Every ANMF duration in file order, in milliseconds."""
	if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
		raise ValueError("not a RIFF/WEBP file")
	durations: list[int] = []
	offset = 12
	while offset + 8 <= len(data):
		fourcc = data[offset : offset + 4]
		(size,) = struct.unpack_from("<I", data, offset + 4)
		payload = offset + 8
		if fourcc == b"ANMF":
			at = payload + ANMF_DURATION_OFFSET
			raw = data[at : at + 3]
			if len(raw) == 3:
				durations.append(raw[0] | (raw[1] << 8) | (raw[2] << 16))
		# ANMF payloads hold their own sub-chunks, so the walk steps OVER a frame rather
		# than into it. Odd-sized chunks carry a pad byte that is not counted in `size`.
		offset = payload + size + (size & 1)
	return durations


def main() -> int:
	ap = argparse.ArgumentParser()
	ap.add_argument("webp", type=pathlib.Path)
	ap.add_argument(
		"--expect-ms",
		type=int,
		help="the capture interval; gates the typical frame and the moving average against it",
	)
	ap.add_argument(
		"--still-ms",
		type=int,
		help="a hold this long or longer is a still screen, not lag (default: ten times --expect-ms)",
	)
	ap.add_argument(
		"--tolerance",
		type=float,
		default=0.10,
		help="how far below the capture rate the moving average may sit (default 0.10)",
	)
	args = ap.parse_args()

	durations = frame_durations(args.webp.read_bytes())
	if not durations:
		print(f"{args.webp}: no animation frames (a still WebP has no ANMF chunks)")
		return 1

	total_ms = sum(durations)
	seconds = total_ms / 1000
	histogram = collections.Counter(durations)
	spread = " ".join(f"{ms}ms x{count}" for ms, count in sorted(histogram.items()))
	typical, typical_count = histogram.most_common(1)[0]
	longest = max(durations)
	print(f"{args.webp}: {len(durations)} frames, {seconds:.2f}s, {len(durations) / seconds:.1f} fps average")
	print(f"  per-frame: {spread}")
	share = 100 * typical_count / len(durations)
	print(f"  typical: {typical}ms ({typical_count} of {len(durations)} frames, {share:.0f}%), longest hold {longest}ms")

	if args.expect_ms is None:
		return 0
	if abs(typical - args.expect_ms) > 1:
		print(
			f"  FAIL: the typical frame holds {typical}ms, not {args.expect_ms}ms +/-1 —"
			f" the clip was resampled away from its source cadence",
			file=sys.stderr,
		)
		return 1
	print(f"  the typical frame holds {args.expect_ms}ms +/-1, which is the cadence the recorder captured")

	# The moving portion: everything that is not a held still screen. A hold is
	# either compression (the screen did not change) or the product drawing
	# slowly, and the file cannot tell them apart -- so the threshold says where
	# the line is, and it is reported rather than assumed.
	still_ms = args.still_ms if args.still_ms is not None else args.expect_ms * 10
	moving = [ms for ms in durations if ms < still_ms]
	stills = [ms for ms in durations if ms >= still_ms]
	if stills:
		print(f"  stills: {len(stills)} holds >= {still_ms}ms, {sum(stills) / 1000:.2f}s set aside")
	if not moving:
		print(f"  FAIL: every frame holds >= {still_ms}ms — nothing in this file moves", file=sys.stderr)
		return 1

	captured_fps = 1000 / args.expect_ms
	moving_fps = len(moving) / (sum(moving) / 1000)
	floor_fps = captured_fps * (1 - args.tolerance)
	at_cadence = sum(1 for ms in moving if abs(ms - args.expect_ms) <= 1)
	cadence_share = 100 * at_cadence / len(moving)
	print(
		f"  moving: {len(moving)} frames, {sum(moving) / 1000:.2f}s, {moving_fps:.1f} fps"
		f" ({cadence_share:.0f}% at the capture interval)"
	)
	if moving_fps < floor_fps:
		print(
			f"  FAIL: the moving portion averages {moving_fps:.1f} fps, under the {floor_fps:.1f} fps floor"
			f" ({captured_fps:.1f} fps captured, {args.tolerance:.0%} tolerance) —"
			f" most of the clock is slower than its most common frame",
			file=sys.stderr,
		)
		return 1
	print(f"  the moving portion averages {moving_fps:.1f} fps against {captured_fps:.1f} fps captured")
	return 0


raise SystemExit(main())
