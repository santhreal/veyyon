/**
 * Every mode a session exposes has a desktop carrier.
 *
 * WHY THIS SUITE EXISTS:
 * A mode the terminal can enter and the desktop cannot leaves a desktop session
 * stuck in, or shut out of, that mode. `desktop-parity/modes.ts` records one
 * carrier per mode; this suite enumerates the modes at run time from the wire's
 * settable modes, the host's `SetSessionMode` vocabulary, the `AgentSession`
 * mode accessors, the goal controls and the autoswarm console actions.
 *
 * THE CLASS THIS CLOSES:
 * 1. A new session mode accessor (`get<X>ModeState`, `set<X>Mode`), settable
 *    mode, goal control or autoswarm action with no recorded carrier.
 * 2. A recorded mode that no longer exists.
 * 3. A carrier that points at nothing: a `SetSessionMode` spelling the host
 *    rejects, a setting path the schema lacks, or a `RunCommand` carrier for a
 *    command a window cannot run.
 *
 * WHAT IT DOES NOT CATCH:
 * A mode added by a plugin through something other than the autoswarm console,
 * and whether the desktop app draws the control.
 */

import { expect, test } from "bun:test";
import { SETTINGS_SCHEMA } from "../../../src/config/settings-schema";
import { SESSION_MODES } from "../../../src/gui-host/actions/session-mode";
import { isDesktopHostCommand } from "../../../src/gui-host/desktop-commands";
import { membersCarriedBy } from "../../../src/gui-host/desktop-parity/carrier";
import { SESSION_MODE_CARRIERS } from "../../../src/gui-host/desktop-parity/modes";
import { ALL_AUTOSWARM_ACTIONS, ALL_GOAL_CONTROLS, SETTABLE_MODES } from "../../../src/gui-host/wire";
import { AgentSession } from "../../../src/session/agent-session";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
} from "../../../src/slash-commands/builtin-declarations";

function sessionModes(): string[] {
	const ids = new Set<string>([...SETTABLE_MODES, ...SESSION_MODES]);
	for (const name of Object.getOwnPropertyNames(AgentSession.prototype)) {
		const stem = (/^get([A-Z]\w*)ModeState$/.exec(name) ?? /^set([A-Z]\w*)Mode$/.exec(name))?.[1];
		if (stem) ids.add(stem.charAt(0).toLowerCase() + stem.slice(1));
	}
	for (const op of ALL_GOAL_CONTROLS) ids.add(`goal.${op}`);
	for (const action of ALL_AUTOSWARM_ACTIONS) ids.add(`autoswarm.${action}`);
	return [...ids].sort();
}

function isRunnableByWindow(command: string): boolean {
	const declaration = (BUILTIN_SLASH_COMMAND_DECLARATIONS as readonly BuiltinSlashCommandDeclaration[]).find(
		candidate => candidate.name === command,
	);
	return declaration?.textMode === true || isDesktopHostCommand(command);
}

test("every session mode has a recorded desktop carrier", () => {
	const modes = sessionModes();
	expect(modes.filter(mode => !Object.hasOwn(SESSION_MODE_CARRIERS, mode))).toEqual([]);
	expect(Object.keys(SESSION_MODE_CARRIERS).filter(mode => !modes.includes(mode))).toEqual([]);
});

test("no session mode is opted out or recorded as a gap", () => {
	expect(membersCarriedBy(SESSION_MODE_CARRIERS, "optOut")).toEqual([]);
	expect(membersCarriedBy(SESSION_MODE_CARRIERS, "gap")).toEqual([]);
});

test("every mode carrier reaches something the host accepts", () => {
	const broken: string[] = [];
	for (const [mode, carrier] of Object.entries(SESSION_MODE_CARRIERS)) {
		if ("action" in carrier && carrier.action === "SetSessionMode") {
			if (!(SESSION_MODES as readonly string[]).includes(mode)) broken.push(mode);
		} else if ("action" in carrier && carrier.action === "RunCommand") {
			if (!isRunnableByWindow(mode)) broken.push(mode);
		} else if ("setting" in carrier) {
			if (!Object.hasOwn(SETTINGS_SCHEMA, carrier.setting)) broken.push(mode);
		}
	}
	expect(broken).toEqual([]);
});
