/**
 * Every session operation the terminal offers has a desktop carrier.
 *
 * WHY THIS SUITE EXISTS:
 * Creating, opening, branching, renaming, moving, deleting, exporting, sharing,
 * compacting and handing off a session each reach the terminal through a
 * keybinding or a slash command. `desktop-parity/session-ops.ts` records how the
 * desktop performs each one; this suite enumerates the `app.session.*`
 * keybindings and the subcommands of every session command at run time and
 * holds each carrier to something the host runs.
 *
 * THE CLASS THIS CLOSES:
 * 1. A new `app.session.*` keybinding or a new subcommand of a session command
 *    with no recorded carrier.
 * 2. A recorded operation that no longer exists, including a session command
 *    that was renamed or removed.
 * 3. A gap closed or opened without a decision: the gaps are pinned by exact
 *    equality.
 * 4. A `RunCommand` carrier for a command a window cannot run.
 *
 * WHAT IT DOES NOT CATCH:
 * A new top-level slash command that operates on a session: membership in
 * `SESSION_OPERATION_COMMANDS` is recorded by hand, and the command sweep
 * decides every slash command independently.
 */

import { expect, test } from "bun:test";
import { KEYBINDINGS } from "../../../src/config/keybindings";
import { isDesktopHostCommand } from "../../../src/gui-host/desktop-commands";
import { membersCarriedBy } from "../../../src/gui-host/desktop-parity/carrier";
import {
	SESSION_OPERATION_CARRIERS,
	SESSION_OPERATION_COMMANDS,
} from "../../../src/gui-host/desktop-parity/session-ops";
import {
	BUILTIN_SLASH_COMMAND_DECLARATIONS,
	type BuiltinSlashCommandDeclaration,
} from "../../../src/slash-commands/builtin-declarations";

const DECLARATIONS = BUILTIN_SLASH_COMMAND_DECLARATIONS as readonly BuiltinSlashCommandDeclaration[];

function declaration(name: string): BuiltinSlashCommandDeclaration | undefined {
	return DECLARATIONS.find(candidate => candidate.name === name);
}

function sessionOperations(): string[] {
	const ids = Object.keys(KEYBINDINGS).filter(id => id.startsWith("app.session."));
	for (const name of SESSION_OPERATION_COMMANDS) {
		ids.push(`/${name}`);
		for (const subcommand of declaration(name)?.subcommands ?? []) ids.push(`/${name} ${subcommand.name}`);
	}
	return ids.sort();
}

test("every session command is still a declared slash command", () => {
	expect(SESSION_OPERATION_COMMANDS.filter(name => !declaration(name))).toEqual([]);
});

test("every session operation has a recorded desktop carrier", () => {
	const operations = sessionOperations();
	expect(operations.filter(id => !Object.hasOwn(SESSION_OPERATION_CARRIERS, id))).toEqual([]);
	expect(Object.keys(SESSION_OPERATION_CARRIERS).filter(id => !operations.includes(id))).toEqual([]);
});

test("the session operations the desktop cannot perform are exactly the recorded gaps", () => {
	expect(membersCarriedBy(SESSION_OPERATION_CARRIERS, "gap")).toEqual(["/fork", "/tree", "app.session.tree"]);
	expect(membersCarriedBy(SESSION_OPERATION_CARRIERS, "optOut")).toEqual([]);
});

test("a RunCommand carrier names a command a window can run", () => {
	const unrunnable = Object.entries(SESSION_OPERATION_CARRIERS)
		.filter(([, carrier]) => "action" in carrier && carrier.action === "RunCommand")
		.map(([id]) => id.slice(1).split(" ")[0] ?? "")
		.filter(name => declaration(name)?.textMode !== true && !isDesktopHostCommand(name));
	expect(unrunnable).toEqual([]);
});
