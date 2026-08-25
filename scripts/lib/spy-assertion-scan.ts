/**
 * Scanning test sources for fakes, without being fooled by prose.
 *
 * The gate that uses this (`a-test-proves-behavior-not-that-a-spy-was-called`)
 * names the very patterns it rejects, and so do several test files that carry a
 * comment explaining why they avoid `mock.module`. One file also embeds a whole
 * test program in a template literal as a fixture. A naive substring scan reads
 * all of those as offenders, reports five violations nobody may fix, and gets
 * switched off within the week.
 *
 * So the scan strips comments and string bodies first, and the stripping is
 * asserted by the gate rather than assumed.
 *
 * Owned here rather than inside the gate because the grandfather ledger has to
 * be produced by exactly the same counting the gate applies; two copies of this
 * logic would drift and the ledger would stop meaning anything.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Directories holding source we do not own or do not ship. */
const SKIPPED_DIRS = new Set(["vendor", "node_modules", "repo-cache", "dist", "build", ".git", "book"]);

/** Bun's module-registry mock, which leaks across files (oven-sh/bun#12823). */
const MOCK_MODULE = /\bmock\.module\s*\(/;

/**
 * Spy-call assertions, assembled from fragments so this module does not match
 * its own pattern when the gate reads the repository.
 */
const SPY_ASSERTION = new RegExp(["toHaveBeen", "(?:Called|LastCalledWith|NthCalledWith)", "\\w*"].join(""), "g");

/**
 * Replace comment and string bodies with spaces, preserving length and line
 * structure so any position reported downstream still lines up with the file.
 *
 * This is a scanner, not a parser: it tracks the five states that matter for
 * hiding an identifier — line comment, block comment, single-quoted, double
 * quoted, and template literal — and honors backslash escapes inside strings.
 * A template literal's `${...}` interpolation is left as code, because a real
 * call written inside one is a real call.
 */
export function stripCommentsAndStrings(source: string): string {
	const out: string[] = [];
	let index = 0;
	// Depth of `${...}` nesting, so the closing brace returns to template text.
	const templateStack: number[] = [];
	let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";

	const blank = (character: string): string => (character === "\n" ? "\n" : " ");

	while (index < source.length) {
		const character = source[index] as string;
		const next = source[index + 1];

		if (state === "code") {
			if (character === "/" && next === "/") {
				state = "line";
				out.push("  ");
				index += 2;
				continue;
			}
			if (character === "/" && next === "*") {
				state = "block";
				out.push("  ");
				index += 2;
				continue;
			}
			if (character === "'") {
				state = "single";
				out.push("'");
				index += 1;
				continue;
			}
			if (character === '"') {
				state = "double";
				out.push('"');
				index += 1;
				continue;
			}
			if (character === "`") {
				state = "template";
				out.push("`");
				index += 1;
				continue;
			}
			if (character === "}" && templateStack.length > 0) {
				templateStack.pop();
				state = "template";
				out.push("}");
				index += 1;
				continue;
			}
			out.push(character);
			index += 1;
			continue;
		}

		if (state === "line") {
			if (character === "\n") state = "code";
			out.push(blank(character));
			index += 1;
			continue;
		}

		if (state === "block") {
			if (character === "*" && next === "/") {
				state = "code";
				out.push("  ");
				index += 2;
				continue;
			}
			out.push(blank(character));
			index += 1;
			continue;
		}

		// Inside a string or template body.
		if (character === "\\") {
			out.push("  ".slice(0, Math.min(2, source.length - index)));
			index += 2;
			continue;
		}
		if (state === "template" && character === "$" && next === "{") {
			templateStack.push(1);
			state = "code";
			out.push("${");
			index += 2;
			continue;
		}
		if (
			(state === "single" && character === "'") ||
			(state === "double" && character === '"') ||
			(state === "template" && character === "`")
		) {
			state = "code";
			out.push(character);
			index += 1;
			continue;
		}
		out.push(blank(character));
		index += 1;
	}

	return out.join("");
}

/** Spy-call assertions in `source`, ignoring comments and string bodies. */
export function countSpyAssertions(source: string): number {
	return stripCommentsAndStrings(source).match(SPY_ASSERTION)?.length ?? 0;
}

/** `true` when `source` really calls `mock.module(`, not merely mentions it. */
export function usesMockModule(source: string): boolean {
	return MOCK_MODULE.test(stripCommentsAndStrings(source));
}

/** Every `*.test.ts` under `packages/` and `scripts/`, excluding `exclude`. */
export function testFiles(repoRoot: string, exclude: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
				continue;
			}
			if (entry.name.endsWith(".test.ts") && entry.name !== exclude) found.push(path.join(dir, entry.name));
		}
	};
	for (const base of ["packages", "scripts"]) {
		const root = path.join(repoRoot, base);
		if (fs.existsSync(root)) walk(root);
	}
	return found.sort();
}
