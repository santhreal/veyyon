import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { promptSectionNames, templateSectionNames } from "@veyyon/coding-agent/system-prompt-builder/prompt-sections";

/**
 * No module in this pair may read the other's bindings while it is evaluating.
 *
 * WHY THIS SUITE EXISTS (PROMPT-SECTIONS-INIT-ORDER-FLAKE). A run of
 * `bun test` on 2026-07-24 died at import time with
 * `ReferenceError: BANNERED_TEMPLATE_SECTIONS is not defined`, thrown from
 * `prompt-sections.ts` while it was evaluating its own module body. That is not
 * a failing test, it is the process aborting: 17 of 66 cases ran and the rest
 * never started. The same command passed before and after, and each of the three
 * files passed alone, so it depended on the order Bun happened to evaluate
 * modules in rather than on anything under test.
 *
 * The obvious explanation was ruled out: the import graph inside
 * `src/system-prompt-builder/` is acyclic, and `section-registry.ts` imports nothing
 * but a helper from `@veyyon/utils`, so it cannot be re-entered through
 * `prompt-sections.ts`. With nothing to point at, the fix is to remove the
 * hazard rather than the cycle: `prompt-sections.ts` used to derive three values
 * by reading imported bindings at module top level, and a top-level read of an
 * imported binding is exactly what makes a value depend on evaluation order. If
 * any ordering ever puts this module first, the binding is in its temporal dead
 * zone and the read throws.
 *
 * The derivations are now computed on first CALL, by which time the graph is
 * fully evaluated, so no ordering can observe them early. These cases pin both
 * halves of that: the results are still correct and still memoized, and the
 * source no longer contains a top-level read that could reintroduce the hazard.
 */

describe("the derived section names are correct", () => {
	/**
	 * The lazy form must return what the eager one did. A memoization bug that
	 * returned an empty array would leave every section unrecognised, and the
	 * splitter reports an unrecognised banner by folding the section into its
	 * predecessor rather than by failing.
	 */
	it("derives a non-trivial list of prompt section names", () => {
		const names = promptSectionNames();

		expect(names.length).toBeGreaterThan(3);
		expect(names).toContain("role");
	});

	/** The template subset is a real subset of the whole, not a copy of it. */
	it("derives template section names that are a proper subset of the whole", () => {
		const template = templateSectionNames();
		const all = promptSectionNames();

		expect(template.length).toBeGreaterThan(0);
		expect(template.length).toBeLessThan(all.length);
		for (const name of template) expect(all).toContain(name);
	});

	/** Every name is a non-empty string: an undefined id would stringify to "undefined". */
	it("derives no empty or undefined names", () => {
		for (const name of promptSectionNames()) {
			expect(typeof name).toBe("string");
			expect(name.length).toBeGreaterThan(0);
		}
	});
});

describe("the derivation is memoized", () => {
	/**
	 * These are called on hot paths (every profile validation, every reorder), so
	 * the deferral must not turn one map into one map per call. Identity is the
	 * assertion because a fresh equal array would pass a value comparison.
	 */
	it("returns the same array instance on every call", () => {
		expect(promptSectionNames()).toBe(promptSectionNames());
		expect(templateSectionNames()).toBe(templateSectionNames());
	});
});

describe("the source keeps no top-level read of the registry", () => {
	const sourcePath = path.join(import.meta.dir, "..", "..", "src", "system-prompt-builder", "prompt-sections.ts");

	/**
	 * THE LOCK. Everything above still passes if someone reintroduces
	 * `export const X = BANNERED_SECTIONS.map(...)` alongside the functions,
	 * because the values would be identical. The hazard is the top-level READ,
	 * not the value, so the source itself is what has to be checked.
	 *
	 * Read line by line and ignore indented lines: a read inside a function body
	 * is fine and is the whole point of the fix. Only a read at column zero of a
	 * statement runs during module evaluation.
	 */
	it("references the imported registry only from inside function bodies", async () => {
		const source = await Bun.file(sourcePath).text();
		const offenders = source
			.split("\n")
			.filter(line => /^(?:export\s+)?(?:const|let|var)\s/.test(line))
			.filter(line => /\bBANNERED_(?:TEMPLATE_)?SECTIONS\b/.test(line));

		expect(offenders).toEqual([]);
	});

	/**
	 * The import itself must stay a plain named import. An `import * as registry`
	 * followed by a top-level `registry.BANNERED_SECTIONS` would evade the check
	 * above while reintroducing exactly the same evaluation-order dependency.
	 *
	 * Asserted as a PROPERTY of the import rather than as its exact text. This test
	 * used to pin the whole line, which made it fail for reasons that had nothing to
	 * do with load order: adding a symbol to the import broke it, and so did moving
	 * the banner grammar out to its own module. A guard that fires on correct
	 * refactors teaches the reader to edit the expected string without thinking,
	 * which is how it stops guarding anything.
	 */
	it("imports the registry by name rather than as a namespace", async () => {
		const source = await Bun.file(sourcePath).text();

		const named = /^import \{[^}]*\} from "\.\/section-registry";$/m.exec(source);
		expect(named, "the registry import is missing or is no longer a named import").not.toBeNull();
		// The bindings the load-order checks above are written against must be the
		// ones actually imported, or those checks scan for a name nothing uses.
		expect(named?.[0]).toContain("BANNERED_SECTIONS");
		expect(named?.[0]).toContain("BANNERED_TEMPLATE_SECTIONS");
		expect(source).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s+"\.\/section-registry"/);
	});
});
