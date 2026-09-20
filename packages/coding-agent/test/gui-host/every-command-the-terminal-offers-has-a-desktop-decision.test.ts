/**
 * WHY: a command with `textMode: true` reaches the desktop by itself, because
 * the host advertises the catalogue and the palette lists it. A command
 * without it runs a terminal surface, so the desktop reaches it only if
 * somebody built one — and nothing said which of the 39 were built and which
 * were not. The defect is a terminal command that quietly exists on one host
 * and not the other.
 *
 * THE CLASS THIS CLOSES: an undecided command. The sweep is over
 * `BUILTIN_SLASH_COMMAND_DECLARATIONS` at run time, so a builtin added to the
 * table turns this red until a decision is recorded for it, and the recorded
 * gaps are pinned by exact equality, so closing one is a change somebody makes
 * on purpose rather than a count that drifts.
 *
 * WHAT IT DOES NOT CATCH: whether the desktop surface a decision names is
 * drawn correctly, or drawn at all. A decision naming a host action is checked
 * against `ALL_HOST_ACTIONS`, so it cannot name an action the protocol does
 * not carry; a decision naming a window-local surface is a claim this process
 * cannot verify, and the desktop's own suites drive those.
 */

import { describe, expect, test } from "bun:test";
import { DESKTOP_HOST_COMMAND_NAMES } from "../../src/gui-host/desktop-commands";
import { ALL_HOST_ACTIONS, type HostActionTag } from "../../src/gui-host/wire";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
} from "../../src/slash-commands/builtin-declarations";

/** How the desktop reaches one command the terminal offers outside text mode. */
type Decision =
	/** The window sends this host action, so the protocol carries the command. */
	| { action: HostActionTag }
	/** The window answers it alone: navigation, a local selection, the process. */
	| { client: string }
	/** The host answers it for the window, and lists it in the catalogue. */
	| { host: string }
	/** No desktop surface reaches it yet. */
	| { gap: string };

const DECISIONS: Record<string, Decision> = {
	settings: { client: "SurfaceRoute::Settings, from the /settings row" },
	statusline: { client: "the settings sheet's own group" },
	welcome: { client: "EmptySurface::Welcome, drawn by a window holding no session" },
	lsp: { client: "SettingsPage::Diagnostics" },
	setup: { client: "SurfaceRoute::Account" },
	providers: { client: "SettingsPage::Providers" },
	login: { action: "StartProviderAuth" },
	logout: { client: "SettingsPage::Authentication" },
	plan: { action: "SetSessionMode" },
	"plan-review": { action: "ReviewPlan" },
	vibe: { action: "SetSessionMode" },
	goal: { host: "answered by the host via GoalDriver, drawn in the goal card and status line" },
	"guided-goal": { gap: "no goal interview surface" },
	loop: { action: "SetSessionMode" },
	queue: { action: "FollowUp" },
	switch: { action: "SelectModel" },
	collab: { gap: "no share surface" },
	join: { gap: "no share surface" },
	leave: { gap: "no share surface" },
	copy: { client: "Intent::CopyText, over the transcript selection" },
	hotkeys: { client: "SettingsPage::Keybindings" },
	extensions: { client: "SettingsPage::Extensions" },
	agents: { gap: "the extensions page draws extensions, not the agent roster" },
	branch: { action: "BranchSession" },
	fork: { action: "BranchSession" },
	tree: { client: "the queue rail's indented, collapsible branch tree" },
	new: { action: "CreateSession" },
	drop: { action: "DeleteSession" },
	resume: { action: "SearchSessions" },
	btw: { host: "answered on the session's own context, drawn as a side pair" },
	tan: { gap: "no background-agent submission on the composer" },
	omfg: { gap: "no rule-forging surface" },
	retry: { action: "RetryTurn" },
	rephrase: { action: "RephraseReply" },
	debug: { gap: "no debug tools surface" },
	exit: { client: "Intent::Quit" },
	profile: { gap: "no profile picker" },
	pause: { action: "PauseAgents" },
	quit: { client: "Intent::Quit" },
};

/** The gaps as they stand, so closing one is a recorded change. */
const RECORDED_GAPS = ["agents", "collab", "debug", "guided-goal", "join", "leave", "omfg", "profile", "tan"];

/**
 * The declarations through their declared interface. The table is `as const`,
 * so each member is an exact literal and `textMode` exists only on the ones
 * that set it; the widened element type is how every other reader reaches it.
 */
const DECLARATIONS: readonly BuiltinSlashCommandDeclaration[] =
	BUILTIN_SLASH_COMMAND_DECLARATIONS as readonly BuiltinSlashCommandDeclaration[];

const UI_ONLY = DECLARATIONS.filter(declaration => declaration.textMode !== true).map(declaration => declaration.name);

describe("every command the terminal offers has a desktop decision", () => {
	test("each command outside text mode is decided, and only those are", () => {
		expect(Object.keys(DECISIONS).sort()).toEqual([...UI_ONLY].sort());
	});

	test("a decision naming a host action names one the protocol carries", () => {
		const named = Object.entries(DECISIONS).flatMap(([name, decision]) =>
			"action" in decision ? [[name, decision.action] as const] : [],
		);
		expect(named.length).toBeGreaterThan(0);
		const unknown = named.filter(([, action]) => !(ALL_HOST_ACTIONS as readonly string[]).includes(action));
		expect(unknown).toEqual([]);
	});

	test("a decision saying the host answers it names one the host declares", () => {
		const answered = Object.entries(DECISIONS)
			.filter(([, decision]) => "host" in decision)
			.map(([name]) => name)
			.sort();
		expect(answered).toEqual([...DESKTOP_HOST_COMMAND_NAMES].sort());
	});

	test("the commands with no desktop surface are exactly the recorded gaps", () => {
		const gaps = Object.entries(DECISIONS)
			.filter(([, decision]) => "gap" in decision)
			.map(([name]) => name)
			.sort();
		expect(gaps).toEqual(RECORDED_GAPS);
	});

	test("a command a text client can drive is reached by the catalogue, not by a decision", () => {
		const textMode = DECLARATIONS.filter(declaration => declaration.textMode === true).map(
			declaration => declaration.name,
		);
		const decided = textMode.filter(name => name in DECISIONS);
		expect(decided).toEqual([]);
	});
});
