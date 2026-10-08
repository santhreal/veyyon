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
 *
 * THE GATEWAY. The auth gateway answered its client from inline regexes that ran before the registry
 * read the failure, so a wording the registry classified was decided twice and the two answers could
 * disagree, and a verdict named no rule. Its answers are now `GATEWAY_RULES` in the registry, each
 * declared in the family module it answers for. The gateway half of this suite reads the gateway
 * rules out of every family module's exports, so a rule declared and never assembled is red. It sends
 * every wording each rule declares, alone and against every wording and structure of every other
 * rule, through `classifyGatewayError`, so a wording its own rule does not answer, a wording an
 * earlier rule shadows, and an order change are red. A rule that answers a family the registry
 * flags (a cancellation, a spent allowance) must answer exactly where the registry sets the flag, so a
 * rule that re-reads the family's wording instead of its flag is red. It sends every HTTP reason
 * phrase the platform defines, and requires each answer to name one rule or to be the default, so a
 * verdict decided outside the rules is red for any wording in that corpus.
 *
 * What the gateway half does not catch: a verdict decided outside the rules on a wording that is
 * neither declared by a rule nor an HTTP reason phrase; a disagreement with the registry on a
 * spelling of a spent allowance that the agreement corpus does not hold; and whether a wording list
 * is the right vocabulary for the provider text it answers.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { STATUS_CODES } from "node:http";
import * as path from "node:path";
import { BUILTIN_API_IDS } from "@veyyon/ai/api-registry";
import { RequestAbortError } from "@veyyon/ai/error/abort";
import { LoginCancelledError } from "@veyyon/ai/error/auth";
import * as accountFamilies from "@veyyon/ai/error/domains/account";
import * as networkFamilies from "@veyyon/ai/error/domains/network";
import * as requestFamilies from "@veyyon/ai/error/domains/request";
import * as turnFamilies from "@veyyon/ai/error/domains/turn";
import type { GatewayRule, GatewayVerdict, GatewayWordingRule, Signal } from "@veyyon/ai/error/domains/types";
import {
	CLASS_RULES,
	CLASSIFICATION_RULES,
	classify,
	classifyIdentity,
	classifyMessage,
	create,
	explain,
	Flag,
	isUsageLimit,
	stringify,
} from "@veyyon/ai/error/flags";
import { classifyGatewayError } from "@veyyon/ai/error/gateway";
import { GATEWAY_RULES } from "@veyyon/ai/error/registry";
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
	 *
	 * `AuthFailed` reads the wording in two rules and only one of them is here. `auth-failure-prose`
	 * declines a 5xx, because reading `authentication` out of a sentence with no other evidence
	 * walled a `503 overloaded_error` whose body named an authentication service as the thing that
	 * was busy: an auth verdict is 401 or 403, and a status the server sent outranks a word in the
	 * prose beside it. `named-auth-refusal-code` is unguarded and stays here, because it matches a
	 * machine token rather than an English word — a gateway that holds no credential answers
	 * `503 auth_unavailable`, and no sentence about a busy auth service contains that token. The
	 * distinction is the one the paragraph above draws: a provider rewording a sentence must not
	 * move a verdict, and a provider renaming a code would cost this rule its match rather than
	 * hand it a wrong one.
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
			// `named-auth-refusal-code`: the `auth_unavailable` token, which carries a 503 the
			// gateway sends when it holds no usable credential (issue #986).
			"AuthFailed",
			// Two content rules, because a refusal arrives as text by definition: `content_filter` is
			// OpenAI's spelling and `content-verdict` covers the finish reasons and policy codes the
			// other providers use for the same verdict.
			"ContentBlocked",
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
			"content-verdict",
			"context-overflow-prose",
			"copilot-model-not-supported-flap",
			"fast-mode-entitlement-wall",
			"fast-mode-parameter-rejected",
			"malformed-function-call",
			"named-auth-refusal-code",
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
			"tool-choice-value-rejected",
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

describe("the auth gateway answers through a named registry rule", () => {
	/** What the gateway answers a failure no rule reads. */
	const DEFAULT: GatewayVerdict = { status: 502, type: "upstream_error" };
	/** A sentence that states no status, no cancellation and no wording any gateway rule reads. */
	const UNREAD = "the upstream failed";

	/** Every family module under `src/error/domains`, by file name. `types.ts` declares no rule. */
	const FAMILY_MODULES: Record<string, object> = {
		"account.ts": accountFamilies,
		"network.ts": networkFamilies,
		"request.ts": requestFamilies,
		"turn.ts": turnFamilies,
	};

	const isGatewayRule = (value: unknown): value is GatewayRule =>
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		"why" in value &&
		("answer" in value || "wordings" in value);
	const isWordingRule = (rule: GatewayRule): rule is GatewayWordingRule => "wordings" in rule;
	const gatewayNames = GATEWAY_RULES.map(rule => rule.name);

	/**
	 * The gateway's precedence, first-match-wins. The precedence sweep below ranks rules by this list
	 * rather than by the registry's array, so reordering the registry is red there too and not only in
	 * the pin.
	 */
	const POLICY = [
		"gateway-status-field",
		"gateway-cancellation-identity",
		"gateway-status-in-message",
		"gateway-cancellation-wording",
		"gateway-throttle-wording",
		"gateway-usage-limit",
		"gateway-auth-refusal-wording",
		"gateway-invalid-request-wording",
	];
	const rank = (name: string): number => POLICY.indexOf(name);

	/**
	 * The gateway rules that answer from a flag the registry sets, and the registry's reading of that
	 * flag for one thrown failure. Each rule answers exactly the failures the registry flags, unless an
	 * earlier rule answered first, so the gateway cannot decide the family a second time and disagree.
	 * Every other rule is pinned below as reading no registry flag, so a new rule is red until it
	 * records which it is.
	 */
	const REGISTRY_READINGS: Record<string, (failure: Error) => boolean> = {
		"gateway-cancellation-identity": failure => (classifyIdentity(failure) & Flag.Abort) !== 0,
		"gateway-usage-limit": failure => isUsageLimit(failure.message),
	};

	interface Answered {
		readonly verdict: { readonly status: number; readonly type: string };
		readonly rules: readonly string[];
	}

	function answer(failure: unknown): Answered {
		const rules: string[] = [];
		const { status, type } = classifyGatewayError(failure, rules);
		return { verdict: { status, type }, rules };
	}

	function appended(failure: Error, text: string): Error {
		failure.message = `${failure.message} ${text}`;
		return failure;
	}

	interface Carrier {
		readonly rule: string;
		readonly label: string;
		/** Adds what the rule reads to a failure, leaving what the failure already carries in place. */
		readonly carry: (failure: Error) => Error;
		readonly verdict: GatewayVerdict;
	}

	/**
	 * How each structural rule is reached, and what it answers. Pinned below against the rule set by
	 * exact equality, so a new structural rule is red until it records a failure that reaches it.
	 */
	const STRUCTURAL_CARRIERS: Record<string, Omit<Carrier, "rule" | "label">> = {
		"gateway-status-field": {
			carry: failure => Object.assign(failure, { status: 418 }),
			verdict: { status: 418, type: "invalid_request_error" },
		},
		"gateway-cancellation-identity": {
			carry: failure => Object.assign(failure, { name: "AbortError" }),
			verdict: { status: 499, type: "request_aborted" },
		},
		"gateway-status-in-message": {
			carry: failure => {
				failure.message = `HTTP 503: ${failure.message}`;
				return failure;
			},
			verdict: { status: 503, type: "upstream_error" },
		},
		"gateway-usage-limit": {
			carry: failure => appended(failure, "You have hit your ChatGPT usage limit. Try again in ~158 min."),
			verdict: { status: 429, type: "rate_limit_error" },
		},
	};

	/** Every way a rule is reached: each wording a rule declares, as declared and upper-cased, and each structural carrier. */
	const carriers: Carrier[] = GATEWAY_RULES.flatMap((rule): Carrier[] => {
		if (isWordingRule(rule)) {
			return rule.wordings.flatMap(wording =>
				[wording, wording.toUpperCase()].map(text => ({
					rule: rule.name,
					label: JSON.stringify(text),
					carry: (failure: Error) => appended(failure, text),
					verdict: rule.verdict,
				})),
			);
		}
		const structural = STRUCTURAL_CARRIERS[rule.name];
		return structural === undefined ? [] : [{ rule: rule.name, label: rule.name, ...structural }];
	});

	it("assembles every gateway rule a family module declares, so no rule is declared and unread", () => {
		const files = fs.readdirSync(path.join(import.meta.dirname, "../src/error/domains")).sort();
		expect(files).toEqual([...Object.keys(FAMILY_MODULES), "types.ts"].sort());
		const declared = Object.values(FAMILY_MODULES).flatMap(module => Object.values(module).filter(isGatewayRule));
		expect(declared.filter(rule => !GATEWAY_RULES.includes(rule)).map(rule => rule.name)).toEqual([]);
		expect(GATEWAY_RULES.filter(rule => !declared.includes(rule)).map(rule => rule.name)).toEqual([]);
	});

	it("holds exactly the gateway rules recorded here, in the order that is the policy", () => {
		expect(gatewayNames).toEqual(POLICY);
	});

	it("answers a family it reads from the registry exactly where the registry sets the family's flag", () => {
		expect(gatewayNames.filter(name => !(name in REGISTRY_READINGS))).toEqual([
			"gateway-status-field",
			"gateway-status-in-message",
			"gateway-cancellation-wording",
			"gateway-throttle-wording",
			"gateway-auth-refusal-wording",
			"gateway-invalid-request-wording",
		]);
		const failures: Error[] = [
			...carriers.map(carrier => carrier.carry(new Error(UNREAD))),
			...Object.values(STATUS_CODES).flatMap(phrase => (phrase === undefined ? [] : [new Error(phrase)])),
			// Spellings of a spent allowance that contain none of the gateway's own wordings.
			...[
				"insufficient_quota",
				"RESOURCE_EXHAUSTED",
				"You have run out of credits.",
				"usage_not_included",
				"Monthly spending limit reached.",
			].map(text => new Error(text)),
			new RequestAbortError(),
			new LoginCancelledError(),
			Object.assign(new Error(UNREAD), { name: "ToolAbortError" }),
			Object.assign(new Error(UNREAD), { name: "TimeoutError" }),
		];
		const disagreements: string[] = [];
		for (const failure of failures) {
			const [answeredBy] = answer(failure).rules;
			for (const [rule, flagged] of Object.entries(REGISTRY_READINGS)) {
				if (answeredBy !== undefined && rank(answeredBy) < rank(rule)) continue;
				if ((answeredBy === rule) !== flagged(failure)) {
					disagreements.push(`${rule} on ${failure.name} ${JSON.stringify(failure.message)}: ${answeredBy}`);
				}
			}
		}
		expect(disagreements).toEqual([]);
		// Each reading holds for some failure in the corpus, so the agreement is not vacuous.
		for (const flagged of Object.values(REGISTRY_READINGS)) expect(failures.some(flagged)).toBe(true);
	});

	it("gives every gateway rule a name no other rule in the registry holds, and a reason", () => {
		const names = [...CLASSIFICATION_RULES, ...CLASS_RULES, ...GATEWAY_RULES].map(rule => rule.name);
		expect(new Set(names).size).toBe(names.length);
		for (const rule of GATEWAY_RULES) {
			expect(rule.name).toMatch(/^gateway(?:-[a-z0-9]+)+$/);
			expect(rule.why.length).toBeGreaterThan(40);
		}
	});

	it("declares each wording once, as lowercase words, so the compiled pattern reads the list and nothing else", () => {
		const wordings = GATEWAY_RULES.filter(isWordingRule).flatMap(rule => rule.wordings);
		expect(new Set(wordings).size).toBe(wordings.length);
		for (const wording of wordings) expect(wording).toMatch(/^[a-z]+(?:[ _-][a-z]+)*$/);
	});

	it("records how every structural rule is reached", () => {
		expect(Object.keys(STRUCTURAL_CARRIERS).sort()).toEqual(
			GATEWAY_RULES.filter(rule => !isWordingRule(rule))
				.map(rule => rule.name)
				.sort(),
		);
	});

	it("answers every declared wording and every structural carrier through its own rule", () => {
		const got = carriers.map(carrier => ({ label: carrier.label, ...answer(carrier.carry(new Error(UNREAD))) }));
		const want = carriers.map(carrier => ({ label: carrier.label, verdict: carrier.verdict, rules: [carrier.rule] }));
		expect(got).toEqual(want);
	});

	it("reads a wording only as a whole word", () => {
		const inside = GATEWAY_RULES.filter(isWordingRule).flatMap(rule =>
			rule.wordings
				.filter(wording => answer(new Error(`x${wording}x`)).rules.includes(rule.name))
				.map(wording => `${rule.name}: ${wording}`),
		);
		expect(inside).toEqual([]);
	});

	it("answers through the first rule that reads a failure, whatever else the failure carries", () => {
		const wrong: string[] = [];
		for (const first of carriers) {
			for (const later of carriers) {
				if (rank(first.rule) >= rank(later.rule)) continue;
				for (const failure of [
					first.carry(later.carry(new Error(UNREAD))),
					later.carry(first.carry(new Error(UNREAD))),
				]) {
					const got = answer(failure);
					const expected = { verdict: first.verdict, rules: [first.rule] };
					if (JSON.stringify(got) !== JSON.stringify(expected)) {
						wrong.push(`${first.label} + ${later.label}: ${JSON.stringify(got)}`);
					}
				}
			}
		}
		expect(wrong).toEqual([]);
	});

	/**
	 * A verdict decided outside the rules names no rule, and so looks like the default in a trace
	 * while answering something else. The corpus is every reason phrase the platform's HTTP module
	 * defines, bare, after its status, and after `HTTP` and its status, in each shape a failure
	 * arrives as.
	 */
	it("names one rule for every answer but the default, across every HTTP reason phrase", () => {
		const phrases = Object.entries(STATUS_CODES).flatMap(([code, phrase]) =>
			phrase === undefined ? [] : [phrase, `${code} ${phrase}`, `HTTP ${code} ${phrase}`],
		);
		const shapes: ((text: string) => unknown)[] = [
			text => new Error(text),
			text => text,
			text => ({ message: text }),
		];
		const unnamed: string[] = [];
		const reached = new Set<string>();
		for (const phrase of phrases) {
			for (const shape of shapes) {
				const got = answer(shape(phrase));
				for (const rule of got.rules) reached.add(rule);
				const named = got.rules.length === 1 && gatewayNames.includes(got.rules[0]);
				const defaulted =
					got.rules.length === 0 && got.verdict.status === DEFAULT.status && got.verdict.type === DEFAULT.type;
				if (!named && !defaulted) unnamed.push(`${JSON.stringify(phrase)}: ${JSON.stringify(got)}`);
			}
		}
		expect(unnamed).toEqual([]);
		// The corpus reaches these rules, so the sweep is not green for want of an answer to check.
		expect([...reached].sort()).toEqual([
			"gateway-auth-refusal-wording",
			"gateway-invalid-request-wording",
			"gateway-status-in-message",
			"gateway-throttle-wording",
		]);
	});

	it("answers the default and names no rule for a failure no rule reads", () => {
		for (const failure of [new Error(UNREAD), UNREAD, { message: UNREAD }, "", undefined, null, {}, 42]) {
			expect(answer(failure)).toEqual({ verdict: DEFAULT, rules: [] });
		}
	});
});
