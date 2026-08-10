/**
 * What the retry machinery is allowed to do with a failed turn is decided
 * entirely by classification, so classification is where a whole class of
 * non-recovery is either prevented or created.
 *
 * Three unions are closed here, each derived from source at run time so a new
 * member turns this file red instead of shipping undecided:
 *
 *  - every `AIError.Flag`, against a recorded retriability decision;
 *  - every exported `ProviderHttpError` subclass, against the requirement that
 *    a stated retry window survives into the message the session reads;
 *  - every source filename that could appear in a stack frame and collide with
 *    a transient keyword, against the requirement that a stack is not evidence.
 *
 * The fourth block is the observed failure corpus itself: the distinct error
 * texts behind 61% of unrecovered turns, each pinned to the routing decision it
 * must produce.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as AIError from "@veyyon/ai/error";
import { isProviderRetryableError } from "@veyyon/ai/providers/anthropic";

/**
 * Whether a turn carrying only this flag is worth sending again.
 *
 * Every flag needs an entry. A flag with no decision is a flag whose failures
 * are routed by accident, which is how a non-transient quota error ends up in a
 * seconds-scale retry loop.
 */
const RETRY_DECISION: Record<string, boolean> = {
	// Marker bit, not a failure kind: it only records that the id holds flags
	// rather than a bare HTTP status. It authorizes nothing on its own.
	Class: false,
	// Transient faults: the next attempt can legitimately differ.
	Transient: true,
	ThinkingLoop: true,
	StaleResponsesItem: true,
	ProviderFinishError: true,
	// Owned by the credential-rotation layer, which retries against a DIFFERENT
	// account. Retriable at the session level for that reason, and deliberately
	// not retriable at the provider level (asserted in the corpus block below).
	UsageLimit: true,
	// The call was never well-formed enough to run, so there is no tool effect
	// to duplicate and re-sampling is the repair.
	MalformedFunctionCall: true,
	// Repeating these reproduces them exactly. Retrying is pure cost.
	Timeout: false,
	ContentBlocked: false,
	ContextOverflow: false,
	AuthFailed: false,
	OAuthExpiry: false,
	Grammar: false,
	FastModeUnsupported: false,
	// Deliberate stops. Retrying one overrides a decision already taken.
	SilentAbort: false,
	UserInterrupt: false,
	Abort: false,
};

const RETRY_AFTER_HEADERS = new Headers({ "retry-after": "62" });
const NEUTRAL_429 = "429 upstream declined the request";

/**
 * How to build each provider HTTP error carrying a stated retry window. The
 * constructors genuinely differ, so this cannot be derived — but the SET of
 * classes can be, and is asserted against these keys below.
 */
const PROVIDER_ERROR_FACTORIES: Record<string, () => AIError.ProviderHttpError> = {
	AnthropicApiError: () => new AIError.AnthropicApiError(429, NEUTRAL_429, RETRY_AFTER_HEADERS),
	AuthGatewayError: () => new AIError.AuthGatewayError(NEUTRAL_429, 429, RETRY_AFTER_HEADERS),
	BedrockApiError: () => new AIError.BedrockApiError(NEUTRAL_429, 429, { headers: RETRY_AFTER_HEADERS }),
	CursorApiError: () => new AIError.CursorApiError(NEUTRAL_429, 429, { headers: RETRY_AFTER_HEADERS }),
	DevinApiError: () => new AIError.DevinApiError(NEUTRAL_429, 429, { headers: RETRY_AFTER_HEADERS }),
	GeminiCliApiError: () => new AIError.GeminiCliApiError(NEUTRAL_429, 429, { headers: RETRY_AFTER_HEADERS }),
	GitLabDuoApiError: () => new AIError.GitLabDuoApiError(NEUTRAL_429, 429, { headers: RETRY_AFTER_HEADERS }),
	GitLabDuoWorkflowApiError: () =>
		new AIError.GitLabDuoWorkflowApiError(NEUTRAL_429, 429, { headers: RETRY_AFTER_HEADERS }),
	GoogleApiError: () => new AIError.GoogleApiError(NEUTRAL_429, 429, { headers: RETRY_AFTER_HEADERS }),
	OllamaApiError: () => new AIError.OllamaApiError(NEUTRAL_429, 429, { headers: RETRY_AFTER_HEADERS }),
	OpenAIHttpError: () => new AIError.OpenAIHttpError(NEUTRAL_429, { status: 429, headers: RETRY_AFTER_HEADERS }),
};

function discoverProviderHttpErrorNames(): string[] {
	const names: string[] = [];
	for (const [name, exported] of Object.entries(AIError)) {
		if (typeof exported !== "function") continue;
		if (exported.prototype instanceof AIError.ProviderHttpError) names.push(name);
	}
	return names.sort();
}

/**
 * Every TypeScript source file the classifier's own stack can name. Filtering
 * these down to names that "look transient" was a hole: a frame naming
 * `auth-storage.ts` sets no transient keyword and still smuggled `AuthFailed`
 * past a partial fix. A stack frame is never evidence about the failure, for
 * any flag, so the whole tree is the variant space and a new file joins it
 * without anyone remembering to.
 */
async function sourceFilePaths(): Promise<string[]> {
	const roots = [path.join(import.meta.dirname, "../src"), path.join(import.meta.dirname, "../../utils/src")];
	const found: string[] = [];
	for (const root of roots) {
		for (const entry of await fs.readdir(root, { recursive: true })) {
			if (entry.endsWith(".ts")) found.push(path.join(root, entry));
		}
	}
	return found;
}

/**
 * A message the classifier's own text patterns are built to recognise, one per
 * flag. Used as stack-frame content: a predicate that reads the unstripped
 * string will pick the flag straight back out of the frame.
 */
const FRAME_BAIT_TEXT: Record<keyof typeof AIError.Flag, string> = {
	Class: "class marker",
	Transient: "503 service unavailable: overloaded_error",
	ThinkingLoop: "model repeated the same thinking block",
	StaleResponsesItem: "Item with id 'rs_abc' not found. previous_response expired",
	ProviderFinishError: "Provider finish_reason: error",
	UsageLimit: "You've reached your usage limit. Upgrade to increase your limit.",
	MalformedFunctionCall: "MALFORMED_FUNCTION_CALL",
	Timeout: "Request timed out after 60000ms",
	ContentBlocked: "incomplete: content_filter",
	ContextOverflow: "prompt is too long: 250000 tokens > 200000 maximum",
	AuthFailed: "401 Unauthorized: invalid api key",
	OAuthExpiry: '400 {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}',
	Grammar: "grammar error",
	FastModeUnsupported: "fast mode is not supported for this model",
	SilentAbort: "silent abort",
	UserInterrupt: "user interrupted the request",
	Abort: "The operation was aborted",
};

/**
 * The distinct error texts behind the unrecovered turns in the session corpus,
 * each with the routing it must produce.
 *
 * `usageLimit` sends the failure to credential rotation; `providerRetryable`
 * authorizes the seconds-scale in-provider backoff. The two are mutually
 * exclusive by design and that exclusivity is asserted over the whole table,
 * not per row: an account-level cap does not become available because a
 * provider slept four seconds.
 */
const OBSERVED_FAILURES: { name: string; message: string; usageLimit: boolean; providerRetryable: boolean }[] = [
	{
		name: "anthropic org rate limit",
		message:
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 30,000 input tokens per minute."}}',
		usageLimit: false,
		providerRetryable: true,
	},
	{
		name: "anthropic account rate limit",
		message:
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
		usageLimit: true,
		providerRetryable: false,
	},
	{
		name: "kimi usage limit",
		message:
			'403 {"error":{"type":"permission_error","message":"You\'ve reached your usage limit. Upgrade to increase your limit."}}',
		usageLimit: true,
		providerRetryable: false,
	},
	{
		name: "anthropic overloaded",
		message: "Anthropic stream error (overloaded_error): Overloaded",
		usageLimit: false,
		providerRetryable: true,
	},
	{
		name: "bare rate limit with stated window",
		message: "429 Rate limit exceeded. Please try again later. retry-after 60",
		usageLimit: false,
		providerRetryable: true,
	},
	{
		name: "xai out of credits",
		message: "403 You have run out of credits or need a Grok subscription.",
		usageLimit: true,
		providerRetryable: false,
	},
	{
		name: "devin overall message rate limit",
		message: "Devin stream error permission_denied: Reached overall message rate limit",
		usageLimit: false,
		providerRetryable: true,
	},
	{
		name: "http/2 internal error",
		message: "Stream closed with error code NGHTTP2_INTERNAL_ERROR",
		usageLimit: false,
		providerRetryable: true,
	},
	{
		name: "openai stalled stream",
		message: "OpenAI responses stream stalled while waiting for the next event",
		usageLimit: false,
		providerRetryable: true,
	},
];

describe("AIError.Flag retry decisions", () => {
	it("records a decision for every flag the classifier can set", () => {
		expect(Object.keys(RETRY_DECISION).sort()).toEqual(Object.keys(AIError.Flag).sort());
	});

	it("routes each flag the way its decision says", () => {
		for (const [name, flag] of Object.entries(AIError.Flag)) {
			const expected = RETRY_DECISION[name];
			expect(AIError.retriable(AIError.create(flag))).toBe(expected!);
		}
	});

	it("refuses to replay any flag once a tool call may already have run", () => {
		// The one exception is a call that was never well-formed enough to
		// execute, so there is no side effect to duplicate.
		for (const [name, flag] of Object.entries(AIError.Flag)) {
			expect(AIError.retriable(AIError.create(flag), { replayUnsafe: true })).toBe(name === "MalformedFunctionCall");
		}
	});
});

describe("stated retry window survives into the message the session reads", () => {
	it("covers every exported provider HTTP error class", () => {
		// The session parses a window out of the error TEXT, because that is all
		// that is left by the time it decides how long to wait. A subclass added
		// without a factory here is a subclass nobody checked, so the set is
		// asserted rather than sampled.
		expect(Object.keys(PROVIDER_ERROR_FACTORIES).sort()).toEqual(discoverProviderHttpErrorNames());
	});

	it("folds retry-after into the finalized message for each of them", async () => {
		for (const [name, build] of Object.entries(PROVIDER_ERROR_FACTORIES)) {
			const result = await AIError.finalize(build(), { api: "anthropic-messages", provider: "anthropic" });
			expect(`${name}: ${result.message}`).toContain("retry-after-ms=62000");
		}
	});

	it("folds an Anthropic reset clock in when the provider sent no retry-after", async () => {
		// The largest failure bucket in the corpus. Anthropic omits `retry-after`
		// on a meaningful share of its 429s and still states when the exhausted
		// bucket refills; without that the session has no stated window at all
		// and falls back to a sub-10s backoff against a per-minute limit.
		const resetAt = new Date(Date.now() + 90_000).toISOString();
		const error = new AIError.AnthropicApiError(
			429,
			NEUTRAL_429,
			new Headers({
				"anthropic-ratelimit-input-tokens-reset": resetAt,
				"anthropic-ratelimit-input-tokens-remaining": "0",
			}),
		);
		const result = await AIError.finalize(error, { api: "anthropic-messages", provider: "anthropic" });
		const hint = /retry-after-ms=(\d+)/.exec(result.message);
		expect(hint).not.toBeNull();
		expect(Number(hint![1])).toBeGreaterThan(80_000);
		expect(Number(hint![1])).toBeLessThanOrEqual(90_000);
	});
});

describe("a stack trace is not evidence about the failure", () => {
	it("classifies the same with or without a frame naming any source file in the tree", async () => {
		// Two baselines, because appending a frame can only ADD flags: the fewer
		// a baseline carries, the more sensitive it is to one being smuggled in.
		// A dead OAuth grant is nothing like transient, and calling it transient
		// retries a credential that can never work until the budget runs out.
		// The plain sentence carries no classification at all, so ANY flag a
		// frame introduces shows up against it.
		const baselines = [
			'400 {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}',
			"the model produced no content for this request",
		];
		const paths = await sourceFilePaths();
		expect(paths.length).toBeGreaterThan(0);
		for (const message of baselines) {
			const baseline = AIError.stringify(AIError.classify(new Error(message)));
			expect(AIError.is(AIError.classify(new Error(message)), AIError.Flag.Transient)).toBe(false);
			for (const filePath of paths) {
				const framed = new Error(`${message}\n    at async run (${filePath}:53:16)`);
				expect(`${filePath} => ${AIError.stringify(AIError.classify(framed))}`).toBe(`${filePath} => ${baseline}`);
			}
		}
	});

	it("reads none of the corpus wording back out of a stack frame that quotes it", async () => {
		// Falsification: the tree loop above only proves immunity to filenames
		// that exist today, so leaving one predicate on the raw string stayed
		// green because no source file happens to be named like a usage limit.
		// The frame text here is every observed failure message verbatim, which
		// is exactly what each predicate is built to recognise, so a predicate
		// that still sees the unstripped string cannot hide behind the tree.
		// Paths may contain spaces and punctuation, so this is a frame the
		// runtime could really produce.
		const neutral = "the model produced no content for this request";
		const baseline = AIError.stringify(AIError.classify(new Error(neutral)));
		for (const { name, message } of OBSERVED_FAILURES) {
			const bait = message.replaceAll("\n", " ");
			const framed = new Error(`${neutral}\n    at async run (/repo/src/${bait}.ts:1:1)`);
			expect(`${name} => ${AIError.stringify(AIError.classify(framed))}`).toBe(`${name} => ${baseline}`);
		}
	});

	it("reads none of the classifier's own vocabulary back out of a stack frame", async () => {
		// One bait per flag, because the corpus above only carries the wording
		// the transcripts happened to contain: leaving the content-filter
		// predicate on the raw string survived both loops for that reason. Keys
		// are held equal to the decision table, so a new flag lands here with no
		// bait and turns this red rather than shipping unprobed.
		const baitFlags = Object.keys(FRAME_BAIT_TEXT) as (keyof typeof AIError.Flag)[];
		expect([...baitFlags].sort().join(",")).toBe(Object.keys(RETRY_DECISION).sort().join(","));
		const reachable = baitFlags.filter(flag =>
			AIError.is(AIError.classify(new Error(FRAME_BAIT_TEXT[flag])), AIError.Flag[flag]),
		);
		// Pinning which flags a message's own text can produce is what makes a
		// NEW text predicate go red here: it joins this set and arrives with an
		// unproven bait. A bait that goes stale drops out and is equally red.
		expect(reachable.sort()).toEqual([
			"AuthFailed",
			"ContentBlocked",
			"ContextOverflow",
			"MalformedFunctionCall",
			"ProviderFinishError",
			"Timeout",
			"Transient",
			"UsageLimit",
		]);

		const neutral = "the model produced no content for this request";
		const baseline = AIError.stringify(AIError.classify(new Error(neutral)));
		for (const flag of baitFlags) {
			const text = FRAME_BAIT_TEXT[flag];
			const framed = new Error(`${neutral}\n    at async run (/repo/src/${text}.ts:1:1)`);
			expect(`${flag} => ${AIError.stringify(AIError.classify(framed))}`).toBe(`${flag} => ${baseline}`);
		}
	});
});

describe("observed failure corpus", () => {
	it("routes every observed message to the layer that can act on it", () => {
		for (const observed of OBSERVED_FAILURES) {
			const error = new Error(observed.message);
			expect(`${observed.name}: usageLimit=${AIError.isUsageLimit(error)}`).toBe(
				`${observed.name}: usageLimit=${observed.usageLimit}`,
			);
			expect(`${observed.name}: providerRetryable=${isProviderRetryableError(error, "anthropic")}`).toBe(
				`${observed.name}: providerRetryable=${observed.providerRetryable}`,
			);
		}
	});

	it("never hands an account-level cap to the in-provider backoff", () => {
		// The exclusivity invariant, over the whole corpus rather than one row.
		// A quota wall does not come down because a provider slept four seconds;
		// only a different credential or a real wait clears it.
		for (const observed of OBSERVED_FAILURES) {
			const error = new Error(observed.message);
			if (!AIError.isUsageLimit(error)) continue;
			expect(`${observed.name}: ${isProviderRetryableError(error, "anthropic")}`).toBe(`${observed.name}: false`);
		}
	});

	it("keeps every observed message retriable somewhere, so none is a dead end", () => {
		// Termination in the other direction: an error that no layer will act on
		// ends the session outright, which is the worst outcome in the corpus.
		for (const observed of OBSERVED_FAILURES) {
			const error = new Error(observed.message);
			expect(`${observed.name}: ${AIError.retriable(AIError.classify(error))}`).toBe(`${observed.name}: true`);
		}
	});
});
