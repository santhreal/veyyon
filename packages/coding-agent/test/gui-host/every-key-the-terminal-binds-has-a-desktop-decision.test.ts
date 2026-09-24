/**
 * WHY: a terminal keybinding is a verb, not a chord. `app.history.search`
 * recalled a prompt submitted earlier and nothing on the desktop did, because
 * the two keymaps were written independently and nothing compared them. The
 * defect is a verb one host offers and the other does not, found only when
 * somebody reaches for it.
 *
 * THE CLASS THIS CLOSES: an undecided verb. The sweep is over `KEYBINDINGS` at
 * run time, so a keybinding added to the terminal turns this red until a
 * decision is recorded for it, and the gaps are pinned by exact equality, so
 * closing one is a change somebody makes on purpose rather than a count that
 * drifts. A decision naming a desktop chord is checked against the keymap the
 * desktop ships, so it cannot name a chord that is not bound.
 *
 * WHAT IT DOES NOT CATCH: whether the desktop surface a decision names behaves
 * the way the terminal's does. A decision naming a host action is checked
 * against `ALL_HOST_ACTIONS`; a decision naming a window-local surface is a
 * claim this process cannot verify, and the desktop's own suites drive those.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { KEYBINDINGS } from "../../src/config/keybinding-defs";
import { ALL_HOST_ACTIONS, type HostActionTag } from "../../src/gui-host/wire";

/** How the desktop reaches one verb the terminal binds a key to. */
type Decision =
	/** A chord the desktop keymap binds, named by its action. */
	| { chord: string }
	/** The window sends this host action, from a control or a palette row. */
	| { action: HostActionTag }
	/** The window answers it alone: navigation, a local selection, its editor. */
	| { client: string }
	/** The verb exists because a terminal can be corrupted or suspended. */
	| { terminalOnly: string }
	/** No desktop surface reaches it yet. */
	| { gap: string };

const DECISIONS: Record<string, Decision> = {
	"app.agents.hub": { client: "SurfaceRoute::Agents, from the /agents palette row" },
	"app.bash.background": { action: "BackgroundCommand" },
	"app.clear": { action: "ClearOutput" },
	"app.clipboard.copyLine": { chord: "CopySelection" },
	"app.clipboard.copyPrompt": { gap: "no window control copies the composer's draft" },
	"app.clipboard.pasteImage": {
		client: "the composer's own paste, which attaches each image the clipboard holds",
	},
	"app.clipboard.pasteTextRaw": { client: "the window's own text field, which pastes what the clipboard holds" },
	"app.display.reset": { terminalOnly: "redraws a terminal whose screen state was corrupted" },
	"app.editor.external": { gap: "the draft cannot be opened in an external editor and read back" },
	"app.exit": { chord: "Quit" },
	"app.history.search": { chord: "PromptHistory" },
	"app.interrupt": { chord: "AbortTurn" },
	"app.message.dequeue": { chord: "TakeBackQueuedPrompt" },
	"app.message.followUp": { action: "FollowUp" },
	"app.model.cycleBackward": { gap: "the catalogue is chosen from, never stepped through" },
	"app.model.cycleForward": { gap: "the catalogue is chosen from, never stepped through" },
	"app.model.select": { chord: "ModelPicker" },
	"app.model.selectTemporary": { client: "the model row taken without persisting, from PaletteState::models" },
	"app.plan.toggle": { action: "SetSessionMode" },
	"app.retry": { action: "RetryTurn" },
	"app.session.fork": { action: "BranchSession" },
	"app.session.new": { chord: "NewSession" },
	"app.session.observe": { gap: "a session running elsewhere cannot be watched from this window" },
	"app.session.resume": { action: "SearchSessions" },
	"app.session.tree": { client: "the queue rail's indented, collapsible branch tree" },
	"app.stt.toggle": { chord: "ToggleDictation" },
	"app.suspend": { terminalOnly: "stops the process and returns the shell its terminal" },
	"app.thinking.cycle": { chord: "ThinkingLevel" },
	"app.thinking.toggle": { client: "the same cycle, which walks every level the host reports for the model" },
	"app.tools.expand": { action: "SetToolViewExpanded" },
};

/** The verbs with no desktop surface, as they stand. */
const RECORDED_GAPS = [
	"app.clipboard.copyPrompt",
	"app.editor.external",
	"app.model.cycleBackward",
	"app.model.cycleForward",
	"app.session.observe",
];

/**
 * The window draws its own text field, so every `tui.*` binding — cursor
 * motion, deletion, undo, the kill ring, selection movement — is answered by
 * that field rather than by a chord this table would name. They are decided
 * as one class rather than restated one by one.
 */
const EDITOR_PREFIX = "tui.";

const KEYMAP_TOML = path.join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"..",
	"crates",
	"veyyon-desktop-surface",
	"keymap.toml",
);

/** The action names the desktop's shipped keymap binds a chord to. */
function boundActions(): Set<string> {
	const toml = fs.readFileSync(KEYMAP_TOML, "utf8");
	const bound = new Set<string>();
	for (const line of toml.split("\n")) {
		const match = /^\s*action\s*=\s*"([^"]+)"/.exec(line);
		if (match?.[1]) bound.add(match[1]);
	}
	return bound;
}

const TERMINAL_VERBS = Object.keys(KEYBINDINGS)
	.filter(id => !id.startsWith(EDITOR_PREFIX))
	.sort();

describe("every key the terminal binds has a desktop decision", () => {
	test("each verb the terminal binds is decided, and only those are", () => {
		expect(Object.keys(DECISIONS).sort()).toEqual(TERMINAL_VERBS);
	});

	test("a decision naming a desktop chord names one the shipped keymap binds", () => {
		const bound = boundActions();
		const named = Object.entries(DECISIONS).flatMap(([id, decision]) =>
			"chord" in decision ? [[id, decision.chord] as const] : [],
		);
		expect(named.length).toBeGreaterThan(0);
		expect(named.filter(([, action]) => !bound.has(action))).toEqual([]);
	});

	test("a decision naming a host action names one the protocol carries", () => {
		const named = Object.entries(DECISIONS).flatMap(([id, decision]) =>
			"action" in decision ? [[id, decision.action] as const] : [],
		);
		expect(named.length).toBeGreaterThan(0);
		const carried = ALL_HOST_ACTIONS as readonly string[];
		expect(named.filter(([, action]) => !carried.includes(action))).toEqual([]);
	});

	test("the verbs with no desktop surface are exactly the recorded gaps", () => {
		const gaps = Object.entries(DECISIONS)
			.filter(([, decision]) => "gap" in decision)
			.map(([id]) => id)
			.sort();
		expect(gaps).toEqual(RECORDED_GAPS);
	});

	test("recalling a prompt submitted earlier is bound on both hosts", () => {
		expect(KEYBINDINGS["app.history.search"]).toBeDefined();
		expect(boundActions().has("PromptHistory")).toBe(true);
	});

	test("a text-editing key is answered by the window's own field, not by a chord", () => {
		const editorKeys = Object.keys(KEYBINDINGS).filter(id => id.startsWith(EDITOR_PREFIX));
		expect(editorKeys.length).toBeGreaterThan(0);
		expect(editorKeys.filter(id => id in DECISIONS)).toEqual([]);
	});
});
