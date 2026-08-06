/**
 * Per-provider retry policy resolution.
 *
 * This suite exists because the retry loop ran one global policy for every
 * backend: ten attempts at 500ms base backoff. That is fine for a token API,
 * where a failed attempt costs a second. It is badly wrong for `cursor` and
 * `devin`, which run their agent loop remotely and can occupy minutes before
 * failing, so ten attempts turned one bad turn into a very long silence and
 * produced a report of the tool being "very slow and constantly erroring out".
 *
 * The contracts pinned here are the ones a future edit could plausibly break:
 * layer precedence, which fields each layer is allowed to touch, and the
 * refusal to let object key order decide anything.
 */
import { describe, expect, it } from "bun:test";
import {
	describeRetryPolicySource,
	PROVIDER_RETRY_DEFAULTS,
	type RetryPolicy,
	type RetryPolicyOverride,
	resolveRetryPolicy,
} from "../../src/session/retry-policy";

/** The shipped global defaults from `retry.*`, so drift in either is visible here. */
const GLOBAL: RetryPolicy = { maxRetries: 10, baseDelayMs: 500, maxDelayMs: 300_000 };

const openaiModel = { provider: "openai", id: "gpt-4o-mini" };
const cursorModel = { provider: "cursor", id: "grok-code-fast-1" };
const devinModel = { provider: "devin", id: "grok-4-5" };

describe("resolveRetryPolicy", () => {
	describe("providers with no policy of their own", () => {
		/**
		 * The default path must be a true no-op. Introducing per-provider policy
		 * cannot be allowed to perturb the backends nobody characterized, or the
		 * change stops being a targeted fix and becomes a global behavior change.
		 */
		it("returns the global policy untouched", () => {
			const policy = resolveRetryPolicy(GLOBAL, {}, openaiModel);

			expect(policy.maxRetries).toBe(GLOBAL.maxRetries);
			expect(policy.baseDelayMs).toBe(GLOBAL.baseDelayMs);
			expect(policy.maxDelayMs).toBe(GLOBAL.maxDelayMs);
			expect(policy.source).toBe("global");
		});

		/**
		 * A global policy needs no explanation in the UI: the operator set it.
		 * Only a policy they did not set is worth a note.
		 */
		it("offers no source explanation", () => {
			expect(describeRetryPolicySource(resolveRetryPolicy(GLOBAL, {}, openaiModel))).toBeUndefined();
		});
	});

	describe("built-in provider defaults", () => {
		/**
		 * The fix itself: an agentic backend must not inherit ten attempts. If
		 * this regresses, one failing Cursor turn again becomes tens of minutes
		 * of retrying a slow remote agent.
		 */
		it("caps cursor attempts far below the global budget", () => {
			const policy = resolveRetryPolicy(GLOBAL, {}, cursorModel);

			expect(policy.maxRetries).toBe(3);
			expect(policy.maxRetries).toBeLessThan(GLOBAL.maxRetries);
			expect(policy.source).toBe("provider-default");
		});

		/**
		 * Devin turns are longer still and its transport has no timeout of its
		 * own, so a failed attempt has already cost the full watchdog budget
		 * before the retry loop sees it. Its cap is the tightest for that reason.
		 */
		it("caps devin attempts below even cursor", () => {
			const devin = resolveRetryPolicy(GLOBAL, {}, devinModel);
			const cursor = resolveRetryPolicy(GLOBAL, {}, cursorModel);

			expect(devin.maxRetries).toBe(2);
			expect(devin.maxRetries).toBeLessThan(cursor.maxRetries);
		});

		/**
		 * Backing off in milliseconds is wrong when the failure cause needs real
		 * time to clear (capacity, a faulted remote session). The wider base
		 * delay is as much of the fix as the attempt cap.
		 */
		it("backs off in seconds rather than milliseconds", () => {
			const policy = resolveRetryPolicy(GLOBAL, {}, cursorModel);

			expect(policy.baseDelayMs).toBe(2000);
			expect(policy.baseDelayMs).toBeGreaterThan(GLOBAL.baseDelayMs);
		});

		/**
		 * A built-in entry specifies only what is provider-intrinsic. Fields it
		 * stays silent about must keep falling through to the operator's global
		 * setting rather than being reset to some hidden built-in value.
		 */
		it("leaves unspecified fields on the global setting", () => {
			const policy = resolveRetryPolicy(GLOBAL, {}, cursorModel);

			// The cursor entry sets maxRetries and baseDelayMs but not maxDelayMs.
			expect(policy.maxDelayMs).toBe(GLOBAL.maxDelayMs);
		});

		/**
		 * A budget the operator never configured is otherwise inexplicable: they
		 * set 10 in settings and see 3 in the UI. The source string is what makes
		 * that traceable.
		 */
		it("explains itself as a provider default", () => {
			expect(describeRetryPolicySource(resolveRetryPolicy(GLOBAL, {}, cursorModel))).toBe("cursor provider default");
		});

		/**
		 * The built-in table is a product decision, not a scratch pad: an entry
		 * that sets nothing usable would silently mislabel the policy source as
		 * `provider-default` while changing no behavior at all.
		 */
		it("ships only entries that actually contribute a field", () => {
			for (const [provider, override] of Object.entries(PROVIDER_RETRY_DEFAULTS)) {
				const fields = [override.maxRetries, override.baseDelayMs, override.maxDelayMs];
				expect(
					fields.some(value => value !== undefined),
					`${provider} sets no field`,
				).toBe(true);
			}
		});
	});

	describe("operator configuration", () => {
		/**
		 * A built-in default is the product's opinion; an explicit config entry
		 * is the operator's. The operator wins, or the built-in table becomes an
		 * override the user cannot escape.
		 */
		it("outranks the built-in provider default", () => {
			const policy = resolveRetryPolicy(GLOBAL, { cursor: { maxRetries: 7 } }, cursorModel);

			expect(policy.maxRetries).toBe(7);
			expect(policy.source).toBe("config");
			// Untouched by the config entry, so the built-in still applies.
			expect(policy.baseDelayMs).toBe(2000);
		});

		/**
		 * The three key spellings are one vocabulary shared with
		 * `retry.fallbackChains`. Each must address the model, or operators have
		 * to learn which subset works where.
		 */
		it.each([
			["bare provider", "cursor"],
			["provider wildcard", "cursor/*"],
			["exact model selector", "cursor/grok-code-fast-1"],
		])("matches a %s key", (_label, key) => {
			const policy = resolveRetryPolicy(GLOBAL, { [key]: { maxRetries: 9 } }, cursorModel);

			expect(policy.maxRetries).toBe(9);
			expect(policy.matchedKey).toBe(key);
		});

		/**
		 * Selectors may carry a `:thinking` suffix. Retry policy is per model,
		 * not per thinking level, so the suffix must not defeat the match and
		 * strand the operator's entry.
		 */
		it("matches a selector carrying a thinking suffix", () => {
			const policy = resolveRetryPolicy(GLOBAL, { "cursor/grok-code-fast-1:high": { maxRetries: 4 } }, cursorModel);

			expect(policy.maxRetries).toBe(4);
		});

		/**
		 * The most specific entry must win no matter which order the keys were
		 * written in. Object key order reflects how the operator happened to type
		 * their config, which is not a decision they meant to make.
		 */
		it.each([
			["specific first", { "cursor/grok-code-fast-1": { maxRetries: 4 }, "cursor/*": { maxRetries: 8 } }],
			["wildcard first", { "cursor/*": { maxRetries: 8 }, "cursor/grok-code-fast-1": { maxRetries: 4 } }],
		])("prefers the exact model over the wildcard, %s", (_label, configured) => {
			const policy = resolveRetryPolicy(GLOBAL, configured as Record<string, RetryPolicyOverride>, cursorModel);

			expect(policy.maxRetries).toBe(4);
			expect(policy.matchedKey).toBe("cursor/grok-code-fast-1");
		});

		/**
		 * Only the single most specific entry applies. Blending a wildcard and an
		 * exact entry would produce an effective policy the operator never wrote
		 * in either place and could not find by reading their config.
		 */
		it("does not blend a wildcard entry into the exact match", () => {
			const policy = resolveRetryPolicy(
				GLOBAL,
				{ "cursor/*": { baseDelayMs: 60_000 }, "cursor/grok-code-fast-1": { maxRetries: 4 } },
				cursorModel,
			);

			expect(policy.maxRetries).toBe(4);
			// From the built-in, not from the unselected wildcard entry.
			expect(policy.baseDelayMs).toBe(2000);
		});

		/**
		 * An entry aimed at another provider must not leak. A wrong match here
		 * silently applies one backend's limits to a different one.
		 */
		it.each([
			["another provider", "openai"],
			["another provider wildcard", "openai/*"],
			["a same-provider different model", "cursor/some-other-model"],
		])("ignores an entry keyed for %s", (_label, key) => {
			const policy = resolveRetryPolicy(GLOBAL, { [key]: { maxRetries: 99 } }, cursorModel);

			expect(policy.maxRetries).not.toBe(99);
		});

		/**
		 * A model of a provider with no built-in entry, configured explicitly,
		 * must pick up the config and nothing else.
		 */
		it("applies to an uncharacterized provider", () => {
			const policy = resolveRetryPolicy(GLOBAL, { openai: { maxRetries: 2 } }, openaiModel);

			expect(policy.maxRetries).toBe(2);
			expect(policy.baseDelayMs).toBe(GLOBAL.baseDelayMs);
			expect(policy.source).toBe("config");
		});

		it("names the matched config key in its explanation", () => {
			const policy = resolveRetryPolicy(GLOBAL, { "cursor/*": { maxRetries: 5 } }, cursorModel);

			expect(describeRetryPolicySource(policy)).toBe('retry.perProvider["cursor/*"]');
		});
	});

	describe("malformed configuration", () => {
		/**
		 * `retry.perProvider` is hand-edited JSON, so it will contain garbage.
		 * A non-numeric or negative value reaching the retry loop becomes a `NaN`
		 * or negative deadline, which is a hang or a busy loop rather than a
		 * config error. Every bad value must fall through to the layer below.
		 */
		it.each([
			["a string", "3"],
			["null", null],
			["NaN", Number.NaN],
			["Infinity", Number.POSITIVE_INFINITY],
			["a negative number", -1],
		])("ignores %s and keeps the layer below", (_label, value) => {
			const configured = { cursor: { maxRetries: value } } as unknown as Record<string, RetryPolicyOverride>;

			const policy = resolveRetryPolicy(GLOBAL, configured, cursorModel);

			// The built-in cursor default, not the garbage and not a NaN.
			expect(policy.maxRetries).toBe(3);
		});

		/**
		 * Zero is a legitimate operator choice meaning "do not retry this
		 * backend", and must survive the validation that rejects negatives.
		 */
		it("accepts an explicit zero as no retries", () => {
			const policy = resolveRetryPolicy(GLOBAL, { cursor: { maxRetries: 0 } }, cursorModel);

			expect(policy.maxRetries).toBe(0);
		});

		/**
		 * An entry whose value is not an object at all must not throw on the
		 * retry path: a config typo would then abort error handling itself,
		 * turning a recoverable provider error into a crash.
		 */
		it.each([
			["an array", []],
			["a string", "nope"],
			["null", null],
		])("survives an entry whose value is %s", (_label, value) => {
			const configured = { cursor: value } as unknown as Record<string, RetryPolicyOverride>;

			expect(() => resolveRetryPolicy(GLOBAL, configured, cursorModel)).not.toThrow();
			expect(resolveRetryPolicy(GLOBAL, configured, cursorModel).maxRetries).toBe(3);
		});

		/**
		 * An empty or whitespace key must never be treated as a match; an
		 * accidental `"": {...}` would otherwise silently reconfigure every
		 * provider at once.
		 */
		it.each([
			["empty", ""],
			["whitespace", "   "],
		])("ignores an %s key", (_label, key) => {
			const policy = resolveRetryPolicy(GLOBAL, { [key]: { maxRetries: 99 } }, cursorModel);

			expect(policy.maxRetries).toBe(3);
		});

		/**
		 * A more specific key that states no usable policy must not shadow the
		 * broader key that does. An inert `{}` (a cleared entry) or a garbage
		 * value is not a policy for this model, so treating it as the winning
		 * match discards the operator's `provider/*` layer entirely and drops
		 * the resolution to a built-in default they never asked for.
		 */
		it.each([
			["an empty object", {}],
			["a negative number", { maxRetries: -1 }],
			["a string", { maxRetries: "3" }],
			["NaN", { maxRetries: Number.NaN }],
		])("keeps the wildcard when the exact-model entry holds %s", (_label, specific) => {
			const configured = {
				"cursor/*": { maxRetries: 9 },
				"cursor/grok-code-fast-1": specific,
			} as unknown as Record<string, RetryPolicyOverride>;

			const policy = resolveRetryPolicy(GLOBAL, configured, cursorModel);

			expect(policy.maxRetries).toBe(9);
			expect(policy.matchedKey).toBe("cursor/*");
		});

		/**
		 * The explanation must name the key that actually set the value. An inert
		 * exact-model entry used to leave the source reading "cursor provider
		 * default", which sends the operator looking at a built-in for a number
		 * their own config produced.
		 */
		it("explains the key that actually applied, not the inert one", () => {
			const configured = {
				"cursor/*": { maxRetries: 9 },
				"cursor/grok-code-fast-1": {},
			} as unknown as Record<string, RetryPolicyOverride>;

			expect(describeRetryPolicySource(resolveRetryPolicy(GLOBAL, configured, cursorModel))).toBe(
				'retry.perProvider["cursor/*"]',
			);
		});

		it("treats a missing config object as no configuration", () => {
			expect(resolveRetryPolicy(GLOBAL, undefined, cursorModel).maxRetries).toBe(3);
		});
	});
});
