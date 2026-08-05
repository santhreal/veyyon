/**
 * A provider response body cannot become an unbounded assistant message.
 *
 * WHY THIS SUITE EXISTS. Every provider that interpolates a non-2xx body into
 * an error had its own answer to "how much of it". Before this: 4096 chars on
 * the OpenAI path, 1000 on Bedrock, 200 on the AWS SSO credential path, and
 * NOTHING at all on Anthropic, Devin, GitLab Duo, Codex and Google. Four
 * numbers and three absences for one question.
 *
 * The absence is the defect. A non-2xx body is not always the provider's error
 * envelope: a corporate proxy, a captive portal or a CDN interstitial answers
 * with an HTML page, and the whole page became `Error.message`, then the
 * assistant turn's `errorMessage`, rendered in the TUI and written to the
 * session file, re-rendered on every later read of that turn.
 *
 * WHAT IS PINNED, and why it is shaped this way. The earlier scale bug in this
 * codebase shipped green because the assertion covered ONE branch. So the
 * ceiling here is asserted over EVERY branch of the helper and then again at
 * the real entry points, with exact byte counts rather than "shorter than the
 * input". A per-field cap that does not compose into a stated total is the
 * thing this guards.
 */
import { describe, expect, it } from "bun:test";
import { AnthropicApiError } from "@veyyon/ai/error";
import { boundProviderErrorDetail, MAX_PROVIDER_ERROR_DETAIL_CHARS } from "@veyyon/ai/error/detail-bounds";
import { parseCodexError } from "@veyyon/ai/providers/openai-codex/response-handler";

/** A gateway HTML page, far past anything a real provider envelope carries. */
const HOSTILE_PAGE = `<!doctype html><html><body>${"A".repeat(200_000)}</body></html>`;
const HOSTILE_LENGTH = 200_041;

describe("boundProviderErrorDetail", () => {
	it("is 4096, the value the busiest path already used", () => {
		expect(MAX_PROVIDER_ERROR_DETAIL_CHARS).toBe(4096);
	});

	it("caps and states the real size", () => {
		expect(HOSTILE_PAGE.length).toBe(HOSTILE_LENGTH);

		const bounded = boundProviderErrorDetail(HOSTILE_PAGE);

		expect(bounded).toBe(`${HOSTILE_PAGE.slice(0, 4096)} [truncated, ${HOSTILE_LENGTH} chars total]`);
		expect(bounded.length).toBe(4128);
	});

	/**
	 * The boundary in both directions. Off by one here means either a silently
	 * truncated 4096-char body or an uncapped 4097-char one.
	 */
	it.each([
		["one under the ceiling", 4095, 4095],
		["exactly on the ceiling", 4096, 4096],
		["one over the ceiling", 4097, 4096 + " [truncated, 4097 chars total]".length],
	])("handles a body %s", (_label, inputLength, expectedLength) => {
		const bounded = boundProviderErrorDetail("x".repeat(inputLength));

		expect(bounded.length).toBe(expectedLength);
		expect(bounded.startsWith("x".repeat(Math.min(inputLength, 4096)))).toBe(true);
	});

	it("leaves an ordinary provider message byte-identical", () => {
		const detail = "invalid_api_key: Incorrect API key provided.";

		expect(boundProviderErrorDetail(detail)).toBe(detail);
	});

	it("passes an empty body straight through so callers can still detect it", () => {
		// `AnthropicApiError.fromResponse` relies on the empty string staying
		// falsy to substitute "status code (no body)".
		expect(boundProviderErrorDetail("")).toBe("");
	});
});

describe("provider entry points inherit the ceiling", () => {
	it("bounds an Anthropic non-2xx body", async () => {
		const response = new Response(HOSTILE_PAGE, { status: 429, headers: { "request-id": "req-1" } });

		const error = await AnthropicApiError.fromResponse(response);

		expect(error.status).toBe(429);
		expect(error.requestId).toBe("req-1");
		expect(error.message).toBe(`429 ${HOSTILE_PAGE.slice(0, 4096)} [truncated, ${HOSTILE_LENGTH} chars total]`);
		// "429 " plus the bounded detail: the whole message, not just the field.
		expect(error.message.length).toBe(4132);
	});

	it("still says 'no body' for an empty Anthropic response", async () => {
		const error = await AnthropicApiError.fromResponse(new Response("   ", { status: 500 }));

		expect(error.message).toBe("500 status code (no body)");
	});

	/**
	 * The Codex path is the one where the raw body survives furthest: `message`
	 * is seeded from the raw text and only replaced when the body parses as a
	 * Codex envelope, so a proxy page skips every later assignment.
	 */
	it("bounds a Codex non-JSON body while keeping the raw text for classification", async () => {
		const info = await parseCodexError(new Response(HOSTILE_PAGE, { status: 502 }));

		expect(info.message).toBe(`${HOSTILE_PAGE.slice(0, 4096)} [truncated, ${HOSTILE_LENGTH} chars total]`);
		expect(info.message.length).toBe(4128);
		expect(info.status).toBe(502);
		// Unbounded on purpose: `raw` feeds classification, never a rendered message.
		expect(info.raw).toHaveLength(HOSTILE_LENGTH);
	});

	it("bounds an oversized Codex envelope message", async () => {
		const body = JSON.stringify({ error: { code: "server_error", message: "B".repeat(9000) } });

		const info = await parseCodexError(new Response(body, { status: 500 }));

		expect(info.message).toBe(`${"B".repeat(4096)} [truncated, 9000 chars total]`);
		expect(info.code).toBe("server_error");
	});

	it("leaves an ordinary Codex envelope message intact", async () => {
		const body = JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Slow down." } });

		const info = await parseCodexError(new Response(body, { status: 429 }));

		expect(info.message).toBe("Slow down.");
		expect(info.friendlyMessage).toBe("ChatGPT rate limit exceeded.");
	});
});
