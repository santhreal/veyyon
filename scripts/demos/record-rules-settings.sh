#!/usr/bin/env bash
#
# The settings differential for the rules section index: the Experimental section
# with nothing opted in, and the same screen with `argot-load-nudge` named in
# `ttsr.experimentalRules`.
#
# `ttsr.experimentalRules` is a PERSISTED setting, so the pair is captured across
# two launches against two seeded config files rather than by pressing a toggle in
# one session: the question the proof answers is whether a value written to config
# reaches the screen at all, and an in-session capture cannot answer it.
#
# Both states come out of one run so they can never drift apart, and the run fails
# if the two frames are byte-identical — a degenerate pair is a failed proof, not a
# proof that the setting has no visible effect.
#
# Usage:
#     bash scripts/demos/record-rules-settings.sh
#
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
assets="$root/assets"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# One geometry for every frame here, so the off/on pair and the two levels are read
# side by side. Tall enough that the longest section shows all twelve of its rules
# AND the footer under them: the footer is where "Esc for sections" is stated, which
# is the part of the drill-in a reader has no other way to discover.
width=110
height=34

mkdir -p "$work/off" "$work/on"
printf 'ttsr:\n  experimentalRules: []\n' >"$work/off/config.yml"
printf 'ttsr:\n  experimentalRules:\n    - argot-load-nudge\n' >"$work/on/config.yml"

for state in off on; do
	bun "$root/scripts/demos/render-settings-rules-tab.ts" \
		--tab rules --open Rules --agent-dir "$work/$state" \
		--width "$width" --height "$height" |
		bun "$root/scripts/demos/render-proof.ts" \
			--out "$assets/rules-experimental-$state" --width "$width" --scale 2
done

for ground in grey black; do
	if cmp -s "$assets/rules-experimental-off-$ground.png" "$assets/rules-experimental-on-$ground.png"; then
		echo "degenerate pair on the $ground ground: the two frames are identical" >&2
		exit 1
	fi
done

# The two levels the list now has. The drill-in is a separate screen rather than a
# scrolled position in the same one, so a capture of the index says nothing about
# what Enter reaches; the renderer itself refuses to write this frame if it is still
# sitting on the index.
bun "$root/scripts/demos/render-settings-rules-tab.ts" \
	--tab rules --open Rules --section TypeScript --agent-dir "$work/off" \
	--width "$width" --height "$height" |
	bun "$root/scripts/demos/render-proof.ts" \
		--out "$assets/rules-section-typescript" --width "$width" --scale 2

echo "wrote $assets/rules-experimental-{off,on}-{grey,black}.png"
echo "wrote $assets/rules-section-typescript-{grey,black}.png"
