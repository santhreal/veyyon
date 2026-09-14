#!/usr/bin/env python3
"""Read native review results and locate rendered button borders without mutating UI state."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import tomllib

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = Path(os.environ["TMPDIR"])
PROBE = RUNTIME / "diff-review"


def geometry():
    tokens = ROOT / "crates/veyyon-desktop-tokens/tokens"
    panels = tomllib.loads((tokens / "surface/panels.toml").read_text())
    palette = tomllib.loads((tokens / "surface/palette.toml").read_text())["geometry"]
    scale = tomllib.loads((tokens / "scale.toml").read_text())
    print(panels["diff"]["row_height_px"], panels["diff"]["gutter_width_px"],
          panels["diff"]["hunk_header_height_px"], panels["tabs"]["height_px"],
          panels["chrome"]["row_height_px"], palette["anchored_width_px"],
          palette["max_height_px"], scale["spacing"]["s2"])


def buttons():
    image, left, top, width, height, action = sys.argv[2:]
    left, top, width, height = map(int, (left, top, width, height))
    theme = tomllib.loads((ROOT / "crates/veyyon-desktop-tokens/themes/dark.toml").read_text())
    edge = bytes.fromhex(theme["role"]["hairline"].removeprefix("#"))
    pixels = subprocess.check_output(["magick", image, "-crop", f"{width}x{height}+{left}+{top}",
                                      "+repage", "-depth", "8", "rgb:-"], timeout=10)
    if len(pixels) != width * height * 3:
        raise SystemExit("Review popover crop is outside the captured screen")
    spans = {}
    for y in range(height):
        start = None
        for x in range(width + 1):
            offset = (y * width + x) * 3
            matched = x < width and all(abs(pixels[offset + c] - edge[c]) <= 2 for c in range(3))
            if matched and start is None:
                start = x
            if not matched and start is not None:
                if x - start >= 22:
                    spans.setdefault(y, []).append((start, x - 1))
                start = None
    # Small native controls have a 24px height (kit controls::metrics). Both
    # horizontal edges must be visible, so text or a single divider is not a hit.
    boxes = []
    for y, runs in spans.items():
        for start, end in runs:
            if any(abs(a - start) <= 2 and abs(b - end) <= 2 for a, b in spans.get(y + 23, [])):
                boxes.append((start, y, end, y + 23))
    boxes.sort(key=lambda box: (box[1], box[0]))
    (PROBE / "button-boxes.json").write_text(json.dumps(boxes))
    expected = {"post-new": 2, "reply": 3, "resolve": 3, "reopen": 3, "post-reply": 4}
    if action not in expected or len(boxes) != expected[action]:
        raise SystemExit(f"Review {action}: expected {expected.get(action)} rendered buttons, found {boxes}")
    box = boxes[-2] if action.startswith("post") else boxes[0 if action == "reply" else 1]
    print(left + (box[0] + box[2]) // 2, top + (box[1] + box[3]) // 2)


def state():
    transition = sys.argv[2]
    deadline = time.monotonic() + 15
    last = "reviews.json has not been written"
    first = "Check the changed total."
    reply = "The boundary case is covered."
    while time.monotonic() < deadline:
        try:
            document = json.loads((RUNTIME / "desktop-state/reviews.json").read_text())
            threads = document["threads"]
            assert len(threads) == 1, f"Expected one thread, found {len(threads)}"
            thread = threads[0]
            anchor = thread["anchor"]
            assert anchor["repository"] == os.environ["REPO_DIR"], anchor
            assert anchor["file"] == "ledger.rs" and anchor["side"] == "New", anchor
            assert anchor["scope"] == "WorkingTree" and anchor["original_line"] == 3, anchor
            assert anchor["text"] == "let bravo = 2;", anchor
            assert anchor["before"] == "let alpha = 11;" and anchor["after"] == "let carol = 3;", anchor
            if transition == "created":
                assert thread["comments"] == [first] and not thread["resolved"] and not thread["orphaned"], thread
            else:
                original = json.loads((PROBE / "created.json").read_text())["threads"][0]
                assert thread["id"] == original["id"] and anchor == original["anchor"], thread
                assert thread["comments"] == [first, reply], thread
                assert thread["resolved"] == (transition == "resolved"), thread
                assert thread["orphaned"] == (transition in ("orphaned", "still-orphaned")), thread
                if transition == "moved":
                    lines = (Path(os.environ["REPO_DIR"]) / "ledger.rs").read_text().splitlines()
                    assert lines.index(anchor["text"]) + 1 == 5, lines
            assert transition in {"created", "replied", "resolved", "reopened", "relaunched", "moved", "orphaned", "still-orphaned"}
            (PROBE / f"{transition}.json").write_text(json.dumps(document, indent=2))
            print(f"scene: native review persisted {transition}")
            return
        except (OSError, ValueError, KeyError, AssertionError) as error:
            last = str(error)
        time.sleep(0.1)
    raise SystemExit(f"Review {transition} timed out: {last}")


if __name__ == "__main__":
    {"geometry": geometry, "buttons": buttons, "state": state}[sys.argv[1]]()
