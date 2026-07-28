import { describe, expect, it } from "bun:test";
import { THINKING_EFFORTS } from "@veyyon/catalog/effort";
import { type } from "arktype";
import { modelsConfigSchemas } from "../../src/config/models-config-schema";

/**
 * The models-config schema accepts exactly the thinking ladder that
 * `@veyyon/catalog/effort` declares: every level on it, and nothing off it.
 *
 * WHY THIS SUITE EXISTS. ArkType infers a literal union only from a literal
 * definition, so `EffortSchema` has to spell the six levels rather than build
 * them from `THINKING_EFFORTS`; generating the string would infer as `string`
 * and every `defaultLevel`, `minLevel` and `maxLevel` in that file would quietly
 * stop being checked. That leaves a hand-written copy of the ladder, and the
 * schema builder guards it with a throw, but only in ONE direction: it proves
 * the schema accepts every level the owner declares. This suite adds the
 * direction a throw cannot cover, that the schema accepts NOTHING ELSE, and
 * pins the same agreement for `reasoningEffortMap`, whose keys are a third
 * spelling of the same six values.
 *
 * The failure being locked out is not loud. Adding a level to the owner and
 * forgetting this file does not break the build: a user who names the new level
 * in their models config gets a validation error against THEIR file, reading as
 * though they made a typo. Dropping a level here has the same shape. Both are
 * silent from the code's point of view and confusing from the user's, which is
 * why the check has to be a test rather than a review habit.
 *
 * Every expectation is derived from `THINKING_EFFORTS` on purpose. Writing the
 * six literals again here would make this suite a fourth copy of the ladder and
 * it would go stale in exactly the way it exists to prevent.
 */

const { ModelOverrideSchema } = modelsConfigSchemas();

/** A models-config model override carrying one thinking config. */
function overrideWithThinking(thinking: unknown): unknown {
	return { thinking };
}

function accepts(value: unknown): boolean {
	return !(ModelOverrideSchema(value) instanceof type.errors);
}

describe("the models-config thinking ladder agrees with its owner", () => {
	/**
	 * Guard on the guard: the ladder has to be non-trivial for any loop below to
	 * assert anything. An empty or one-entry ladder would make every "for each
	 * level" test vacuous, and this suite would pass while checking nothing.
	 */
	it("reads a real ladder from the owner", () => {
		expect(THINKING_EFFORTS.length).toBeGreaterThanOrEqual(6);
		expect(new Set(THINKING_EFFORTS).size).toBe(THINKING_EFFORTS.length);
	});

	/** Every level the owner declares is a `defaultLevel` a user may write. */
	it("accepts every declared level as defaultLevel", () => {
		for (const effort of THINKING_EFFORTS) {
			expect(accepts(overrideWithThinking({ mode: "effort", efforts: [effort], defaultLevel: effort }))).toBe(
				true,
			);
		}
	});

	/** The whole ladder is a valid `efforts` array, which is the canonical vocabulary. */
	it("accepts the whole ladder as an efforts array", () => {
		expect(accepts(overrideWithThinking({ mode: "effort", efforts: [...THINKING_EFFORTS] }))).toBe(true);
	});

	/** The legacy `minLevel`/`maxLevel` range spans the same vocabulary. */
	it("accepts the ladder's endpoints as a legacy min/max range", () => {
		const first = THINKING_EFFORTS[0];
		const last = THINKING_EFFORTS[THINKING_EFFORTS.length - 1];
		expect(accepts(overrideWithThinking({ mode: "effort", minLevel: first, maxLevel: last }))).toBe(true);
	});

	/**
	 * The direction the schema builder's throw cannot check.
	 *
	 * A level the owner has retired must stop validating here too, otherwise the
	 * schema keeps accepting a value nothing downstream can clamp against and the
	 * config loads with a level no provider will be sent.
	 */
	it("rejects a level the owner does not declare", () => {
		for (const notALevel of ["ultra", "none", "off", "Medium", "MAX", "", "high ", "xxhigh"]) {
			expect(accepts(overrideWithThinking({ mode: "effort", efforts: [notALevel] }))).toBe(false);
			expect(accepts(overrideWithThinking({ mode: "effort", efforts: ["high"], defaultLevel: notALevel }))).toBe(
				false,
			);
		}
	});

	/**
	 * `reasoningEffortMap` remaps a level to whatever string a given
	 * OpenAI-compatible server calls it, so its KEYS are the ladder and its
	 * values are free text. A missing key means that level cannot be remapped
	 * and gets sent verbatim to a server that may not know it.
	 */
	it("accepts every declared level as a reasoningEffortMap key", () => {
		for (const effort of THINKING_EFFORTS) {
			expect(accepts({ compat: { reasoningEffortMap: { [effort]: "custom-value" } } })).toBe(true);
		}
		const wholeLadder = Object.fromEntries(THINKING_EFFORTS.map(effort => [effort, `wire-${effort}`]));
		expect(accepts({ compat: { reasoningEffortMap: wholeLadder } })).toBe(true);
	});

	/** A key off the ladder is rejected rather than carried, so a typo is caught at load. */
	it("rejects a reasoningEffortMap key that is not a level", () => {
		expect(accepts({ compat: { reasoningEffortMap: { ultra: "x" } } })).toBe(false);
	});
});

describe("the legacy min/max range resolves through the owner's order", () => {
	/**
	 * The range shape normalizes to an ordered `efforts` list by slicing the
	 * ladder between the two endpoints, so this asserts the ORDER the owner
	 * declares, not just membership. A reordered ladder would produce a range
	 * that skips levels or comes out empty, and the clamp helpers downstream walk
	 * that list assuming it runs least to most intensive.
	 */
	it("expands min..max to the owner's slice, in the owner's order", () => {
		const first = THINKING_EFFORTS[1];
		const last = THINKING_EFFORTS[THINKING_EFFORTS.length - 2];
		const result = ModelOverrideSchema(overrideWithThinking({ mode: "effort", minLevel: first, maxLevel: last }));
		expect(result instanceof type.errors).toBe(false);
		const thinking = (result as { thinking: { efforts: string[] } }).thinking;
		expect(thinking.efforts).toEqual(THINKING_EFFORTS.slice(1, THINKING_EFFORTS.length - 1) as unknown as string[]);
	});

	/** An inverted range collapses to the single level rather than producing nothing. */
	it("does not produce an empty ladder when max is below min", () => {
		const result = ModelOverrideSchema(
			overrideWithThinking({
				mode: "effort",
				minLevel: THINKING_EFFORTS[3],
				maxLevel: THINKING_EFFORTS[1],
			}),
		);
		expect(result instanceof type.errors).toBe(false);
		const thinking = (result as { thinking: { efforts: string[] } }).thinking;
		expect(thinking.efforts).toEqual([THINKING_EFFORTS[3] as unknown as string]);
	});
});
