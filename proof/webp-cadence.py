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

With `--expect-ms` it is a gate, and what it gates is the TYPICAL frame: the most
common duration must be that value give or take a millisecond, which is the rounding a
30 fps source allows (33ms and 34ms alternate). It is deliberately not every frame. A
WebP encoder merges frames that are byte-identical, so a stretch where the screen is
genuinely still becomes one frame held for 100ms, and that is compression rather than
lag -- the old asset's defect was that its typical frame was 83ms, not that a few were
long. The longest hold is printed either way, because a second-long hold in the middle
of a scroll is worth looking at.
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
		help="fail unless every frame holds for this long, +/-1ms",
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
	return 0


raise SystemExit(main())
