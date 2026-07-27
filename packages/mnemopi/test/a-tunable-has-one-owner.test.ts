/**
 * Every `MNEMOPI_*` tunable is read through `config.ts` and nowhere else.
 *
 * WHY THIS EXISTS. `config.ts` is the declared owner of mnemopi's Tier A knobs: one
 * exported accessor per environment variable, each naming the variable and its default in
 * one place. `core/beam/consolidate.ts` nonetheless called `envInt` on five of the same
 * variable names itself, with byte-identical defaults:
 *
 *     const TIER2_DAYS = envInt("MNEMOPI_TIER2_DAYS", 30);        // consolidate.ts
 *     export function tier2Days(env) { return envInt("MNEMOPI_TIER2_DAYS", 30, env); }
 *
 * Identical copies cost nothing until someone tunes one of them. Nothing compares the two,
 * so the tier boundary the consolidator applies and the one `config.tier2Days()` reports
 * would simply stop agreeing, and a reader looking up "what does MNEMOPI_TIER2_DAYS do"
 * would find the right answer in the wrong place.
 *
 * These tests pin the values the consolidator actually applies, so a drift in either
 * direction fails, and ratchet the class down with a source check: `envInt`, `envFloat`,
 * `envString`, `envOneOf` and `envBool` are for `config.ts` to call on a `MNEMOPI_*` name,
 * not for a module downstream of it.
 *
 * A RATCHET, NOT A CLEAN GATE, BECAUSE THE PROBLEM IS BIGGER THAN THE FIVE. Seven more
 * modules still parse `MNEMOPI_*` names themselves, and several of them duplicate each
 * other rather than only the owner: `MNEMOPI_LLM_ENABLED` is parsed in both
 * `core/local-llm-config.ts` and `core/extraction.ts`, and `MNEMOPI_HOST_LLM_PROVIDER` and
 * `MNEMOPI_HOST_LLM_MODEL` in both `core/extraction.ts` and `core/local-llm.ts`. That is
 * also why `config.ts`'s `llmThreads`, `llmContext`, `llmRepo`, `llmFile`, `llmModel`,
 * `hostLlmProvider`, `hostLlmModel` and `hostLlmContext` accessors have no caller: the
 * owner was not unused, it was bypassed. Those modules sit on live LLM paths, so they are
 * filed rather than swept up here, and the allowlist below is what stops the set from
 * growing while they wait.
 */

import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { degradeBatchSize, sleepBatchSize, tier2Days, tier3Days, tier3MaxChars } from "@veyyon/mnemopi/config";

const SRC = path.join(import.meta.dir, "..", "src");

/**
 * Files allowed to parse a `MNEMOPI_*` name because that IS their job: `config.ts` is the
 * owner, `util/env.ts` defines the parsers, and `diagnose.ts` reports the raw environment
 * back to the operator rather than deciding anything from it.
 */
const EXEMPT = new Set(["config.ts", path.join("util", "env.ts"), "diagnose.ts"]);

/**
 * Modules that still parse their own `MNEMOPI_*` names, with the debt each carries. This
 * list may only ever SHRINK. Adding to it is how a ratchet turns into a rubber stamp, and
 * the test below fails if an entry is removed from the code without being removed here.
 */
const KNOWN_BYPASSES = new Set([
	// Duplicates MNEMOPI_LLM_ENABLED with core/extraction.ts, and the MNEMOPI_LLM_* family
	// with config.ts's llmThreads/llmContext/llmRepo/llmFile/llmModel accessors.
	path.join("core", "local-llm-config.ts"),
	// Duplicates MNEMOPI_LLM_ENABLED with core/local-llm-config.ts and
	// MNEMOPI_HOST_LLM_PROVIDER/MODEL with core/local-llm.ts.
	path.join("core", "extraction.ts"),
	// Duplicates MNEMOPI_HOST_LLM_PROVIDER/MODEL with core/extraction.ts.
	path.join("core", "local-llm.ts"),
]);

/** Every `.ts` file under `packages/mnemopi/src`. */
async function sourceFiles(dir: string = SRC): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true, encoding: "utf8" })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
		else if (entry.name.endsWith(".ts")) found.push(full);
	}
	return found;
}

describe("the consolidation tunables", () => {
	/**
	 * Real values, not merely internal agreement. These are the defaults the consolidator
	 * applies with no environment set, and the whole point of one owner is that changing
	 * one of them changes the behaviour rather than half of it.
	 */
	it("carry the defaults the consolidator applies", () => {
		expect(sleepBatchSize({})).toBe(5000);
		expect(tier2Days({})).toBe(30);
		expect(tier3Days({})).toBe(180);
		expect(degradeBatchSize({})).toBe(100);
		expect(tier3MaxChars({})).toBe(300);
	});

	/** The tier boundaries are ordered, or tier 3 would start before tier 2. */
	it("keep the tier boundaries in order", () => {
		expect(tier3Days({})).toBeGreaterThan(tier2Days({}));
	});

	/** Each reads its own variable, so a rename cannot silently point two at one name. */
	it("read the variable each is named for", () => {
		expect(sleepBatchSize({ MNEMOPI_SLEEP_BATCH: "7" })).toBe(7);
		expect(tier2Days({ MNEMOPI_TIER2_DAYS: "7" })).toBe(7);
		expect(tier3Days({ MNEMOPI_TIER3_DAYS: "7" })).toBe(7);
		expect(degradeBatchSize({ MNEMOPI_DEGRADE_BATCH: "7" })).toBe(7);
		expect(tier3MaxChars({ MNEMOPI_TIER3_MAX_CHARS: "7" })).toBe(7);
	});

	/**
	 * A knob set to something that is not a number falls back to its default rather than
	 * seeding `NaN`. A NaN batch size corrupts the SQLite `LIMIT ?` bind and a NaN cutoff
	 * makes every comparison false, so consolidation would quietly do nothing.
	 */
	it("fall back to the default rather than NaN", () => {
		expect(tier2Days({ MNEMOPI_TIER2_DAYS: "soon" })).toBe(30);
		expect(degradeBatchSize({ MNEMOPI_DEGRADE_BATCH: "" })).toBe(100);
	});
});

describe("no module reads a MNEMOPI_ variable behind config.ts", () => {
	/**
	 * The structural lock. The value assertions above prove the two copies agreed on the
	 * day they were merged; only a source check stops a sixth `envInt("MNEMOPI_...")` from
	 * appearing in a module downstream of the owner, which is exactly how the five came to
	 * exist.
	 *
	 * `util/env.ts` is exempt because it DEFINES the parsers, and `diagnose.ts` is exempt
	 * because it reports the raw environment back to the operator rather than deciding
	 * anything from it.
	 */
	it("only config.ts parses one", async () => {
		const files = await sourceFiles();
		// NON-VACUITY: the walk really read the package.
		expect(files.length).toBeGreaterThan(20);

		const parse = /\benv(?:Int|Float|String|Bool|OneOf)\(\s*"MNEMOPI_/;
		const offenders: string[] = [];
		for (const file of files) {
			const rel = path.relative(SRC, file);
			if (EXEMPT.has(rel) || KNOWN_BYPASSES.has(rel)) continue;
			if (parse.test(await readFile(file, "utf8"))) offenders.push(rel);
		}

		expect(offenders.sort(), "parses a MNEMOPI_ variable directly. Call the accessor in ../config instead").toEqual(
			[],
		);
	});

	/**
	 * The allowlist may only shrink. An entry for a file that no longer parses anything is
	 * a standing permission nobody is checking, ready to excuse the next bypass that lands
	 * at that path, so removing the last direct parse from a module must also remove its
	 * row here.
	 */
	it("carries no stale allowlist entry", async () => {
		const parse = /\benv(?:Int|Float|String|Bool|OneOf)\(\s*"MNEMOPI_/;
		for (const rel of KNOWN_BYPASSES) {
			const text = await readFile(path.join(SRC, rel), "utf8");
			expect(parse.test(text), `${rel} no longer parses a MNEMOPI_ variable. Remove it from KNOWN_BYPASSES`).toBe(
				true,
			);
		}
	});

	/**
	 * The consolidator is off the list for good. It is the module this change fixed, so a
	 * regression there is the specific thing worth naming rather than leaving to the
	 * general rule.
	 */
	it("does not let the consolidator back on", async () => {
		const rel = path.join("core", "beam", "consolidate.ts");
		expect(KNOWN_BYPASSES.has(rel)).toBe(false);
		expect(await readFile(path.join(SRC, rel), "utf8")).not.toMatch(/\benvInt\(\s*"MNEMOPI_/);
	});

	/**
	 * The lock above is only meaningful while the file it exempts still owns the parsing.
	 * An exemption for a file that stopped reading the environment is a hole that opens
	 * quietly, ready to excuse a copy that lands at that path later.
	 */
	it("and config.ts really still parses them", async () => {
		const text = await readFile(path.join(SRC, "config.ts"), "utf8");
		const parsed = text.match(/\benv(?:Int|Float|String|Bool|OneOf)\(\s*"MNEMOPI_[A-Z0-9_]+"/g) ?? [];

		expect(parsed.length).toBeGreaterThan(20);
		expect(text).toInclude('envInt("MNEMOPI_TIER2_DAYS"');
	});
});
