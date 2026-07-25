/**
 * The prefix Devin's API expects on a session token.
 *
 * WHY THIS SUITE EXISTS. Two packages send that header: the discovery call in `@veyyon/catalog`
 * that lists Devin's models, and the provider in `@veyyon/ai` that makes the requests. Each had
 * its own copy of the prefix string AND of the normalization, so one format had four statements
 * across two packages. If the two ever disagreed, discovery would authenticate while the
 * requests that follow would not, or the reverse: the model list would load and every completion
 * would 401, which reads like a broken account rather than a mismatched header.
 *
 * A user pastes the token either way, with the prefix or without it, so the value is normalized
 * rather than demanded, and that tolerance is the behaviour asserted here.
 */

import { describe, expect, it } from "bun:test";
import { DEVIN_SESSION_TOKEN_PREFIX, normalizeDevinSessionToken } from "../src/discovery/devin";

describe("normalizing a pasted token", () => {
	/** The exact prefix, as literal bytes: it is a wire value, not a label. */
	it("is `devin-session-token$`", () => {
		expect(DEVIN_SESSION_TOKEN_PREFIX).toBe("devin-session-token$");
	});

	it("adds the prefix to a bare token", () => {
		expect(normalizeDevinSessionToken("abc123")).toBe("devin-session-token$abc123");
	});

	/** Someone who pasted the full value must not end up with the prefix twice. */
	it("leaves a token that already carries the prefix alone", () => {
		expect(normalizeDevinSessionToken("devin-session-token$abc123")).toBe("devin-session-token$abc123");
	});

	it("is idempotent, so normalizing twice changes nothing", () => {
		const once = normalizeDevinSessionToken("abc123");

		expect(normalizeDevinSessionToken(once)).toBe(once);
	});

	/**
	 * No credential means no header, and an empty string says that without the caller having to
	 * check: a prefix with nothing after it would be sent as a token and rejected as one.
	 */
	it("answers an empty string when there is no token", () => {
		expect(normalizeDevinSessionToken(undefined)).toBe("");
		expect(normalizeDevinSessionToken("")).toBe("");
	});
});

describe("the two packages that send it", () => {
	/** The lock: `@veyyon/ai` imports this rather than spelling the prefix again. */
	it("share one owner, and the provider defines neither the prefix nor the normalizer", async () => {
		const provider = await Bun.file(new URL("../../ai/src/providers/devin.ts", import.meta.url)).text();

		expect(provider).not.toContain('const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$"');
		expect(provider).not.toContain("function normalizeDevinSessionToken(");
		expect(provider).toContain("normalizeDevinSessionToken");
	});
});
