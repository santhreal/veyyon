/**
 * Every builtin slash command has at least one dedicated test file.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. A slash command with no dedicated test file is a parity gap. This
 * suite derives the command list from BUILTIN_SLASH_COMMAND_DECLARATIONS at
 * runtime and asserts each has at least one test file that names it, so
 * adding a new slash command makes this suite red until someone writes its
 * tests.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_SLASH_COMMAND_DECLARATIONS } from "@veyyon/coding-agent/slash-commands/builtin-declarations";

const TEST_ROOT = join(import.meta.dir, "..");

/** Recursively collect every .test.ts file under a root. */
function collectTestFiles(root: string): string[] {
	const out: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				stack.push(full);
			} else if (entry.endsWith(".test.ts")) {
				out.push(full);
			}
		}
	}
	return out;
}

const ALL_TEST_FILES = collectTestFiles(TEST_ROOT);

/** Whether a slash command has a dedicated test file by name. */
function hasDedicatedTest(commandName: string): boolean {
	return ALL_TEST_FILES.some(file => {
		const base = file.split("/").pop()!;
		return base.includes(commandName);
	});
}

/** Commands tested via cross-tool suites or aliases. */
const TESTED_VIA_CROSS_TOOL: Record<string, string> = {
	quit: "alias for /exit — tested via exit-* suites",
	"reload-plugins": "tested via plugin and extension reload suites",
	trust: "tested via trust-cli and security suites",
};

describe("every slash command has dedicated test coverage", () => {
	const commands = BUILTIN_SLASH_COMMAND_DECLARATIONS.map(c => c.name);

	it("there are builtin slash commands", () => {
		expect(commands.length).toBeGreaterThan(0);
	});

	for (const cmd of commands) {
		it(`slash command "/${cmd}" has a dedicated test file or is audited via cross-tool`, () => {
			const hasFile = hasDedicatedTest(cmd);
			const hasCrossToolNote = cmd in TESTED_VIA_CROSS_TOOL;
			expect(
				hasFile || hasCrossToolNote,
				`Slash command "/${cmd}" has no dedicated test file and no cross-tool coverage note. ` +
					"Add a test file or record the cross-tool suite that covers it.",
			).toBe(true);
		});
	}

	it("the cross-tool exemption list is exhaustive for commands without a dedicated file", () => {
		const withoutFiles = commands.filter(name => !hasDedicatedTest(name));
		const unaccounted = withoutFiles.filter(name => !(name in TESTED_VIA_CROSS_TOOL));
		expect(unaccounted).toEqual([]);
		const stale = Object.keys(TESTED_VIA_CROSS_TOOL).filter(name => hasDedicatedTest(name));
		expect(stale, "These commands now have dedicated files — remove them from TESTED_VIA_CROSS_TOOL").toEqual([]);
	});
});
