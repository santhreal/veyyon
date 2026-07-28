/**
 * The keybinding TABLE, with nothing that reads a file.
 *
 * This is a leaf on purpose. `config/keybindings.ts` owns the manager, the
 * `keybindings.yml` loader and the legacy-name migration, so it reaches yaml,
 * atomic writes, the quarantine path and the profile resolver. A UI component
 * that only needs to know what a key does by default should not drag all of that
 * in at import time, and before this split the alternative was to keep a SECOND
 * copy of the defaults next to the component: `custom-editor.ts` had one, twenty
 * ids restated by hand, and it had already drifted (`app.clipboard.pasteImage`
 * was pinned to `ctrl+v`, so the Windows `alt+v` and macOS `super+v` fallbacks
 * were missing from it).
 *
 * One table, two importers, no drift. `config/keybindings.ts` re-exports
 * everything here, so nothing that already imported from there has to change.
 */
import type { KeybindingDefinitions, KeyId } from "@veyyon/tui";
import { TUI_KEYBINDINGS } from "@veyyon/tui";


/**
 * Application-level keybindings (coding agent specific).
 * Values are always `true` — used for declaration merging.
 */
interface AppKeybindings {
	"app.interrupt": true;
	"app.clear": true;
	"app.exit": true;
	"app.suspend": true;
	"app.display.reset": true;
	"app.thinking.cycle": true;
	"app.thinking.toggle": true;
	"app.model.cycleForward": true;
	"app.model.cycleBackward": true;
	"app.model.select": true;
	"app.model.selectTemporary": true;
	"app.tools.expand": true;
	"app.editor.external": true;
	"app.message.followUp": true;
	"app.retry": true;
	"app.message.dequeue": true;
	"app.clipboard.pasteImage": true;
	"app.clipboard.pasteTextRaw": true;
	"app.clipboard.copyLine": true;
	"app.clipboard.copyPrompt": true;
	"app.agents.hub": true;
	"app.session.new": true;
	"app.session.tree": true;
	"app.session.fork": true;
	"app.session.resume": true;
	"app.session.observe": true;
	"app.plan.toggle": true;
	"app.history.search": true;
	"app.stt.toggle": true;
	"app.bash.background": true;
}

export type AppKeybinding = keyof AppKeybindings;

declare module "@veyyon/tui" {
	interface Keybindings extends AppKeybindings {}
}

/**
 * Resolve default image-paste shortcuts for the current terminal platform.
 */
export function getDefaultPasteImageKeys(platform: NodeJS.Platform = process.platform): KeyId[] {
	if (platform === "win32") return ["ctrl+v", "alt+v"];
	if (platform === "darwin") return ["ctrl+v", "super+v"];
	return ["ctrl+v"];
}

/**
 * All keybindings definitions: TUI + app-specific.
 */
export const KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"app.interrupt": {
		defaultKeys: "escape",
		description: "Interrupt current operation",
	},
	"app.clear": {
		defaultKeys: "ctrl+c",
		description: "Clear screen or cancel",
	},
	"app.exit": {
		defaultKeys: "ctrl+d",
		description: "Exit application",
	},
	"app.suspend": {
		defaultKeys: "ctrl+z",
		description: "Suspend application",
	},
	"app.bash.background": {
		defaultKeys: "ctrl+b",
		description: "Move the running foreground command to a background job",
	},
	"app.display.reset": {
		defaultKeys: "ctrl+l",
		description: "Reset terminal display",
	},
	"app.thinking.cycle": {
		defaultKeys: "shift+tab",
		description: "Cycle thinking level",
	},
	"app.thinking.toggle": {
		defaultKeys: "ctrl+t",
		description: "Toggle thinking mode",
	},
	"app.model.cycleForward": {
		defaultKeys: "ctrl+p",
		description: "Cycle to next model",
	},
	"app.model.cycleBackward": {
		defaultKeys: "shift+ctrl+p",
		description: "Cycle to previous model",
	},
	"app.model.select": {
		defaultKeys: "alt+m",
		description: "Select model",
	},
	"app.model.selectTemporary": {
		defaultKeys: "alt+p",
		description: "Select temporary model for current session",
	},
	"app.tools.expand": {
		defaultKeys: "ctrl+o",
		description: "Expand tools",
	},
	"app.editor.external": {
		defaultKeys: "ctrl+g",
		description: "Open external editor",
	},
	"app.message.followUp": {
		// Ctrl+Enter is preserved for terminals that deliver it (Kitty/iTerm2/WezTerm/Ghostty),
		// but Windows Terminal does not emit a distinct event for Ctrl+Enter — Ctrl+Q is listed
		// first so the default binding works there without remapping (#1903).
		defaultKeys: ["ctrl+q", "ctrl+enter"],
		description: "Send follow-up message",
	},
	"app.retry": {
		defaultKeys: "alt+r",
		description: "Retry last failed assistant turn",
	},
	"app.message.dequeue": {
		defaultKeys: "alt+up",
		description: "Dequeue message",
	},
	"app.clipboard.pasteImage": {
		defaultKeys: getDefaultPasteImageKeys(),
		description: "Paste image or text from clipboard",
	},
	"app.clipboard.pasteTextRaw": {
		defaultKeys: ["ctrl+shift+v", "alt+shift+v"],
		description: "Paste text from clipboard as raw text (no collapse)",
	},
	"app.clipboard.copyLine": {
		defaultKeys: "alt+shift+l",
		description: "Copy current line",
	},
	"app.clipboard.copyPrompt": {
		defaultKeys: "alt+shift+c",
		description: "Copy prompt",
	},
	"app.session.new": {
		defaultKeys: [],
		description: "Create new session",
	},
	"app.session.tree": {
		defaultKeys: [],
		description: "Show session tree",
	},
	"app.session.fork": {
		defaultKeys: [],
		description: "Fork session",
	},
	"app.session.resume": {
		defaultKeys: [],
		description: "Resume session",
	},
	"app.agents.hub": {
		defaultKeys: "alt+a",
		description: "Open the Agent Control Center",
	},
	// Two chords, one screen. `app.session.observe` was bound to a separate
	// observation view; it opens the same card, and both close it again, so the
	// key you opened it with is the key that dismisses it.
	"app.session.observe": {
		defaultKeys: "ctrl+s",
		description: "Open the Agent Control Center",
	},
	// SEVEN IDS USED TO SIT HERE AND NOTHING READ ANY OF THEM. `app.session.rename`,
	// `togglePath`, `toggleSort` and `deleteNoninvasive` named actions the session
	// selector does not have; `app.tree.foldOrUp`/`unfoldOrDown` named a tree it does
	// not implement; and `app.session.delete` names one it DOES have, except the
	// selector matches the literal `delete`/`backspace` keys rather than reading a
	// binding, so remapping it did nothing. A dead entry here is not inert: every id
	// is advertised to the user by `/hotkeys` and by the generated `keybindings.yml`,
	// so `toggleSort` told them ctrl+s sorts the session list when ctrl+s opens the
	// Agent Control Center (`app.session.observe`, same default key, right below).
	// `every-keybinding-id-is-read-by-something.test.ts` fails if another one appears.
	"app.plan.toggle": {
		defaultKeys: "alt+shift+p",
		description: "Toggle plan mode",
	},
	"app.history.search": {
		defaultKeys: "ctrl+r",
		description: "Search history",
	},
	"app.stt.toggle": {
		defaultKeys: [],
		description: "Toggle speech-to-text (default gesture: hold Space)",
	},
} as const satisfies KeybindingDefinitions;
