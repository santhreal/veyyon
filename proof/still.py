#!/usr/bin/env python3
"""Cut one frame out of a scene recording.

    proof/still.py <video.mp4> <out.png> --at <seconds> [--crop w:h:x:y]

The page's stills come out of the video for the same reason its filmstrips do.
A scene that takes its own stills calls `import -window root`, which costs about
fifteen seconds a frame on the recorder's display: long enough to stall the
middle of every motion the scene was recording, and long enough that the still
lands after the animation it was meant to catch. Cutting the frame out of the
video afterwards is the same pixels with none of that.
"""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


def cut(video: Path, out: Path, at: float, crop: str | None) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    command = ["ffmpeg", "-v", "error", "-ss", f"{at:.4f}", "-i", str(video), "-frames:v", "1"]
    if crop:
        command += ["-vf", f"crop={crop}"]
    command += ["-y", str(out)]
    subprocess.run(command, check=True)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("video", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--at", type=float, required=True, help="seconds into the recording")
    parser.add_argument("--crop", help="ffmpeg crop, w:h:x:y")
    args = parser.parse_args()
    print("wrote", cut(args.video, args.out, args.at, args.crop))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
