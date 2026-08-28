/**
 * WHY THIS EXISTS. Evaluating arktype costs 362ms on this workspace before a single schema is
 * built; the first schema afterwards costs 4.7ms and the next fifty 0.71ms each. So the price is
 * the library's module evaluation, and the only way not to pay it is not to reach the library.
 * A launch reached it through five paths that had nothing to do with validating a model's tool
 * call: a catalog descriptor table pulling five HTTP discovery readers, a usage report validator
 * declared at module scope, a `type.errors` instance check, a config-file error branch, and a
 * custom-theme validator loaded whether or not a custom theme exists.
 *
 * THE CLASS THIS CLOSES. Not "one module imported arktype" but "a launch pays for a request-time
 * validator". Each case below imports one module in a fresh process and then times
 * `import("arktype")`: a cached module answers in microseconds, an unevaluated one costs its
 * evaluation. So a new schema anywhere under `@veyyon/ai`, `@veyyon/catalog`, the theme layer or
 * the config layer turns this suite RED without anyone remembering to add a case.
 *
 * WHAT IT DOES NOT CATCH. The three modules in HOLDERS still reach arktype, and they are pinned
 * by exact equality so a fourth cannot join them quietly -- but a new arktype importer that sits
 * on none of the probed graphs is invisible here. The task tool's dynamic parameter schemas are
 * the reason the list is not empty: a tool's `parameters` must be a schema a provider can render
 * as JSON Schema, and that tool's wire format is owned elsewhere.
 */

import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../../../..");

/**
 * Milliseconds under which a second `import("arktype")` means the library was already evaluated.
 * Its evaluation measures ~300ms cold and a cached import is a map lookup, so the band between
 * them is two orders of magnitude wide and the threshold is not load-sensitive: a busy machine
 * makes an unevaluated import slower, never faster.
 */
const CACHED_IMPORT_CEILING_MS = 40;

/** Modules a launch reaches that must not carry a schema library with them. */
const CLEAN = [
	"packages/ai/src/stream.ts",
	"packages/ai/src/api-registry.ts",
	"packages/ai/src/usage.ts",
	"packages/catalog/src/provider-models/index.ts",
	"packages/coding-agent/src/theme/theme.ts",
	"packages/coding-agent/src/config/config-file.ts",
] as const;

/** Modules that still reach it, and are allowed to. */
const HOLDERS = [
	"packages/coding-agent/src/task/types.ts",
	"packages/coding-agent/src/tools/irc.ts",
	"packages/coding-agent/src/tools/review.ts",
] as const;

async function arktypeIsEvaluatedAfterImporting(moduleFile: string): Promise<boolean> {
	const code = `await import(${JSON.stringify(`./${moduleFile}`)});
const started = performance.now();
await import("arktype");
console.log(performance.now() - started);`;
	const { stdout } = await run("bun", ["-e", code], { cwd: repoRoot, maxBuffer: 1 << 24 });
	const elapsedMs = Number.parseFloat(stdout.trim().split("\n").at(-1) ?? "");
	if (!Number.isFinite(elapsedMs)) {
		throw new Error(`probe of ${moduleFile} printed no timing: ${stdout}`);
	}
	return elapsedMs < CACHED_IMPORT_CEILING_MS;
}

describe("a launch does not load a schema library it will not use", () => {
	for (const moduleFile of CLEAN) {
		it(`loads ${moduleFile} without evaluating arktype`, async () => {
			expect(await arktypeIsEvaluatedAfterImporting(moduleFile)).toBe(false);
		}, 60_000);
	}

	/**
	 * The other direction, so the exemption list cannot describe a state that no longer exists:
	 * a holder that stops reaching arktype must be moved out of HOLDERS rather than left there
	 * as a false claim about where the cost lives.
	 */
	for (const moduleFile of HOLDERS) {
		it(`still reaches arktype through ${moduleFile}`, async () => {
			expect(await arktypeIsEvaluatedAfterImporting(moduleFile)).toBe(true);
		}, 60_000);
	}

	/**
	 * Pinned by exact equality rather than by a count, so adding a fourth holder is a decision
	 * someone records here instead of a line that slips in beside three others.
	 */
	it("keeps the exemption list to the modules whose wire format is owned elsewhere", () => {
		expect([...HOLDERS]).toEqual([
			"packages/coding-agent/src/task/types.ts",
			"packages/coding-agent/src/tools/irc.ts",
			"packages/coding-agent/src/tools/review.ts",
		]);
	});
});
