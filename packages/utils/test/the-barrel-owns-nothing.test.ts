/**
 * `@veyyon/utils`'s barrel re-exports and defines nothing.
 *
 * WHY THIS SUITE EXISTS. `index.ts` re-exports about eighty leaf modules, and its
 * whole value is that nobody has to import it: a caller that wants `errorMessage`
 * imports `@veyyon/utils/type-guards` and pays for one module instead of eighty.
 * That only works while every name has a leaf to be imported from.
 *
 * One did not. `structuredCloneJSON` was DEFINED in the barrel, with a private
 * `isPlainObject` beside it, so the only way to get a deep copy was to import the
 * whole thing. Five files in `@veyyon/ai` did, which is part of how the barrel got
 * onto `tools/read.ts`'s module graph and turned a landed reach cut red. It lives in
 * `json.ts` now, where the other JSON helpers are.
 *
 * A definition in a barrel is easy to add and invisible afterwards: it looks like
 * every other export in the file. So the rule is checked rather than remembered, and
 * it is checked on the SOURCE rather than on the module's exports, because a runtime
 * check cannot tell a re-export from a definition.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const INDEX = path.join(import.meta.dir, "..", "src", "index.ts");
const source = fs.readFileSync(INDEX, "utf-8");

/** Lines of `index.ts` with block comments and `//` lines removed. */
function codeLines(): string[] {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter(line => !line.trim().startsWith("//"));
}

describe("the utils barrel", () => {
	/**
	 * Anti-vacuity. Every rule below is an absence over this file, so a path that
	 * stopped resolving, or a comment stripper that ate everything, would pass them
	 * all. The barrel is large and the count is stable; this asserts it is still the
	 * file it claims to be.
	 */
	it("is the re-export file it claims to be", () => {
		const lines = codeLines().filter(line => line.trim().length > 0);

		expect(lines.length).toBeGreaterThan(60);
		expect(lines.every(line => line.startsWith("export"))).toBe(true);
		expect(source).toContain('export * from "./type-guards";');
	});

	/**
	 * THE RULE. Every statement is a re-export, so no name can be reached ONLY
	 * through the barrel. Reported with the offending lines, because on failure the
	 * useful information is what got defined, not that something did.
	 */
	it("defines nothing of its own", () => {
		const definitions = codeLines().filter(line =>
			/^(export )?(async )?(function|const|let|var|class|interface|type|enum)\b/.test(line),
		);

		expect(definitions).toEqual([]);
	});

	/**
	 * The same rule from the other side: no statement that is not an export at all.
	 * A bare `function isPlainObject(...)` helper is how the last one arrived, and it
	 * is not caught by looking for `export`.
	 */
	it("has no statement that is not a re-export", () => {
		const strays = codeLines().filter(line => line.trim().length > 0 && !line.startsWith("export"));

		expect(strays).toEqual([]);
	});

	/**
	 * The name that was moved, pinned at its new home so a revert lands here rather
	 * than quietly reinstating the import that cost eighty modules. Asserted through
	 * the leaf import, which is the one that has to keep working.
	 */
	it("leaves structuredCloneJSON importable from the module that owns it", async () => {
		const { structuredCloneJSON } = await import("@veyyon/utils/json");
		const original = { a: 1, b: { c: [1, 2, 3] } };
		const copy = structuredCloneJSON(original);

		expect(copy).toEqual(original);
		expect(copy.b).not.toBe(original.b);
		expect(source).not.toContain("structuredCloneJSON");
	});

	/**
	 * And it still behaves the way its five callers rely on: a value `structuredClone`
	 * refuses comes back through the JSON round trip rather than throwing, and the
	 * non-JSON parts are dropped. `@veyyon/ai`'s validation path clones tool arguments
	 * that can hold a function default, so a throw here would be a crash on a request.
	 */
	it("falls back to a JSON round trip rather than throwing on a non-cloneable value", async () => {
		const { structuredCloneJSON } = await import("@veyyon/utils/json");

		const withFunction: Record<string, unknown> = { keep: 1, drop: () => 2 };

		expect(structuredCloneJSON(withFunction)).toEqual({ keep: 1 });
		expect(structuredCloneJSON([1, { nested: "x" }])).toEqual([1, { nested: "x" }]);
		expect(structuredCloneJSON("plain")).toBe("plain");
		expect(structuredCloneJSON(null)).toBe(null);
		expect(structuredCloneJSON(undefined)).toBe(undefined);
	});
});
