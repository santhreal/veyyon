#!/usr/bin/env bash
# Record the rollback + post-update-hint UI proof across the theme/ground matrix.
#
# Two surfaces, three grounds each (per .veyyon/skills/ui):
#   assets/proof/rollback/hint-<ground>.png     the post-update tip-slot hint
#   assets/proof/rollback/picker-<ground>.png   the interactive /rollback picker
# Grounds: titanium/black (#000000), light/white (#FFFFFF), titanium/grey
# (#1e2127). The picker's version list is served from a local fixture registry
# so the shots are deterministic and offline.
#
# Run from the repo root:  bash scripts/demos/record-rollback-ui.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
FIXTURE_DIR="$REPO_ROOT/assets/tapes/rollback-fixture"
OUT_DIR="$REPO_ROOT/assets/proof/rollback"
mkdir -p "$OUT_DIR" "$FIXTURE_DIR"

# --- fixture registry: a deterministic packument for the picker -------------
cat > "$FIXTURE_DIR/packument.json" <<'JSON'
{
  "name": "@veyyon/coding-agent",
  "dist-tags": { "latest": "1.0.12" },
  "versions": {
    "0.9.0": {}, "1.0.0": {}, "1.0.5": {}, "1.0.9": {}, "1.0.10": {}, "1.0.11": {}, "1.0.12": {}
  },
  "time": {
    "0.9.0": "2026-01-02T10:00:00.000Z", "1.0.0": "2026-02-14T10:00:00.000Z",
    "1.0.5": "2026-04-01T10:00:00.000Z", "1.0.9": "2026-06-10T10:00:00.000Z",
    "1.0.10": "2026-06-28T10:00:00.000Z", "1.0.11": "2026-07-09T10:00:00.000Z",
    "1.0.12": "2026-07-18T10:00:00.000Z"
  }
}
JSON
cat > "$FIXTURE_DIR/server.ts" <<'TS'
const packument = await Bun.file(new URL("./packument.json", import.meta.url)).text();
Bun.serve({ port: 4873, fetch() { return new Response(packument, { headers: { "content-type": "application/json" } }); } });
TS

"$BUN" "$FIXTURE_DIR/server.ts" &
FIXTURE_PID=$!
trap 'kill "$FIXTURE_PID" 2>/dev/null || true' EXIT
sleep 1

# Ground matrix: name → terminal ground hex + a legible default foreground.
# veyyon auto-selects the light theme from the white ground's OSC 11 luminance.
grounds=(
  "black:#000000:#C6CBD4"
  "white:#FFFFFF:#1A1D23"
  "grey:#1e2127:#C6CBD4"
)

shoot() { # tape, ground_hex, fg_hex, out_png
  local tape="$1" ground="$2" fg="$3" out_png="$4"
  local tmp_tape gif
  tmp_tape="$(mktemp --suffix=.tape)"
  gif="$(mktemp --suffix=.gif)"
  sed -e "s|__GROUND__|$ground|g" -e "s|__FG__|$fg|g" \
      -e "s|__OUT_PNG__|$out_png|g" -e "s|__OUT_GIF__|$gif|g" \
      "$tape" > "$tmp_tape"
  rm -f "$out_png"
  vhs "$tmp_tape"
  rm -f "$tmp_tape" "$gif"
  [[ -f "$out_png" ]] || { echo "error: $tape did not produce $out_png" >&2; exit 1; }
  echo "wrote $out_png"
}

for entry in "${grounds[@]}"; do
  IFS=":" read -r name ground fg <<< "$entry"
  shoot assets/tapes/rollback-update-hint.tape "$ground" "$fg" "$OUT_DIR/hint-$name.png"
  shoot assets/tapes/rollback-picker.tape      "$ground" "$fg" "$OUT_DIR/picker-$name.png"
done

echo "done: rollback UI proof in $OUT_DIR"
