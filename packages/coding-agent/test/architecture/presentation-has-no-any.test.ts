/**
 * WHY: the presentation layer's whole job is to be a typed boundary. An `any`
 * in it does not fail to compile — it silently turns the contract into a
 * suggestion, and the first thing to break is a renderer receiving a field
 * whose shape nobody checked. The defect class is one `any` added to get past a
 * union that was awkward at the time.
 *
 * The rule is enforced by the type system where it can be, and here where it
 * cannot: TypeScript has no way to say "this directory contains no `any`", so
 * the declared annotations are read from source. That makes this a type-level
 * invariant expressed through the only surface that carries it.
 *
 * What it does NOT catch: an implicit `any` from an untyped dependency, which
 * `tsgo --noEmit` under `strict` already rejects, and a widening cast to
 * `unknown` followed by a narrow, which is the sanctioned spelling.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isDirectory, repoPath, repoRelative, typeScriptFiles } from "./helpers/module-graph";

const DIRECTORIES = [repoPath("packages/wire/src/presentation"), repoPath("packages/coding-agent/src/presentation")];

/**
 * The terminal modules written against the contract. The rest of the terminal
 * tree predates it and carries its own `any`s; those are not the boundary this
 * rule protects, and the boundary is what a browser client is written from.
 */
const TERMINAL_CONTRACT_MODULES = [
	repoPath("packages/coding-agent/src/modes/terminal/driver.ts"),
	repoPath("packages/coding-agent/src/modes/terminal/block-rows.ts"),
	repoPath("packages/coding-agent/src/modes/terminal/chrome-rows.ts"),
	repoPath("packages/coding-agent/src/modes/terminal/theme-ansi.ts"),
];

/**
 * `any` in a type position. Matches the annotation forms — `: any`, `as any`,
 * `<any>`, `any[]`, `Array<any>`, `Record<string, any>` — and not the substring
 * inside an identifier or a word in a comment.
 */
const ANY_IN_TYPE_POSITION = /(?:\bas\s+any\b|:\s*any\b|<\s*any\s*[,>]|\bany\s*\[\]|,\s*any\s*[,>])/g;

/** Strip comments and string literals so prose and messages cannot trip the scan. */
function codeOnly(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1")
		.replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
		.replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
		.replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

describe("the presentation layer declares no any", () => {
	test("every directory under the rule exists", () => {
		for (const directory of DIRECTORIES) expect(isDirectory(directory)).toBe(true);
	});

	test("no file declares any in a type position", () => {
		const offenders: string[] = [];
		const files = [...DIRECTORIES.flatMap(directory => typeScriptFiles(directory)), ...TERMINAL_CONTRACT_MODULES];
		for (const file of files) {
			const code = codeOnly(readFileSync(file, "utf8"));
			for (const match of code.matchAll(ANY_IN_TYPE_POSITION)) {
				offenders.push(`${repoRelative(file)}: ${match[0].trim()}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the scan finds an any that is really there", () => {
		// Without this, a broken pattern would report a clean layer forever.
		const planted = "function f(x: any): void {}\nconst y = z as any;\nconst r: Record<string, any> = {};";
		expect([...codeOnly(planted).matchAll(ANY_IN_TYPE_POSITION)].length).toBe(3);
	});

	test("the scan ignores the word in prose and in an identifier", () => {
		const innocent = '// any of these is fine\nconst anyValue: string = "any";\nfunction many(): void {}';
		expect([...codeOnly(innocent).matchAll(ANY_IN_TYPE_POSITION)]).toEqual([]);
	});
});
