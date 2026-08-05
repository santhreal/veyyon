/**
 * A Google error body is bounded before it becomes an assistant message.
 *
 * WHY THIS SUITE EXISTS. `extractGoogleErrorMessage` returned the response body
 * verbatim whenever it was not a Google error envelope, and returned
 * `error.message` verbatim whenever it was. Neither had a ceiling. A non-2xx
 * body is not always an envelope: a corporate proxy, a captive portal, or a CDN
 * interstitial in front of `generativelanguage.googleapis.com` answers with an
 * HTML page, and the whole page became `Error.message`. From there it became
 * the assistant turn's `errorMessage` through `createProviderErrorMessage`,
 * which is rendered in the TUI and written to the session file, so a single
 * blocked request replayed a megabyte on every later read of that turn.
 *
 * The sibling paths were already capped: 4096 chars on the OpenAI path
 * (`MAX_DETAIL_CHARS` in `utils/openai-http.ts`) and 1000 on Bedrock
 * (`amazon-bedrock.ts`). This one was the outlier.
 *
 * Exact lengths are asserted, not "is shorter than the input". A per-field cap
 * that does not compose into a stated total is the defect this guards.
 */
import { describe, expect, it } from "bun:test";
import { streamGoogle } from "@veyyon/ai/providers/google";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

/** Mirrors `MAX_GOOGLE_ERROR_DETAIL_CHARS` in `providers/google-shared.ts`. */
const DETAIL_CAP = 4096;
const PREFIX = "Google API error (400): ";

const model: Model<"google-generative-ai"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

async function errorMessageFor(body: string): Promise<string> {
	const fetchMock: FetchImpl = async () =>
		new Response(body, { status: 400, headers: { "content-type": "text/html" } });
	const stream = streamGoogle(model, context, { apiKey: "k", fetch: fetchMock });
	const result = await stream.result();
	expect(result.stopReason).toBe("error");
	return result.errorMessage ?? "";
}

describe("Google error bodies are bounded before they reach a message", () => {
	it("caps a hostile non-JSON body at the detail ceiling and states the real size", async () => {
		// A gateway HTML page, well past anything a real Google envelope carries.
		const page = `<!doctype html><html><body>${"A".repeat(200_000)}</body></html>`;
		expect(page.length).toBe(200_041);

		const message = await errorMessageFor(page);
		const suffix = " [truncated, 200041 chars total]";

		expect(message).toBe(`${PREFIX}${page.slice(0, DETAIL_CAP)}${suffix}`);
		// The whole message, not just the detail field: the ceiling has to compose.
		expect(message.length).toBe(PREFIX.length + DETAIL_CAP + suffix.length);
		expect(message.length).toBe(4152);
	});

	it("caps an oversized envelope message the same way", async () => {
		// Google 400s echo request content, so the envelope path needs the cap too.
		const detail = "B".repeat(9000);
		const body = JSON.stringify({ error: { code: 400, message: detail, status: "INVALID_ARGUMENT" } });

		const message = await errorMessageFor(body);

		expect(message).toBe(`${PREFIX}${"B".repeat(DETAIL_CAP)} [truncated, 9000 chars total]`);
		expect(message.length).toBe(4150);
	});

	it("leaves an ordinary envelope message byte-identical", async () => {
		const detail = "API key not valid. Please pass a valid API key.";
		const body = JSON.stringify({ error: { code: 400, message: detail, status: "INVALID_ARGUMENT" } });

		expect(await errorMessageFor(body)).toBe(`${PREFIX}${detail}`);
	});

	it("leaves a body sitting exactly on the ceiling untouched", async () => {
		const detail = "C".repeat(DETAIL_CAP);
		const body = JSON.stringify({ error: { code: 400, message: detail } });

		const message = await errorMessageFor(body);

		expect(message).toBe(`${PREFIX}${detail}`);
		expect(message.length).toBe(PREFIX.length + DETAIL_CAP);
	});
});
