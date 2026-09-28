/**
 * WHY: a plugin that prompts, notifies or decorates the session does it
 * through the extension UI surface, and on a desktop that surface is
 * `GuiHostUIContext`. A member the desktop context implements as a silent
 * no-op, or omits, loses what the extension asked for, and nothing recorded
 * which members those were.
 *
 * THE CLASS THIS CLOSES: an undecided interaction. The sweep enumerates the
 * decision kinds a live `InteractionLedger` publishes and the members on
 * `GuiHostUIContext`'s prototype at run time, so a new decision kind or a new
 * context member turns this red until a carrier is recorded. The table is
 * typed over `keyof ExtensionUIContext` and `keyof ExtensionTerminalCapability`
 * too, so a member added to either interface fails the type check until it is
 * decided. Opt-outs and gaps are pinned by exact equality.
 *
 * WHAT IT DOES NOT CATCH: whether the interaction dock draws a raised
 * decision; the desktop app's suites drive the dock. An optional interface
 * member the desktop context omits is found by the type, not by this run.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { membersCarriedBy } from "../../../src/gui-host/desktop-parity/carrier";
import {
	PENDING_DECISION_CARRIERS,
	TERMINAL_CAPABILITY_CARRIERS,
	UI_CONTEXT_CARRIERS,
} from "../../../src/gui-host/desktop-parity/interactions";
import { GuiHostUIContext, InteractionLedger } from "../../../src/gui-host/interactions";

const RECORDED_GAPS = [
	"addAutocompleteProvider",
	"askDialog",
	"getEditorText",
	"notify",
	"pasteToEditor",
	"setEditorText",
	"setStatus",
	"setWidget",
	"setWorkingMessage",
];

const RECORDED_OPT_OUTS = [
	"custom",
	"getAllThemes",
	"getTheme",
	"getToolsExpanded",
	"onTerminalInput",
	"setEditorComponent",
	"setFooter",
	"setHeader",
	"setTheme",
	"setTitle",
	"setToolsExpanded",
	"terminal",
	"theme",
];

/** Interface members the desktop context does not implement at all. */
const OMITTED_BY_THE_DESKTOP_CONTEXT = ["askDialog", "terminal"];

const socket = new net.Socket();
const ledger = new InteractionLedger(socket, () => "parity-session");
const context = new GuiHostUIContext(ledger);

afterAll(() => {
	socket.destroy();
});

const CONTEXT_MEMBERS = Object.getOwnPropertyNames(GuiHostUIContext.prototype)
	.filter(member => member !== "constructor")
	.sort();

describe("every interaction the host raises has a desktop carrier", () => {
	test("each decision kind the ledger publishes has a carrier, and only those do", () => {
		expect(Object.keys(PENDING_DECISION_CARRIERS).sort()).toEqual(Object.keys(ledger.pending()).sort());
	});

	test("each member of the desktop's UI context has a carrier", () => {
		expect(CONTEXT_MEMBERS.filter(member => !Object.hasOwn(UI_CONTEXT_CARRIERS, member))).toEqual([]);
	});

	test("the members the desktop context leaves out are exactly the recorded ones, and it does leave them out", () => {
		const decidedButAbsent = Object.keys(UI_CONTEXT_CARRIERS)
			.filter(member => !CONTEXT_MEMBERS.includes(member))
			.sort();
		expect(decidedButAbsent).toEqual(OMITTED_BY_THE_DESKTOP_CONTEXT);
		expect(OMITTED_BY_THE_DESKTOP_CONTEXT.filter(member => member in context)).toEqual([]);
	});

	test("the terminal-only capability is opted out member by member", () => {
		expect(membersCarriedBy(TERMINAL_CAPABILITY_CARRIERS, "optOut")).toEqual([
			"custom",
			"setEditorComponent",
			"setWidgetComponent",
		]);
	});

	test("the members the desktop does without are exactly the recorded opt-outs", () => {
		expect(membersCarriedBy(UI_CONTEXT_CARRIERS, "optOut")).toEqual(RECORDED_OPT_OUTS);
	});

	test("the members no desktop surface reaches are exactly the recorded gaps", () => {
		expect(membersCarriedBy(UI_CONTEXT_CARRIERS, "gap")).toEqual(RECORDED_GAPS);
	});
});
