#!/usr/bin/env bash
# capture.sh <tape-file> <out-name>
# Runs a vhs tape, writes .captures/<out-name>.gif, and extracts the last
# frame as .captures/<out-name>.png. Tapes must already Hide the boot
# sequence and end on the state to capture.
set -euo pipefail
cd "$(dirname "$0")"
tape="$1"; name="$2"
mkdir -p .captures
timeout 220 vhs "$tape" >/dev/null 2>&1
ffmpeg -y -loglevel error -i ".captures/${name}.gif" -update 1 ".captures/${name}.png"
echo "captured ${name}"
