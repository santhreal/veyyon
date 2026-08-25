/**
 * Every Rust native module has a dedicated test or audited exemption.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite of the natives crate needs the test
 * suite as a parity oracle. A native module with no dedicated test is a parity
 * gap. This suite derives the module list from the Rust source directory at
 * runtime and asserts each has a dedicated test file or an audited exemption.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const NATIVES_SRC = join(import.meta.dir, "..", "..", "..", "crates", "veyyon-natives", "src");
const NATIVES_TESTS = join(import.meta.dir, "..", "..", "..", "crates", "veyyon-natives", "tests");

/** Collect every .rs source file in the natives crate (excluding test modules). */
function collectNativeModules(): string[] {
	return readdirSync(NATIVES_SRC)
		.filter(f => f.endsWith(".rs"))
		.map(f => f.replace(/\.rs$/, ""))
		.filter(name => name !== "lib" && name !== "testing")
		.sort();
}

/** Collect every .rs test file in the tests directory. */
function collectTestFiles(): string[] {
	try {
		return readdirSync(NATIVES_TESTS)
			.filter(f => f.endsWith(".rs"))
			.map(f => f.replace(/\.rs$/, ""));
	} catch {
		return [];
	}
}

const NATIVE_MODULES = collectNativeModules();
const TEST_FILES = collectTestFiles();

/** Whether a module name appears in any test file content. */
function hasTestReference(name: string): boolean {
	return TEST_FILES.some(testName => testName.includes(name));
}

/** Whether a module has inline tests (#[cfg(test)] or #[test]). */
function hasInlineTests(name: string): boolean {
	try {
		const content = readFileSync(join(NATIVES_SRC, `${name}.rs`), "utf-8");
		return content.includes("#[test]") || content.includes("#[cfg(test)]");
	} catch {
		return false;
	}
}

/**
 * Native modules tested via the TS natives package or integration suites
 * rather than a dedicated Rust test. Each value names the covering suite.
 */
const TESTED_VIA_TS_PACKAGE: Record<string, string> = {
	appearance: "tested via TS natives package (native-portability, text-width-contracts)",
	block: "tested via TS natives package (native.test, text-width-property)",
	cpu_budget: "tested via TS natives package (native.test, lazy-native-loading)",
	html: "tested via TS natives package (native.test)",
	iofs: "tested via TS natives package (native.test, source-install-cache-fallback)",
	iso: "tested via TS natives package (native.test)",
	keys: "tested via TS natives package (native.test)",
	power: "tested via TS natives package (native.test)",
	prof: "tested via TS natives package (native.test)",
	ps: "tested via TS natives package (native.test)",
	pty: "tested via TS natives package (native.test)",
	sixel: "tested via TS natives package (native.test)",
	summary: "tested via TS natives package (native.test)",
	text: "tested via TS natives package (text-width-contracts, text-width-property)",
	tokens: "tested via TS natives package (native.test)",
	utils: "tested via TS natives package (native.test)",
	workspace: "tested via TS natives package (native.test)",
};

describe("Rust natives module inventory", () => {
	it("there are native source modules", () => {
		expect(NATIVE_MODULES.length).toBeGreaterThan(0);
	});

	it("the native module count is pinned", () => {
		// Update this number when a module is added or removed.
		expect(NATIVE_MODULES.length).toBe(28);
	});

	for (const name of NATIVE_MODULES) {
		it(`native module "${name}" has a test file, inline tests, or audited exemption`, () => {
			const hasFile = hasTestReference(name);
			const hasInline = hasInlineTests(name);
			const hasTsExemption = name in TESTED_VIA_TS_PACKAGE;
			expect(
				hasFile || hasInline || hasTsExemption,
				`Native module "${name}" has no test coverage. ` +
					"Add a Rust test, inline tests, or record the TS suite that covers it.",
			).toBe(true);
		});
	}

	it("the TS exemption list has no stale entries", () => {
		const stale = Object.keys(TESTED_VIA_TS_PACKAGE).filter(
			name => hasTestReference(name) || hasInlineTests(name),
		);
		expect(
			stale,
			"These native modules now have Rust tests — remove them from TESTED_VIA_TS_PACKAGE",
		).toEqual([]);
	});

	it("every exemption name corresponds to a real source module", () => {
		const phantom = Object.keys(TESTED_VIA_TS_PACKAGE).filter(
			name => !NATIVE_MODULES.includes(name),
		);
		expect(phantom, "These exemption names do not match any source module").toEqual([]);
	});
});
