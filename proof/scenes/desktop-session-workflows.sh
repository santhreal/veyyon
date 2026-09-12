#!/usr/bin/env bash
# Native history, file drafts, tab membership and named spaces.
# Run through proof/docker/record-native.sh with a fresh OUT_DIR for each arm.
# State changes use the window; persisted documents are read only as assertions.
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

WORKFLOW_DIR="${TMPDIR}/session-workflows"
mkdir -p "${WORKFLOW_DIR}"
export WORKFLOW_DIR
WORKFLOW_DRAFT="Review the attached project notes before sending."
WORKFLOW_FILE="${WORKFLOW_DIR}/project-notes.txt"
printf 'Project notes\nThe sample total is 37.\n' > "${WORKFLOW_FILE}"
export WORKFLOW_DRAFT WORKFLOW_FILE

# The titlebar precedes the space row and the session-tab row.
SPACE_Y=$(( WIN_Y + TITLEBAR_H + TITLEBAR_H / 2 ))
TAB_Y=$(( WIN_Y + 2 * TITLEBAR_H + TITLEBAR_H / 2 ))
CLOSE_CROP="${WIN_W}x${TITLEBAR_H}+${WIN_X}+$(( WIN_Y + 3 * TITLEBAR_H ))"
BODY_CROP="${SESSION_REGION_W}x$(( WIN_H - 3 * TITLEBAR_H ))+${SESSION_REGION_X}+$(( WIN_Y + 3 * TITLEBAR_H ))"
read -r HISTORY_W HISTORY_H < <(
python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens/surface/settings.toml" "${WIN_W}" "${WIN_H}" "${TITLEBAR_H}" "${GUTTER_PX}" <<'PY'
from pathlib import Path
import sys
import tomllib

layout = tomllib.loads(Path(sys.argv[1]).read_text())['layout']
width, height, titlebar, margin = map(int, sys.argv[2:])
print(int(min(layout['group_width_px'], width - 2 * margin)),
      int(min(layout['sheet_height_px'], height - 3 * titlebar - 2 * margin)))
PY
)
if [ -z "${HISTORY_W:-}" ] || [ -z "${HISTORY_H:-}" ]; then
	abandon_take "history-geometry" "the shared history sheet dimensions were not resolved"
fi

workflow_state() { # <transition>
python3 - "$1" <<'PY'
import json
import os
from pathlib import Path
import sys
import time

mode = sys.argv[1]
root = Path(os.environ['WORKFLOW_DIR'])
state = Path(os.environ['TMPDIR']) / 'desktop-state'
deadline = time.monotonic() + 15
last = 'documents not written'
while time.monotonic() < deadline:
    try:
        shell = json.loads((state / 'shell.json').read_text())
        composers = json.loads((state / 'composer.json').read_text())
        nav = shell['navigation']
        active = next(space for space in nav['spaces'] if space['id'] == nav['active_space'])
        current = active['selected']
        draft = composers.get(current, {})
        original_path = root / 'original.json'
        original = json.loads(original_path.read_text()) if original_path.exists() else None
        if mode == 'attached':
            passed = (draft.get('draft_text') == os.environ['WORKFLOW_DRAFT'] and
                      draft.get('attachments') == [os.environ['WORKFLOW_FILE']])
            if passed:
                original_path.write_text(json.dumps({'session': current, 'space': active['id'],
                                                     'tabs': active['tabs'], 'draft': draft}))
        elif mode == 'second-tab':
            passed = (current != original['session'] and
                      len(active['tabs']) == len(original['tabs']) + 1 and
                      composers[original['session']] == original['draft'])
            if passed:
                (root / 'second.json').write_text(json.dumps({'session': current}))
        elif mode in ('tabs-reordered', 'tabs-order-restored'):
            second = json.loads((root / 'second.json').read_text())
            expected = ([second['session']] + original['tabs'] if mode == 'tabs-reordered'
                        else original['tabs'] + [second['session']])
            passed = (active['tabs'] == expected and current == second['session'] and
                      composers[original['session']] == original['draft'])
        elif mode == 'tab-closed':
            second = json.loads((root / 'second.json').read_text())
            expected = [tab for tab in original['tabs'] if tab != original['session']] + [second['session']]
            passed = (active['tabs'] == expected and current == second['session'] and
                      composers[original['session']] == original['draft'])
        elif mode == 'history-return':
            second = json.loads((root / 'second.json').read_text())
            passed = (current == second['session'] and composers[original['session']] == original['draft'])
        elif mode == 'space-created':
            passed = (active['id'] != original['space'] and active['tabs'] == [] and current is None)
        elif mode == 'space-renamed':
            passed = active['name'] == 'Research'
        elif mode == 'space-return':
            second = json.loads((root / 'second.json').read_text())
            passed = active['id'] == original['space'] and current == second['session']
        elif mode in ('draft-restored', 'close-cancelled'):
            passed = (current == original['session'] and
                      composers[current] == original['draft'] and
                      len(active['tabs']) == len(original['tabs']) + 1)
        else:
            raise RuntimeError(f'Unknown transition {mode}')
        last = json.dumps({'active': active, 'draft': draft})
        if passed:
            (root / f'{mode}.json').write_text(json.dumps({'shell': shell, 'composer': composers}, indent=2))
            print(f'scene: persisted {mode}')
            raise SystemExit(0)
    except (OSError, ValueError, KeyError, StopIteration) as error:
        last = str(error)
    time.sleep(0.1)
raise SystemExit(f'Workflow {mode} timed out: {last}')
PY
}

# Build history through a real completed provider turn, not injected transcript data.
submit_prompt "Reply with READY only."
if ! native_session_ready finished; then
	abandon_take "history-has-a-completed-turn" "the local provider did not complete the history source turn"
fi
python3 - <<'PY'
import json
import os
from pathlib import Path

runtime = Path(os.environ['TMPDIR'])
created = json.loads((runtime / 'created-session.json').read_text())
sessions = Path.home() / '.veyyon' / 'profiles' / (os.environ.get('VEYYON_PROFILE') or 'default') / 'agent' / 'sessions'
paths = list(sessions.rglob(f'*_{created}.jsonl'))
if len(paths) != 1:
    raise SystemExit(f'Expected one persisted history source, found {len(paths)}')
messages = []
with paths[0].open() as transcript:
    for line in transcript:
        message = json.loads(line).get('message', {})
        if message.get('role') in ('user', 'assistant'):
            content = message.get('content', [])
            text = content if isinstance(content, str) else ''.join(
                block.get('text', '') for block in content if block.get('type') == 'text')
            messages.append({'role': message['role'], 'text': text})
if not any(message == {'role': 'user', 'text': 'Reply with READY only.'} for message in messages):
    raise SystemExit('The typed history source prompt was not persisted')
if not any(message['role'] == 'assistant' and message['text'].strip() == 'READY' for message in messages):
    raise SystemExit(f'The provider did not persist the requested READY reply: {messages}')
(Path(os.environ['WORKFLOW_DIR']) / 'history-messages.json').write_text(json.dumps(messages, indent=2))
PY
shot workflow-completed-turn
# Keep the tab title deterministic through the native rename field.
move_px "$(( WIN_X + WIN_W / 3 ))" "$(( WIN_Y + TITLEBAR_H / 2 ))"
click
k "ctrl+a"
t "new session"
k "Return"
pause 0.5

# URI-list paste uses the production file adapter without a desktop portal.
type_prompt "${WORKFLOW_DRAFT}"
shot workflow-draft
python3 - "${WORKFLOW_FILE}" <<'PY' | xclip -selection clipboard -t text/uri-list -i
from pathlib import Path
import sys
print(Path(sys.argv[1]).as_uri(), end='\r\n')
PY
CLIPBOARD_TARGETS="$(xclip -selection clipboard -o -t TARGETS)"
case "${CLIPBOARD_TARGETS}" in
	*text/uri-list*) ;;
	*) abandon_take "uri-list-clipboard-ready" "clipboard does not offer text/uri-list" ;;
esac
xclip -selection clipboard -o -t text/uri-list > "${WORKFLOW_DIR}/clipboard-uri-list.txt"
k "ctrl+v"
workflow_state attached
pause 0.7
shot workflow-text-preview
probe_frame "${WORKFLOW_DIR}/attached.png"

k "ctrl+n"
workflow_state second-tab
pause 0.7
shot workflow-second-tab

workflow_drag_tab() {
	move_px "$1" "${TAB_Y}"
	xdotool mousedown 1
	move_px "$(( $1 + 2 * GUTTER_PX ))" "${TAB_Y}"
	pause 0.2
	move_px "$2" "${TAB_Y}"
	pause 0.2
	xdotool mouseup 1
}
workflow_drag_tab "$(( WIN_X + 29 * GUTTER_PX ))" "$(( WIN_X + 4 * GUTTER_PX ))"
workflow_state tabs-reordered
pause 0.4
shot workflow-tabs-reordered
workflow_drag_tab "$(( WIN_X + 4 * GUTTER_PX ))" "$(( WIN_X + 29 * GUTTER_PX ))"
workflow_state tabs-order-restored
pause 0.4
shot workflow-tabs-order-restored

# /history is activated from the real composer command palette.
type_prompt "/history" 100
k "Return"
pause 1.0
t "READY"
pause 1.0
shot workflow-history-list
probe_frame "${WORKFLOW_DIR}/history-list.png"
k "Return"
pause 1.0
shot workflow-history-preview
HISTORY_PIXELS="$(screen_differs_from_frame_pixels_at "${WORKFLOW_DIR}/history-list.png" "${BODY_CROP}")"
if [ "${HISTORY_PIXELS}" -lt 1200 ]; then
	abandon_take "history-preview-opened" "history selection changed only ${HISTORY_PIXELS} pixels"
fi
k "Escape"
pause 0.5
# Escape steps back to the list; a second Escape returns to the draft.
k "Escape"
pause 1.0
workflow_state history-return
shot workflow-history-return

# Resume the preview through its own control, then return to the second tab.
type_prompt "/history" 100
k "Return"
pause 1.0
k "ctrl+a"
t "READY"
pause 1.0
k "Return"
pause 1.0
move_px "$(( WIN_X + (WIN_W + HISTORY_W) / 2 - 4 * GUTTER_PX ))" \
	"$(( WIN_Y + 3 * TITLEBAR_H + (WIN_H - 3 * TITLEBAR_H - HISTORY_H) / 2 + 3 * GUTTER_PX ))"
click
workflow_state draft-restored
pause 0.7
HISTORY_RESUMED_PIXELS="$(screen_differs_from_frame_pixels_at "${WORKFLOW_DIR}/attached.png" "${COMPOSER_BAND_CROP}")"
if [ "${HISTORY_RESUMED_PIXELS}" -gt 300 ]; then
	abandon_take "history-resumed-input" "Resume session changed the saved input by ${HISTORY_RESUMED_PIXELS} pixels"
fi
shot workflow-history-resumed
move_px "$(( WIN_X + 29 * GUTTER_PX ))" "${TAB_Y}"
click
workflow_state history-return
pause 0.5

# The space-name field precedes the trailing New space button.
move_px "$(( WIN_X + WIN_W - 4 * GUTTER_PX ))" "${SPACE_Y}"
click
workflow_state space-created
pause 0.4
move_px "$(( WIN_X + WIN_W - 14 * GUTTER_PX ))" "${SPACE_Y}"
click
k "ctrl+a"
t "Research"
k "Return"
workflow_state space-renamed
shot workflow-named-space
move_px "$(( WIN_X + 4 * GUTTER_PX ))" "${SPACE_Y}"
click
workflow_state space-return
pause 0.6
shot workflow-space-return

# The first session tab is retained across both navigation transitions.
move_px "$(( WIN_X + 4 * GUTTER_PX ))" "${TAB_Y}"
click
workflow_state draft-restored
pause 0.7
shot workflow-draft-restored
RESTORED_PIXELS="$(frames_differ_pixels_at "${WORKFLOW_DIR}/attached.png" "${SCENE_OUT}/${SCENE_NAME}-workflow-draft-restored.png" "${COMPOSER_BAND_CROP}")"
if [ "${RESTORED_PIXELS}" -gt 300 ]; then
	abandon_take "the-draft-preview-restored" "restored composer differs by ${RESTORED_PIXELS} pixels from the original draft and attachment"
fi

# Tab close is adjacent to its title. Escape cancels the inline confirmation.
move_px "$(( WIN_X + 20 * GUTTER_PX ))" "${TAB_Y}"
click
pause 0.5
shot workflow-dirty-close
probe_frame "${WORKFLOW_DIR}/close-prompt.png"
k "Escape"
pause 0.5
workflow_state close-cancelled
shot workflow-close-cancelled
CANCEL_PIXELS="$(screen_differs_from_frame_pixels_at "${WORKFLOW_DIR}/close-prompt.png" "${CLOSE_CROP}")"
if [ "${CANCEL_PIXELS}" -lt 300 ]; then
	abandon_take "dirty-close-cancelled" "Escape changed only ${CANCEL_PIXELS} navigation pixels; no close confirmation was dismissed"
fi
echo "scene: history preview ${HISTORY_PIXELS}px, restored composer ${RESTORED_PIXELS}px, close cancellation ${CANCEL_PIXELS}px" >&2

# Quit through the product action, then reopen the same executable and state directory.
k "ctrl+q"
for _ in $(seq 1 60); do
	if ! xwininfo -id "${SCENE_WINDOW}" >/dev/null 2>&1; then break; fi
	pause 0.1
done
if xwininfo -id "${SCENE_WINDOW}" >/dev/null 2>&1; then
	abandon_take "native-window-quit" "the Quit action left the original window open"
fi
wait "${KITTY_PID}"
"${TMPDIR}/bootstrap.sh" >"${TMPDIR}/term-relaunch.log" 2>&1 &
KITTY_PID=$!
REOPENED=""
for _ in $(seq 1 60); do
	REOPENED="$(xdotool search --onlyvisible --pid "${KITTY_PID}" 2>/dev/null | tail -n 1 || true)"
	if [ -n "${REOPENED}" ]; then break; fi
	pause 0.25
done
if [ -z "${REOPENED}" ]; then
	abandon_take "native-window-reopened" "no viewable window appeared after relaunch"
fi
export SCENE_WINDOW="${REOPENED}"
# Match the recorder's initial placement before comparing window-relative input.
xdotool getwindowgeometry --shell "${SCENE_WINDOW}" > "${WORKFLOW_DIR}/relaunch-geometry-before.txt"
xdotool windowmove "${SCENE_WINDOW}" "${WIN_X}" "${WIN_Y}"
xdotool windowsize "${SCENE_WINDOW}" "${WIN_W}" "${WIN_H}"
xdotool getwindowgeometry --shell "${SCENE_WINDOW}" > "${WORKFLOW_DIR}/relaunch-geometry-after.txt"
xdotool windowfocus --sync "${SCENE_WINDOW}"
for _ in $(seq 1 60); do
	RELAUNCH_PIXELS="$(screen_differs_from_frame_pixels_at "${WORKFLOW_DIR}/attached.png" "${COMPOSER_BAND_CROP}")"
	if [ "${RELAUNCH_PIXELS}" -le 300 ]; then break; fi
	pause 0.25
done
workflow_state draft-restored
shot workflow-relaunch-restored
if [ "${RELAUNCH_PIXELS}" -gt 300 ]; then
	abandon_take "native-relaunch-restored-input" "reopened composer differs by ${RELAUNCH_PIXELS} pixels from the saved draft and attachment"
fi
echo "scene: reopened composer differs by ${RELAUNCH_PIXELS}px from the original input" >&2

# Confirm closing the dirty tab only after proving its restored input.
move_px "$(( WIN_X + 20 * GUTTER_PX ))" "${TAB_Y}"
click
pause 0.5
shot workflow-restored-close-prompt
move_px "$(( WIN_X + 64 * GUTTER_PX ))" "$(( WIN_Y + 3 * TITLEBAR_H + TITLEBAR_H / 2 ))"
click
workflow_state tab-closed
pause 0.7
shot workflow-close-confirmed
