import type { Keybinding } from "@veyyon/tui";
import type { KeybindingsManager } from "../../config/keybindings";

export interface HotkeysMarkdownBindings {
	keybindings: Pick<KeybindingsManager, "getDisplayString">;
}

/**
 * The live chord for an action, or `Disabled` when the user unbound it.
 *
 * This takes the whole `Keybinding` union rather than only the `app.*` half. The
 * editor and composer rows used to hardcode their chords, so `/hotkeys` printed
 * `Ctrl+U` at a user who had rebound `tui.editor.deleteToLineStart` to something
 * else, in a panel whose entire purpose is showing what the keys are RIGHT NOW.
 */
function key(bindings: HotkeysMarkdownBindings, action: Keybinding): string {
	return bindings.keybindings.getDisplayString(action) || "Disabled";
}

export function buildHotkeysMarkdown(bindings: HotkeysMarkdownBindings): string {
	return [
		"**Navigation**",
		"| Key | Action |",
		"|-----|--------|",
		"| `Arrow keys` | Move cursor / browse history (Up when empty) |",
		`| \`${key(bindings, "tui.editor.cursorWordLeft")}\` / \`${key(bindings, "tui.editor.cursorWordRight")}\` | Move by word |`,
		`| \`${key(bindings, "tui.editor.cursorLineStart")}\` | Start of line |`,
		`| \`${key(bindings, "tui.editor.cursorLineEnd")}\` | End of line |`,
		"",
		"**Editing**",
		"| Key | Action |",
		"|-----|--------|",
		`| \`${key(bindings, "tui.input.submit")}\` | Send message |`,
		`| \`${key(bindings, "tui.input.newLine")}\` / \`Alt+Enter\` | New line |`,
		`| \`${key(bindings, "tui.editor.deleteWordBackward")}\` | Delete word backwards |`,
		`| \`${key(bindings, "tui.editor.deleteToLineStart")}\` | Delete to start of line |`,
		`| \`${key(bindings, "tui.editor.deleteToLineEnd")}\` | Delete to end of line |`,
		`| \`${key(bindings, "app.clipboard.copyLine")}\` | Copy current line |`,
		`| \`${key(bindings, "app.clipboard.copyPrompt")}\` | Copy whole prompt |`,
		"",
		"**Other**",
		"| Key | Action |",
		"|-----|--------|",
		`| \`${key(bindings, "tui.input.tab")}\` | Path completion / accept autocomplete |`,
		`| \`${key(bindings, "app.interrupt")}\` | Cancel autocomplete / interrupt active work |`,
		`| \`${key(bindings, "app.clear")}\` | Clear editor (first) / exit (second) |`,
		`| \`${key(bindings, "app.exit")}\` | Exit (when editor is empty) |`,
		`| \`${key(bindings, "app.suspend")}\` | Suspend to background |`,
		`| \`${key(bindings, "app.bash.background")}\` | Move the running foreground command to a background job |`,
		`| \`${key(bindings, "app.display.reset")}\` | Reset terminal display |`,
		`| \`${key(bindings, "app.thinking.cycle")}\` | Cycle thinking level |`,
		`| \`${key(bindings, "app.model.cycleForward")}\` | Cycle role models (slow/default/smol) |`,
		`| \`${key(bindings, "app.model.cycleBackward")}\` | Cycle role models (backward) |`,
		`| \`${key(bindings, "app.model.selectTemporary")}\` | Select model (temporary) |`,
		`| \`${key(bindings, "app.model.select")}\` | Select model (set roles) |`,
		`| \`${key(bindings, "app.plan.toggle")}\` | Toggle plan mode |`,
		`| \`${key(bindings, "app.history.search")}\` | Search prompt history |`,
		`| \`${key(bindings, "app.tools.expand")}\` | Toggle tool output expansion |`,
		`| \`${key(bindings, "app.thinking.toggle")}\` | Toggle thinking block visibility |`,
		`| \`${key(bindings, "app.editor.external")}\` | Edit message in external editor |`,
		`| \`${key(bindings, "app.retry")}\` | Retry last failed assistant turn |`,
		`| \`${key(bindings, "app.clipboard.pasteImage")}\` | Paste image or text from clipboard |`,
		"| Hold `Space` | Speech-to-text (push-to-talk): hold to record, release to transcribe |",
		`| \`${key(bindings, "app.agents.hub")}\` / \`${key(bindings, "app.session.observe")}\` / double-tap \`←\` (empty editor) | Open the Agent Control Center |`,
		"| `#<number>` | GitHub issue/PR reference (e.g. `#3164` → `pr://`/`issue://`) |",
		"| `#` / `#<text>` | Prompt actions (copy / undo / move cursor) |",
		"| `/` | Slash commands |",
		"| `!` | Run bash command |",
		"| `!!` | Run bash command (excluded from context) |",
		"| `$` | Run Python in shared kernel |",
		"| `$$` | Run Python (excluded from context) |",
	].join("\n");
}
