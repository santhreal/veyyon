/**
 * Every system-prompt-builder module has a test file (inline or separate).
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. A prompt-builder module with no test is a parity gap — the rewrite
 * can change how the system prompt is assembled and nothing goes red. This
 * suite scans the source directory and asserts each module has a test file.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "..", "..", "src", "system-prompt-builder");
const TEST_ROOT = join(import.meta.dir, "..");

/** Collect source modules (excluding .test.ts and subdirectories). */
function collectSourceModules(): string[] {
	return readdirSync(SRC_DIR)
		.filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"))
		.map(f => f.replace(/\.ts$/, ""))
		.sort();
}

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

const ALL_TEST_FILES = [...collectTestFiles(TEST_ROOT), ...collectTestFiles(SRC_DIR)];
const ALL_TEST_NAMES = new Set(ALL_TEST_FILES.map(f => f.split("/").pop()!.replace(/\.test\.ts$/, "")));


/** Modules tested via cross-tool suites. */
const TESTED_VIA_CROSS_TOOL: Record<string, string> = {
	"gate-inputs": "tested via settings and config suites that exercise gate resolution",
	"gate-registry": "tested via settings and config suites that exercise gate registration",
	"secret-inventory": "tested via secrets and slash-command suites",
	"section-overrides": "tested via section-registry and config suites",
};

describe("every system-prompt-builder module has test coverage", () => {
	const modules = collectSourceModules();

	it("the source directory has modules", () => {
		expect(modules.length).toBeGreaterThan(0);
	});

	for (const mod of modules) {
		it(`module "${mod}" has a test file or is audited via cross-tool`, () => {
			const hasFile = ALL_TEST_NAMES.has(mod);
			const hasCrossToolNote = mod in TESTED_VIA_CROSS_TOOL;
			expect(
				hasFile || hasCrossToolNote,
				`Module "${mod}" has no test file and no cross-tool coverage note. ` +
					"Add a test file or record the cross-tool suite that covers it.",
			).toBe(true);
		});
	}

	it("the cross-tool exemption list is exhaustive for modules without a test file", () => {
		const withoutFiles = modules.filter(name => !ALL_TEST_NAMES.has(name));
		const unaccounted = withoutFiles.filter(name => !(name in TESTED_VIA_CROSS_TOOL));
		expect(unaccounted).toEqual([]);
		const stale = Object.keys(TESTED_VIA_CROSS_TOOL).filter(name => ALL_TEST_NAMES.has(name));
		expect(stale, "These modules now have test files — remove them from TESTED_VIA_CROSS_TOOL").toEqual([]);
	});
});
