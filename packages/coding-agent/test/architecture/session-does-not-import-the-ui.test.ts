import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";

const SRC = path.join(import.meta.dir, "..", "..", "src");
const SESSION = path.join(SRC, "session");

/**
 * `modes/` is the interactive terminal UI. `session/` is the conversation engine
 * underneath it. The dependency runs one way, UI on top of session, and this
 * asserts it.
 *
 * WHY IT NEEDS A GATE RATHER THAN A CONVENTION. Every violation arrived as one
 * convenient import of something small and true: "does this message mention
 * ultrathink", "what colour is the active theme". Each pulled in a module that
 * also owned a piece of terminal rendering, and through it
 * `modes/gradient-highlight` and the 108-module theme engine. Three keyword
 * modules did this, each mixing a text predicate with an editor gradient, and
 * `session/agent-session` imported all three. Nothing failed, so nothing objected.
 *
 * The fix in each case was to split the file rather than to argue about the
 * import: detection into a leaf, drawing left where it was, both re-exported from
 * the original path so no other caller had to change. If you are here because this
 * test failed, that is the move to copy. Adding your module to the list below is
 * almost never the right answer, and the list says what each entry had to prove.
 */
const ALLOWED = new Map<string, string>([
	[
		"modes/theme/theme-binding",
		"The live `theme` binding and nothing else. Imports one type and no values, which `test/theme/theme-binding-stays-live.test.ts` asserts, so it cannot bring the engine back.",
	],
	[
		"modes/orchestrate-keyword",
		"Detection half of the `orchestrate` keyword. The gradient that paints it stays in `modes/orchestrate`.",
	],
	[
		"modes/ultrathink-keyword",
		"Detection half of the `ultrathink` keyword. The gradient stays in `modes/ultrathink`.",
	],
	[
		"modes/workflow-keyword",
		"Detection half of the `workflowz` keyword, plus the notice renderer. The gradient stays in `modes/workflow`.",
	],
	["modes/turn-budget", "Parses a turn budget out of message text. No rendering."],
	["modes/utils/context-usage", "Computes context usage numbers. Formatting them is the caller's job."],
]);

/*
 * THE EXTRACTION IS NOT DEFINED HERE. It used to be, as a copy of two patterns, and the first of them was
 * the buggy version: a `[\s\S]*?` middle does not stop at the end of a statement, so a non-re-export
 * `export` ran forward to the next `from "…"` in the file and every real import inside the swallowed span
 * went unexamined. This gate is an absence check, so a hidden import PASSES.
 * `@veyyon/utils/module-reach` owns the extraction and
 * `packages/utils/test/module-reach-reads-code-not-prose.test.ts` pins both directions of that bug.
 */

/** Every `.ts` file under `session/`, recursively. */
function sessionFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sessionFiles(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** Specifiers a file imports at runtime, resolved to `src`-relative module paths. */
function uiImportsIn(file: string): string[] {
	const found: string[] = [];
	for (const specifier of specifiersIn(file)) {
		if (!specifier.startsWith(".")) continue;
		const resolved = path.resolve(path.dirname(file), specifier);
		const rel = path.relative(SRC, resolved).replace(/\\/g, "/");
		if (rel.startsWith("modes/")) found.push(rel);
	}
	return found;
}

/** Raw specifiers a file imports at runtime, unresolved. */
function specifiersIn(file: string): string[] {
	return moduleSpecifiersIn(fs.readFileSync(file, "utf-8"));
}

describe("session does not import the terminal UI", () => {
	const files = sessionFiles(SESSION);

	/**
	 * Anti-vacuity first. A bug in the walker or the pattern would make every case
	 * below pass by finding nothing, and this is the whole suite's foundation.
	 */
	it("reads a real, non-trivial set of session modules", () => {
		expect(files.length).toBeGreaterThan(10);
		expect(files.some(file => file.endsWith("agent-session.ts"))).toBe(true);
	});

	/**
	 * The rule. Reported as a list of `file -> module` pairs rather than one
	 * boolean, because the useful information on failure is which import to look at.
	 */
	it("imports nothing from modes/ outside the allowed leaves", () => {
		const violations: string[] = [];
		for (const file of files) {
			for (const target of uiImportsIn(file)) {
				if (ALLOWED.has(target)) continue;
				violations.push(`${path.relative(SRC, file)} -> ${target}`);
			}
		}

		expect(violations).toEqual([]);
	});

	/**
	 * The allow-list stays honest. An entry that no session file imports any more is
	 * a door left open: it reads as sanctioned, so the next person adds an import to
	 * it rather than asking whether the layering is right.
	 */
	it("has no stale entries in the allow-list", () => {
		const used = new Set(files.flatMap(uiImportsIn));
		const unused = [...ALLOWED.keys()].filter(allowed => !used.has(allowed));

		expect(unused).toEqual([]);
	});

	/**
	 * The one that actually holds the line, and the reason the rule is worth a test
	 * rather than a comment. `gradient-highlight` reaches the theme engine, and the
	 * three keyword leaves exist precisely so that nothing in `session/` reaches it.
	 * A leaf that re-acquired the import would still satisfy the allow-list above.
	 *
	 * Matched against the IMPORTS, not the raw text: each of these files explains in
	 * a comment why it does not import the highlighter, and naming it there is
	 * correct. A substring check over the whole source fails on the explanation.
	 */
	it.each(["modes/orchestrate-keyword", "modes/ultrathink-keyword", "modes/workflow-keyword"])(
		"%s does not import the gradient highlighter",
		relative => {
			const file = path.join(SRC, `${relative}.ts`);

			expect(uiImportsIn(file).concat(specifiersIn(file))).not.toContain("./gradient-highlight");
		},
	);
});
