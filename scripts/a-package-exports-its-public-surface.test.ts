/**
 * WHY THIS EXISTS. A package's barrel re-exports are its public API. A refactor that
 * un-exports a function, moves it behind a helper file without a re-export, or deletes
 * a type it thought was dead silently shrinks that surface, and every downstream
 * consumer that imported the name breaks at its next type check — not in the package
 * that lost the name, but in whatever consumer imported it, which may be in another
 * package or an external project. The tree has 12 publishable packages with `export *`
 * star re-exports chains that are several hops deep, so a removal at the leaf is
 * invisible in the diff and surfaces only when a distant consumer fails.
 *
 * WHAT THIS CLOSES. The class of defect is "a name that was part of the public API is
 * no longer exported." A helper-extraction campaign moved hundreds of free functions
 * from main modules to `-helpers.ts` companions; a dead-code sweep un-exported hundreds
 * more. Both are safe only if every name an external consumer could import is still
 * importable. This gate proves that by importing each package and comparing the
 * exported keys against a committed baseline.
 *
 * WHAT IT DOES. For each publishable package it dynamically imports the package's main
 * entry point, collects `Object.keys(mod)`, and asserts that the set is a superset of
 * the baseline. A name that disappeared from the baseline turns this red. A name that
 * was added is allowed: the baseline is a floor, not a ceiling, and the test prints a
 * hint to regenerate the baseline so the floor rises.
 *
 * WHAT IT DOES NOT CATCH. Type-only exports (`export type { Foo }`) are not visible to
 * `Object.keys` at runtime, so a type that was removed is not caught here. A type test
 * or a compile-time check is the right tool for that. This gate catches value exports
 * — functions, constants, classes, enums — which are the names a runtime import
 * resolves.
 *
 * HOW TO UPDATE. Add a new public export to a package, run the test, and it will tell
 * you the baseline is stale. Regenerate with:
 *
 *   bun run scripts/gen-package-exports-baseline.ts
 *
 * Then commit the updated baseline alongside the change that added the export.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BASELINE_PATH = path.join(REPO_ROOT, "scripts", "package-exports-baseline.json");

interface Baseline {
	[pkg: string]: string[];
}

const baseline: Baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));

/** Packages whose public API surface is gated. Each maps to its import specifier. */
const PACKAGES: Record<string, string> = {
	"@veyyon/ai": "@veyyon/ai",
	"@veyyon/catalog": "@veyyon/catalog",
	"@veyyon/utils": "@veyyon/utils",
	"@veyyon/tui": "@veyyon/tui",
	"@veyyon/agent-core": "@veyyon/agent-core",
	"@veyyon/wire": "@veyyon/wire",
	argot: "argot",
	"@veyyon/hashline": "@veyyon/hashline",
	"@veyyon/mnemopi": "@veyyon/mnemopi",
	"@veyyon/tool-render": "@veyyon/tool-render",
	"@veyyon/stats": "@veyyon/stats",
	"@veyyon/coding-agent": "@veyyon/coding-agent",
};

describe("a package exports its public surface", () => {
	for (const [label, spec] of Object.entries(PACKAGES)) {
		it(`${label} exports every name in the baseline`, async () => {
			// Dynamic import: the specifier is runtime-selected from the package table.
			// Static imports cannot iterate over a collection of packages.
			const mod = await import(spec);
			const exported = new Set(Object.keys(mod));
			const expected = baseline[label] ?? [];

			const missing = expected.filter(name => !exported.has(name));
			if (missing.length > 0) {
				throw new Error(
					`${label} lost ${missing.length} public export(s):\n` +
						missing.map(n => `  - ${n}`).join("\n") +
						`\n\nThese names were part of the public API and are no longer exported. ` +
						`Restore the export or update the baseline if the removal is intentional:\n` +
						`  bun run scripts/gen-package-exports-baseline.ts`,
				);
			}

			// New exports are allowed but reported.
			const added = [...exported].filter(name => !expected.includes(name));
			if (added.length > 0) {
				console.log(
					`${label} added ${added.length} new export(s). Regenerate the baseline:\n` +
						`  bun run scripts/gen-package-exports-baseline.ts`,
				);
			}

			expect(missing).toEqual([]);
		});
	}
});
