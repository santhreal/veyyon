/**
 * The inline-output floor: how tightly an early tool result is held.
 *
 * WHY THIS SUITE EXISTS. A tool result is not paid for once. It enters context
 * as fresh input and is then re-read as a cache token on every later turn, so
 * the same bytes cost far more arriving at turn 3 than at turn 55.
 * `inlineCapForTurn` prices that by scaling the inline budget with the number
 * of remaining re-reads.
 *
 * The curve is not what actually binds. The scaled budget is
 * `maxBytes / remaining re-reads`, which sits under a 0.25 floor until about
 * four turns from the horizon, so across essentially all of a real session the
 * mechanism is a FLAT tightening by `1 / floorFraction`. The floor is therefore
 * the whole parameter, which is why it is a setting (`tools.inlineOutputFloor`)
 * and the curve is not, and why the exact crossover turn is pinned below rather
 * than described.
 *
 * The stakes run both ways, which is why this is measured and not chosen by
 * taste. Too generous and early output is billed for the rest of the session.
 * Too tight and the agent spills the output it most needs while it is still
 * orienting, then spends an extra turn fetching it back, and a turn costs more
 * than the bytes saved.
 *
 * A floor of 1 restores the flat cap EXACTLY. That is not a convenience: it is
 * the control arm, and an experiment comparing priced against unpriced output
 * is only valid if the unpriced side is byte-identical to the old behaviour.
 */
import { describe, expect, it } from "bun:test";
import { DEFAULT_INLINE_FLOOR_FRACTION } from "../src/config/settings-domains/shared";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_SESSION_HORIZON_TURNS,
	enforceInlineByteCap,
	inlineCapForTurn,
} from "../src/session/streaming-output";
import type { ToolSession } from "../src/tools/index";
import { inlineOutputPricing } from "../src/tools/output-artifact";
import { makeToolSession } from "./helpers/tool-session";

const BUDGET = DEFAULT_MAX_BYTES;
const HORIZON = DEFAULT_SESSION_HORIZON_TURNS;

describe("inlineCapForTurn: what the floor does", () => {
	/**
	 * The control arm, and the reason a floor of 1 is a supported value rather
	 * than a degenerate one. Comparing priced output against unpriced output only
	 * measures the pricing if the unpriced side is the old flat cap to the byte,
	 * at every turn, not merely close to it.
	 */
	it("restores the flat cap exactly at every turn when the floor is 1", () => {
		for (const turn of [0, 1, 7, 30, 55, 59, 60, 200]) {
			expect(inlineCapForTurn(BUDGET, turn, HORIZON, 1)).toBe(BUDGET);
		}
	});

	/**
	 * The default, at the turn where a result is most expensive. 51200 bytes
	 * scaled by 60 remaining re-reads is 853 bytes, which is far under the floor,
	 * so the floor is what the agent actually gets.
	 */
	it("holds a turn-0 result to a quarter of the budget by default", () => {
		expect(inlineCapForTurn(BUDGET, 0, HORIZON, DEFAULT_INLINE_FLOOR_FRACTION)).toBe(12_800);
	});

	/**
	 * The crossover, pinned exactly. This is the claim that the floor is the only
	 * parameter that matters: the scaled value does not exceed a 0.25 floor until
	 * turn 57 of a 60-turn horizon, so 57 of 60 turns get the identical cap and
	 * the "curve" is a flat 4x tightening in practice.
	 */
	it("is flat until four turns from the horizon, then rises", () => {
		const floor = DEFAULT_INLINE_FLOOR_FRACTION;
		for (let turn = 0; turn <= 56; turn++) {
			expect(inlineCapForTurn(BUDGET, turn, HORIZON, floor)).toBe(12_800);
		}
		expect(inlineCapForTurn(BUDGET, 57, HORIZON, floor)).toBe(17_067);
		expect(inlineCapForTurn(BUDGET, 58, HORIZON, floor)).toBe(25_600);
		expect(inlineCapForTurn(BUDGET, 59, HORIZON, floor)).toBe(BUDGET);
	});

	/** A lower floor is a tighter cap, which is the direction the setting exists
	 * to move. Asserted as exact byte counts so a change to the arithmetic cannot
	 * pass by merely preserving the ordering. */
	it("scales the early cap linearly with the floor", () => {
		expect(inlineCapForTurn(BUDGET, 0, HORIZON, 0.5)).toBe(25_600);
		expect(inlineCapForTurn(BUDGET, 0, HORIZON, 0.25)).toBe(12_800);
		expect(inlineCapForTurn(BUDGET, 0, HORIZON, 0.1)).toBe(5_120);
	});

	/** Past the horizon a result is re-read once, so it is nearly free and gets
	 * the whole budget whatever the floor says. The floor is a lower bound, and
	 * must never become an upper one. */
	it("gives the full budget past the horizon regardless of the floor", () => {
		for (const floor of [0.1, 0.25, 0.5, 1]) {
			expect(inlineCapForTurn(BUDGET, HORIZON, HORIZON, floor)).toBe(BUDGET);
			expect(inlineCapForTurn(BUDGET, HORIZON + 40, HORIZON, floor)).toBe(BUDGET);
		}
	});
});

/**
 * The floor arrives from a settings file a human can edit, so every value that
 * is not a fraction is reachable. None of them may produce a cap that is
 * negative, larger than the budget the caller set, or NaN, because the cap is
 * compared against byte counts and a NaN comparison silently disables the guard
 * rather than failing.
 */
describe("inlineCapForTurn: a floor that is not a fraction", () => {
	/** Above 1 would authorise a cap LARGER than the budget the caller passed,
	 * which would quietly overrule every other limit in the pipeline. */
	it("clamps a floor above 1 down to the full budget", () => {
		expect(inlineCapForTurn(BUDGET, 0, HORIZON, 4)).toBe(BUDGET);
		expect(inlineCapForTurn(BUDGET, 0, HORIZON, 1.0001)).toBe(BUDGET);
	});

	/** Below 0 would be a negative floor. It clamps to 0, which leaves the scaled
	 * value in charge: a turn-0 result then gets its true priced size of 853
	 * bytes rather than a nonsense cap. */
	it("clamps a negative floor to zero and lets the scaled value stand", () => {
		expect(inlineCapForTurn(BUDGET, 0, HORIZON, -1)).toBe(853);
		expect(inlineCapForTurn(BUDGET, 0, HORIZON, 0)).toBe(853);
	});

	/** A non-finite floor is not a preference, it is a broken value, so it takes
	 * the default rather than propagating NaN into the byte comparison. */
	it("falls back to the default for a non-finite floor", () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(inlineCapForTurn(BUDGET, 0, HORIZON, bad)).toBe(12_800);
		}
	});

	/** Omitting the floor takes the same default as supplying it, so the compiled
	 * fallback and the setting's default cannot disagree. */
	it("uses the shared default when no floor is given", () => {
		expect(inlineCapForTurn(BUDGET, 0, HORIZON)).toBe(
			inlineCapForTurn(BUDGET, 0, HORIZON, DEFAULT_INLINE_FLOOR_FRACTION),
		);
	});
});

describe("enforceInlineByteCap: the floor reaching a real result", () => {
	const text = "x".repeat(20_000);

	/** End to end at the default: 20000 bytes is comfortably under the 51200 flat
	 * cap and comfortably over the 12800 early-turn cap, so it is exactly the
	 * result whose fate the floor decides. It spills, and the elided bytes stay
	 * recoverable through the artifact footer. */
	it("spills a result that the flat cap would have kept inline", async () => {
		const saved: string[] = [];
		const out = await enforceInlineByteCap(text, {
			turnIndex: 0,
			floorFraction: DEFAULT_INLINE_FLOOR_FRACTION,
			saveArtifact: full => {
				saved.push(full);
				return "abc123";
			},
		});
		expect(out.length).toBeLessThan(text.length);
		expect(out).toContain("artifact://abc123");
		expect(saved).toEqual([text]);
	});

	/** The same bytes on the control arm. A floor of 1 must return the text
	 * untouched and save nothing, or the control is not a control. */
	it("keeps the identical result inline when the floor is 1", async () => {
		const saved: string[] = [];
		const out = await enforceInlineByteCap(text, {
			turnIndex: 0,
			floorFraction: 1,
			saveArtifact: full => {
				saved.push(full);
				return "abc123";
			},
		});
		expect(out).toBe(text);
		expect(saved).toEqual([]);
	});

	/** The floor is meaningless without a turn index, and must not become a cap
	 * of its own. A caller that prices nothing gets the flat cap even if a floor
	 * is present, which is what keeps lighter tool sessions on old behaviour. */
	it("ignores the floor when no turn index is given", async () => {
		const out = await enforceInlineByteCap(text, {
			floorFraction: 0.1,
			saveArtifact: () => "abc123",
		});
		expect(out).toBe(text);
	});

	/** The whole point of the floor is that it moves. A tenth spills strictly
	 * more than a quarter of the same result. */
	it("keeps less inline as the floor drops", async () => {
		const at = async (floorFraction: number): Promise<number> =>
			(await enforceInlineByteCap(text, { turnIndex: 0, floorFraction, saveArtifact: () => undefined })).length;
		expect(await at(0.1)).toBeLessThan(await at(0.25));
		expect(await at(0.25)).toBeLessThan(await at(0.5));
	});
});

/**
 * Build a tool session that implements only what pricing reads.
 *
 * Through the typed helper, not a double cast: the cast switched off checking of
 * the two members this stub sets, which are the entire point of the stub. A
 * `getTurnIndex` with the wrong signature, or the setting key misspelled into a
 * key nothing reads, would have been accepted silently and the tests below would
 * have passed while proving nothing.
 */
function sessionWith(turnIndex: number | undefined, floor: unknown): ToolSession {
	return makeToolSession({
		...(turnIndex === undefined ? {} : { getTurnIndex: () => turnIndex }),
		settings: { get: (key: string) => (key === "tools.inlineOutputFloor" ? floor : undefined) },
	});
}

/**
 * `inlineOutputPricing` is the ONE owner of "how is this result priced", spread
 * into every capped tool. Reading the two inputs separately at each call site is
 * how they drift: bash ends up scaling by turn and browser does not, for no
 * reason anyone decided. These pin that the owner reads both.
 */
describe("inlineOutputPricing", () => {
	/** Both inputs come from the session, and nothing else does. */
	it("reads the turn index and the floor setting", () => {
		expect(inlineOutputPricing(sessionWith(7, 0.5))).toEqual({ turnIndex: 7, floorFraction: 0.5 });
	});

	/**
	 * A session that cannot report its turn (a subagent, a test harness, an
	 * embedding host) must fall back to the flat cap, not to turn 0. Turn 0 is the
	 * most expensive turn there is, so defaulting to it would hold every unpriced
	 * session to the tightest cap in the table.
	 */
	it("leaves the turn index undefined when the session cannot report one", async () => {
		const pricing = inlineOutputPricing(sessionWith(undefined, 0.25));
		expect(pricing.turnIndex).toBeUndefined();
		expect(await enforceInlineByteCap("y".repeat(20_000), pricing)).toHaveLength(20_000);
	});

	/** The control-arm value survives the trip from settings to the cap, which is
	 * what makes `tools.inlineOutputFloor: 1` a usable bench arm. */
	it("passes a floor of 1 straight through", () => {
		expect(inlineOutputPricing(sessionWith(0, 1)).floorFraction).toBe(1);
	});

	/** An unset setting yields undefined, and `inlineCapForTurn` then applies its
	 * own default. The two defaults are the same constant, so an operator who has
	 * never touched the setting and one who set it to 0.25 get the same cap. */
	it("yields undefined for an unset setting, which takes the shared default", () => {
		const pricing = inlineOutputPricing(sessionWith(0, undefined));
		expect(pricing.floorFraction).toBeUndefined();
		expect(inlineCapForTurn(BUDGET, 0, HORIZON, pricing.floorFraction)).toBe(
			inlineCapForTurn(BUDGET, 0, HORIZON, DEFAULT_INLINE_FLOOR_FRACTION),
		);
	});
});
