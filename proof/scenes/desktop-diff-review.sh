#!/usr/bin/env bash
# Record through proof/docker/record-native.sh on its container-private display.
# The host reads a tracked sandbox file; all review writes use native controls.
# Marks: review-empty, review-created, review-replied, review-resolved,
# review-reopened, review-relaunched, review-moved, review-orphaned.
set -Eeuo pipefail
REPO_DIR="${SCENE_CWD:?}"
export REPO_DIR
case "${REPO_DIR}" in /sandbox/*) ;; *) abandon_take "review-sandbox" "fixture repository is not recorder-owned" ;; esac
REVIEW_HELPER="${BASH_SOURCE[0]%/*}/native-review-probe.py"
REVIEW_DIR="${TMPDIR:?}/diff-review"
mkdir -p "${REVIEW_DIR}"
printf '*\n!ledger.rs\n!.gitignore\n' > "${REPO_DIR}/.gitignore"
printf 'fn ledger() {\nlet alpha = 1;\nlet bravo = 2;\nlet carol = 3;\nlet delta = 4;\n}\n' > "${REPO_DIR}/ledger.rs"
if [ ! -d "${REPO_DIR}/.git" ]; then git -C "${REPO_DIR}" init -q; fi
git -C "${REPO_DIR}" add -- .gitignore ledger.rs
git -C "${REPO_DIR}" -c user.name=santhreal -c user.email=64453045+santhreal@users.noreply.github.com \
	commit -q -m "Seed native review diff" -- .gitignore ledger.rs
printf 'fn ledger() {\nlet alpha = 11;\nlet bravo = 2;\nlet carol = 3;\nlet delta = 4;\n}\n' > "${REPO_DIR}/ledger.rs"

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"
trap 'shot review-failed' ERR
read -r REVIEW_ROW REVIEW_GUTTER REVIEW_HUNK REVIEW_TABS REVIEW_CHROME REVIEW_W REVIEW_H REVIEW_MARGIN < <(python3 "${REVIEW_HELPER}" geometry)
PANEL_LEFT=$(( WIN_X + WIN_W - PANEL_W + SHEET_INSET ))
PANEL_TOP=$(( WIN_Y + 3 * TITLEBAR_H + SHEET_INSET ))
REVIEW_BAR_Y=$(( PANEL_TOP + REVIEW_TABS + REVIEW_CHROME + REVIEW_CHROME / 2 ))
REVIEW_SCOPE_Y=$(( PANEL_TOP + REVIEW_TABS + REVIEW_CHROME / 2 ))
REVIEW_X=$(( PANEL_LEFT + REVIEW_GUTTER / 2 ))
REVIEW_Y=$(( PANEL_TOP + REVIEW_TABS + 3 * REVIEW_CHROME + REVIEW_HUNK + 3 * REVIEW_ROW + REVIEW_ROW / 2 ))

review_aim() { move_px "$1" "$2"; pause 0.2; click; pause 0.8; }
review_box() {
	local x=$(( $1 - WIN_X )) y=$(( $2 - WIN_Y ))
	if (( x + REVIEW_W > WIN_W - REVIEW_MARGIN && x - REVIEW_W >= REVIEW_MARGIN )); then x=$(( x - REVIEW_W )); fi
	if (( y + REVIEW_H > WIN_H - REVIEW_MARGIN && y - REVIEW_H >= REVIEW_MARGIN )); then y=$(( y - REVIEW_H )); fi
	if (( x + REVIEW_W > WIN_W - REVIEW_MARGIN )); then x=$(( WIN_W - REVIEW_MARGIN - REVIEW_W )); fi
	if (( y + REVIEW_H > WIN_H - REVIEW_MARGIN )); then y=$(( WIN_H - REVIEW_MARGIN - REVIEW_H )); fi
	POP_X=$(( WIN_X + x )); POP_Y=$(( WIN_Y + y ))
}
review_button() {
	local x y
	move_px "$(( WIN_X + WIN_W / 2 ))" "$(( WIN_Y + WIN_H - 10 ))"
	pause 0.5
	probe_frame "${REVIEW_DIR}/buttons.png"
	read -r x y < <(python3 "${REVIEW_HELPER}" buttons "${REVIEW_DIR}/buttons.png" "${POP_X}" "${POP_Y}" "${REVIEW_W}" "${REVIEW_H}" "$1")
	if [ -z "${x:-}" ] || [ -z "${y:-}" ]; then abandon_take "review-button-$1" "native button borders were not located"; fi
	review_aim "${x}" "${y}"
}
review_state() { python3 "${REVIEW_HELPER}" state "$1"; pause 0.5; }
review_open_list() {
	review_box "$(( PANEL_LEFT + 60 ))" "${REVIEW_BAR_Y}"
	review_aim "$(( PANEL_LEFT + 60 ))" "${REVIEW_BAR_Y}"
}
review_refresh() {
	k "Escape"
	review_aim "$(( PANEL_LEFT + 40 ))" "${REVIEW_SCOPE_Y}"
	pause 1.0
}

k "ctrl+backslash"
pause 1.2
review_aim "$(( PANEL_LEFT + 40 ))" "$(( PANEL_TOP + REVIEW_TABS / 2 ))"
shot review-empty
review_box "${REVIEW_X}" "${REVIEW_Y}"
review_aim "${REVIEW_X}" "${REVIEW_Y}"
if [ "${SCENE_ARM:-after}" = before ]; then
	# The same real line has no comment control in the baseline executable.
	shot review-created
	if [ -f "${TMPDIR}/desktop-state/reviews.json" ]; then
		abandon_take "review-before" "baseline unexpectedly wrote review state"
	fi
	return
fi
t "Check the changed total."
review_button post-new
review_state created
shot review-created
k "Escape"
review_open_list
review_button reply
t "The boundary case is covered."
review_button post-reply
review_state replied
shot review-replied
k "Escape"
review_open_list
review_button resolve
review_state resolved
shot review-resolved
k "Escape"
pause 0.8
shot review-resolved-count
review_open_list
review_button reopen
review_state reopened
shot review-reopened
k "Escape"
pause 0.8
shot review-unresolved-count

# Close only the recorder's native window and relaunch the same executable and
# state directory. No review document is seeded or rewritten by the scene.
k "ctrl+q"
CLOSED=0
for _ in $(seq 1 60); do
	if ! kill -0 "${KITTY_PID}" 2>/dev/null; then CLOSED=1; break; fi
	pause 0.2
done
if [ "${CLOSED}" != 1 ]; then abandon_take "review-relaunch" "native window process did not exit after close"; fi
wait "${KITTY_PID}" || true
"${TMPDIR}/bootstrap.sh" > "${REVIEW_DIR}/relaunch.log" 2>&1 &
KITTY_PID=$!
PLACED=0
for _ in $(seq 1 60); do
	SCENE_WINDOW="$(pick_window)"
	if [ -n "${SCENE_WINDOW}" ] && xdotool windowmove "${SCENE_WINDOW}" "${WIN_X}" "${WIN_Y}" 2>/dev/null \
		&& xdotool windowsize "${SCENE_WINDOW}" "${WIN_W}" "${WIN_H}" 2>/dev/null; then
		pause 0.3
		if xwininfo -id "${SCENE_WINDOW}" 2>/dev/null | grep -q 'IsViewable'; then PLACED=1; break; fi
	fi
	pause 0.2
done
if [ "${PLACED}" != 1 ]; then abandon_take "review-relaunch" "relaunched native window did not become viewable"; fi
export SCENE_WINDOW
xdotool windowfocus --sync "${SCENE_WINDOW}"
pause 1.5
review_state relaunched
review_aim "$(( PANEL_LEFT + 40 ))" "${REVIEW_SCOPE_Y}"
pause 1.0
review_open_list
probe_frame "${REVIEW_DIR}/restored-thread.png"
python3 "${REVIEW_HELPER}" buttons "${REVIEW_DIR}/restored-thread.png" "${POP_X}" "${POP_Y}" "${REVIEW_W}" "${REVIEW_H}" reply > "${REVIEW_DIR}/restored-thread-control.txt"
shot review-relaunched
probe_frame "${REVIEW_DIR}/before-move.png"

# Insert before the complete anchored context. Refresh through the existing
# Working tree control; the host must send the new diff to the native window.
printf '// first inserted line\n// second inserted line\nfn ledger() {\nlet alpha = 11;\nlet bravo = 2;\nlet carol = 3;\nlet delta = 4;\n}\n' > "${REPO_DIR}/ledger.rs"
review_refresh
review_open_list
review_state moved
shot review-moved
MOVED_PIXELS="$(screen_differs_from_frame_pixels_at "${REVIEW_DIR}/before-move.png" "${REVIEW_W}x160+${POP_X}+${POP_Y}")"
if [ "${MOVED_PIXELS}" -lt 5 ]; then abandon_take "review-moved" "native thread location did not redraw after line-number shift"; fi

# Changing the contextual line cannot transfer the existing comment to it.
printf '// first inserted line\n// second inserted line\nfn ledger() {\nlet alpha = 11;\nlet bravo = 99;\nlet carol = 3;\nlet delta = 4;\n}\n' > "${REPO_DIR}/ledger.rs"
review_refresh
review_state orphaned
review_open_list
shot review-orphaned
k "Escape"
pause 0.8
shot review-orphaned-count
printf '// first inserted line\n// second inserted line\nfn ledger() {\nlet alpha = 11;\nlet bravo = 2;\nlet carol = 3;\nlet delta = 4;\n}\n' > "${REPO_DIR}/ledger.rs"
review_aim "$(( PANEL_LEFT + 40 ))" "${REVIEW_SCOPE_Y}"
pause 1.0
review_state still-orphaned
review_open_list
shot review-still-orphaned
