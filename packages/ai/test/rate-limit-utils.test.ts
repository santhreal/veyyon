import { describe, expect, it } from "bun:test";
import { ProviderHttpError } from "@veyyon/ai/error";
import { isUsageLimit } from "@veyyon/ai/error/flags";
import { calculateRateLimitBackoffMs, parseRateLimitReason } from "@veyyon/ai/error/rate-limit";

describe("parseRateLimitReason", () => {
	/**
	 * A status code was matched as a bare substring, so any longer number
	 * containing 503, 529 or 500 was read as that status. The consequence is not
	 * a wrong label: MODEL_CAPACITY_EXHAUSTED backs off for 45 seconds and
	 * retries the same credential, where QUOTA_EXHAUSTED rotates, so a balance
	 * that had actually run out retried against the account that could not serve
	 * it. These pin the digit boundary; the prose branches above and below the
	 * status checks are unchanged and still win where they match first.
	 */
	it("reads a status code named in prose, not one buried in a longer number", () => {
		expect(parseRateLimitReason("insufficient balance: 5030 credits remaining")).toBe("QUOTA_EXHAUSTED");
		expect(parseRateLimitReason("quota exhausted after 1500 requests")).toBe("QUOTA_EXHAUSTED");

		// One case per boundary, each on a message no other branch claims, so the
		// classification observes that guard alone. A digit before the run
		// (`4503`, `2500`) and a digit after it (`5291`, `15000`) are both
		// "somebody else's number" and neither is a status.
		expect(parseRateLimitReason("request 5291 failed")).toBe("UNKNOWN");
		expect(parseRateLimitReason("request id 4503 failed")).toBe("UNKNOWN");
		expect(parseRateLimitReason("request id 2500 failed")).toBe("UNKNOWN");
		expect(parseRateLimitReason("request 15000 failed")).toBe("UNKNOWN");
		expect(parseRateLimitReason("request id 5001 failed")).toBe("UNKNOWN");

		expect(parseRateLimitReason("HTTP 503 upstream unavailable")).toBe("MODEL_CAPACITY_EXHAUSTED");
		expect(parseRateLimitReason("Anthropic returned 529")).toBe("MODEL_CAPACITY_EXHAUSTED");
		expect(parseRateLimitReason("500 upstream failure")).toBe("SERVER_ERROR");
	});

	it("classifies Google Quota exceeded as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Cloud Code Assist API error (429): Quota exceeded for aiplatform.googleapis.com"),
		).toBe("QUOTA_EXHAUSTED");
	});

	// "Resource has been exhausted (e.g. check quota)" is a quota/daily-limit error — long wait.
	// Only the literal phrase "resource exhausted" (gRPC status name) is MODEL_CAPACITY.
	it("classifies 'Resource has been exhausted (e.g. check quota)' as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Cloud Code Assist API error (429): Resource has been exhausted (e.g. check quota)."),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies 'resource exhausted' (exact gRPC phrase) as MODEL_CAPACITY_EXHAUSTED", () => {
		expect(parseRateLimitReason("resource exhausted")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});

	it("classifies Too many requests as RATE_LIMIT_EXCEEDED", () => {
		expect(parseRateLimitReason("Cloud Code Assist API error (429): Too many requests")).toBe("RATE_LIMIT_EXCEEDED");
	});

	it("classifies per minute errors as RATE_LIMIT_EXCEEDED", () => {
		expect(parseRateLimitReason("Requests per minute limit reached")).toBe("RATE_LIMIT_EXCEEDED");
	});

	it("classifies overloaded 529 as MODEL_CAPACITY_EXHAUSTED", () => {
		expect(parseRateLimitReason("Service overloaded 529")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});

	it("classifies internal server error as SERVER_ERROR", () => {
		expect(parseRateLimitReason("Internal Server Error (500)")).toBe("SERVER_ERROR");
	});

	it("returns UNKNOWN for unrecognised messages", () => {
		expect(parseRateLimitReason("Something completely unexpected happened")).toBe("UNKNOWN");
	});

	it("classifies Codex usage limit error as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Codex error event: The usage limit has been reached (code=usage_limit_reached)"),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies account rate limits as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
			),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies OpenCode Go insufficient balance as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("401 Insufficient balance. Manage your billing here: https://opencode.ai/workspace/demo"),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies Antigravity capacity-exhausted as QUOTA_EXHAUSTED, not transient MODEL_CAPACITY", () => {
		// Antigravity returns "You have exhausted your capacity on this model. Your
		// quota will reset after 3h6m38s." The literal "capacity" used to win the
		// classifier race and land in MODEL_CAPACITY_EXHAUSTED (45-75s backoff),
		// blocking the agent from rotating to another OAuth account even though the
		// "quota will reset" suffix is the long-wait, switch-account signal.
		expect(
			parseRateLimitReason(
				"Cloud Code Assist API error (429): You have exhausted your capacity on this model. Your quota will reset after 3h6m38s.",
			),
		).toBe("QUOTA_EXHAUSTED");
	});
});

describe("isUsageLimit", () => {
	it("detects account rate limits as credential-rotatable usage limits", () => {
		expect(
			isUsageLimit(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
			),
		).toBe(true);
	});

	it("detects OpenCode Go insufficient balance as a credential-rotatable usage limit", () => {
		expect(
			isUsageLimit("401 Insufficient balance. Manage your billing here: https://opencode.ai/workspace/demo"),
		).toBe(true);
	});

	it("detects Antigravity capacity-exhausted message as a usage-limit error", () => {
		// Without this branch `markUsageLimitReached` is never invoked, so the
		// session sticks to the exhausted OAuth account instead of rotating —
		// see `agent-session.ts` line 8314 and `auth-storage.ts` line 3457.
		expect(
			isUsageLimit(
				"Cloud Code Assist API error (429): You have exhausted your capacity on this model. Your quota will reset after 3h6m38s.",
			),
		).toBe(true);
	});

	// Antigravity / Cloud Code Assist returns this phrasing for an exhausted
	// project quota; `parseRateLimitReason` already maps it to QUOTA_EXHAUSTED
	// via the generic `quota` substring, but `isUsageLimitError` decides
	// whether the auth layer rotates to a sibling OAuth credential, so it
	// must match too — otherwise the session stays pinned to the exhausted
	// account (see issue #2198).
	it("detects Antigravity 'Individual quota reached' as a credential-rotatable usage limit", () => {
		expect(
			isUsageLimit(
				"Cloud Code Assist API error (429): Individual quota reached. Contact your administrator to enable overages.",
			),
		).toBe(true);
	});

	it("detects bare 'quota reached' phrasing", () => {
		expect(isUsageLimit("quota reached")).toBe(true);
		expect(isUsageLimit("quota_reached")).toBe(true);
	});

	it("detects subscription quota insufficient phrasing as usage limit", () => {
		expect(isUsageLimit("403 订阅额度不足或未配置订阅: subscription quota insufficient, need=14447")).toBe(true);
		expect(isUsageLimit("quota insufficient")).toBe(true);
		expect(isUsageLimit("额度耗尽")).toBe(true);
	});

	it("detects xAI Grok SuperGrok credit exhaustion as a credential-rotatable usage limit", () => {
		// xAI returns HTTP 403 with (type=personal-team-blocked:spending-limit), not a
		// 429 usage_limit_reached. Without this match, multi-account xai-oauth pools
		// stick to the exhausted credential instead of rotating siblings.
		const message =
			"403 You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok.\nYou have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok. (type=personal-team-blocked:spending-limit)";
		expect(isUsageLimit(message)).toBe(true);
		expect(isUsageLimit(Object.assign(new Error(message), { status: 403 }))).toBe(true);
		expect(parseRateLimitReason(message)).toBe("QUOTA_EXHAUSTED");
	});

	it("detects OpenAI quota payload codes as credential-rotatable usage limits", () => {
		for (const message of ["insufficient_quota", "usage_limit_exceeded", "usage_limit_reached"]) {
			expect(isUsageLimit(message)).toBe(true);
		}
	});

	it("detects structured provider usage codes without quota wording", () => {
		expect(isUsageLimit(new ProviderHttpError("Generic provider failure", 429, { code: "insufficient_quota" }))).toBe(
			true,
		);
		expect(isUsageLimit(new ProviderHttpError("Generic provider failure", 429, { code: "rate_limit_error" }))).toBe(
			false,
		);
	});
});

// WHY: `isUsageLimit` is the only accessor for the quota question, and these cases are the ones six
// call sites used to answer with a second predicate over `(status, message)`. The pair that matters
// is the last two blocks: a 429 with NO body is a wall, and a 429 whose body says "too many
// requests" is a throttle. A rule that reads the status without checking for a body first collapses
// them, which is how every throttle would start burning sibling credentials.
describe("isUsageLimit, over a status and a body", () => {
	it("reads a bare or opaque 429 as a wall", () => {
		expect(isUsageLimit({ status: 429 })).toBe(true);
		expect(isUsageLimit({ status: 429, message: "" })).toBe(true);
		expect(isUsageLimit({ status: 429, message: "429" })).toBe(true);
		expect(isUsageLimit({ status: 429, message: "HTTP 429" })).toBe(true);
		expect(isUsageLimit({ status: 429, message: "Error 429" })).toBe(true);
		expect(isUsageLimit({ status: 429, message: "{}" })).toBe(true);
	});

	it("reads a status other than 429 as no wall of its own", () => {
		expect(isUsageLimit({ status: 400 })).toBe(false);
		expect(isUsageLimit({ status: 401 })).toBe(false);
		expect(isUsageLimit({ status: 500 })).toBe(false);
		expect(isUsageLimit({ status: 503 })).toBe(false);
	});

	it("keeps an informative transient 429 in the upstream-backoff lane", () => {
		// RATE_LIMIT_EXCEEDED — generic throttling.
		expect(isUsageLimit({ status: 429, message: "Cloud Code Assist API error (429): Too many requests" })).toBe(
			false,
		);
		expect(isUsageLimit({ status: 429, message: "Requests per minute limit reached" })).toBe(false);
		// MODEL_CAPACITY_EXHAUSTED — provider overload, not account quota.
		expect(isUsageLimit({ status: 429, message: "Service overloaded 529" })).toBe(false);
		// UNKNOWN but carries a transient retry hint — the body is informative, so the reason decides.
		expect(isUsageLimit({ status: 429, message: "Please retry in 5s" })).toBe(false);
	});

	it("reads explicit account rate-limit framing on a 429 as a wall", () => {
		expect(
			isUsageLimit({
				status: 429,
				message:
					'{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
			}),
		).toBe(true);
	});

	it("reads quota wording as a wall whatever the status says", () => {
		expect(isUsageLimit({ message: "usage_limit_reached" })).toBe(true);
		expect(isUsageLimit({ status: 500, message: "insufficient_quota" })).toBe(true);
		expect(
			isUsageLimit({
				status: 403,
				message: "403 订阅额度不足或未配置订阅: subscription quota insufficient, need=14447",
			}),
		).toBe(true);
	});

	it("reads an xAI Grok credit exhaustion as a wall on 403, 429 and no status", () => {
		const message =
			"403 You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok. (type=personal-team-blocked:spending-limit)";
		expect(isUsageLimit({ status: 403, message })).toBe(true);
		expect(isUsageLimit({ message })).toBe(true);
		expect(isUsageLimit({ status: 429, message })).toBe(true);
	});

	it("reads an auth or invalid-request body as no wall", () => {
		expect(isUsageLimit({ status: 401, message: "Invalid API key" })).toBe(false);
		expect(isUsageLimit({ status: 400, message: "invalid_request_error: model unsupported" })).toBe(false);
	});
});

describe("calculateRateLimitBackoffMs", () => {
	it("returns 45–75s range for MODEL_CAPACITY_EXHAUSTED (jitter)", () => {
		for (let i = 0; i < 20; i++) {
			const ms = calculateRateLimitBackoffMs("MODEL_CAPACITY_EXHAUSTED");
			expect(ms).toBeGreaterThanOrEqual(45_000);
			expect(ms).toBeLessThanOrEqual(75_000);
		}
	});
});
