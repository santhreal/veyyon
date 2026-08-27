/**
 * WHY: the classifier and the message disagreed about who serves llama.cpp.
 *
 * `LLAMA_CPP_TOOL_CALL_PARSE_PATTERN` names a deterministic failure: llama.cpp
 * answers HTTP 500 when the model emits tool-call arguments it cannot parse, and
 * the same prompt reproduces it every time, so an agent-level retry burns the
 * budget and lands back on the same 500. `error/flags.ts` reads that pattern for
 * every provider and strips the Transient flag, which is what stops the retry.
 * `error/format.ts` attached the explanation only when the provider id was
 * literally `ollama`.
 *
 * llama.cpp is reached by more than one route — the `llama-cpp` provider,
 * LM Studio, and any OpenAI-compatible local endpoint in front of it — so on
 * every route but one the retry was suppressed and the user was shown a bare
 * HTTP 500, with nothing naming the fix. The explanation is the only place
 * "reload the model or reduce context" appears.
 *
 * THE CLASS. One fact — "this text is llama.cpp's deterministic parse error" —
 * with two readers that gated it differently. It closes by both reading the
 * pattern and nothing else. The sweep runs the production `finalize` path over
 * every route that can front a local server plus the no-provider case, and
 * asserts the classification and the message together, so a future gate added
 * to one half turns this red rather than splitting them again.
 *
 * WHAT THIS DOES NOT CATCH. The route list is the set of provider ids a local
 * server is reached by today; a new id is not discoverable from a registry,
 * because any OpenAI-compatible id can front llama.cpp, which is the whole
 * reason the id is the wrong gate. The negative control below is what defends
 * against the opposite error of explaining every 500.
 */
import { describe, expect, it } from "bun:test";
import { finalize } from "@veyyon/ai/error/finalize";
import { Flag, LLAMA_CPP_TOOL_CALL_PARSE_PATTERN } from "@veyyon/ai/error/flags";

/** llama.cpp's own wording for the failure, as it reaches the client. */
const LLAMA_CPP_500 = "HTTP 500: Failed to parse tool call arguments as JSON: [json.exception.parse_error.101]";

/** Every provider id observed fronting a local llama.cpp server, plus none at all. */
const LOCAL_ROUTES = ["ollama", "llama-cpp", "lmstudio", "openai-compatible", undefined];

function localServerError(): Error {
	const error = new Error(LLAMA_CPP_500);
	Object.assign(error, { status: 500 });
	return error;
}

describe("a deterministic local parse failure is explained on every route", () => {
	it("matches llama.cpp's wording, which is what both readers key on", () => {
		expect(LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(LLAMA_CPP_500)).toBe(true);
	});

	for (const provider of LOCAL_ROUTES) {
		it(`explains the failure and suppresses the retry for ${provider ?? "no provider id"}`, async () => {
			const result = await finalize(localServerError(), { provider });

			expect(result.message).toContain("reload the model or reduce context");
			expect(result.message).toContain(LLAMA_CPP_500);
			// The other half of the same fact: a deterministic failure is not
			// transient, so the agent must not retry it.
			expect(result.id & Flag.Transient).toBe(0);
		});
	}

	/**
	 * The opposite error. A 500 that is not llama.cpp's parse failure keeps the
	 * server's own words and stays retryable, so ungating the rewrite cannot turn
	 * into explaining every local outage as a model-output problem.
	 */
	it("leaves an ordinary local 500 alone", async () => {
		const error = new Error("HTTP 500: internal server error");
		Object.assign(error, { status: 500 });

		const result = await finalize(error, { provider: "ollama" });

		expect(result.message).not.toContain("reload the model");
		expect(result.message).toContain("internal server error");
	});
});
