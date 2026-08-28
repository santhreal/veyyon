import type { KeybindingDefinitions, KeyId } from "@veyyon/tui";
import { TUI_KEYBINDINGS } from "@veyyon/tui";

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

export function getDefaultPasteImageKeys(platform: NodeJS.Platform = process.platform): KeyId[] {
	if (platform === "win32") return ["ctrl+v", "alt+v"];
	if (platform === "darwin") return ["ctrl+v", "super+v"];
	return ["ctrl+v"];
}

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
	"app.session.observe": {
		defaultKeys: "ctrl+s",
		description: "Open the Agent Control Center",
	},
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
