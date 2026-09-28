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
 * drifts. A decision naming a desktop chord is checked against the bindings
 * `crates/veyyon-desktop-app/src/keymap.rs` ships, and one naming a palette
 * row against the actions `crates/veyyon-desktop-app/src/actions/registry.rs`
 * lists, both read at run time, so neither can name an action the window
 * does not offer.
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
	/** A chord the desktop keymap binds, named by its action (`namespace::Name`). */
	| { chord: string }
	/** A command palette row, named by the action it runs (`namespace::Name`). */
	| { palette: string }
	/** The window sends this host action, from a control or a palette row. */
	| { action: HostActionTag }
	/** The window answers it alone: navigation, a local selection, its editor. */
	| { client: string }
	/** The verb exists because a terminal can be corrupted or suspended. */
	| { terminalOnly: string }
	/** No desktop surface reaches it yet. */
	| { gap: string };

const DECISIONS: Record<string, Decision> = {
	"app.agents.hub": { client: "the right panel's Agents tab, from the Show agents palette row (/agents)" },
	"app.bash.background": { action: "BackgroundCommand" },
	"app.clear": { action: "ClearOutput" },
	"app.clipboard.copyLine": {
		client: "the composer field's own copy of its selection, and the copy control a hovered transcript entry draws",
	},
	"app.clipboard.copyPrompt": { chord: "composer::CopyDraft" },
	"app.clipboard.pasteImage": {
		client: "the composer's own paste, which attaches each image the clipboard holds",
	},
	"app.clipboard.pasteTextRaw": { client: "the window's own text field, which pastes what the clipboard holds" },
	"app.display.reset": { terminalOnly: "redraws a terminal whose screen state was corrupted" },
	"app.editor.external": { chord: "composer::EditDraftExternally" },
	"app.exit": { chord: "workspace::Quit" },
	"app.history.search": { palette: "composer::SearchHistory" },
	"app.interrupt": { chord: "composer::Stop" },
	"app.message.dequeue": { palette: "composer::TakeBackQueued" },
	"app.message.followUp": { action: "FollowUp" },
	"app.model.cycleBackward": { chord: "composer::PreviousModel" },
	"app.model.cycleForward": { chord: "composer::NextModel" },
	"app.model.select": { chord: "composer::OpenModelPicker" },
	"app.model.selectTemporary": { chord: "composer::OpenThreadModelPicker" },
	"app.plan.toggle": { action: "SetSessionMode" },
	"app.retry": { action: "RetryTurn" },
	"app.session.fork": { action: "BranchSession" },
	"app.session.new": { chord: "workspace::NewThread" },
	"app.session.observe": { client: "the agent dashboard `app.agents.hub` opens: the right panel's Agents tab" },
	"app.session.resume": { action: "SearchSessions" },
	"app.session.tree": { chord: "thread::ToggleSessionTree" },
	"app.stt.toggle": { palette: "composer::ToggleDictation" },
	"app.suspend": { terminalOnly: "stops the process and returns the shell its terminal" },
	"app.thinking.cycle": { chord: "composer::CycleThinkingLevel" },
	"app.thinking.toggle": { client: "the same cycle, which walks every level the host reports for the model" },
	"app.tools.expand": { action: "SetToolViewExpanded" },
};

/** The verbs with no desktop surface, as they stand. */
const RECORDED_GAPS: string[] = [];

/**
 * The window draws its own text field, so every `tui.*` binding — cursor
 * motion, deletion, undo, the kill ring, selection movement — is answered by
 * that field rather than by a chord this table would name. They are decided
 * as one class rather than restated one by one.
 */
const EDITOR_PREFIX = "tui.";

const APP_SRC = path.join(import.meta.dirname, "..", "..", "..", "..", "crates", "veyyon-desktop-app", "src");

/** The `namespace::Name` of every action `pattern` captures in one source file. */
function actionsIn(file: string, pattern: RegExp): Set<string> {
	const source = fs.readFileSync(path.join(APP_SRC, file), "utf8");
	const names = new Set<string>();
	for (const match of source.matchAll(pattern)) names.add(`${match[1]}::${match[2]}`);
	return names;
}

/** The actions the desktop's default keymap binds a chord to. */
const BOUND = actionsIn("keymap.rs", /bind::<(?:crate::actions::)?(\w+)::(\w+)>/g);

/** The actions the command palette lists a row for. */
const LISTED = actionsIn(path.join("actions", "registry.rs"), /entry::<(\w+)::(\w+)>/g);

const TERMINAL_VERBS = Object.keys(KEYBINDINGS)
	.filter(id => !id.startsWith(EDITOR_PREFIX))
	.sort();

describe("every key the terminal binds has a desktop decision", () => {
	test("each verb the terminal binds is decided, and only those are", () => {
		expect(Object.keys(DECISIONS).sort()).toEqual(TERMINAL_VERBS);
	});

	test("a decision naming a desktop chord names one the shipped keymap binds", () => {
		const named = Object.entries(DECISIONS).flatMap(([id, decision]) =>
			"chord" in decision ? [[id, decision.chord] as const] : [],
		);
		expect(named.length).toBeGreaterThan(0);
		expect(named.filter(([, action]) => !BOUND.has(action))).toEqual([]);
	});

	test("a decision naming a palette row names one the palette lists", () => {
		const named = Object.entries(DECISIONS).flatMap(([id, decision]) =>
			"palette" in decision ? [[id, decision.palette] as const] : [],
		);
		expect(named.length).toBeGreaterThan(0);
		expect(named.filter(([, action]) => !LISTED.has(action))).toEqual([]);
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

	test("recalling a prompt submitted earlier is reachable on both hosts", () => {
		expect(KEYBINDINGS["app.history.search"]).toBeDefined();
		expect(LISTED.has("composer::SearchHistory")).toBe(true);
	});

	test("a text-editing key is answered by the window's own field, not by a chord", () => {
		const editorKeys = Object.keys(KEYBINDINGS).filter(id => id.startsWith(EDITOR_PREFIX));
		expect(editorKeys.length).toBeGreaterThan(0);
		expect(editorKeys.filter(id => id in DECISIONS)).toEqual([]);
	});
});
