/**
 * `veyyon rollback` must be a registered top-level subcommand, not a bare word
 * that falls through to `launch` and gets forwarded to the model as a paid
 * prompt (the #1496/#2935 leak class). These pin the routing invariants:
 *
 *  1. `rollback` is in the CLI command table and `isSubcommand` recognizes it,
 *     so `veyyon rollback 1.0.11` reaches the command, never the LLM.
 *  2. A near-miss typo (`rollbck`) is caught with a "did you mean" hint instead
 *     of silently starting a session on the word.
 */
import { describe, expect, test } from "bun:test";
import { commands, isSubcommand, nearMissSubcommandMessage, resolveCliArgv } from "@veyyon/coding-agent/cli-commands";

describe("rollback command is registered as a top-level subcommand", () => {
	test("CLI runner sees `rollback` as a known command", () => {
		expect(commands.some(c => c.name === "rollback")).toBe(true);
		expect(isSubcommand("rollback")).toBe(true);
	});

	test("a version argument routes to rollback, not launch", () => {
		// `veyyon rollback 1.0.11` must dispatch to the command with the version as
		// its positional; it must never become `launch rollback 1.0.11`.
		expect(resolveCliArgv(["rollback", "1.0.11"])).toEqual({ argv: ["rollback", "1.0.11"] });
		expect(resolveCliArgv(["rollback", "--list"])).toEqual({ argv: ["rollback", "--list"] });
	});

	test("a typo of rollback is offered as a suggestion", () => {
		// One-edit typo on a 7-letter word is within the near-miss window.
		const message = nearMissSubcommandMessage("rollbck", 1);
		expect(message).toContain("`veyyon rollback`");
	});
});
