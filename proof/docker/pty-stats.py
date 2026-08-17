#!/usr/bin/env python3
"""What an app actually wrote to a terminal, counted.

    pty-stats.py <pty.raw> [label]

The numbers a video cannot carry. ED3 is the one that matters: it erases the
terminal's own scroll buffer, and it is the byte sequence behind both symptoms
this branch chased -- the strobe, because the screen is rebuilt from nothing, and
the void, because everything above the window is gone. A frame that repaints in
place writes cursor moves and text; a frame that gives up and erases writes
ED3. Counting them separates the two.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

ESC = 27
ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-B0-9]")


def main() -> int:
    raw = Path(sys.argv[1]).read_bytes()
    label = sys.argv[2] if len(sys.argv) > 2 else ""
    ed3 = raw.count(bytes([ESC]) + b"[3J")
    ed2 = raw.count(bytes([ESC]) + b"[2J")
    # A frame boundary the app announces itself: synchronized-update begin.
    begin = bytes([ESC]) + b"[?2026h"
    starts = [m.start() for m in re.finditer(re.escape(begin), raw)]
    frames = len(starts)
    # What a frame COSTS, as a distribution rather than an average. The average
    # hides the only frame that matters: a full-screen repaint of a 125x33
    # terminal with colour runs tens of kilobytes, so a p95 in the low thousands
    # is the statement that no frame ever rebuilt the screen.
    sizes = sorted(b - a for a, b in zip(starts, starts[1:]))

    def pct(p: float) -> int:
        return sizes[min(len(sizes) - 1, int(len(sizes) * p))] if sizes else 0

    if label:
        print(f"label              {label}")
    for key, value in (
        ("pty bytes", len(raw)),
        ("ED3 native-scrollback erases", ed3),
        ("ED2 screen erases", ed2),
        ("synchronized frames", frames),
        ("bytes per frame", round(len(raw) / frames, 1) if frames else "n/a"),
        ("frame bytes median", pct(0.5)),
        ("frame bytes p95", pct(0.95)),
        ("frame bytes max", sizes[-1] if sizes else 0),
    ):
        print(f"{key:34} {value}")
    for name in ("SESSION_BYTES", "SESSION_MESSAGES", "WALL_SECONDS"):
        if os.environ.get(name):
            print(f"{name.lower().replace('_', ' '):34} {os.environ[name]}")
    # Every ED3 in the file, with the text that preceded it. An erase during a
    # streamed answer would be the defect; an erase where the transcript itself
    # was replaced -- a resume, a compaction -- is the app doing what it said.
    for i, m in enumerate(re.finditer(re.escape(bytes([ESC]) + b"[3J"), raw), 1):
        before = ANSI.sub(" ", raw[max(0, m.start() - 400) : m.start()].decode("utf8", "replace"))
        print(f"erase {i} at byte {m.start()} ({m.start() / len(raw):.1%}) after: {' '.join(before.split())[-90:]}")
    text = ANSI.sub("", raw[-6000:].decode("utf8", "replace"))
    print("--- last screen ---")
    print("\n".join(line for line in text.splitlines() if line.strip())[-1500:])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
