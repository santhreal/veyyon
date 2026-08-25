/**
 * Every registered CLI command has a dedicated test file.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. A command with no dedicated test is a parity gap. This suite
 * derives the command list from the `commands` registry in cli-commands.ts
 * at runtime and asserts each has a dedicated test file, so adding a new
 * command makes this suite red until someone writes its tests.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { commands } from "@veyyon/coding-agent/cli-commands";

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

/** Whether a command has a dedicated test file by name. */
function hasDedicatedTest(commandName: string): boolean {
	// Strip subcommand path (e.g. "bench/throughput" → "bench")
	const base = commandName.split("/")[0];
	return ALL_TEST_FILES.some(file => {
		const name = file.split("/").pop()!;
		return name.includes(base);
	});
}

/** Commands tested via cross-tool suites. */
const TESTED_VIA_CROSS_TOOL: Record<string, string> = {
	"auth-gateway": "tested via auth-gateway-* suites in packages/ai/test",
	"__complete": "tested via completion-gen and completions-parity suites",
	"dry-balance": "tested via session budget and dry-balance-cli suites",
	"licenses": "tested via installer and license suites",
	"trust": "tested via trust-cli and security suites",
};

describe("every registered command has dedicated test coverage", () => {
	const commandNames = commands.map(c => c.name);

	it("the command registry is non-empty", () => {
		expect(commandNames.length).toBeGreaterThan(0);
	});

	for (const name of commandNames) {
		it(`command "${name}" has a dedicated test file or is audited via cross-tool`, () => {
			const hasFile = hasDedicatedTest(name);
			const hasCrossToolNote = name in TESTED_VIA_CROSS_TOOL;
			expect(
				hasFile || hasCrossToolNote,
				`Command "${name}" has no dedicated test file and no cross-tool coverage note. ` +
					"Add a test file or record the cross-tool suite that covers it.",
			).toBe(true);
		});
	}

	it("the cross-tool exemption list is exhaustive for commands without a dedicated file", () => {
		const withoutFiles = commandNames.filter(name => !hasDedicatedTest(name));
		const unaccounted = withoutFiles.filter(name => !(name in TESTED_VIA_CROSS_TOOL));
		expect(unaccounted).toEqual([]);
		const stale = Object.keys(TESTED_VIA_CROSS_TOOL).filter(name => hasDedicatedTest(name));
		expect(stale, "These commands now have dedicated files — remove them from TESTED_VIA_CROSS_TOOL").toEqual([]);
	});
});
