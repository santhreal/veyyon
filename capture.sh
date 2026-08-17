#!/usr/bin/env bash
# capture.sh <tape-file> <out-name>
# Runs a vhs tape, writes proof/captures/<out-name>.gif, and extracts the last
# frame as proof/captures/<out-name>.png. Tapes must already Hide the boot
# sequence and end on the state to capture.
set -euo pipefail
cd "$(dirname "$0")"
tape="$1"; name="$2"
timeout 220 vhs "$tape" >/dev/null 2>&1
ffmpeg -y -loglevel error -i "proof/captures/${name}.gif" -update 1 "proof/captures/${name}.png"
echo "captured ${name}"
