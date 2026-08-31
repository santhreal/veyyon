import { getKeybindings, type Keybinding, type KeyId, matchesKey } from "@veyyon/tui";
import { KEYBINDINGS } from "../../config/keybinding-defs";

/**
 * The chords to match for an action: the user's, or the shipped default.
 *
 * The fallback exists because some isolated component tests run with only the TUI
 * manager installed, which has no `app.*` ids at all, and a component that then
 * matched nothing would be untestable in isolation. It reads the SHIPPED table
 * rather than a literal written here: three of these matchers each restated their
 * own default (`escape`, `ctrl+g`, `["ctrl+enter", "ctrl+q"]`), so changing a
 * default in one place left the fallback on the old chord.
 *
 * An action the user deliberately unbound returns the shipped default here, which
 * is the one case this is wrong about, and it cannot be told apart: `getKeys`
 * answers an empty list both for "you unbound it" and for "this manager has never
 * heard of it". Interactive mode always installs the app manager, so in the
 * product the first branch is the one that runs.
 */
function effectiveKeys(action: Keybinding): readonly KeyId[] {
	const keys = getKeybindings().getKeys(action);
	return keys.length > 0 ? keys : [KEYBINDINGS[action].defaultKeys].flat();
}

/**
 * Match the coding-agent interrupt key.
 *
 * Interactive mode installs a keybinding manager that exposes `app.interrupt`
 * globally, but some isolated component tests still run with only TUI
 * keybindings registered. In that case, fall back to raw Escape matching.
 */
export function matchesAppInterrupt(data: string): boolean {
	return effectiveKeys("app.interrupt").some(key => matchesKey(data, key));
}

/** Match the generic selector cancel keybinding. */
export function matchesSelectCancel(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.cancel");
}

/** Match the generic selector up-navigation keybinding. */
export function matchesSelectUp(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.up");
}

/** Match the generic selector down-navigation keybinding. */
export function matchesSelectDown(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.down");
}

/** Match the generic selector page-up keybinding. */
export function matchesSelectPageUp(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.pageUp");
}

/** Match the generic selector page-down keybinding. */
export function matchesSelectPageDown(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.pageDown");
}

export function matchesAppExternalEditor(data: string): boolean {
	return effectiveKeys("app.editor.external").some(key => matchesKey(data, key));
}

function matchesEffectiveKey(data: string, key: KeyId): boolean {
	if ((key === "ctrl+enter" || key === "ctrl+return") && data.charCodeAt(0) === 10 && data.length > 1) {
		return true;
	}
	return matchesKey(data, key);
}

function matchesEffectiveKeys(data: string, keys: readonly KeyId[]): boolean {
	for (const key of keys) {
		if (matchesEffectiveKey(data, key)) return true;
	}
	return false;
}

/**
 * Match the "submit multi-line text input" keybinding (`app.message.followUp`).
 *
 * Used by forms where plain Enter inserts a newline and a modified-Enter chord
 * submits — the main editor's follow-up handler, the agent dashboard's new-agent
 * description, and the hook editor's hook-style mode. The keybinding defaults to
 * `["ctrl+q", "ctrl+enter"]` so Windows Terminal (which can't deliver a distinct
 * Ctrl+Enter event; #1903) still has a working chord without user remapping.
 *
 * Also recognizes modifier-tagged LF as Ctrl+Enter only when Ctrl+Enter is an
 * effective follow-up binding.
 */
export function matchesAppFollowUp(data: string): boolean {
	return matchesEffectiveKeys(data, effectiveKeys("app.message.followUp"));
}
