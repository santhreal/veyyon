/**
 * Every MCP transport implementation and utility module has a dedicated test.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. An MCP transport with no dedicated test is a parity gap. This suite
 * derives the transport list from the source directory at runtime and asserts
 * each transport source file has a dedicated test file or an audited
 * cross-tool exemption.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const TRANSPORT_SRC = join(import.meta.dir, "..", "..", "src", "mcp", "transports");
const TEST_ROOT = join(import.meta.dir);

/** Collect every .ts source file (non-test) in the transports directory. */
function collectTransportSources(): string[] {
	return readdirSync(TRANSPORT_SRC)
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

const TRANSPORT_SOURCES = collectTransportSources();
const ALL_TEST_FILES = collectTestFiles(TEST_ROOT);

/** Whether a transport source name appears in any test file path. */
function hasTest(name: string): boolean {
	return ALL_TEST_FILES.some(file => {
		const base = file.split("/").pop()!;
		return base.includes(name);
	});
}

/** Whether a transport source name is referenced in any test file content. */
function hasTestReference(name: string): boolean {
	return ALL_TEST_FILES.some(file => {
		const content = require("node:fs").readFileSync(file, "utf-8");
		return content.includes(name);
	});
}

/**
 * Transports that are tested via integration suites rather than a dedicated
 * file named after the transport. Each value names the covering suite.
 */
const TESTED_VIA_CROSS_TOOL: Record<string, string> = {};

describe("MCP transport source inventory", () => {
	it("there are transport source modules", () => {
		expect(TRANSPORT_SOURCES.length).toBeGreaterThanOrEqual(7);
	});

	it("the transport source count is pinned", () => {
		// Update this number when a transport is added or removed.
		expect(TRANSPORT_SOURCES.length).toBe(7);
	});

	it("every transport source is accounted for", () => {
		const unaccounted = TRANSPORT_SOURCES.filter(
			name => !hasTest(name) && !hasTestReference(name) && !(name in TESTED_VIA_CROSS_TOOL),
		);
		expect(
			unaccounted,
			"These transport sources have no test file, no test reference, and no cross-tool exemption",
		).toEqual([]);
	});

	for (const name of TRANSPORT_SOURCES) {
		it(`transport source "${name}" has a dedicated test file, test reference, or audited exemption`, () => {
			const hasFile = hasTest(name);
			const hasRef = hasTestReference(name);
			const hasCrossTool = name in TESTED_VIA_CROSS_TOOL;
			expect(
				hasFile || hasRef || hasCrossTool,
				`Transport source "${name}" has no test coverage. ` +
					"Add a test file or record the cross-tool suite that covers it.",
			).toBe(true);
		});
	}

	it("the cross-tool exemption list has no stale entries", () => {
		const stale = Object.keys(TESTED_VIA_CROSS_TOOL).filter(
			name => hasTest(name) || hasTestReference(name),
		);
		expect(
			stale,
			"These transports now have test files — remove them from TESTED_VIA_CROSS_TOOL",
		).toEqual([]);
	});
});
