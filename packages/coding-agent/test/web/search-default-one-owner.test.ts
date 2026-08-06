/**
 * Every search provider's default result count comes from ONE constant.
 *
 * WHY THIS SUITE EXISTS. `const DEFAULT_NUM_RESULTS = 10` was declared privately in fifteen
 * provider files. Changing what the agent asks for by default was fifteen edits, and — the part
 * that actually bites — a reader could not tell those fifteen copies apart from the two providers
 * that deviate deliberately: `public.ts` uses 15 because an aggregate needs breadth for consensus,
 * and `tavily.ts` uses 5 to match its upstream API's own default. With everything spelled the same
 * way, an accidental sixteenth value would have looked exactly like an intentional one.
 *
 * So the shared value has a single owner, `SEARCH_DEFAULT_NUM_RESULTS` in `web/search/utils.ts`,
 * beside the `clampNumResults` that consumes it. This suite reads the provider SOURCES to prove the
 * copies are gone and stay gone: a source-level assertion, because that is the only place a private
 * re-declaration is visible — a re-copied `10` would behave identically today and drift later, which
 * is precisely the failure no behavioural test can catch.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { clampNumResults, SEARCH_DEFAULT_NUM_RESULTS } from "@veyyon/coding-agent/web/search/utils";
import { namedImportsFrom } from "@veyyon/utils/module-reach";

const PROVIDER_DIR = path.join(import.meta.dir, "../../src/web/search/providers");

/** Every provider source, by file name. */
function providerSources(): Array<{ name: string; text: string }> {
	return fs
		.readdirSync(PROVIDER_DIR)
		.filter(name => name.endsWith(".ts"))
		.sort()
		.map(name => ({ name, text: fs.readFileSync(path.join(PROVIDER_DIR, name), "utf8") }));
}

/**
 * The providers allowed to declare their own default, and the value each is allowed to use.
 *
 * Adding an entry here is the deliberate act: it forces the author to state the value in a place a
 * reviewer reads, next to the comment in the file explaining why this provider differs.
 */
const DELIBERATE_DEVIATIONS: Readonly<Record<string, number>> = {
	// An aggregate queries several engines and needs breadth before it can find consensus.
	"public.ts": 15,
	// Tavily's own `max_results` default, so an unset limit behaves the same either way.
	"tavily.ts": 5,
};

describe("SEARCH_DEFAULT_NUM_RESULTS", () => {
	it("is ten, which is the value the fifteen copies all held", () => {
		// Pinned as a number rather than compared to itself: the unification must not have
		// changed what any provider asks for, and this is the assertion that says so.
		expect(SEARCH_DEFAULT_NUM_RESULTS).toBe(10);
	});

	it("is what clampNumResults falls back to for every absent or unusable count", () => {
		// The owner exists to be passed here. These are the inputs that reach the default:
		// nothing, zero, NaN — the same list `clampNumResults` documents.
		expect(clampNumResults(undefined, SEARCH_DEFAULT_NUM_RESULTS, 40)).toBe(10);
		expect(clampNumResults(0, SEARCH_DEFAULT_NUM_RESULTS, 40)).toBe(10);
		expect(clampNumResults(Number.NaN, SEARCH_DEFAULT_NUM_RESULTS, 40)).toBe(10);
	});

	it("does not override an explicit count the caller asked for", () => {
		// The negative twin: a shared default that won a fight with an explicit request
		// would silently narrow every search the model asked to widen.
		expect(clampNumResults(3, SEARCH_DEFAULT_NUM_RESULTS, 40)).toBe(3);
		expect(clampNumResults(25, SEARCH_DEFAULT_NUM_RESULTS, 40)).toBe(25);
		// Still bounded by the provider's own maximum, which is NOT shared.
		expect(clampNumResults(1000, SEARCH_DEFAULT_NUM_RESULTS, 40)).toBe(40);
	});
});

describe("the provider sources", () => {
	it("declare no private copy of the shared default", () => {
		// The lock. A sixteenth `const DEFAULT_NUM_RESULTS = 10` would pass every other
		// test in the repository and drift the first time someone changed the owner.
		const offenders = providerSources()
			.filter(({ text }) => /^const DEFAULT_NUM_RESULTS = 10;$/m.test(text))
			.map(({ name }) => name);

		expect(offenders).toEqual([]);
	});

	it("declare a private default only where the deviation is registered here", () => {
		// Deviating is allowed. Deviating silently is not: a provider with its own default
		// has to appear in DELIBERATE_DEVIATIONS with its value, which is a line a reviewer
		// sees and can ask about.
		const declared = new Map<string, number>();
		for (const { name, text } of providerSources()) {
			const match = /^const DEFAULT_NUM_RESULTS = (\d+);$/m.exec(text);
			if (match) declared.set(name, Number(match[1]));
		}

		expect(Object.fromEntries([...declared].sort())).toEqual(DELIBERATE_DEVIATIONS);
	});

	it("explains each deviation in the file itself, not only in this test", () => {
		// A registered value with no reason in the source leaves the next reader exactly
		// where they started. The word has to appear within the few lines above the
		// declaration, which is where a reader looks.
		for (const name of Object.keys(DELIBERATE_DEVIATIONS)) {
			const text = fs.readFileSync(path.join(PROVIDER_DIR, name), "utf8");
			const lines = text.split("\n");
			const index = lines.findIndex(line => /^const DEFAULT_NUM_RESULTS = \d+;$/.test(line));
			expect(index).toBeGreaterThan(0);
			const preamble = lines.slice(Math.max(0, index - 4), index).join("\n");
			expect(preamble).toContain("SEARCH_DEFAULT_NUM_RESULTS");
		}
	});

	it("take the shared default from the owner module and nowhere else", () => {
		// Every user imports it from `../utils`, the module that also owns `clampNumResults`.
		// An import of the same name from anywhere else would mean a second definition had
		// appeared somewhere — the exact thing this row was cleaning up — so the SOURCE of
		// the name is asserted, not merely its presence.
		const users = providerSources().filter(({ text }) =>
			/clampNumResults\([^)]*SEARCH_DEFAULT_NUM_RESULTS/.test(text),
		);

		// Fifteen files used a private copy; every one of them is a user now.
		expect(users.length).toBe(15);
		for (const { name, text } of users) {
			// The named import, not a hand-split line: it settles the source of the name, survives a
			// formatter breaking the import across lines (which the single-line scan this replaced
			// could not see), and TypeScript refuses a module that both imports the binding and
			// declares it, so this is also the proof that no private copy came back.
			expect(namedImportsFrom(text, "../utils"), `${name} must take the shared default from the owner`).toContain(
				"SEARCH_DEFAULT_NUM_RESULTS",
			);
		}
	});
});
