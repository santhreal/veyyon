#!/usr/bin/env python3
"""Cut a filmstrip out of a scene recording.

    proof/filmstrip.py <video.mp4> <out-prefix> --at <seconds> [--frames 8] [--step 1]

Every frame it writes came off the recording of a real terminal; nothing here
renders a component. The unfold this proves runs 220ms, which is thirteen frames
at 60fps, so a still taken from inside the scene always lands after it -- the
frames have to be cut from the video afterwards.

`--find` locates the moment instead of trusting a hand-typed timestamp: it walks
the frame differences ffmpeg reports and returns the first large jump after a
quiet stretch, which is what a card arriving on a still screen looks like.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


def scene_changes(video: Path, threshold: float) -> list[float]:
    """Timestamps where the frame differs sharply from the one before it."""
    proc = subprocess.run(
        [
            "ffmpeg", "-loglevel", "info", "-i", str(video),
            "-vf", f"select='gt(scene,{threshold})',metadata=print",
            "-f", "null", "-",
        ],
        capture_output=True,
        text=True,
    )
    stamps = []
    for match in re.finditer(r"pts_time:([0-9.]+)", proc.stdout + proc.stderr):
        stamps.append(float(match.group(1)))
    return sorted(set(stamps))


def cut(video: Path, prefix: Path, at: float, frames: int, fps: int, step: int, crop: str | None = None) -> list[Path]:
    """Decode the frames in [at, at + frames*step/fps) exactly.

    A seek placed before `-i` lands on the nearest keyframe, and at this
    encoder's GOP that is the same frame for every offset inside a second, so
    sixteen "different" offsets came back as sixteen copies of one picture. One
    decode pass with a `select` on the timestamp is exact and costs one run.
    """
    prefix.parent.mkdir(parents=True, exist_ok=True)
    for stale in prefix.parent.glob(f"{prefix.name}-f*.png"):
        stale.unlink()
    end = at + (frames * step) / fps
    select = f"select='between(t,{at:.4f},{end:.4f})'"
    chain = f"{select},crop={crop}" if crop else select
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-i", str(video),
         "-vf", chain, "-vsync", "0",
         "-frames:v", str(frames * step),
         str(prefix.parent / f"{prefix.name}-raw-%03d.png")],
        check=True,
    )
    raw = sorted(prefix.parent.glob(f"{prefix.name}-raw-*.png"))
    written = []
    for index, source in enumerate(raw[::step][:frames]):
        out = prefix.parent / f"{prefix.name}-f{index:02d}.png"
        source.rename(out)
        written.append(out)
    for leftover in prefix.parent.glob(f"{prefix.name}-raw-*.png"):
        leftover.unlink()
    return written


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("prefix", type=Path)
    parser.add_argument("--at", type=float, default=None)
    parser.add_argument("--find", action="store_true", help="list frame-difference peaks and exit")
    parser.add_argument("--nth", type=int, default=0, help="use the nth peak as the moment")
    parser.add_argument("--threshold", type=float, default=0.02)
    parser.add_argument("--frames", type=int, default=8)
    parser.add_argument("--fps", type=int, default=60)
    parser.add_argument("--step", type=int, default=1)
    parser.add_argument("--lead", type=float, default=0.0, help="seconds before the moment to start")
    parser.add_argument(
        "--crop",
        default=None,
        help="ffmpeg crop geometry w:h:x:y, so a strip of a card is legible at page width",
    )
    args = parser.parse_args()

    if args.find:
        for index, stamp in enumerate(scene_changes(args.video, args.threshold)):
            print(f"{index:3d}  {stamp:8.3f}s")
        return 0

    at = args.at
    if at is None:
        peaks = scene_changes(args.video, args.threshold)
        if len(peaks) <= args.nth:
            print(f"only {len(peaks)} peaks found", file=sys.stderr)
            return 1
        at = peaks[args.nth]
    at = max(0.0, at - args.lead)

    written = cut(args.video, args.prefix, at, args.frames, args.fps, args.step, args.crop)
    print(f"{args.video.name}: {len(written)} frames from {at:.3f}s")
    for path in written:
        print(" ", path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
