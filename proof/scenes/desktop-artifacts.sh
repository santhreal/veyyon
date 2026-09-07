#!/usr/bin/env bash
# Drive the native GPUI desktop front end window and capture transcript artifact
# and disclosure workflows through the real GUI host.
#
# Records visual evidence for:
#   1. idle (composer in initial idle state)
#   2. typed-draft (draft text typed into composer)
#   3. model-picker-open (model picker palette overlay open)
#   4. model-picker-dismissed (model picker dismissed; draft retained in composer)
#   5. slash-palette-open (slash commands palette overlay open)
#   6. slash-palette-dismissed (slash palette dismissed)
#   7. model-selected (local model chosen from picker)
#   8. artifact-user-image-collapsed (user turn with prompt and collapsed image artifact)
#   9. artifact-user-image-expanded (expanded image artifact with decoded preview & metadata)
#  10. artifact-user-image-recollapsed (re-collapsed image artifact block)
#  11. transcript-second-turn (second turn completed with file inspection output)
#  12. contextual-file-panel-open (contextual right panel open with file / tree view)
#  13. contextual-file-panel-closed (contextual right panel toggled closed)
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT,
# and SCENE_LIB already initialized.

set -euo pipefail

# Synthesize a non-private PNG test asset in the demo workspace
synthesize_demo_png() {
python3 - <<'PY'
import base64
import os
from pathlib import Path
import struct
import zlib

def create_test_png(w=64, h=64, color=(0, 160, 255, 255)):
    png = b'\x89PNG\r\n\x1a\n'
    ihdr_data = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    ihdr_crc = struct.pack('>I', zlib.crc32(b'IHDR' + ihdr_data) & 0xffffffff)
    png += struct.pack('>I', len(ihdr_data)) + b'IHDR' + ihdr_data + ihdr_crc
    
    raw_rows = bytearray()
    for y in range(h):
        raw_rows.append(0)  # filter type: None
        for x in range(w):
            if (x < w // 2 and y < h // 2) or (x >= w // 2 and y >= h // 2):
                raw_rows.extend([color[0], color[1], color[2], color[3]])
            else:
                raw_rows.extend([255, 255, 255, 255])
    
    idat_data = zlib.compress(bytes(raw_rows))
    idat_crc = struct.pack('>I', zlib.crc32(b'IDAT' + idat_data) & 0xffffffff)
    png += struct.pack('>I', len(idat_data)) + b'IDAT' + idat_data + idat_crc
    
    iend_crc = struct.pack('>I', zlib.crc32(b'IEND') & 0xffffffff)
    png += struct.pack('>I', 0) + b'IEND' + iend_crc
    return png

runtime_dir = Path(os.environ["SCENE_RUNTIME_DIR"])
runtime_dir.mkdir(parents=True, exist_ok=True)
png_bytes = create_test_png(64, 64)

demo_dir = Path("/sandbox/home/demo/src")
demo_dir.mkdir(parents=True, exist_ok=True)
png_path = demo_dir / "architecture.png"
png_path.write_bytes(png_bytes)
print(f"Synthesized demo PNG: {png_path} ({len(png_bytes)} bytes)")
PY
}

synthesize_demo_png

# Drive composer interactions: idle, typed-draft, model-picker, slash-palette
source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Model Selection ──────────────────────────────────────────────────────────
k "ctrl+shift+m"
pause 0.3
t "local/qwen2.5-1.5b"
pause 0.4
k "Return"
pause 0.5
shot model-selected

# ─── Prompt Submission with PNG Attachment ────────────────────────────────────
move_px "$((WIN_X + WIN_W / 2))" "$((WIN_Y + WIN_H - 98))"
click
k "ctrl+a"
pause 0.2
k "BackSpace"
pause 0.3

# Type /attach in composer and submit prompt with file attachment mention
t "/attach"
pause 0.5
k "Return"
pause 0.4
t "Examine @src/architecture.png and state its structure in one short sentence. Do not call tools."
k "Return"
if ! native_session_ready finished 2; then
	abandon_take "native-artifact-turn-produced" "turn with attachment did not produce completed transcript within 90s"
fi

pause 0.8
# The transcript displays the user turn with prompt text and collapsed image artifact block
shot artifact-user-image-collapsed

# ─── Expand Transcript Artifact Disclosure ────────────────────────────────────
# Click the collapsed artifact row in the transcript column
# Titlebar = 52px, queue width ~256px, transcript column width = 768px
ARTIFACT_CLICK_X=$((WIN_X + 256 + (WIN_W - 256 - 768) / 2 + 384))
if (( WIN_W < 980 )); then
	ARTIFACT_CLICK_X=$((WIN_X + WIN_W / 2))
fi
ARTIFACT_CLICK_Y=$((WIN_Y + 52 + 88))

move_px "${ARTIFACT_CLICK_X}" "${ARTIFACT_CLICK_Y}"
pause 0.3
click
pause 0.8
# Capture expanded image artifact view with decoded PNG rendering & metadata
shot artifact-user-image-expanded

# ─── Re-collapse the Artifact Disclosure ──────────────────────────────────────
move_px "${ARTIFACT_CLICK_X}" "${ARTIFACT_CLICK_Y}"
pause 0.3
click
pause 0.8
shot artifact-user-image-recollapsed

# ─── Second Turn with File Inspection ─────────────────────────────────────────
move_px "$((WIN_X + WIN_W / 2))" "$((WIN_Y + WIN_H - 98))"
click
t "Inspect src/parser.ts and state what it exports in one sentence. Do not call tools."
k "Return"

if ! native_session_ready finished 4; then
	abandon_take "native-second-turn-completed" "second turn did not complete within 90s"
fi

pause 0.6
shot transcript-second-turn

# ─── Contextual File Panel Transitions ────────────────────────────────────────
PANEL_OVERLAY_BREAKPOINT="$(python3 -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["right_panel"]["overlay_breakpoint_px"])' "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens/surface/panels.toml")"
if (( WIN_W < PANEL_OVERLAY_BREAKPOINT )); then
	k "ctrl+backslash"
	pause 0.5
fi

# Toggle contextual file panel open
k "ctrl+backslash"
pause 0.6
shot contextual-file-panel-open

# Toggle contextual file panel closed
k "ctrl+backslash"
pause 0.6
shot contextual-file-panel-closed

# Restore contextual file panel open
k "ctrl+backslash"
pause 0.6
