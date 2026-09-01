/**
 * WHY THIS EXISTS. `retry.fallbackChains` is keyed by two different things that look alike as text:
 * a model role (`smol`, `default`) and a model selector (`anthropic/claude-sonnet-4`, optionally
 * with an effort suffix). Everything downstream of the chain depends on telling them apart and on
 * separating a selector's model from its effort: the chain key decides whether a fallback follows a
 * role or follows the model across role reassignments, and the BASE selector is what cooldown and
 * pinning state is keyed by. Two selectors that name one model at two efforts must collapse to one
 * base, or the same model accumulates a second, independent cooldown entry and a model that was
 * stood down keeps being retried at another effort.
 *
 * WHAT IT DOES NOT CATCH. `formatRetryFallbackSelector` is not exercised: it is a composition of
 * `formatModelStringWithRouting` and `formatModelSelectorValue`, both owned and tested in
 * `config/model-resolver`, and reaching it needs a populated model catalog that says nothing about
 * this module. Nor does it pin how `parseModelString` resolves a `:` that could be either an effort
 * suffix or part of a model id; that ambiguity belongs to the parser this module calls.
 */
import { describe, expect, it } from "bun:test";
import {
	formatRetryFallbackBaseSelector,
	isRetryFallbackModelKey,
	isRetryFallbackWildcardKey,
	parseRetryFallbackSelector,
} from "@veyyon/coding-agent/session/retry-fallback";

describe("a fallback chain key says whether it follows a role or a model", () => {
	it("reads a name with no slash as a role, which is not a selector", () => {
		for (const role of ["default", "smol", "slow"]) {
			expect(isRetryFallbackModelKey(role)).toBe(false);
			expect(isRetryFallbackWildcardKey(role)).toBe(false);
			// The pairing is the point: a role key must not also parse as a model selector, or one
			// key would be read as both and the chain would follow the wrong thing.
			expect(parseRetryFallbackSelector(role)).toBeUndefined();
		}
	});

	it("reads a slashed key as a model, and only a trailing /* as a wildcard", () => {
		expect(isRetryFallbackModelKey("anthropic/claude-sonnet-4")).toBe(true);
		expect(isRetryFallbackWildcardKey("anthropic/claude-sonnet-4")).toBe(false);

		expect(isRetryFallbackModelKey("anthropic/*")).toBe(true);
		expect(isRetryFallbackWildcardKey("anthropic/*")).toBe(true);
	});

	it("does not read a star anywhere else as a wildcard", () => {
		// `endsWith("/*")` is the rule; a star inside the id is part of the id.
		expect(isRetryFallbackWildcardKey("anthropic/*-sonnet")).toBe(false);
	});
});

describe("a fallback chain selector keeps its model apart from its effort", () => {
	it("refuses a selector that names nothing", () => {
		expect(parseRetryFallbackSelector("")).toBeUndefined();
		expect(parseRetryFallbackSelector("   ")).toBeUndefined();
		expect(parseRetryFallbackSelector("not a model")).toBeUndefined();
	});

	it("parses a bare model selector with no effort", () => {
		const parsed = parseRetryFallbackSelector("anthropic/claude-sonnet-4");
		expect(parsed).toEqual({
			raw: "anthropic/claude-sonnet-4",
			provider: "anthropic",
			id: "claude-sonnet-4",
			thinkingLevel: undefined,
		});
	});

	it("splits a trailing effort suffix off the model id", () => {
		const parsed = parseRetryFallbackSelector("anthropic/claude-sonnet-4:high");
		expect(parsed?.provider).toBe("anthropic");
		// The id must NOT keep the suffix, or the fallback would name a model that does not exist.
		expect(parsed?.id).toBe("claude-sonnet-4");
		expect(parsed?.thinkingLevel).toBe("high");
	});

	it("carries the trimmed text as raw, so one selector keys one entry", () => {
		// State is keyed by `raw`. Untrimmed text would key a second entry for the same selector.
		expect(parseRetryFallbackSelector("  anthropic/claude-sonnet-4  ")?.raw).toBe("anthropic/claude-sonnet-4");
	});

	it("collapses every effort of one model onto a single base selector", () => {
		const plain = parseRetryFallbackSelector("anthropic/claude-sonnet-4");
		const high = parseRetryFallbackSelector("anthropic/claude-sonnet-4:high");
		const max = parseRetryFallbackSelector("anthropic/claude-sonnet-4:max");
		if (!plain || !high || !max) throw new Error("expected all three selectors to parse");

		const base = "anthropic/claude-sonnet-4";
		expect(formatRetryFallbackBaseSelector(plain)).toBe(base);
		expect(formatRetryFallbackBaseSelector(high)).toBe(base);
		expect(formatRetryFallbackBaseSelector(max)).toBe(base);
	});

	it("keeps two different models on two different base selectors", () => {
		const one = parseRetryFallbackSelector("anthropic/claude-sonnet-4:high");
		const two = parseRetryFallbackSelector("anthropic/claude-opus-4:high");
		if (!one || !two) throw new Error("expected both selectors to parse");

		expect(formatRetryFallbackBaseSelector(one)).not.toBe(formatRetryFallbackBaseSelector(two));
	});

	it("parses a wildcard key as the literal star id", () => {
		const parsed = parseRetryFallbackSelector("anthropic/*");
		expect(parsed?.provider).toBe("anthropic");
		expect(parsed?.id).toBe("*");
		expect(formatRetryFallbackBaseSelector(parsed!)).toBe("anthropic/*");
	});
});
