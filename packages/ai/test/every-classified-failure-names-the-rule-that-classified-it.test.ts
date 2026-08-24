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
 * The third defect had not shipped as a wrong answer, only as a diagnosis cost: the id states what a
 * failure IS and nothing stated which of the twenty-six rules said so, so a misclassification was
 * chased by re-running conditions by hand against the provider's sentence. Every rule states a name,
 * `explain` returns the ones that fired, and the whole inventory is pinned here.
 *
 * The class this closes: a classification member that is declared and unreachable, unnamed, decided
 * by prose without a stated reason, or unattributable once it has decided. The variant space is
 * derived from `Flag`, `CLASSIFICATION_RULES`, `CLASS_RULES` and the api registry at run time, so a
 * seventeenth flag or a new rule turns this red until someone records a decision for it. The sets
 * that are exempt are pinned by exact equality, never by a count, so a second member cannot join one
 * quietly.
 *
 * What it does not catch: whether a rule's condition is the RIGHT condition for the provider text it
 * was written for. That is what the per-incident suites beside this one pin, message by message. Nor
 * does the subsumption sweep reach a text rule, whose representative sentence cannot be derived from
 * the rule itself.
 */
import { describe, expect, it } from "bun:test";
import { BUILTIN_API_IDS } from "@veyyon/ai/api-registry";
import type { Signal } from "@veyyon/ai/error/domains/types";
import {
	CLASS_RULES,
	CLASSIFICATION_RULES,
	classify,
	classifyMessage,
	create,
	explain,
	Flag,
	stringify,
} from "@veyyon/ai/error/flags";
import { STREAM_FRAME_LIMIT_ERROR_NAME } from "@veyyon/utils/stream-frame-limit";

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
	 * purpose rather than the path of least resistance. It is a SET: the rules are grouped by the
	 * failure family that owns them and applied in any order, so their sequence in the registry is
	 * the recovery precedence and says nothing about classification.
	 */
	it("decides on prose alone only for the failures that arrive without structure", () => {
		const proseOnly = CLASSIFICATION_RULES.filter(rule => rule.structural === undefined)
			.map(rule =>
				flagNames
					.filter(({ bit }) => (rule.flags & bit) !== 0)
					.map(({ name }) => name)
					.join("|"),
			)
			.sort();
		expect(proseOnly).toEqual([
			"AuthFailed",
			"ContentBlocked",
			"ContextOverflow",
			"MalformedFunctionCall",
			"ProviderFinishError",
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

describe("a classification names the rules that produced it", () => {
	const ruleNames = [...CLASSIFICATION_RULES.map(rule => rule.name), ...CLASS_RULES.map(rule => rule.name)];

	/**
	 * The three names a trace can carry that are not rules, pinned by exact equality.
	 *
	 * Two are latches that REMOVE a flag after the walk (a framing violation is not transient however
	 * the wrapper worded it, a deterministic local-model parse failure is not worth another attempt),
	 * and one is the status-only fallback for a 401 or 403 that arrived with nothing to read. A fourth
	 * name outside the rule tables is a decision someone records here, because a diagnostic that
	 * prints a name nobody can find in the registry is worse than printing nothing.
	 */
	const NOT_A_RULE = [
		"framing-violation-clears-transient",
		"llama-cpp-tool-call-parse-clears-transient",
		"status-401-403",
	];

	it("holds exactly the rules recorded here, so a new one is a decision", () => {
		expect([...ruleNames].sort()).toEqual([
			"abort-by-error-name",
			"anthropic-connection-error",
			"anthropic-connection-timeout",
			"auth-failure-prose",
			"aws-credential-chain",
			"codex-retryable-stream",
			"codex-websocket-transport",
			"content-filter",
			"context-overflow-prose",
			"copilot-model-not-supported-flap",
			"fast-mode-entitlement-wall",
			"fast-mode-parameter-rejected",
			"malformed-function-call",
			"named-http2-refused-code",
			"named-http2-retryable-code",
			"opaque-or-exhausted-429",
			"provider-finish-error",
			"provider-http-error",
			"stale-responses-item",
			"stream-corruption",
			"stream-frame-limit-breach",
			"strict-tools-rejection",
			"timeout-with-http2-verdict",
			"timeout-without-http2-verdict",
			"transport-vocabulary",
			"usage-limit-vocabulary",
		]);
	});

	it("gives every rule a name of its own", () => {
		expect(new Set(ruleNames).size).toBe(ruleNames.length);
		for (const name of ruleNames) expect(name).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/);
	});

	it("names the rule that decided each failure, not only what it decided", () => {
		expect(explain(new Error("read ECONNRESET")).rules).toEqual(["transport-vocabulary"]);
		expect(explain(new Error("Request timed out after 60000ms")).rules).toEqual(["timeout-without-http2-verdict"]);
		expect(explain(new Error("prompt is too long: 250000 tokens > 200000 maximum")).rules).toEqual([
			"context-overflow-prose",
		]);
		expect(explain(new Error("incomplete: content_filter")).rules).toEqual(["content-filter"]);
		expect(explain(new Error("You've reached your usage limit.")).rules).toEqual(["usage-limit-vocabulary"]);
	});

	it("names every rule that fired, when more than one reads the same sentence", () => {
		const both = explain(new Error("MALFORMED_FUNCTION_CALL"));
		expect(both.rules).toEqual(["malformed-function-call", "transport-vocabulary"]);
		expect(stringify(both.id)).toBe("transient|malformed-function-call");
	});

	it("names each rule once, however many links of the chain carried it", () => {
		const chain = new Error("fetch failed", { cause: new Error("read ECONNRESET") });
		expect(explain(chain).rules).toEqual(["transport-vocabulary"]);
	});

	it("names the identity rule when the error states its own kind, and the latch that follows it", () => {
		const framing = Object.assign(new Error("a line arrived with no line feed"), {
			name: STREAM_FRAME_LIMIT_ERROR_NAME,
		});
		expect(explain(new Error("connection error, please retry", { cause: framing })).rules).toEqual([
			"stream-frame-limit-breach",
			"transport-vocabulary",
			"framing-violation-clears-transient",
		]);
	});

	it("names nothing for a failure no rule classifies", () => {
		const unclassified = explain(new Error("random failure"));
		expect(unclassified.rules).toEqual([]);
		expect(stringify(unclassified.id)).toBe("none");
	});

	it("agrees with classify, so a diagnostic and a decision cannot disagree", () => {
		for (const message of [
			"read ECONNRESET",
			"503 Service Unavailable",
			"401 Unauthorized: invalid api key",
			"random failure",
		]) {
			expect(explain(new Error(message)).id).toBe(classify(new Error(message)));
		}
	});

	it("prints only names the registry holds, or a latch pinned above", () => {
		const traces: string[][] = [];
		for (const message of [
			"read ECONNRESET",
			"Request timed out after 60000ms",
			"prompt is too long: 250000 tokens > 200000 maximum",
			"incomplete: content_filter",
			"MALFORMED_FUNCTION_CALL",
			"Provider finish_reason: error",
			"You've reached your usage limit.",
			"random failure",
		]) {
			traces.push([...explain(new Error(message)).rules]);
		}
		traces.push([...explain(Object.assign(new Error("nothing here to read"), { status: 401 })).rules]);
		const framing = Object.assign(new Error("a line arrived with no line feed"), {
			name: STREAM_FRAME_LIMIT_ERROR_NAME,
		});
		traces.push([...explain(new Error("connection error, please retry", { cause: framing })).rules]);
		const llama: string[] = [];
		classifyMessage({ errorMessage: "failed to parse tool call arguments as json", errorStatus: 500 }, llama);
		traces.push(llama);

		const known = new Set([...ruleNames, ...NOT_A_RULE]);
		const unknown = traces.flat().filter(name => !known.has(name));
		expect(unknown).toEqual([]);
		// Each latch is reachable, so the pinned set is not three dead strings.
		for (const latch of NOT_A_RULE) expect(traces.flat()).toContain(latch);
	});

	/**
	 * A rule that decides on structure alone and fires nowhere another rule does not, for flags that
	 * rule already sets, is dead: it cannot change an answer and it reads as a second opinion. The
	 * probe space is derived at run time from the api registry and the statuses these rules read, so a
	 * new structural rule is swept the day it lands.
	 *
	 * Text rules are out of scope: a representative sentence for one cannot be derived from the rule,
	 * which is what the per-incident suites beside this one pin message by message.
	 */
	it("keeps no structural rule another structural rule already covers", () => {
		const structural = CLASSIFICATION_RULES.filter(rule => rule.text === undefined && rule.structural !== undefined);
		const probes: Signal[] = [];
		for (const status of [undefined, 400, 401, 403, 404, 408, 413, 422, 429, 500, 502, 503, 504]) {
			for (const api of [undefined, ...BUILTIN_API_IDS]) {
				for (const http2 of [undefined, true, false]) {
					for (const code of [undefined, "model_not_supported"]) {
						probes.push({ text: "", status, api, http2, code });
					}
				}
			}
		}
		const fires = new Map(
			structural.map(rule => [rule.name, probes.map(probe => rule.structural?.(probe) === true)]),
		);

		const dead: string[] = [];
		for (const rule of structural) {
			const own = fires.get(rule.name) ?? [];
			expect(own.some(Boolean)).toBe(true);
			for (const other of structural) {
				if (other === rule || (rule.flags & ~other.flags) !== 0) continue;
				const cover = fires.get(other.name) ?? [];
				if (own.every((hit, index) => !hit || cover[index])) dead.push(`${rule.name} covered by ${other.name}`);
			}
		}
		expect(dead).toEqual([]);
	});
});
