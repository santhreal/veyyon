import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { moduleReach, moduleSpecifiersIn } from "@veyyon/utils/module-reach";

/**
 * Contracts: specifier extraction reads the CODE, and every match stays inside one statement.
 *
 * WHY THIS IS ITS OWN SUITE AND NOT MORE CASES IN `module-reach.test.ts`. That file tests what the walk
 * does with edges it has already been given: resolution order, diamonds, cycles, an unreadable file.
 * This one is about the step before it, where a defect does not look like a wrong answer to a question
 * but like a right answer to the wrong text. The two failure directions below are the reason every
 * architecture ceiling in this repo is only as honest as this function.
 *
 * THE DEFECT THIS SUITE EXISTS TO LOCK OUT, exactly as it happened. `FROM_IMPORT_RE` used to be
 *
 *     /(?:^|\n)[ \t]*(?:import|export)\s+(?!type[\s{*])[\s\S]*?\sfrom\s*["']([^"']+)["']/g
 *
 * and the `[\s\S]*?` in the middle crossed anything, including the end of the statement it started in.
 * Most `export`s are not re-exports, so `export const $env: Record<string, string> = Bun.env as ...;`
 * began a match, found no `from`, and ran FORWARD through the file until it found one.
 *
 * In `src/env.ts` it settled 140 lines later on a doc comment that says `import { $env } from
 * "@veyyon/utils"` as ADVICE TO THE READER. So `env.ts` was recorded as importing its own package
 * barrel, `moduleReach("src/env.ts")` returned all 74 modules of the barrel instead of its 8, and every
 * module that reached `env.ts` was credited with the whole of it. The ranking that decides which
 * imports to cut was reading a sentence in a comment as a dependency.
 *
 * IT ALSO HID EDGES, which is worse and is why this is a correctness suite rather than a tidiness one.
 * `String.prototype.matchAll` resumes after the END of a match, so every real import inside the span a
 * runaway swallowed was never examined. One non-re-export `export` above them was enough. A sweep over
 * all 22,539 `.ts`/`.tsx` files in this repo when the fix landed found 426 phantom specifiers being
 * counted (whole sentences, template-literal fragments, doc-comment examples) and 4 genuine imports
 * that had been invisible. Every gate built on this is an UPPER BOUND, so hidden edges pass silently:
 * that is the same blindness `module-reach.ts` was created to end, one layer lower down.
 */

let root = "";

/** Write `source` to `relative` inside the fixture tree, creating directories as needed. */
function write(relative: string, source: string): string {
	const file = path.join(root, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, source);
	return file;
}

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "module-reach-prose-"));
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("moduleSpecifiersIn reads code, not prose", () => {
	/**
	 * The `env.ts` case, reduced to its three ingredients: a value `export` with no `from`, a doc comment
	 * that shows an import as an example, and nothing else. The correct answer is that this module imports
	 * NOTHING. Anything else means a comment is being counted.
	 */
	it("does not count an import shown as an example inside a doc comment", () => {
		const source = [
			"export const $env: Record<string, string> = Bun.env as Record<string, string>;",
			"",
			"/**",
			" * Intentional re-export of Bun.env.",
			" *",
			' * All users should import this env module (import { $env } from "@veyyon/utils")',
			" * before using environment variables.",
			" */",
			"export function envValue(key: string): string | undefined {",
			"\treturn $env[key];",
			"}",
		].join("\n");

		expect(moduleSpecifiersIn(source)).toEqual([]);
	});

	/** A whole-line `//` comment is prose too, and an example in one is just as inert. */
	it("does not count an import shown as an example in a line comment", () => {
		const source = ['// Callers do: import { readFile } from "./io";', "export const READY = true;"].join("\n");

		expect(moduleSpecifiersIn(source)).toEqual([]);
	});

	/**
	 * A commented-OUT import is not an import. This is the case that makes the rule feel obviously right:
	 * deleting an import by commenting it is exactly how a cut gets tried, and a metric that still counts
	 * it reports the cut did nothing.
	 */
	it("does not count a commented-out import", () => {
		const source = [
			'// import { heavy } from "./heavy-subsystem";',
			'/* import { alsoHeavy } from "./also-heavy"; */',
			'import { light } from "./light";',
		].join("\n");

		expect(moduleSpecifiersIn(source)).toEqual(["./light"]);
	});

	/**
	 * A trailing comment AFTER a real import must not take the import with it. The specifier is already
	 * captured by then, and a rule that cut the line would delete a genuine edge to prevent a phantom.
	 */
	it("still counts a real import that carries a trailing comment", () => {
		const source = 'import { logger } from "./logger"; // 15 modules, not the barrel\n';

		expect(moduleSpecifiersIn(source)).toEqual(["./logger"]);
	});

	/**
	 * A specifier may legitimately contain `//`, so comment stripping cuts a line comment only at the
	 * START of a line. Cutting at the first slash pair anywhere would erase this edge.
	 */
	it("counts a specifier that contains a double slash", () => {
		const source = 'import { shim } from "https://esm.sh/left-pad";\n';

		expect(moduleSpecifiersIn(source)).toEqual(["https://esm.sh/left-pad"]);
	});
});

describe("moduleSpecifiersIn keeps every match inside one statement", () => {
	/**
	 * The runaway, in its smallest form: a value `export` with no `from`, and a real import BELOW it. Both
	 * halves of the old bug show up here at once. The old pattern reported `./far-away` as an edge of the
	 * `export const` statement, and because the match ended there, `./near` between them was never seen.
	 */
	it("does not let a value export reach forward to a later from clause", () => {
		const source = [
			"export const LIMIT = 10;",
			'import { near } from "./near";',
			"export function pick(): number {",
			"\treturn LIMIT;",
			"}",
			'export { far } from "./far-away";',
		].join("\n");

		expect(moduleSpecifiersIn(source)).toEqual(["./near", "./far-away"]);
	});

	/** An exported type alias whose right-hand side mentions no module must not borrow a later one. */
	it("does not let an exported type alias reach forward", () => {
		const source = [
			"export type Mode = 'read' | 'write';",
			"export interface Options {",
			"\tmode: Mode;",
			"}",
			'import { open } from "./open";',
		].join("\n");

		expect(moduleSpecifiersIn(source)).toEqual(["./open"]);
	});

	/**
	 * An exported class is the same shape and the one most likely to sit at the top of a heavy module,
	 * which is precisely where a runaway does the most damage to the ranking.
	 */
	it("does not let an exported class reach forward", () => {
		const source = [
			"export class Manager {",
			"\tstatic #instance: Manager | undefined;",
			"\tstatic instance(): Manager | undefined {",
			"\t\treturn Manager.#instance;",
			"\t}",
			"}",
			'export type { Manager as ManagerType } from "./manager-types";',
		].join("\n");

		// The `export type { … } from` line is type-only, so the correct answer is no runtime edge at all.
		expect(moduleSpecifiersIn(source)).toEqual([]);
	});

	/**
	 * And the forms that legitimately DO reach a `from` still work, including across newlines, because
	 * tightening the middle is only correct if it tightens around real syntax. A formatter breaks a long
	 * braced import as soon as it exceeds the line width, and a pattern that stopped at the newline would
	 * report the edge vanished when only its formatting changed.
	 */
	it("counts every real import and re-export form", () => {
		const source = [
			'import "./side-effect";',
			'import def from "./default";',
			'import * as ns from "./namespace";',
			'import { a, b as c } from "./named";',
			"import {",
			"\tlongNameOne,",
			"\tlongNameTwo,",
			"\ttype ErasedName,",
			'} from "./multi-line";',
			'import mixed, { alsoMixed } from "./mixed";',
			'export * from "./star";',
			'export * as reNs from "./star-as";',
			'export { d, e as f } from "./re-export";',
		].join("\n");

		expect(moduleSpecifiersIn(source)).toEqual([
			"./side-effect",
			"./default",
			"./namespace",
			"./named",
			"./multi-line",
			"./mixed",
			"./star",
			"./star-as",
			"./re-export",
		]);
	});
});

describe("moduleReach counts what a phantom edge used to inflate", () => {
	/**
	 * End to end, on real files, because the extraction bug only mattered through the walk: a phantom
	 * specifier is only harmful if it RESOLVES, and then it drags in a whole real subtree.
	 *
	 * `leaf.ts` here is `env.ts`: it imports one sibling and documents an example import of the barrel.
	 * The barrel is genuinely expensive (it reaches three more modules). Reach of `leaf.ts` must be 2,
	 * itself and its sibling. Under the old pattern it was 6, and so was every module that reached it.
	 */
	it("does not follow a specifier that appears only in a comment", () => {
		const leaf = write(
			"comment/leaf.ts",
			[
				'import { helper } from "./helper";',
				"",
				"/**",
				' * Prefer this module over the barrel: `import { leaf } from "@scope/pkg"` also works,',
				" * but costs the whole barrel.",
				" */",
				"export function leaf(): string {",
				"\treturn helper();",
				"}",
			].join("\n"),
		);
		write("comment/helper.ts", "export function helper(): string {\n\treturn 'x';\n}\n");
		const barrel = write(
			"comment/barrel.ts",
			['export * from "./heavy-one";', 'export * from "./heavy-two";', 'export * from "./heavy-three";'].join("\n"),
		);
		for (const name of ["heavy-one", "heavy-two", "heavy-three"]) {
			write(`comment/${name}.ts`, `export const value = "${name}";\n`);
		}

		// The barrel really is expensive, so a phantom edge to it would be unmistakable in the count.
		expect(moduleReach(barrel).size).toBe(4);

		const reached = [...moduleReach(leaf, { packages: [["@scope/pkg", barrel]] })]
			.map(file => path.relative(root, file))
			.sort();

		expect(reached).toEqual([path.join("comment", "helper.ts"), path.join("comment", "leaf.ts")]);
	});

	/**
	 * The hiding direction, end to end. `top.ts` opens with a value `export`, and the import below it is
	 * the ONLY path to `real-dependency.ts`. Under the old pattern the runaway consumed the import line
	 * and the walk never reached that module, so a gate asserting an upper bound on `top.ts` passed while
	 * measuring a graph with a hole in it.
	 */
	it("follows an import that sits below a value export", () => {
		const top = write(
			"hidden/top.ts",
			[
				"export const CONFIGURED: Record<string, number> = { limit: 10 };",
				'import { dependency } from "./real-dependency";',
				"export function use(): number {",
				"\treturn dependency() + CONFIGURED.limit;",
				"}",
			].join("\n"),
		);
		write(
			"hidden/real-dependency.ts",
			['import { deeper } from "./deeper";', "export function dependency(): number {", "\treturn deeper;", "}"].join(
				"\n",
			),
		);
		write("hidden/deeper.ts", "export const deeper = 1;\n");

		const reached = [...moduleReach(top)].map(file => path.relative(root, file)).sort();

		expect(reached).toEqual([
			path.join("hidden", "deeper.ts"),
			path.join("hidden", "real-dependency.ts"),
			path.join("hidden", "top.ts"),
		]);
	});
});
