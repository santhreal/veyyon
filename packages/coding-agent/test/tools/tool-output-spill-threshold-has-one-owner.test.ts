/**
 * `tools.artifactSpillThreshold`: the ONE answer to how many bytes of a tool's
 * output stay in the conversation, as an operator actually sets it.
 *
 * Why this suite exists:
 *   That question had two answers with the same meaning and the same value. The
 *   setting governed the centralised spill that runs after a tool returns, and
 *   every streaming tool priced itself against a compiled 50KB constant nothing
 *   could reach. They agreed only because both happened to be 50KB, so an
 *   operator who lowered the setting to 2KB moved the centralised path and left
 *   bash, eval, ssh and the interactive shell at 50KB -- and eval alone is about
 *   80% of tool-result bytes, so most of the setting did nothing while reading as
 *   if it had been applied. A settings row that reaches half of what it names is
 *   worse than one that reaches none: the operator believes the lever was pulled.
 *
 * The contract these tests lock in:
 *   - The shipped default is unchanged, so the unification moved nothing.
 *   - A configured threshold reaches the BYTES on the streaming path too, proven
 *     as exact byte lengths on a real body rather than as "something was cut".
 *   - The threshold and `tools.inlineOutputFloor` compose, because the floor is a
 *     SHARE of this budget and the two are one parameter pair.
 *   - Spilling loses nothing: the full text is written as an artifact and the
 *     result carries the footer that reads it back, so a lower threshold costs a
 *     re-read rather than output.
 *   - A threshold that cannot be honoured is refused OUT LOUD and falls back to
 *     the compiled default, never silently corrected (Law 10).
 *
 * The precedence case is the one that would otherwise have shipped a dead knob a
 * second time. The budget is spread into the cap options alongside the turn
 * index, and a caller that passes no explicit `maxBytes` would write
 * `maxBytes: undefined` OVER the configured value -- which is every caller but
 * grep, so the setting would have gone on reaching only the path it already
 * reached.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	DEFAULT_ARTIFACT_SPILL_THRESHOLD_KB,
	DEFAULT_INLINE_OUTPUT_MAX_BYTES,
} from "@veyyon/coding-agent/config/settings-domains/shared";
import {
	DEFAULT_MAX_BYTES,
	enforceInlineByteCap,
	inlineCapForTurn,
} from "@veyyon/coding-agent/session/streaming-output";
import {
	type InlinePricingSource,
	inlineBudgetFor,
	inlineOutputPricing,
} from "@veyyon/coding-agent/tools/output-artifact";
import { logger } from "@veyyon/utils";

/** A pricing source with no turn index, which is the flat-cap path. */
function pricingSource(overrides?: Record<string, unknown>, turnIndex?: number): InlinePricingSource {
	return {
		settings: Settings.isolated(overrides),
		...(turnIndex !== undefined ? { getTurnIndex: () => turnIndex } : {}),
	};
}

/** ASCII, so one character is one byte and every byte assertion below is exact. */
function text(bytes: number): string {
	return "a".repeat(bytes);
}

describe("the compiled default and the schema default are one number", () => {
	/**
	 * Two literals for one budget is how a schema default and a compiled fallback
	 * drift: the first tuning moves one of them and the effective budget then
	 * depends on whether a caller happened to have settings in hand.
	 */
	it("DEFAULT_MAX_BYTES is the setting's default, 50KB", () => {
		expect(DEFAULT_MAX_BYTES).toBe(DEFAULT_INLINE_OUTPUT_MAX_BYTES);
		expect(DEFAULT_MAX_BYTES).toBe(50 * 1024);
		expect(Settings.isolated().get("tools.artifactSpillThreshold") * 1024).toBe(DEFAULT_MAX_BYTES);
	});

	/** Unifying the two answers must not move the shipped behaviour of anyone who never sets it. */
	it("an unconfigured session is priced exactly as before", () => {
		expect(inlineBudgetFor(pricingSource())).toBe(DEFAULT_MAX_BYTES);
		// The setting's unit is KILOBYTES, which is why the snapshot reads 50 where the
		// budget reads 51200. Pinning both is what stops a future reader "fixing" one of
		// them to match the other and multiplying or dividing the real budget by 1024.
		expect(Settings.isolated().getEffectiveSnapshot()["tools.artifactSpillThreshold"]).toBe(
			DEFAULT_ARTIFACT_SPILL_THRESHOLD_KB,
		);
		expect(DEFAULT_ARTIFACT_SPILL_THRESHOLD_KB * 1024).toBe(DEFAULT_MAX_BYTES);
	});

	/**
	 * The ONE-PLACE lock. This whole change exists because two rows meant "how many
	 * bytes of tool output stay inline"; a second one reappearing under any name is
	 * the same defect returning, and it would be invisible until an operator set the
	 * one that reaches fewer tools.
	 */
	it("no second setting names the same inline byte budget", () => {
		const paths = Object.keys(Settings.isolated().getEffectiveSnapshot());
		expect(paths.filter(path => /inlineOutputMaxBytes|inlineOutputBytes|spillThreshold/i.test(path))).toEqual([
			"tools.artifactSpillThreshold",
		]);
	});
});

describe("a configured budget reaches the bytes", () => {
	it("prices a result at the configured budget, not the compiled one", () => {
		expect(inlineBudgetFor(pricingSource({ "tools.artifactSpillThreshold": 8 }))).toBe(8192);
		expect(inlineBudgetFor(pricingSource({ "tools.artifactSpillThreshold": 100 }))).toBe(102400);
	});

	/**
	 * The wired-through effect, as bytes. The same 20KB of output is whole under
	 * the default budget and cut under an 8KB one, and the cut result is smaller
	 * than the budget it was cut to. Asserting the byte length rather than "it
	 * contains an ellipsis" is what makes this a proof that the operator's number
	 * is the number in force.
	 */
	it("keeps a 20KB result whole at the default and cuts it at 8KB", async () => {
		const body = text(20 * 1024);

		const whole = await enforceInlineByteCap(body, inlineOutputPricing(pricingSource()));
		expect(Buffer.byteLength(whole, "utf-8")).toBe(20 * 1024);
		expect(whole).toBe(body);

		const cut = await enforceInlineByteCap(
			body,
			inlineOutputPricing(pricingSource({ "tools.artifactSpillThreshold": 8 })),
		);
		expect(Buffer.byteLength(cut, "utf-8")).toBeLessThanOrEqual(8192);
		expect(cut).not.toBe(body);
	});

	/**
	 * Spilling is not eliding. The full text goes to a session artifact and the
	 * result carries the footer that reads it back, so a smaller budget buys
	 * cheaper carried context at the price of a re-read, never lost output. If
	 * this ever stopped holding, a lowered budget would be a recall loss wearing
	 * a performance setting's clothes.
	 */
	it("writes the full text to an artifact and footers the id when it cuts", async () => {
		const body = text(20 * 1024);
		let saved: string | undefined;
		const result = await enforceInlineByteCap(body, {
			...inlineOutputPricing(pricingSource({ "tools.artifactSpillThreshold": 8 })),
			saveArtifact: full => {
				saved = full;
				return "abc123";
			},
		});
		expect(saved).toBe(body);
		expect(result).toContain("artifact://abc123");
	});
});

describe("the budget and the floor compose", () => {
	/**
	 * The floor is a SHARE of the budget, so the effective cap for an early turn
	 * must move when either moves. This is the reason the budget had to become
	 * reachable at all: a quarter of 50KB and a quarter of 8KB are two different
	 * budgets, and only one of the two factors could be set.
	 */
	it("an early-turn cap tracks the configured budget through the floor", () => {
		const early = 3;
		const big = inlineBudgetFor(pricingSource({ "tools.inlineOutputFloor": 0.25 }, early));
		const small = inlineBudgetFor(
			pricingSource({ "tools.artifactSpillThreshold": 8, "tools.inlineOutputFloor": 0.25 }, early),
		);
		expect(big).toBe(inlineCapForTurn(DEFAULT_MAX_BYTES, early, undefined, 0.25));
		expect(small).toBe(inlineCapForTurn(8192, early, undefined, 0.25));
		expect(small).toBeLessThan(big);
	});

	/** A floor of 1 is the documented control arm: the flat budget, whatever the turn. */
	it("a floor of 1 gives the configured budget flat, on any turn", () => {
		for (const turn of [0, 3, 30, 59]) {
			expect(
				inlineBudgetFor(pricingSource({ "tools.artifactSpillThreshold": 8, "tools.inlineOutputFloor": 1 }, turn)),
			).toBe(8192);
		}
	});
});

describe("precedence: a caller's own bound wins, and its absence does not clobber the setting", () => {
	/**
	 * grep bounds its output differently (head only, because matches arrive in
	 * order) and passes its own byte count. A caller that has a reason wins.
	 */
	it("an explicit maxBytes overrides the configured budget", () => {
		expect(inlineBudgetFor(pricingSource({ "tools.artifactSpillThreshold": 8 }), 4096)).toBe(4096);
	});

	/**
	 * The regression this whole knob would have died of. `{ ...pricing, maxBytes }`
	 * with no argument writes `maxBytes: undefined` over the configured value, and
	 * since almost every caller omits it, the setting would have been readable,
	 * documented and completely inert.
	 */
	it("omitting maxBytes leaves the configured budget in force", () => {
		expect(inlineBudgetFor(pricingSource({ "tools.artifactSpillThreshold": 8 }), undefined)).toBe(8192);
		expect(inlineBudgetFor(pricingSource({ "tools.artifactSpillThreshold": 8 }))).toBe(8192);
	});
});

describe("a budget that cannot be honoured is refused out loud", () => {
	/**
	 * Zero is not a preference for a very small budget: it elides every result
	 * down to its ellipsis. A negative one is the same, and a non-finite one
	 * poisons every byte comparison downstream so nothing spills at all. Each
	 * falls back to the compiled default, which is the same answer as not setting
	 * it, and each says so -- a silently corrected setting is a file whose value
	 * disagrees with the value in force, with nothing an operator can see.
	 */
	it.each([
		["zero", 0],
		["negative", -1],
		["not a number", Number.NaN],
		["infinite", Number.POSITIVE_INFINITY],
	])("refuses a %s budget, warns, and uses the compiled default", (_label, configured) => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			expect(inlineBudgetFor(pricingSource({ "tools.artifactSpillThreshold": configured }))).toBe(DEFAULT_MAX_BYTES);
			expect(warn).toHaveBeenCalled();
			const message = warn.mock.calls[0]?.[0];
			expect(message).toContain("tools.artifactSpillThreshold");
		} finally {
			warn.mockRestore();
		}
	});

	/** A session with no settings at all (an MCP or extension tool context) is unpriced, not broken. */
	it("a pricing source with no settings takes the compiled default in silence", () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			expect(inlineBudgetFor({})).toBe(DEFAULT_MAX_BYTES);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});
