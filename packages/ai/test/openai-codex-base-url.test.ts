/**
 * Branch coverage for normalizeCodexBaseUrl (issue #3679).
 *
 * The ChatGPT account endpoints (`wham/usage`, `wham/rate-limit-reset-credits`)
 * live on the canonical ChatGPT origin, NOT on the `/responses` surface that
 * streaming proxies forward. So a `providers.openai-codex.baseUrl` pointed at a
 * proxy must be ignored for these routes, or `/usage show` 404s silently. These
 * pin every branch of the resolver so that guard can't regress.
 */
import { describe, expect, it } from "bun:test";
import { normalizeCodexBaseUrl } from "@veyyon/ai/usage/openai-codex-base-url";
import { CODEX_BASE_URL } from "@veyyon/catalog/wire/codex";

describe("normalizeCodexBaseUrl", () => {
	it("falls back to the canonical Codex base URL when no override is given", () => {
		expect(normalizeCodexBaseUrl(undefined)).toBe(CODEX_BASE_URL);
		expect(normalizeCodexBaseUrl("")).toBe(CODEX_BASE_URL);
		// Whitespace-only trims to empty, so it is treated as "no override".
		expect(normalizeCodexBaseUrl("   ")).toBe(CODEX_BASE_URL);
	});

	it("falls back when the override is not a parseable URL", () => {
		expect(normalizeCodexBaseUrl("not a url")).toBe(CODEX_BASE_URL);
		expect(normalizeCodexBaseUrl("chatgpt.com/backend-api")).toBe(CODEX_BASE_URL);
	});

	it("ignores a streaming-proxy override and uses the canonical origin (issue #3679)", () => {
		// The exact failure: a baseUrl aimed at a forwarding proxy must NOT be used
		// for account endpoints, or `/usage show` builds a 404 URL.
		expect(normalizeCodexBaseUrl("https://9router.example.com/backend-api/codex/responses")).toBe(CODEX_BASE_URL);
		expect(normalizeCodexBaseUrl("https://headroom.internal:8443/v1")).toBe(CODEX_BASE_URL);
	});

	it("accepts the canonical ChatGPT origins and strips any extra path to /backend-api", () => {
		// chatgpt.com resolves to the same value as the default, but via the
		// accepted-host branch: the extra `/codex/responses` path is dropped so the
		// account routes land directly under /backend-api, not nested under it.
		expect(normalizeCodexBaseUrl("https://chatgpt.com")).toBe("https://chatgpt.com/backend-api");
		expect(normalizeCodexBaseUrl("https://chatgpt.com/backend-api/codex/responses")).toBe(
			"https://chatgpt.com/backend-api",
		);
		// chat.openai.com is a distinct accepted origin, proving the branch keeps
		// the override's origin rather than always returning the default constant.
		expect(normalizeCodexBaseUrl("https://chat.openai.com/backend-api")).toBe("https://chat.openai.com/backend-api");
	});

	it("matches the accepted host case-insensitively and tolerates trailing slashes", () => {
		expect(normalizeCodexBaseUrl("https://ChatGPT.com/x")).toBe("https://chatgpt.com/backend-api");
		expect(normalizeCodexBaseUrl("https://chatgpt.com/backend-api/codex/responses///")).toBe(
			"https://chatgpt.com/backend-api",
		);
	});
});
