/**
 * The loader's declaration file says what the loader exports.
 *
 * WHY THIS SUITE EXISTS. `native/loader-state.js` is plain JavaScript with a
 * HAND-WRITTEN `native/loader-state.d.ts` beside it, and nothing kept the two in
 * step. Six exports had accumulated in the JS without a declaration:
 * `classifyCandidateFailure`, `brokenAddonSkippedMessage`,
 * `loadFirstUsableAddon`, `native`, `lazyNativeFn` and `lazyNativeClass`. The
 * failure mode is specific and bad: the function is there at runtime, so nothing
 * breaks, but a TypeScript caller cannot import it. That is how
 * `test/addon-candidate-loop.test.ts` came to exist as a suite that could not
 * compile, which meant the loader's fail-closed candidate loop had no coverage at
 * all while a written test for it sat in the tree.
 *
 * The other direction matters as much: a declaration for a function that has been
 * renamed or deleted is a compile-time promise the runtime cannot keep, and it
 * surfaces as an undefined-is-not-a-function at the call site rather than as a
 * type error.
 *
 * Both directions are asserted here by reading the two files as text, because
 * that is the only way to compare an export list against a declaration list
 * without a build step.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const NATIVE_DIR = path.resolve(import.meta.dir, "..", "native");

/** Every `export function` name in the implementation. */
function implementationExports(): string[] {
	const text = readFileSync(path.join(NATIVE_DIR, "loader-state.js"), "utf8");
	return [...text.matchAll(/^export function (\w+)/gm)].map(match => match[1]).sort();
}

/** Every function name the declaration file promises. */
function declaredExports(): string[] {
	const text = readFileSync(path.join(NATIVE_DIR, "loader-state.d.ts"), "utf8");
	return [...text.matchAll(/^export (?:declare )?function (\w+)/gm)].map(match => match[1]).sort();
}

describe("loader-state.d.ts matches loader-state.js", () => {
	/**
	 * Proves both parses found something. Two empty lists agree perfectly, so
	 * without this the assertions below would pass on a broken regex, a moved file,
	 * or a rename of the module.
	 */
	it("finds the exports in both files", () => {
		expect(implementationExports().length).toBeGreaterThan(20);
		expect(declaredExports().length).toBeGreaterThan(20);
		expect(implementationExports()).toContain("loadNative");
		expect(declaredExports()).toContain("loadNative");
	});

	/**
	 * An undeclared export is unusable from TypeScript even though it runs.
	 *
	 * The exact gap that left the candidate-loop suite uncompilable: the three
	 * helpers it imports were exported by the JS and absent from the declarations,
	 * so `tsgo` refused the import and the suite never ran.
	 */
	it("declares every function the implementation exports", () => {
		const declared = declaredExports();
		const undeclared = implementationExports().filter(name => !declared.includes(name));

		expect(
			undeclared,
			"these are exported by loader-state.js and cannot be imported from TypeScript; declare them in loader-state.d.ts",
		).toEqual([]);
	});

	/**
	 * A declaration with no implementation is worse than a missing one: it type-checks
	 * and fails at the call site.
	 */
	it("declares nothing the implementation does not export", () => {
		const implemented = implementationExports();
		const phantom = declaredExports().filter(name => !implemented.includes(name));

		expect(
			phantom,
			"these are declared in loader-state.d.ts and do not exist in loader-state.js; importing one is an undefined call at runtime",
		).toEqual([]);
	});

	/**
	 * The three helpers of the fail-closed candidate loop are named explicitly.
	 *
	 * They are the reason this file exists, and naming them keeps the list-versus-list
	 * assertions above from passing on a future tree where all three were deleted
	 * together with their declarations. The loop is the gate a "my native change did
	 * nothing" investigation lands on, so it must stay importable and therefore
	 * testable.
	 */
	it("keeps the candidate-loop helpers importable", () => {
		const declared = declaredExports();

		for (const name of ["classifyCandidateFailure", "brokenAddonSkippedMessage", "loadFirstUsableAddon"]) {
			expect(declared).toContain(name);
		}
	});
});
