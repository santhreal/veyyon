import { describe, expect, test, vi } from "bun:test";
import type { DiscoveryFailure } from "@veyyon/catalog/discovery/failure";
import { ollamaCloudModelManagerOptions } from "@veyyon/catalog/provider-models/ollama";
import type { FetchImpl, ModelSpec } from "@veyyon/catalog/types";

/**
 * Ollama Cloud discovery makes TWO calls per refresh: `/api/tags` for the list, then one `/api/show` per
 * model for the part that decides what the model can do. Only the first had a failure channel. A
 * `/api/show` that 429s or never connects left the model in the picker with `thinking` gone, `image`
 * input gone and a 128k context window invented in its place, and reported nothing: `fetchDynamicModels`
 * did not even accept the `hooks` argument every other reader in this package takes.
 *
 * That is worse than a model that disappears. A model that vanishes sends the user to look at their
 * credentials; a model that is quietly stripped of thinking looks like veyyon does not support thinking
 * on it, and the ONLY difference from the healthy case is metadata nobody can see.
 *
 * These tests drive the reader with a live `/api/tags` and a broken `/api/show`, which is the real shape
 * of the failure: rate limiting is per-request, and `/api/show` is called once per model with no retry
 * while `/api/tags` gets three.
 */

const TAGS = "https://ollama.com/api/tags";
const SHOW = "https://ollama.com/api/show";

/** A `/api/tags` that lists one model, plus a caller-supplied `/api/show` behaviour. */
function cloudFetch(onShow: (model: string) => Response): FetchImpl {
	return vi.fn(async (input, init) => {
		const url = String(input);
		if (url === TAGS) {
			return new Response(JSON.stringify({ models: [{ model: "qwen3-coder:480b", name: "Qwen3 Coder" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url === SHOW) {
			const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
			return onShow(body.model ?? "");
		}
		throw new Error(`Unexpected URL: ${url}`);
	});
}

async function discover(fetchImpl: FetchImpl): Promise<{
	failures: DiscoveryFailure[];
	models: readonly ModelSpec<"ollama-chat">[];
}> {
	const failures: DiscoveryFailure[] = [];
	const options = ollamaCloudModelManagerOptions({ apiKey: "cloud-test-key", fetch: fetchImpl });
	const models = await options.fetchDynamicModels?.({ onFailure: failure => failures.push(failure) });
	return { failures, models: models ?? [] };
}

describe("Ollama Cloud per-model metadata failures", () => {
	test("reports a rate-limited /api/show and names the model that lost its metadata", async () => {
		const { failures, models } = await discover(
			cloudFetch(() => new Response("rate limited", { status: 429, statusText: "Too Many Requests" })),
		);

		// The model is still offered. Dropping it would be a different bug: the user asked for their Ollama
		// catalog and the list endpoint answered honestly.
		expect(models.map(model => model.id)).toEqual(["qwen3-coder:480b"]);

		expect(failures).toHaveLength(1);
		expect(failures[0]?.stage).toBe("status");
		expect(failures[0]?.url).toBe(SHOW);
		// Which model, or an operator with forty of them learns nothing actionable.
		expect(failures[0]?.detail).toContain("qwen3-coder:480b");
		expect(failures[0]?.detail).toContain("429");
	});

	test("reports an unreachable /api/show as a request failure", async () => {
		const failures: DiscoveryFailure[] = [];
		const fetchImpl: FetchImpl = vi.fn(async input => {
			const url = String(input);
			if (url === TAGS) {
				return new Response(JSON.stringify({ models: [{ model: "gpt-oss:120b" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error("connect ECONNREFUSED 127.0.0.1:443");
		});
		const options = ollamaCloudModelManagerOptions({ apiKey: "cloud-test-key", fetch: fetchImpl });
		await options.fetchDynamicModels?.({ onFailure: failure => failures.push(failure) });

		expect(failures).toHaveLength(1);
		expect(failures[0]?.stage).toBe("request");
		expect(failures[0]?.detail).toContain("gpt-oss:120b");
		expect(failures[0]?.detail).toContain("ECONNREFUSED");
	});

	test("reports a /api/show body that is not JSON", async () => {
		const { failures } = await discover(
			cloudFetch(
				() =>
					new Response("<html>captive portal</html>", {
						status: 200,
						headers: { "Content-Type": "text/html" },
					}),
			),
		);

		expect(failures).toHaveLength(1);
		expect(failures[0]?.stage).toBe("body");
		expect(failures[0]?.detail).toContain("qwen3-coder:480b");
	});

	test("names every model whose metadata was lost, not just the first", async () => {
		const failures: DiscoveryFailure[] = [];
		const fetchImpl: FetchImpl = vi.fn(async input => {
			const url = String(input);
			if (url === TAGS) {
				return new Response(JSON.stringify({ models: [{ model: "a:1" }, { model: "b:2" }, { model: "c:3" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("nope", { status: 503, statusText: "Service Unavailable" });
		});
		const options = ollamaCloudModelManagerOptions({ apiKey: "cloud-test-key", fetch: fetchImpl });
		await options.fetchDynamicModels?.({ onFailure: failure => failures.push(failure) });

		const named = failures.map(failure => failure.detail).join(" ");
		expect(failures).toHaveLength(3);
		for (const id of ["a:1", "b:2", "c:3"]) expect(named).toContain(id);
	});

	/**
	 * A channel that fires when nothing is wrong is worse than no channel, so the healthy path is pinned
	 * alongside the broken ones.
	 */
	test("stays quiet when every /api/show answers", async () => {
		const { failures, models } = await discover(
			cloudFetch(
				() =>
					new Response(
						JSON.stringify({
							capabilities: ["completion", "thinking", "vision"],
							model_info: { "qwen3.context_length": 262144 },
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		);

		expect(failures).toEqual([]);
		expect(models[0]?.contextWindow).toBe(262144);
		expect(models[0]?.input).toEqual(["text", "image"]);
	});
});
