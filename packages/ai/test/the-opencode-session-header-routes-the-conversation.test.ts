import { describe, expect, it } from "bun:test";
import {
	conversationIdForOpenCode,
	getOpenCodeHeaders,
	OPENCODE_PROVIDER_IDS,
	openCodeSessionHeaderValue,
} from "@veyyon/ai/utils/opencode-headers";

/**
 * WHY: the OpenCode gateway requires a stable `x-opencode-session` on every
 * request to route a conversation's traffic to one upstream and hit its prompt
 * cache, and flags traffic that omits it as abusive. The header value is
 * hashed rather than sent verbatim, so a regression here either cold-misses
 * the cache (value flips per request) or leaks the local session id to a third
 * party — both invisible without an explicit contract.
 *
 * What this closes: the id a side-channel turn presents (cache key over
 * per-request session id), the digest's stability and shape, and the header's
 * presence rules. What it does not catch: whether the gateway honors the
 * value, which only a live gateway answers.
 */
describe("the opencode session header routes the conversation", () => {
	it("presents the cache key over the per-request session id", () => {
		// A side-channel turn routes under a fresh session id while keeping the
		// conversation's cache key; the header must keep landing on the same
		// upstream conversation.
		expect(conversationIdForOpenCode({ promptCacheKey: "cache-a", sessionId: "ses_b" })).toBe("cache-a");
		expect(conversationIdForOpenCode({ sessionId: "ses_b" })).toBe("ses_b");
		expect(conversationIdForOpenCode(undefined)).toBeUndefined();
	});

	it("digests the session id without ever sending it verbatim", () => {
		const value = openCodeSessionHeaderValue("ses_local_secret");
		expect(value).toMatch(/^ses_[0-9a-f]{32}$/);
		expect(value).not.toContain("ses_local_secret");
		expect(openCodeSessionHeaderValue("ses_local_secret")).toBe(value);
		expect(openCodeSessionHeaderValue("ses_other")).not.toBe(value);
	});

	it("omits the session header when no conversation is known, because a per-request value defeats the affinity", () => {
		const bare = getOpenCodeHeaders();
		expect(Object.keys(bare).sort()).toEqual(["User-Agent"]);
		const named = getOpenCodeHeaders("ses_local_secret");
		expect(named["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{32}$/);
		expect(named["User-Agent"]).toBeTruthy();
	});

	it("recognizes exactly the providers that reach an opencode gateway", () => {
		expect(OPENCODE_PROVIDER_IDS).toEqual(["opencode", "opencode-go", "opencode-zen"]);
	});
});
