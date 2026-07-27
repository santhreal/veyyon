/**
 * Two values that must agree across modules are declared once.
 *
 * WHY THIS EXISTS. A sweep of every `const NAME = <scalar>;` declaration under
 * `packages/*​/src` found nineteen constant names declared with the SAME value in two or
 * more files. Same-name-same-value is the quiet half of duplication: it costs nothing
 * until someone edits one copy, and then the two disagree with nothing to say so. Two of
 * those pairs sat on paths where a drift would fail silently rather than loudly, and this
 * suite covers both.
 *
 * PROJECT_TAG_PREFIX. `hindsight/bank.ts` WRITES a per-project tag as
 * `project:<label>` and `hindsight/mental-models.ts` READS it back by stripping the same
 * prefix. Each held its own private copy. A drift raises nothing: the reader stops
 * recognising project tags, every seed falls back to its unscoped id, and per-project
 * scoping quietly stops working while both files still look correct in isolation.
 *
 * SUMMARY_MAX_CHARS. The commit pipeline held a private `72` that it passed to
 * `validateSummary`, and `commit/agentic/validation.ts` exported its own `72` for the
 * agentic path and its propose-commit tool. A generator held to one limit and a validator
 * enforcing another rejects summaries for being exactly the length they were asked to be.
 *
 * MIN_DURATION_MS. Two components publish a tokens-per-second rate, the status line and
 * the per-turn usage row, and each held its own `100` floor below which the rate is
 * nonsense. This pair had ALREADY drifted, not in the value but in the comparison:
 * `token-rate.ts` rejected a duration `< MIN_DURATION_MS` and `usage-row.ts` required
 * `> MIN_DURATION_MS`, so a turn of exactly 100ms got a rate on one surface and not the
 * other. Both the floor and the arithmetic now have one owner.
 *
 * All three now have one owner, chosen by which module the value belongs to: the writer
 * for a tag format, the enforcing module for a limit, the computing module for a rate.
 */

import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { SUMMARY_MAX_CHARS as AGENTIC_SUMMARY_MAX_CHARS } from "../src/commit/agentic/validation";
import { SUMMARY_MAX_CHARS, validateSummary } from "../src/commit/analysis/validation";
import { PROJECT_TAG_PREFIX } from "../src/hindsight/bank";
import {
	calculateTokensPerSecond,
	MIN_RATE_DURATION_MS,
	tokensPerSecond,
} from "../src/modes/components/status-line/token-rate";

const SRC = path.join(import.meta.dir, "..", "src");

/** Every `.ts` file under `src`, excluding generated output. */
async function sourceFiles(dir: string = SRC): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(full);
	}
	return found;
}

/** Files declaring `const <name> = ...`, relative to `src`. */
async function declarersOf(name: string): Promise<string[]> {
	const declaration = new RegExp(`^\\s*(?:export )?const ${name}\\s*=`, "m");
	const out: string[] = [];
	for (const file of await sourceFiles()) {
		if (declaration.test(await readFile(file, "utf8"))) out.push(path.relative(SRC, file));
	}
	return out.sort();
}

describe("the per-project hindsight tag prefix", () => {
	/** Its real value: the tag format is a protocol between the writer and the reader. */
	it("is the string the bank writes", () => {
		expect(PROJECT_TAG_PREFIX).toBe("project:");
	});

	/**
	 * THE regression. Exactly one module may declare it. Two copies is the state this
	 * unification removed, and a third would restore the silent-drift hazard.
	 */
	it("is declared in exactly one module", async () => {
		expect(await declarersOf("PROJECT_TAG_PREFIX")).toEqual([path.join("hindsight", "bank.ts")]);
	});

	/**
	 * The round trip the two modules perform between them: a tag the bank builds is one
	 * the mental-model reader strips back to the label it started from.
	 */
	it("round-trips a label through the writer's format and the reader's strip", () => {
		const label = "veyyon";
		const tag = `${PROJECT_TAG_PREFIX}${label}`;

		expect(tag).toBe("project:veyyon");
		expect(tag.startsWith(PROJECT_TAG_PREFIX)).toBe(true);
		expect(tag.slice(PROJECT_TAG_PREFIX.length)).toBe(label);
	});

	/** A tag without the prefix is left alone rather than having characters shaved off. */
	it("does not match a tag that is not project-scoped", () => {
		expect("language:rust".startsWith(PROJECT_TAG_PREFIX)).toBe(false);
	});
});

describe("the commit summary length limit", () => {
	/**
	 * Its real value. Seventy-two is the conventional git limit, leaving room for the
	 * four-space indent `git log` adds without wrapping at eighty columns.
	 */
	it("is seventy-two characters", () => {
		expect(SUMMARY_MAX_CHARS).toBe(72);
	});

	/**
	 * THE regression, stated as identity rather than equality. The agentic path re-exports
	 * the owner; if that ever became a second declaration this would still be 72 in both
	 * places today and free to drift tomorrow, so the declaration count is what is pinned.
	 */
	it("is declared in exactly one module", async () => {
		expect(await declarersOf("SUMMARY_MAX_CHARS")).toEqual([path.join("commit", "analysis", "validation.ts")]);
	});

	/** And the agentic path's export is the same value, reached by a different import. */
	it("is the same limit on the agentic path", () => {
		expect(AGENTIC_SUMMARY_MAX_CHARS).toBe(SUMMARY_MAX_CHARS);
	});

	/**
	 * The limit is the one actually enforced, not merely a number sitting beside the
	 * validator. A summary at the limit passes and one character past it does not.
	 */
	it("is the boundary validateSummary enforces", () => {
		const atLimit = "a".repeat(SUMMARY_MAX_CHARS);
		const overLimit = "a".repeat(SUMMARY_MAX_CHARS + 1);

		expect(validateSummary(atLimit, SUMMARY_MAX_CHARS).errors).toEqual([]);
		expect(validateSummary(overLimit, SUMMARY_MAX_CHARS).errors).toContain(
			`Summary exceeds ${SUMMARY_MAX_CHARS} characters`,
		);
	});
});

describe("the tokens-per-second floor", () => {
	/** Its real value: a hundred milliseconds, below which a rate is meaningless. */
	it("is a hundred milliseconds", () => {
		expect(MIN_RATE_DURATION_MS).toBe(100);
	});

	/**
	 * THE regression. Two components each declared their own floor; one declaration now.
	 */
	it("is declared in exactly one module", async () => {
		expect(await declarersOf("MIN_RATE_DURATION_MS")).toEqual([
			path.join("modes", "components", "status-line", "token-rate.ts"),
		]);
		// And the old name is gone from both, not merely renamed in one of them.
		expect(await declarersOf("MIN_DURATION_MS")).toEqual([]);
	});

	/**
	 * THE DIVERGENCE THIS PAIR HAD ALREADY DEVELOPED. The status line rejected a
	 * duration `< 100` and the usage row required `> 100`, so a turn of exactly 100ms
	 * was rateable on one surface and not the other. One predicate now, and this is the
	 * boundary it draws: exactly at the floor counts.
	 */
	it("includes a turn of exactly the floor duration", () => {
		expect(tokensPerSecond(50, MIN_RATE_DURATION_MS)).toBe(500);
	});

	/** One millisecond under the floor does not. */
	it("excludes a turn one millisecond under the floor", () => {
		expect(tokensPerSecond(50, MIN_RATE_DURATION_MS - 1)).toBeNull();
	});

	/** The rate itself, as a real number rather than a shape check. */
	it("computes the rate over the whole turn", () => {
		expect(tokensPerSecond(1200, 2000)).toBe(600);
		expect(tokensPerSecond(1, 1000)).toBe(1);
	});

	/** A turn that produced nothing has no rate, whatever its duration. */
	it("has no rate for a turn with no output tokens", () => {
		expect(tokensPerSecond(0, 5000)).toBeNull();
		expect(tokensPerSecond(-5, 5000)).toBeNull();
	});

	/** Nor does a turn whose duration is missing or not a number. */
	it("has no rate without a usable duration", () => {
		expect(tokensPerSecond(100, null)).toBeNull();
		expect(tokensPerSecond(100, undefined)).toBeNull();
		expect(tokensPerSecond(100, Number.NaN)).toBeNull();
		expect(tokensPerSecond(100, Number.POSITIVE_INFINITY)).toBeNull();
	});

	/**
	 * The status line's own entry point still answers the same way, so extracting the
	 * shared owner did not change what that surface reports.
	 */
	it("is the rule the status line applies to a finished turn", () => {
		const message = { role: "assistant", timestamp: 0, duration: 2000, usage: { output: 1200 } };

		expect(calculateTokensPerSecond([message], false)).toBe(600);
	});

	/** And a finished turn under the floor still yields nothing there either. */
	it("gives the status line no rate for a turn under the floor", () => {
		const message = { role: "assistant", timestamp: 0, duration: 50, usage: { output: 1200 } };

		expect(calculateTokensPerSecond([message], false)).toBeNull();
	});
});

describe("the sweep that found them", () => {
	/**
	 * NON-VACUITY for the two locks above. `declarersOf` walks the source tree, and a walk
	 * that silently read nothing would report an empty list for every name and make both
	 * "declared in exactly one module" assertions unfalsifiable. Prove the walk works by
	 * asking it for a name that genuinely is declared, and for one that is not.
	 */
	it("finds a constant that exists and none for a name that does not", async () => {
		expect((await declarersOf("PROJECT_TAG_PREFIX")).length).toBe(1);
		expect(await declarersOf("A_CONSTANT_THAT_DOES_NOT_EXIST")).toEqual([]);
		expect((await sourceFiles()).length).toBeGreaterThan(100);
	});
});
