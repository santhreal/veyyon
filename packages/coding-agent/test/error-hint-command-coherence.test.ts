/**
 * Operator-facing error hints must name slash commands that actually exist.
 *
 * Found live (2026-07-22): the auto-thinking classifier failure hint told the
 * user to "set a fixed thinking level with /think" — but the registered
 * command is /thinking (alias /effort). Typing the suggested /think submitted
 * the text to the MODEL as a plain message and burned a turn on "I don't
 * recognize /think as a command". A hint that names a nonexistent command is
 * worse than no hint.
 *
 * This suite scans the session source for `/command` references inside
 * `fix:`/hint string literals and asserts each one resolves in the builtin
 * slash-command registry (names + aliases), so a renamed or removed command
 * can never leave a dangling recommendation behind.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "@veyyon/coding-agent/slash-commands/builtin-registry";

const SESSION_SRC = path.join(import.meta.dir, "..", "src", "session", "agent-session.ts");

describe("error-hint slash-command coherence", () => {
	it("registers /thinking, the command the auto-thinking failure hint recommends", () => {
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has("thinking")).toBe(true);
	});

	it("only recommends registered commands in agent-session fix hints", () => {
		const source = fs.readFileSync(SESSION_SRC, "utf8");
		// `fix: "... /command ..."` string literals — the operator-facing
		// remediation channel. Extract each /word token inside them.
		const hints = [...source.matchAll(/fix:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]!);
		expect(hints.length).toBeGreaterThan(0);
		const recommended = new Set<string>();
		for (const hint of hints) {
			for (const m of hint.matchAll(/\/([a-z][a-z-]+)/g)) recommended.add(m[1]!);
		}
		// The regression this locks: /think was recommended but never registered.
		for (const name of recommended) {
			expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has(name)).toBe(true);
		}
	});
});
