/**
 * Every CLI module has at least one dedicated test file.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. A CLI module with no dedicated test file is a parity gap. This
 * suite scans the CLI source directory and asserts each non-trivial module
 * has at least one test file that names it, so adding a new CLI module makes
 * this suite red until someone writes its tests.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CLI_SRC = join(import.meta.dir, "..", "..", "src", "cli");
const TEST_ROOT = join(import.meta.dir, "..");

/** Collect every .ts source file in src/cli/ (excluding gallery-fixtures/). */
function collectCliModules(): string[] {
	const out: string[] = [];
	const entries = readdirSync(CLI_SRC);
	for (const entry of entries) {
		const full = join(CLI_SRC, entry);
		if (statSync(full).isDirectory()) continue;
		if (!entry.endsWith(".ts")) continue;
		if (entry.endsWith(".test.ts")) continue;
		out.push(entry.replace(/\.ts$/, ""));
	}
	return out.sort();
}

/** Recursively collect every .test.ts file under the test root. */
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

/** Whether a CLI module has a dedicated test file by name. */
function hasDedicatedTest(moduleName: string): boolean {
	return ALL_TEST_FILES.some(file => {
		const base = file.split("/").pop()!;
		return base.includes(moduleName);
	});
}

/** Modules that are tested via cross-tool suites or are pure type/utility files. */
const TESTED_VIA_CROSS_TOOL: Record<string, string> = {
	"agents-cli": "tested via agents-* and subagent-settings suites",
	"auth-broker-cli": "tested via auth-broker-* suites",
	"auth-gateway-cli": "auth-gateway-* test files in packages/ai/test exercise the gateway",
	"bench-cli": "tested via bench-* and typescript-edit-benchmark suites",
	"classify-install-target": "tested via installer-* suites in scripts/",
	"claude-trace-cli": "tested via agent-session transcript suites",
	"completion-gen": "tested via completion-* and installer-completions-parity suites",
	"dry-balance-cli": "tested via session budget suites",
	"extension-flags": "tested via extension and extensibility suites",
	"file-processor": "tested via prompt-cli and initial-message suites",
	"grep-cli": "tested via grep tool suites",
	"grievances-cli": "tested via grievances and advisor suites",
	"model-runtime": "tested via model-* and provider-* suites",
	"plugin-cli": "tested via plugin and extensibility suites",
	"read-cli": "tested via read tool suites",
	"rollback-cli": "tested via rollback-* suites",
	"rollback-picker-host": "tested via rollback-* and session-picker suites",
	"session-picker": "tested via session-manager suites",
	"session-stats-cli": "tested via session-stats-* suites",
	"setup-cli": "tested via setup-* and setup-wizard suites",
	"setup-model-picker": "tested via setup-wizard suites",
	"shell-cli": "tested via shell-* and posix-shell-portability suites",
	"ssh-cli": "tested via ssh-* suites",
	"stats-cli": "tested via stats-* and session-stats suites",
	"trust-cli": "tested via trust and security suites",
	"usage-error": "tested via args and flag-tables suites",
	"web-search-cli": "tested via web-search-* suites",
	"worktree-cli": "tested via worktree-* suites",
};

describe("every CLI module has dedicated test coverage", () => {
	const modules = collectCliModules();

	it("the CLI source directory has modules", () => {
		expect(modules.length).toBeGreaterThan(0);
	});

	for (const mod of modules) {
		it(`CLI module "${mod}" has a dedicated test file or is audited via cross-tool`, () => {
			const hasFile = hasDedicatedTest(mod);
			const hasCrossToolNote = mod in TESTED_VIA_CROSS_TOOL;
			expect(
				hasFile || hasCrossToolNote,
				`CLI module "${mod}" has no dedicated test file and no cross-tool coverage note. ` +
					"Add a test file or record the cross-tool suite that covers it.",
			).toBe(true);
		});
	}

	it("the cross-tool exemption list is exhaustive for modules without a dedicated file", () => {
		const withoutFiles = modules.filter(name => !hasDedicatedTest(name));
		const unaccounted = withoutFiles.filter(name => !(name in TESTED_VIA_CROSS_TOOL));
		expect(unaccounted).toEqual([]);
		const stale = Object.keys(TESTED_VIA_CROSS_TOOL).filter(name => hasDedicatedTest(name));
		expect(stale, "These modules now have dedicated files — remove them from TESTED_VIA_CROSS_TOOL").toEqual([]);
	});
});
