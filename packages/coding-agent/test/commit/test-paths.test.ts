import { describe, expect, it } from "bun:test";
import { getFilePriority } from "../../src/commit/agentic/tools/git-file-diff";
import { isTestFilePath } from "../../src/commit/utils/test-paths";

/**
 * isTestFilePath is the single owner of the "is this a test file?" rule shared
 * by fallback commit-type inference and the git diff prioritizer, which used to
 * each inline the same pattern list and `.includes` check (DEDUP). It also fixes
 * a blind spot in that old check: the `"/tests/"` substring patterns required a
 * leading slash, so a TOP-LEVEL `tests/foo.go` was NOT recognized as a test
 * while a nested `a/tests/foo.go` was. Segment-based matching recognizes test
 * directories at any depth and, crucially, does not misfire on a directory that
 * merely ends in `tests` (`latests/`).
 *
 * getFilePriority (the diff prioritizer) is tested here too because its test
 * branch delegates to isTestFilePath, and its priority ordering (binary checked
 * before test, low-priority-vs-manifest precedence, defaults) had no test at
 * all.
 */

describe("isTestFilePath", () => {
	describe("directory-segment detection at any depth", () => {
		it("recognizes a TOP-LEVEL test directory (the bug the old '/tests/' pattern missed)", () => {
			// Regression for FINDING-TEST-PATH-TOP-LEVEL-DIR: `tests/foo.go` used to
			// score as high-priority source because "/tests/" needs a leading slash.
			expect(isTestFilePath("tests/helper.go")).toBe(true);
			expect(isTestFilePath("test/foo.py")).toBe(true);
			expect(isTestFilePath("__tests__/x.ts")).toBe(true);
		});

		it("recognizes a nested test directory", () => {
			expect(isTestFilePath("a/b/__tests__/c.ts")).toBe(true);
			expect(isTestFilePath("src/tests/util.rs")).toBe(true);
			expect(isTestFilePath("pkg/test/thing.go")).toBe(true);
		});

		it("matches case-insensitively", () => {
			expect(isTestFilePath("TESTS/Foo.TS")).toBe(true);
			expect(isTestFilePath("src/Test/x.py")).toBe(true);
		});

		it("does NOT treat a directory that merely ends in 'tests' as a test dir", () => {
			// Whole-segment matching is what prevents this false positive; a
			// substring `.includes("tests/")` would have wrongly matched.
			expect(isTestFilePath("latests/foo.ts")).toBe(false);
			expect(isTestFilePath("contest/a.ts")).toBe(false);
			expect(isTestFilePath("greatests/thing.go")).toBe(false);
		});

		it("does not treat the final path component as a directory segment", () => {
			// A file literally named `tests` (no extension) at the root is not a dir.
			expect(isTestFilePath("tests")).toBe(false);
		});
	});

	describe("filename-marker detection", () => {
		it("recognizes each test-name marker anywhere in the path", () => {
			expect(isTestFilePath("src/foo.test.ts")).toBe(true);
			expect(isTestFilePath("pkg/pkg_test.go")).toBe(true);
			expect(isTestFilePath("app/thing.spec.ts")).toBe(true);
			expect(isTestFilePath("app/thing_spec.rb")).toBe(true);
		});

		it("does not flag ordinary source files", () => {
			expect(isTestFilePath("src/main.rs")).toBe(false);
			expect(isTestFilePath("lib/util.ts")).toBe(false);
			expect(isTestFilePath("README.md")).toBe(false);
			expect(isTestFilePath("contestant.ts")).toBe(false);
		});
	});
});

describe("getFilePriority", () => {
	it("ranks a binary file lowest, even inside a test directory", () => {
		// Binary is checked before the test branch, so a test-dir image is -100, not 10.
		expect(getFilePriority("assets/logo.png")).toBe(-100);
		expect(getFilePriority("tests/logo.png")).toBe(-100);
		expect(getFilePriority("bundle.tar.gz")).toBe(-100);
	});

	it("gives test files priority 10 regardless of directory depth", () => {
		expect(getFilePriority("tests/helper.go")).toBe(10);
		expect(getFilePriority("src/foo.test.ts")).toBe(10);
		expect(getFilePriority("a/b/__tests__/c.ts")).toBe(10);
	});

	it("gives high-priority source extensions 100", () => {
		expect(getFilePriority("src/main.rs")).toBe(100);
		expect(getFilePriority("app/x.go")).toBe(100);
		expect(getFilePriority("lib/y.tsx")).toBe(100);
	});

	it("gives shell and sql files 80", () => {
		expect(getFilePriority("scripts/run.sh")).toBe(80);
		expect(getFilePriority("migrate.sql")).toBe(80);
	});

	it("gives manifest files 70 even when their extension is low-priority", () => {
		// package.json / Cargo.toml would be 20 by extension, but the manifest
		// check overrides: the low-priority branch is gated on `!isManifest`.
		expect(getFilePriority("package.json")).toBe(70);
		expect(getFilePriority("Cargo.toml")).toBe(70);
		expect(getFilePriority("Gemfile")).toBe(70);
	});

	it("gives non-manifest low-priority extensions 20", () => {
		expect(getFilePriority("README.md")).toBe(20);
		expect(getFilePriority("docs/notes.txt")).toBe(20);
		expect(getFilePriority("pkg/config.json")).toBe(20);
	});

	it("gives an unknown or extensionless file the default 50", () => {
		expect(getFilePriority("Makefile")).toBe(50);
		expect(getFilePriority("scripts/deploy")).toBe(50);
		expect(getFilePriority(".gitignore")).toBe(50);
	});
});
