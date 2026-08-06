import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { type ModelOverride, modelsConfigSchemas } from "../../src/config/models-config-schema";

/**
 * `compat.supportsServerCompaction` is the documented opt-in for a gateway
 * that serves `POST /responses/compact`. Two doc comments promise it — the
 * transport's own header and the resolver that computes the default in
 * `@veyyon/catalog/compat/openai` — and the catalog lists it in the
 * overridable compat union, so an operator pointing veyyon at a compatible
 * host is told to write it in their models config.
 *
 * WHY THIS SUITE EXISTS. It was never declared in this file's compat field
 * table, unlike every one of its Responses-family siblings
 * (`strictResponsesPairing`, `supportsImageDetailOriginal`,
 * `supportsLongPromptCacheRetention`). It nevertheless worked, because ArkType
 * passes undeclared keys through and `applyCompatOverrides` copies whatever
 * `Object.hasOwn` finds. So the documented contract rested entirely on a
 * permissive default, and it failed in two ways that are both quiet.
 *
 * The type way: the key was absent from the inferred `ModelOverride`, so no
 * code reading an override could see it and a rename in the catalog would not
 * break anything here.
 *
 * The runtime way: an undeclared key is not VALIDATED either. `true` and
 * `"yes"` were equally acceptable, and a string sails through to the compat
 * record where the engine's `!== true` check reads it as off. The operator
 * gets no error, no compaction, and nothing anywhere naming the typo.
 *
 * Declaring it fixes both at once, which is why this suite gates the
 * declaration from both sides rather than trusting one.
 */

const { ModelOverrideSchema } = modelsConfigSchemas();

/** True only when `A` and `B` are the same type in both directions. */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type CompatOverride = NonNullable<ModelOverride["compat"]>;

describe("the models-config compat table declares supportsServerCompaction", () => {
	/**
	 * The compile-time half. An undeclared key makes the property reads below
	 * a type error outright, and a key declared as anything but `boolean`
	 * collapses `Exactly<...>` to `false`, whose annotation is `never` and
	 * refuses the assignment. Either way `bun run check:types` fails, which is
	 * the only place a compile-time guarantee can be gated.
	 */
	it("carries it as an optional boolean on the inferred override type", () => {
		const onCompat: Exactly<CompatOverride["supportsServerCompaction"], boolean | undefined> extends true
			? true
			: never = true;
		// `whenThinking` reuses the same field table, so declaring the key once
		// has to cover the per-thinking-level slot too.
		const onWhenThinking: Exactly<
			NonNullable<CompatOverride["whenThinking"]>["supportsServerCompaction"],
			boolean | undefined
		> extends true
			? true
			: never = true;

		expect(onCompat).toBe(true);
		expect(onWhenThinking).toBe(true);
	});

	/**
	 * The runtime half, which the declaration buys as a side effect: the key is
	 * now type-checked at config load instead of passed through unexamined.
	 */
	it("accepts the documented opt-in and preserves it for applyCompatOverrides", () => {
		const result = ModelOverrideSchema({ compat: { supportsServerCompaction: true } });

		expect(result instanceof type.errors).toBe(false);
		expect(result).toEqual({ compat: { supportsServerCompaction: true } });
	});

	it("rejects a non-boolean and names the key, instead of silently reading it as off", () => {
		const result = ModelOverrideSchema({ compat: { supportsServerCompaction: "yes" } });

		if (!(result instanceof type.errors)) throw new Error(`Expected a validation error, got ${JSON.stringify(result)}`);
		expect(result.summary).toContain("compat.supportsServerCompaction");
		expect(result.summary).toContain("must be boolean");
	});

	it("still leaves the flag optional, so an override that says nothing about it is valid", () => {
		const result = ModelOverrideSchema({ compat: { supportsStore: true } });

		expect(result instanceof type.errors).toBe(false);
	});
});
