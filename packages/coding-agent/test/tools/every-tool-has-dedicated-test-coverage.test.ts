/**
 * Every builtin and hidden tool has at least one dedicated test file.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle: if the port passes every test, behavior is identical. A tool with no
 * dedicated test file is a parity gap — the rewrite can change its behavior and
 * nothing goes red. This suite derives the tool list from the source-of-truth
 * arrays (BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES) and asserts each has at least
 * one test file that names it, so adding a new tool makes this suite red until
 * someone writes its tests.
 *
 * The check is file-name-based, not content-based: a test file whose name
 * contains the tool name is the minimum signal that someone wrote dedicated
 * coverage. Content-level coverage is verified by the mutation campaign, not
 * here.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES } from "@veyyon/coding-agent/tools/builtin-names";

const TEST_ROOT = join(import.meta.dir, "..", "..", "test");

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

/**
 * A tool name matches a test file if the file name (not the full path) contains
 * the tool name with underscores converted to hyphens or kept as-is. Tool names
 * use underscores (`web_search`, `set_cwd`, `memory_edit`); test files use
 * hyphens (`web-search`, `set-cwd`, `memory-edit`) or underscores.
 */
function hasDedicatedTest(toolName: string): boolean {
	const hyphenated = toolName.replace(/_/g, "-");
	const underscored = toolName;
	// Match compound names where all segments appear in the filename, e.g.
	// "manage_skill" matches "managed-skills.test.ts", "report_tool_issue"
	// matches "report-tool-issue.test.ts".
	const segments = toolName.split("_");
	return ALL_TEST_FILES.some(file => {
		const base = file.split("/").pop()!;
		if (base.includes(hyphenated) || base.includes(underscored)) return true;
		if (segments.length >= 2) {
			return segments.every(seg => base.includes(seg));
		}
		return false;
	});
}

/** Tools that are tested only through cross-tool suites, not by a dedicated
 * file whose name matches. Each entry names the suite that covers it so the
 * assertion is auditable. */
const TESTED_VIA_CROSS_TOOL: Record<string, string> = {
	memory_edit: "write-memory-readonly.test.ts and eval schema-rejection suite",
	reflect: "mnemopi-bank-derivation and model-hub suites exercise reflect indirectly",
	report_finding: "review.test.ts constructs reportFindingTool",
	argot_unload: "argot-gate.test.ts and argot-subagent suites exercise both load and unload",
};
describe("every tool has dedicated test coverage", () => {
	const allTools = [...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES];

	it("BUILTIN_TOOL_NAMES and HIDDEN_TOOL_NAMES are non-empty", () => {
		expect(BUILTIN_TOOL_NAMES.length).toBeGreaterThan(0);
		expect(HIDDEN_TOOL_NAMES.length).toBeGreaterThan(0);
	});

	for (const toolName of allTools) {
		it(`tool "${toolName}" has a dedicated test file or is audited via cross-tool`, () => {
			const hasFile = hasDedicatedTest(toolName);
			const hasCrossToolNote = toolName in TESTED_VIA_CROSS_TOOL;
			expect(
				hasFile || hasCrossToolNote,
				`Tool "${toolName}" has no dedicated test file and no cross-tool coverage note. ` +
					"Add a test file or record the cross-tool suite that covers it.",
			).toBe(true);
		});
	}

	it("the cross-tool exemption list is exhaustive for tools without a dedicated file", () => {
		const withoutFiles = allTools.filter(name => !hasDedicatedTest(name));
		const exempted = Object.keys(TESTED_VIA_CROSS_TOOL);
		const unaccounted = withoutFiles.filter(name => !(name in TESTED_VIA_CROSS_TOOL));
		expect(unaccounted).toEqual([]);
		// A tool that gains a dedicated file must be removed from the exemption
		// list, or this assertion fails: the list must shrink as coverage grows.
		const stale = exempted.filter(name => hasDedicatedTest(name));
		expect(stale, "These tools now have dedicated files — remove them from TESTED_VIA_CROSS_TOOL").toEqual([]);
	});
});
