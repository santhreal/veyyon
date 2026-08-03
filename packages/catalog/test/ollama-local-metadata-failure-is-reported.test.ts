import { describe, expect, test, vi } from "bun:test";
import type { DiscoveryFailure } from "@veyyon/catalog/discovery/failure";
import { ollamaModelManagerOptions } from "@veyyon/catalog/provider-models/openai-compat";
import type { FetchImpl } from "@veyyon/catalog/types";

/**
 * Local Ollama discovery lists models through `/v1/models`, which reports its failures, and then
 * OVERWRITES each model's context window from `/api/show`, which reported none.
 *
 * That overwrite is unconditional, so a `/api/show` that fails does not leave the bundled context window
 * in place: it replaces it with a hardcoded 128k. A user running a 32k model then gets prompts packed to
 * 128k, and Ollama drops the front of the context to make them fit, so the agent loses its system prompt
 * and the start of the conversation and simply behaves as though it forgot. There is no error anywhere in
 * that sequence, which is why the reason has to come out of discovery.
 *
 * The `/api/tags` native fallback is the same story one level up: it answered a refused connection and a
 * 404 with the same bare `null`.
 */

const MODELS = "http://127.0.0.1:11434/v1/models";
const SHOW = "http://127.0.0.1:11434/api/show";
const TAGS = "http://127.0.0.1:11434/api/tags";

function collect(): { failures: DiscoveryFailure[]; onFailure: (failure: DiscoveryFailure) => void } {
	const failures: DiscoveryFailure[] = [];
	return { failures, onFailure: failure => failures.push(failure) };
}

/** `/v1/models` lists one model with a real 32k window; `/api/show` behaviour is the caller's. */
function localFetch(onShow: () => Response | never): FetchImpl {
	return vi.fn(async input => {
		const url = String(input);
		if (url === MODELS) {
			return new Response(JSON.stringify({ data: [{ id: "qwen3:30b" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url === SHOW) return onShow();
		throw new Error(`Unexpected URL: ${url}`);
	});
}

describe("local Ollama /api/show failures", () => {
	test("reports a non-ok /api/show instead of silently inventing a 128k window", async () => {
		const { failures, onFailure } = collect();
		const options = ollamaModelManagerOptions({
			fetch: localFetch(() => new Response("no such model", { status: 404, statusText: "Not Found" })),
		});

		const models = await options.fetchDynamicModels?.({ onFailure });

		// The invented window is still what the caller gets: this test is about the silence, and changing
		// the fallback value would be a separate decision.
		expect(models?.[0]?.contextWindow).toBe(128_000);

		const show = failures.filter(failure => failure.url === SHOW);
		expect(show).toHaveLength(1);
		expect(show[0]?.stage).toBe("status");
		expect(show[0]?.detail).toContain("qwen3:30b");
		expect(show[0]?.detail).toContain("404");
	});

	test("reports an unreachable /api/show as a request failure", async () => {
		const { failures, onFailure } = collect();
		const options = ollamaModelManagerOptions({
			fetch: localFetch(() => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
			}),
		});

		await options.fetchDynamicModels?.({ onFailure });

		const show = failures.filter(failure => failure.url === SHOW);
		expect(show).toHaveLength(1);
		expect(show[0]?.stage).toBe("request");
		expect(show[0]?.detail).toContain("qwen3:30b");
		expect(show[0]?.detail).toContain("ECONNREFUSED");
	});

	test("reports a /api/show body that is not JSON", async () => {
		const { failures, onFailure } = collect();
		const options = ollamaModelManagerOptions({
			fetch: localFetch(
				() => new Response("<html>proxy</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
			),
		});

		await options.fetchDynamicModels?.({ onFailure });

		const show = failures.filter(failure => failure.url === SHOW);
		expect(show).toHaveLength(1);
		expect(show[0]?.stage).toBe("body");
		expect(show[0]?.detail).toContain("qwen3:30b");
	});

	test("reports the native /api/tags fallback when it cannot be reached", async () => {
		const { failures, onFailure } = collect();
		// `/v1/models` answers honestly with an empty list, so it reports nothing and discovery falls through
		// to the native endpoint. That endpoint refusing the connection was the whole reason for an empty
		// picker, and it was the one step that said nothing.
		const fetchImpl: FetchImpl = vi.fn(async input => {
			const url = String(input);
			if (url === MODELS) {
				return new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
		});
		const options = ollamaModelManagerOptions({ fetch: fetchImpl });

		await options.fetchDynamicModels?.({ onFailure });

		const tags = failures.filter(failure => failure.url === TAGS);
		expect(tags).toHaveLength(1);
		expect(tags[0]?.stage).toBe("request");
		expect(tags[0]?.detail).toContain("ECONNREFUSED");
	});

	test("reports a non-ok native /api/tags fallback", async () => {
		const { failures, onFailure } = collect();
		const fetchImpl: FetchImpl = vi.fn(async input => {
			const url = String(input);
			if (url === MODELS) {
				return new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("forbidden", { status: 403, statusText: "Forbidden" });
		});
		const options = ollamaModelManagerOptions({ fetch: fetchImpl });

		await options.fetchDynamicModels?.({ onFailure });

		const tags = failures.filter(failure => failure.url === TAGS);
		expect(tags).toHaveLength(1);
		expect(tags[0]?.stage).toBe("status");
		expect(tags[0]?.detail).toContain("403");
	});

	/** A channel that fires when nothing is wrong is worse than no channel. */
	test("stays quiet when /api/show answers", async () => {
		const { failures, onFailure } = collect();
		const options = ollamaModelManagerOptions({
			fetch: localFetch(
				() =>
					new Response(
						JSON.stringify({
							capabilities: ["completion", "thinking"],
							model_info: { "qwen3.context_length": 32768 },
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		});

		const models = await options.fetchDynamicModels?.({ onFailure });

		expect(failures).toEqual([]);
		expect(models?.[0]?.contextWindow).toBe(32768);
		expect(models?.[0]?.reasoning).toBe(true);
	});
});
