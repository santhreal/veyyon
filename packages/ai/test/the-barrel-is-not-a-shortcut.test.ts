/**
 * ONE-PLACE lock: a file that wants one function from `@veyyon/ai` names the module that declares it.
 *
 * WHY THIS IS NOT A STYLE RULE. `@veyyon/ai`'s entry point re-exports the package: the streaming engine, every
 * provider, the model catalogue, the error taxonomy, the usage backends. It reaches 363 modules. Importing a
 * NAME from it costs all of them, and importing a TYPE from it costs nothing at all, because type imports are
 * erased. Those two lines look identical, differ by one keyword, and differ by 363 modules.
 *
 * That is what made this accumulate silently. Every one of the files repointed below was written by someone
 * who wanted a single predicate or a retry wrapper, took it from the obvious place, and paid for the engine:
 *
 *   - `agent/src/proxy.ts` wanted `EventStream`, a 42-module class. 364 modules -> 118.
 *   - `stats/src/parser.ts` wanted three service-tier helpers declared in `types.ts`, which reaches 5. It is a
 *     SESSION FILE PARSER; it has no use for a provider. 366 -> 103, and `db.ts` and `sync-worker.ts` behind
 *     it went from 367 and 366 to 105 and 104.
 *   - `mnemopi/src/core/embeddings.ts` wanted a retry wrapper and a header builder. 369 -> 110.
 *   - `mnemopi/src/core/extraction/client.ts` wanted the same retry wrapper. 367 -> 105.
 *   - `coding-agent/src/config/api-key-resolver.ts` wanted `isUsageLimitOutcome`, a predicate over a status
 *     code in a module with NO imports. 364 -> 42.
 *   - `coding-agent/src/mcp/manager.ts` wanted a string test. 613 -> 498.
 *   - `coding-agent/src/commit/shared-llm.ts` wanted arktype's `type`, which this package only re-exports, and
 *     one validator. 368 -> 112.
 *   - `coding-agent/src/web/search/providers/perplexity.ts` wanted an OAuth retry wrapper. 372 -> 327.
 *
 * WHAT IS STILL ALLOWED, and it is most of the remaining list. `completeSimple` and `streamSimple` ARE the
 * engine, so a module that calls one of them reaches it whichever specifier it uses. The rule below is about
 * names whose owner is cheap, so it names the exemptions explicitly rather than trying to infer them.
 *
 * WHY A RATCHET. Nothing fails when a barrel import comes back. The code works, the tests pass, and the only
 * thing that moves is a number nobody looks at, so the number is what is pinned.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createModuleReachCache, type ModuleReachResolution, moduleReachCount } from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution } from "@veyyon/utils/module-reach-workspace";

const PACKAGES = path.join(import.meta.dir, "..", "..");
const REPO_ROOT = path.join(PACKAGES, "..");

const RESOLUTION: ModuleReachResolution = workspaceModuleReachResolution(REPO_ROOT);
const CACHE = createModuleReachCache();

function reach(relative: string): number {
	return moduleReachCount(path.join(PACKAGES, relative), RESOLUTION, CACHE);
}

/** Every `.ts` under `packages/<pkg>/src`, which is the set a "nowhere in this repo" claim has to cover. */
function sourceFiles(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "vendor" || entry.name === "dist") continue;
			sourceFiles(full, found);
		} else if (entry.name.endsWith(".ts")) {
			found.push(full);
		}
	}
	return found;
}

const SOURCES: Array<readonly [string, string]> = fs
	.readdirSync(PACKAGES, { withFileTypes: true })
	.filter(entry => entry.isDirectory())
	.map(entry => path.join(PACKAGES, entry.name, "src"))
	.filter(dir => fs.existsSync(dir))
	.flatMap(dir => sourceFiles(dir))
	.map(file => [path.relative(PACKAGES, file).replaceAll("\\", "/"), fs.readFileSync(file, "utf-8")] as const);

/**
 * The runtime names a file takes from the `@veyyon/ai` entry point.
 *
 * Braced form only, and `type X` members dropped, because those are the two things the rule turns on: a
 * type is free and a value is not, and the clause is where the difference is written.
 */
function barrelRuntimeNames(source: string): string[] {
	const names: string[] = [];
	for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@veyyon\/ai["']/g)) {
		for (const raw of (match[1] ?? "").split(",")) {
			const name = raw.trim();
			if (name && !name.startsWith("type ")) names.push(name);
		}
	}
	return names;
}

/**
 * Single names whose owner is the ENGINE, so the barrel costs nothing extra.
 *
 * `completeSimple` and `streamSimple` are declared in `stream.ts`, which reaches 299 modules on its own; a
 * module that calls one of them has already bought the engine and repointing it would move nothing. Listed
 * rather than inferred, so that adding a cheap name to this set is a decision somebody had to write down.
 */
const ENGINE_NAMES: ReadonlySet<string> = new Set(["completeSimple", "streamSimple"]);

describe("nobody takes one cheap name from the whole package", () => {
	/**
	 * NON-VACUITY, first. Every case here is "no file does X", which an empty scan answers for free, and this
	 * scan walks the whole monorepo. The named file is one that really does import from the barrel.
	 */
	it("reads every package's sources", () => {
		expect(SOURCES.length).toBeGreaterThan(500);
		expect(SOURCES.some(([relative]) => relative === "agent/src/agent.ts")).toBe(true);
		expect(SOURCES.some(([, source]) => barrelRuntimeNames(source).length > 0)).toBe(true);
	});

	/**
	 * THE RULE. A file taking exactly one runtime name from the barrel is paying 363 modules for it, unless
	 * that name is the engine, in which case it was paying anyway.
	 *
	 * A file taking several names is left alone deliberately: splitting the import into three owner
	 * specifiers removes no edge if any one of them is expensive, and the rule for that case is already
	 * recorded in `coding-agent/test/architecture/leveraged-imports-stay-cut.test.ts`.
	 */
	it("no file takes a single non-engine runtime name from the barrel", () => {
		const offenders = SOURCES.filter(([, source]) => {
			const names = barrelRuntimeNames(source);
			return names.length === 1 && !ENGINE_NAMES.has(names[0] as string);
		}).map(([relative]) => relative);

		expect(offenders, "import it from the module that declares it; @veyyon/ai reaches 363 modules").toEqual([]);
	});

	/**
	 * NON-VACUITY for the rule above, and the reason it needs its own case: the detector is a regex over an
	 * import clause, and a formatting change is exactly what defeats that class of pattern. If it stopped
	 * matching, the rule would pass on a repository full of violations.
	 *
	 * The engine names are the proof, because they are the ones the rule deliberately allows: they must be
	 * FOUND and then excused, not missed.
	 */
	it("the detector really finds single-name barrel imports", () => {
		const singles = SOURCES.filter(([, source]) => barrelRuntimeNames(source).length === 1).map(
			([relative]) => relative,
		);

		expect(singles.length).toBeGreaterThan(5);
		expect(singles).toContain("coding-agent/src/utils/title-generator.ts");
	});
});

describe("the modules that were repointed stay cut", () => {
	/**
	 * Ceilings, one per file, each a little above its measurement so an unrelated dependency does not fail
	 * the gate while a returned barrel import does. The numbers are the point: without them the rule above is
	 * satisfied by a file that takes TWO names from the barrel, which costs exactly the same.
	 */
	it.each([
		["agent/src/proxy.ts", 130],
		["stats/src/parser.ts", 115],
		["stats/src/db.ts", 120],
		["stats/src/sync-worker.ts", 120],
		["mnemopi/src/core/embeddings.ts", 125],
		["mnemopi/src/core/extraction/client.ts", 120],
		["coding-agent/src/config/api-key-resolver.ts", 55],
		["coding-agent/src/commit/shared-llm.ts", 125],
		// The agent's hot loop and the `Agent` class. Both STREAM, so both reach the engine whatever
		// specifier they use; the ceilings are what the other ten names cost when taken from the entry
		// point. 378 -> 321 and 380 -> 323.
		["agent/src/agent-loop.ts", 340],
		["agent/src/agent.ts", 340],
	])("%s reaches at most %i modules", (relative, ceiling) => {
		expect(reach(relative)).toBeLessThanOrEqual(ceiling);
	});

	/**
	 * And none of them names the barrel at runtime any more, asserted as the SPECIFIER because that is the
	 * thing a future edit would change. A ceiling alone cannot say WHY a file grew; this says what to undo.
	 */
	it.each([
		"agent/src/proxy.ts",
		"stats/src/parser.ts",
		"mnemopi/src/core/embeddings.ts",
		"mnemopi/src/core/extraction/client.ts",
		"coding-agent/src/config/api-key-resolver.ts",
		"coding-agent/src/mcp/manager.ts",
		"coding-agent/src/commit/shared-llm.ts",
		"coding-agent/src/web/search/providers/perplexity.ts",
		"agent/src/agent-loop.ts",
		"agent/src/agent.ts",
	])("%s takes no runtime name from the barrel", relative => {
		const source = SOURCES.find(([name]) => name === relative)?.[1];

		expect(source, `${relative} is missing from the scan`).toBeDefined();
		expect(barrelRuntimeNames(source as string)).toEqual([]);
	});

	/**
	 * The types are still imported, from the barrel, on purpose.
	 *
	 * This is the case that proves the cuts were made by moving VALUE imports rather than by deleting
	 * things. `import type` is erased at compile time, so the barrel is the right place to take a type from:
	 * it is the package's public vocabulary and it costs nothing.
	 */
	it("still takes its types from the barrel, which is free", () => {
		const proxy = SOURCES.find(([name]) => name === "agent/src/proxy.ts")?.[1] ?? "";

		expect(proxy).toContain('from "@veyyon/ai"');
		expect(proxy).toContain("AssistantMessageEvent");
	});
});
