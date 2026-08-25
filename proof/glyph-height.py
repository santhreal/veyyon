#!/usr/bin/env python3
"""Measure how much larger a held zoom makes a glyph than the published wide shot.

    .internal/glyph-height.py take.mp4 --cues take-cues.txt

The secret line is readable when the crop is at most half the capture width:
relative scale is capture_width / crop_width, and the gate is 2.0. This is
geometry, not OCR: a 2x crop scaled to 1920 is twice the published wide-shot
glyph height.
"""
from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "proof"))
import zoom  # noqa: E402


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("take", type=Path)
	parser.add_argument("--cues", type=Path, required=True)
	parser.add_argument("--fps", type=float, default=zoom.CUE_FPS)
	parser.add_argument("--min-scale", type=float, default=zoom.MAGNIFY)
	args = parser.parse_args()
	cues = zoom.parse_cues(args.cues)
	at, hold = zoom.cues_to_window(cues, fps=args.fps, ease=zoom.EASE)
	rect = zoom.first_in_rect(cues)
	width, height = zoom.size(args.take)
	if rect is None:
		with tempfile.TemporaryDirectory(prefix=".glyph-", dir=Path.cwd()) as scratch:
			frames = zoom.sample(args.take, at - zoom.SEARCH_LEAD, zoom.SEARCH_LEAD + hold, Path(scratch))
			box = zoom.motion_box(frames)
		if box is None:
			print("glyph-height: nothing moved in the hold; no crop to measure", file=sys.stderr)
			return 1
		measured = zoom.frame_rect(
			box,
			width=width,
			height=height,
			zoom=max(width / zoom.PUBLISH_WIDTH, args.min_scale),
			pad=zoom.PAD,
		)
		rect = (measured.x, measured.y, measured.w, measured.h)
	scale = width / rect[2]
	print(f"{args.take}: crop {rect[2]}x{rect[3]} in {width}px capture -> {scale:.2f}x vs wide shot")
	if scale + 1e-9 < args.min_scale:
		print(f"glyph-height: {scale:.2f}x is under the {args.min_scale:.1f}x floor", file=sys.stderr)
		return 1
	return 0


if __name__ == "__main__":
	sys.exit(main())
