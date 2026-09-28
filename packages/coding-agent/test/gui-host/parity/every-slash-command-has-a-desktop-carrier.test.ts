/**
 * WHY: a command with `textMode: true` reaches the desktop by itself, because
 * the host advertises the catalogue and the palette lists it. A command
 * without it runs a terminal surface, so the desktop reaches it only through a
 * host action, a host-answered command, or a window surface built for it. The
 * defect is a terminal command that quietly exists on one host and not the
 * other.
 *
 * THE CLASS THIS CLOSES: an undecided command. The sweep reads
 * `BUILTIN_SLASH_COMMAND_DECLARATIONS` at run time, so a builtin added to the
 * table turns this red until `COMMAND_CARRIERS` records a carrier for it. The
 * opt-outs and gaps are pinned by exact equality, so closing a gap is a change
 * made on purpose rather than a count that drifts. A window carrier names a
 * surface of the desktop layout by type, and states the host actions that
 * surface sends, each typed against the protocol's action tags.
 *
 * WHAT IT DOES NOT CATCH: whether the surface a window carrier names is drawn
 * correctly, or drawn at all. That is a claim this process cannot verify; the
 * desktop app's own suites drive its surfaces.
 */

import { describe, expect, test } from "bun:test";
import { DESKTOP_HOST_COMMAND_NAMES } from "../../../src/gui-host/desktop-commands";
import { membersCarriedBy } from "../../../src/gui-host/desktop-parity/carrier";
import { COMMAND_CARRIERS, COMMAND_WINDOW_ACTIONS } from "../../../src/gui-host/desktop-parity/commands";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
} from "../../../src/slash-commands/builtin-declarations";

/** The commands no desktop surface reaches, as they stand. */
const RECORDED_GAPS = ["extensions", "logout"];

/** The commands the desktop does without, each with its reason in the table. */
const RECORDED_OPT_OUTS: string[] = [];

/**
 * The declarations through their declared interface. The table is `as const`,
 * so `textMode` exists only on the members that set it; the widened element
 * type is how every other reader reaches it.
 */
const DECLARATIONS: readonly BuiltinSlashCommandDeclaration[] =
	BUILTIN_SLASH_COMMAND_DECLARATIONS as readonly BuiltinSlashCommandDeclaration[];

const UI_ONLY = DECLARATIONS.filter(declaration => declaration.textMode !== true).map(declaration => declaration.name);

describe("every slash command has a desktop carrier", () => {
	test("each command outside text mode has a carrier, and only those do", () => {
		expect(Object.keys(COMMAND_CARRIERS).sort()).toEqual([...UI_ONLY].sort());
	});

	test("the commands the host answers are exactly the ones it declares it answers", () => {
		expect(membersCarriedBy(COMMAND_CARRIERS, "host")).toEqual([...DESKTOP_HOST_COMMAND_NAMES].sort());
	});

	test("each window-carried command states the host actions its surface sends, and only those commands do", () => {
		expect(Object.keys(COMMAND_WINDOW_ACTIONS).sort()).toEqual(membersCarriedBy(COMMAND_CARRIERS, "window"));
	});

	test("the commands the desktop does without are exactly the recorded opt-outs", () => {
		expect(membersCarriedBy(COMMAND_CARRIERS, "optOut")).toEqual(RECORDED_OPT_OUTS);
	});

	test("the commands with no desktop surface are exactly the recorded gaps", () => {
		expect(membersCarriedBy(COMMAND_CARRIERS, "gap")).toEqual(RECORDED_GAPS);
	});

	test("a command a text client can drive is reached by the catalogue, not by a carrier", () => {
		const textMode = DECLARATIONS.filter(declaration => declaration.textMode === true).map(
			declaration => declaration.name,
		);
		expect(textMode.filter(name => Object.hasOwn(COMMAND_CARRIERS, name))).toEqual([]);
	});
});
