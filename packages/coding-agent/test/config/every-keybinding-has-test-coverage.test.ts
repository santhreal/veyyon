/**
 * Every keybinding ID in the KEYBINDINGS registry has a dedicated test.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. A keybinding with no dedicated test is a parity gap. This suite
 * derives the keybinding list from the KEYBINDINGS source at runtime and
 * asserts each keybinding ID is referenced by at least one test file.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { KEYBINDINGS } from "@veyyon/coding-agent/config/keybindings";

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
const KEYBINDING_IDS = Object.keys(KEYBINDINGS).sort();

/** Whether a keybinding ID is referenced in any test file content (excluding this meta-test). */
function hasTestReference(id: string): boolean {
	return ALL_TEST_FILES.some(file => {
		if (file.endsWith("every-keybinding-has-test-coverage.test.ts")) return false;
		try {
			return readFileSync(file, "utf-8").includes(id);
		} catch {
			return false;
		}
	});
}

/**
 * Keybinding IDs tested via integration suites rather than a dedicated file.
 * Each value names the covering suite.
 */
const TESTED_VIA_CROSS_TOOL: Record<string, string> = {
	"app.clipboard.pasteTextRaw": "tested via clipboard and paste integration suites",
	"app.session.resume": "tested via session-tree and session-resume integration suites",
	"app.session.tree": "tested via session-tree integration suites",
	"tui.editor.cursorDown": "tested via @veyyon/tui editor keybinding suites",
	"tui.editor.cursorRight": "tested via @veyyon/tui editor keybinding suites",
	"tui.editor.cursorWordRight": "tested via @veyyon/tui editor keybinding suites",
	"tui.editor.deleteCharForward": "tested via @veyyon/tui editor keybinding suites",
	"tui.editor.deleteWordForward": "tested via @veyyon/tui editor keybinding suites",
	"tui.editor.jumpBackward": "tested via @veyyon/tui editor keybinding suites",
	"tui.editor.jumpForward": "tested via @veyyon/tui editor keybinding suites",
	"tui.editor.pageDown": "tested via @veyyon/tui editor keybinding suites",
	"tui.editor.pageUp": "tested via @veyyon/tui editor keybinding suites",
	"tui.editor.yank": "tested via @veyyon/tui editor keybinding suites",
	"tui.editor.yankPop": "tested via @veyyon/tui editor keybinding suites",
	"tui.input.newLine": "tested via @veyyon/tui input keybinding suites",
	"tui.select.pageDown": "tested via @veyyon/tui select keybinding suites",
};

describe("keybinding registry", () => {
	it("KEYBINDINGS is non-empty", () => {
		expect(KEYBINDING_IDS.length).toBeGreaterThan(0);
	});

	it("the keybinding count is pinned", () => {
		// Update this number when a keybinding is added or removed.
		expect(KEYBINDING_IDS.length).toBe(60);
	});

	it("every keybinding entry has a defaultKeys string", () => {
		for (const id of KEYBINDING_IDS) {
			expect(KEYBINDINGS[id as keyof typeof KEYBINDINGS].defaultKeys, `keybinding "${id}" missing defaultKeys`).toBeDefined();
		}
	});

	it("every keybinding entry has a description", () => {
		for (const id of KEYBINDING_IDS) {
			expect(KEYBINDINGS[id as keyof typeof KEYBINDINGS].description, `keybinding "${id}" missing description`).toBeDefined();
		}
	});
});

describe("every keybinding has test coverage", () => {
	it("every keybinding ID is accounted for", () => {
		const unaccounted = KEYBINDING_IDS.filter(
			id => !hasTestReference(id) && !(id in TESTED_VIA_CROSS_TOOL),
		);
		expect(
			unaccounted,
			"These keybinding IDs have no test reference and no cross-tool exemption",
		).toEqual([]);
	});

	for (const id of KEYBINDING_IDS) {
		it(`keybinding "${id}" has a test reference or audited exemption`, () => {
			const hasRef = hasTestReference(id);
			const hasCrossTool = id in TESTED_VIA_CROSS_TOOL;
			expect(
				hasRef || hasCrossTool,
				`Keybinding "${id}" has no test coverage. ` +
					"Add a test reference or record the cross-tool suite that covers it.",
			).toBe(true);
		});
	}

	it("the cross-tool exemption list has no stale entries", () => {
		const stale = Object.keys(TESTED_VIA_CROSS_TOOL).filter(id => hasTestReference(id));
		expect(
			stale,
			"These keybindings now have test references — remove them from TESTED_VIA_CROSS_TOOL",
		).toEqual([]);
	});
});
