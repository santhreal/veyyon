/**
 * WHY. Provider failures were classified by an if-chain of roughly thirty regexes, each added for
 * one incident, in a file that recorded the history of what had broken rather than a contract. Two
 * defects came out of that shape and both had shipped. A flag could exist with nothing that sets it
 * (`OAuthExpiry` sat in the table and in `KIND_MASK`, so `is(id, Flag.OAuthExpiry)` answered false
 * for every dead grant there has ever been), and a flag could exist with nothing that NAMES it (the
 * hand-kept label list stopped at thirteen while the flag table reached sixteen, so a grammar
 * rejection, a fast-mode wall and a dead grant each rendered in diagnostics as `classified:0x...`
 * — the three failures whose recovery is least obvious were the three with no name).
 *
 * The class this closes: a classification member that is declared and unreachable, unnamed, or
 * decided by prose without a stated reason. The variant space is derived from `Flag` and from
 * `CLASSIFICATION_RULES` at run time, so a seventeenth flag or a new rule turns this red until
 * someone records a decision for it. The sets that are exempt are pinned by exact equality, never
 * by a count, so a second member cannot join one quietly.
 *
 * What it does not catch: whether a rule's condition is the RIGHT condition for the provider text it
 * was written for. That is what the per-incident suites beside this one pin, message by message.
 */
import { describe, expect, it } from "bun:test";
import { CLASSIFICATION_RULES, classify, create, Flag, stringify } from "@veyyon/ai/error/flags";

/** Bits that are not failure kinds, or that are set outside the classifier and named where. */
const SET_ELSEWHERE: Record<string, string> = {
	Class: "the classified-marker bit: it records that an id holds flags rather than a bare status",
	ThinkingLoop: "utils/thinking-loop.ts, from the repetition detector rather than from any message",
	SilentAbort: "coding-agent session, when an internal plan step ends the turn with nothing to show",
	UserInterrupt: "coding-agent session, when the operator stops the turn",
	Abort: "error/abort.ts and error/auth.ts, structurally on the abort classes themselves",
};

const flagNames = Object.entries(Flag).map(([name, bit]) => ({ name, bit }));

describe("the classification rule set", () => {
	it("has a rule for every failure kind, or names where the kind is set instead", () => {
		const ruled = CLASSIFICATION_RULES.reduce((bits, rule) => bits | rule.flags, 0);
		const unruled = flagNames.filter(({ bit }) => (ruled & bit) === 0).map(({ name }) => name);
		expect(unruled.sort()).toEqual(Object.keys(SET_ELSEWHERE).sort());
	});

	it("names every failure kind in a diagnostic, so none renders as a hex id", () => {
		for (const { name, bit } of flagNames) {
			if (name === "Class") continue;
			const rendered = stringify(create(bit));
			expect(rendered).not.toContain("classified:0x");
			expect(rendered).toBe(name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase());
		}
	});

	it("states why every rule exists", () => {
		for (const rule of CLASSIFICATION_RULES) {
			expect(rule.why.length).toBeGreaterThan(40);
			expect(rule.flags & Flag.Class).toBe(0);
		}
	});

	/**
	 * A rule with no structural condition decides on the provider's wording alone, which is the
	 * shape that reclassifies itself when a provider rewords a sentence. Each one is here because
	 * the failure genuinely arrives with no status and no code — a dead socket is a rejection, not a
	 * response — and the set is pinned so a new prose-only rule is a decision somebody makes on
	 * purpose rather than the path of least resistance.
	 */
	it("decides on prose alone only for the failures that arrive without structure", () => {
		const proseOnly = CLASSIFICATION_RULES.filter(rule => rule.structural === undefined).map(rule =>
			flagNames
				.filter(({ bit }) => (rule.flags & bit) !== 0)
				.map(({ name }) => name)
				.join("|"),
		);
		expect(proseOnly).toEqual([
			"ContextOverflow",
			"MalformedFunctionCall",
			"ProviderFinishError",
			"ContentBlocked",
			"AuthFailed",
			"UsageLimit",
		]);
	});

	it("gives every rule a condition, so no rule matches everything", () => {
		for (const rule of CLASSIFICATION_RULES) {
			expect(rule.structural !== undefined || rule.text !== undefined).toBe(true);
		}
	});
});

describe("a failure classifies to the same kinds the chain produced", () => {
	/**
	 * One failure per rule, in the wording the rule was written for, pinned by the diagnostic label
	 * rather than by a bit pattern: the label is what a log carries and what an operator reads. This
	 * is the corpus that proves the table is behaviour-for-behaviour the chain it replaced, and it
	 * fails on a rule whose condition drifted even when the rule still exists.
	 */
	const corpus: [string, string][] = [
		["prompt is too long: 250000 tokens > 200000 maximum", "context-overflow"],
		["MALFORMED_FUNCTION_CALL", "transient|malformed-function-call"],
		["Provider finish_reason: error", "provider-finish-error"],
		["incomplete: content_filter", "content-blocked"],
		["401 Unauthorized: invalid api key", "auth-failed"],
		["You've reached your usage limit. Upgrade to increase your limit.", "usage-limit"],
		["503 Service Unavailable", "transient"],
		["read ECONNRESET", "transient"],
		["Request timed out after 60000ms", "transient|timeout"],
	];

	for (const [message, expected] of corpus) {
		it(`classifies ${JSON.stringify(message)} as ${expected}`, () => {
			expect(stringify(classify(new Error(message)))).toBe(expected);
		});
	}
});
