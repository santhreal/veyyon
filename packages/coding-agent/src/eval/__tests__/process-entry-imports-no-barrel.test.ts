/**
 * Nothing reachable from the JS evaluator's process entry may import the `@veyyon/utils` barrel.
 *
 * WHY THIS SUITE EXISTS. The barrel loads dotenv at import time. The JS evaluator runs in a subprocess
 * whose environment is chosen by the parent, and profile bootstrap decides which `.env` applies, so a
 * `.env` read during module loading applies the WRONG file: the one next to whatever directory the
 * subprocess happens to start in. `process-entry.ts` says this in a comment at the top, and
 * `process-entry-import.test.ts` proves the end result by spawning the entry with a planted `.env` and
 * asserting the probe variable never arrives.
 *
 * That end-to-end test is the contract, but it points at the symptom. It went red because
 * `tools/tool-errors.ts`, seven modules deep in the entry's import graph, imported `errorMessage` and
 * `isAbortError` from the barrel instead of from `@veyyon/utils/type-guards` and `@veyyon/utils/abortable`.
 * Reading a failing spawn tells you a `.env` was loaded; it does not tell you which of eleven modules did
 * it. This suite walks the actual import graph and names the file, so the next accidental barrel import is
 * a one-line diagnosis instead of a bisect.
 *
 * It resolves relative imports the way the runtime does rather than reading a manifest, because the defect
 * is a real edge in the graph and a manifest cannot have one.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const ENTRY = path.resolve(import.meta.dir, "../js/process-entry.ts");
const SRC_ROOT = path.resolve(import.meta.dir, "../..");

/** Resolve a relative specifier to a source file the same way the runtime does, or null if it is not one. */
async function resolveRelative(fromFile: string, specifier: string): Promise<string | null> {
	const base = path.resolve(path.dirname(fromFile), specifier);
	for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
		if (candidate.endsWith(".ts") && (await Bun.file(candidate).exists())) return candidate;
	}
	return null;
}

/** Every `from "..."` specifier in a source file, in source order. */
function specifiers(source: string): string[] {
	return [...source.matchAll(/from\s+"([^"]+)"/g)].map(match => match[1]);
}

interface Graph {
	/** Every source file reachable from the entry, including the entry. */
	files: string[];
	/** Files that import the `@veyyon/utils` barrel, which is the defect this suite forbids. */
	barrelImporters: string[];
}

/** Walk the entry's transitive relative-import graph. */
async function walkFromEntry(): Promise<Graph> {
	const visited = new Set<string>();
	const barrelImporters: string[] = [];
	const queue = [ENTRY];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (visited.has(file)) continue;
		visited.add(file);
		const source = await Bun.file(file).text();
		for (const specifier of specifiers(source)) {
			if (specifier === "@veyyon/utils") {
				barrelImporters.push(path.relative(SRC_ROOT, file));
				continue;
			}
			if (!specifier.startsWith(".")) continue;
			const resolved = await resolveRelative(file, specifier);
			if (resolved) queue.push(resolved);
		}
	}
	return { files: [...visited], barrelImporters };
}

describe("the JS evaluator's process entry", () => {
	/**
	 * The walk has to actually reach the module that broke this, or a passing result would mean nothing.
	 * `tools/tool-errors.ts` is the file that regressed and it sits behind `eval/js/shared/helpers.ts`, so
	 * both are asserted present: this pins that the traversal follows relative imports across directories
	 * and does not stop at the `eval/js` boundary.
	 */
	it("has an import graph that reaches the modules this test is meant to police", async () => {
		const { files } = await walkFromEntry();
		const relative = files.map(file => path.relative(SRC_ROOT, file));

		expect(relative).toContain("eval/js/process-entry.ts");
		expect(relative).toContain("eval/js/shared/helpers.ts");
		expect(relative).toContain("tools/tool-errors.ts");
		expect(relative.length).toBeGreaterThan(5);
	});

	/** The contract itself: no file in that graph pulls the dotenv-loading barrel. */
	it("imports no module that loads the @veyyon/utils barrel", async () => {
		const { barrelImporters } = await walkFromEntry();

		expect(barrelImporters).toEqual([]);
	});

	/**
	 * And the fix stays a subpath import rather than drifting back to the barrel. Asserting the two
	 * specifiers by name documents where these helpers actually live, which is the thing a future editor
	 * reaching for the barrel does not know.
	 */
	it("keeps tool-errors on subpath imports", async () => {
		const source = await Bun.file(path.join(SRC_ROOT, "tools/tool-errors.ts")).text();

		expect(specifiers(source)).toContain("@veyyon/utils/abortable");
		expect(specifiers(source)).toContain("@veyyon/utils/type-guards");
		expect(specifiers(source)).not.toContain("@veyyon/utils");
	});
});
