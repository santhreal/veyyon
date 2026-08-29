/**
 * Operator-facing error hints must name slash commands that actually exist.
 *
 * Found live (2026-07-22): the auto-thinking classifier failure hint told the
 * user to "set a fixed thinking level with /think" — but the registered
 * command is /effort (alias /thinking). Typing the suggested /think submitted
 * the text to the MODEL as a plain message and burned a turn on "I don't
 * recognize /think as a command". A hint that names a nonexistent command is
 * worse than no hint.
 *
 * This suite scans the session source for `/command` references inside
 * `fix:`/hint string literals and asserts each one resolves in the builtin
 * slash-command registry (names + aliases), so a renamed or removed command
 * can never leave a dangling recommendation behind.
 *
 * The scan walks the whole `src/session` tree rather than naming
 * `agent-session.ts`, because the hint this suite was written for now lives in
 * `session/runtime/thinking-runtime.ts`: a single-file scan silently found zero
 * hints the moment the runtime was split into collaborators, and a scan that
 * matches nothing asserts nothing. The emptiness check below is what turns that
 * into a failure instead of a green vacuum.
 *
 * What it does not catch: `fix:` hints outside `src/session`. Those exist (the
 * eval backends and the tools manager carry their own), but they recommend
 * shell commands and paths rather than slash commands, and a `/word` regex over
 * them matches path segments, not commands.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	BUILTIN_SLASH_COMMAND_RESERVED_NAMES,
} from "@veyyon/coding-agent/slash-commands/builtin-registry";

const SESSION_SRC_DIR = path.join(import.meta.dir, "..", "src", "session");

/** Every `.ts` under the session tree, so a hint cannot hide in a collaborator. */
function sessionSources(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) sessionSources(full, found);
		else if (entry.name.endsWith(".ts")) found.push(full);
	}
	return found;
}

describe("error-hint slash-command coherence", () => {
	it("registers /effort, the command the auto-thinking failure hint recommends", () => {
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has("effort")).toBe(true);
		// The old spelling stays reserved as an alias, so no extension can shadow it.
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has("thinking")).toBe(true);
	});

	it("only recommends registered commands in session fix hints", () => {
		const sources = sessionSources(SESSION_SRC_DIR);
		expect(sources.length).toBeGreaterThan(0);
		// `fix: "... /command ..."` string literals — the operator-facing
		// remediation channel. Extract each /word token inside them.
		const hints = sources.flatMap(file =>
			[...fs.readFileSync(file, "utf8").matchAll(/fix:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]!),
		);
		// An empty scan is the failure that hid here once: the hint moved into a
		// collaborator and the single-file read stopped seeing anything at all.
		expect(hints.length).toBeGreaterThan(0);
		const recommended = new Set<string>();
		for (const hint of hints) {
			for (const m of hint.matchAll(/\/([a-z][a-z-]+)/g)) recommended.add(m[1]!);
		}
		// The regression this locks: /think was recommended but never registered.
		for (const name of recommended) {
			expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has(name)).toBe(true);
		}
		// Name the primary, not an alias: a hint is the one place the canonical
		// spelling is taught, so it must not drift to a rename's leftover.
		const aliases = new Set(BUILTIN_SLASH_COMMAND_DEFS.flatMap(def => def.aliases ?? []));
		for (const name of recommended) {
			expect(aliases.has(name)).toBe(false);
		}
	});
});
