/**
 * WHY THIS SUITE EXISTS (ONE-ASSUMED-PAIR-WITH-ONE-OWNER).
 *
 * `DEFAULT_CONTEXT_WINDOW` and `DEFAULT_MAX_TOKENS` were each declared four times under `src/discovery/`, and one
 * of those four held DIFFERENT values under the same names: Antigravity, Cursor and Devin all assumed
 * 200_000 / 64_000 while `codex.ts` assumed 272_000 / 128_000. One name meaning two values in one directory is
 * how a reader carries the wrong number across a file boundary, and these numbers feed auto-compaction, the
 * context panel and the overflow check, so a wrong one is not cosmetic.
 *
 * THE CLASS: an assumed limit must have one owner, and a module that assumes something different must be
 * assuming it for a reason of its own. The suite closes that by driving each module's real discovery over an
 * endpoint that reports nothing and pinning the number it answers, which is the only thing a divergent copy can
 * be observed by. Two of the assertions are deliberately asymmetric, and the pair is what makes divergence
 * visible: the owner's constants are pinned to LITERALS, so changing the assumption is a recorded decision, while
 * every module's fallback is asserted against the CONSTANT, so a module holding its own copy of 200_000 goes red
 * the moment the shared number moves. Against the constant alone the first would follow a bad edit; against the
 * literal alone the second could not tell a shared number from a copied one.
 *
 * WHAT THIS DOES NOT CATCH. A module that retypes 200_000 inline AND is never driven here: it answers the same
 * number today, and only diverges when the assumption changes, which is exactly when the fallback cases above go
 * red. `test/gateway-model-limits.test.ts` is what makes sure the set of driven modules is complete, by
 * classifying every module in the directory.
 */

import { describe, expect, it } from "bun:test";
import { fetchAntigravityDiscoveryModels } from "../src/discovery/antigravity";
import { fetchCodexModels } from "../src/discovery/codex";
import {
	AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW,
	AGENT_GATEWAY_DEFAULT_MAX_TOKENS,
} from "../src/discovery/default-limits";
import { buildGitLabDuoWorkflowModelSpec } from "../src/discovery/gitlab-duo-workflow";

/** A `typeof fetch` that answers every request with one JSON body, without casting through `unknown`. */
function respondWith(models: unknown): typeof fetch {
	return Object.assign(
		async () =>
			new Response(JSON.stringify({ models }), { status: 200, headers: { "Content-Type": "application/json" } }),
		{ preconnect() {} },
	);
}

describe("the agent-gateway assumed limits", () => {
	/**
	 * The Claude-class context window, pinned to the literal. Auto-compaction and the context panel read it: an
	 * over-estimate makes the agent fill a window the model does not have until the provider rejects the request,
	 * so moving this number is a decision and not a refactor.
	 */
	it("assumes a 200k context window", () => {
		expect(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW).toBe(200_000);
	});

	/** The output cap, which is a budget rather than a share of the window. */
	it("assumes a 64k output cap", () => {
		expect(AGENT_GATEWAY_DEFAULT_MAX_TOKENS).toBe(64_000);
	});

	/**
	 * The cap has to stay comfortably below the window, since a request carries both and a cap at or above the
	 * window leaves no room for the prompt at all.
	 */
	it("keeps the output cap well below the window", () => {
		expect(AGENT_GATEWAY_DEFAULT_MAX_TOKENS).toBeLessThan(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW / 2);
	});

	/** Both are positive integers, since they are serialised into a request and compared against token counts. */
	it("holds positive integers", () => {
		for (const value of [AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW, AGENT_GATEWAY_DEFAULT_MAX_TOKENS]) {
			expect(Number.isSafeInteger(value)).toBe(true);
			expect(value).toBeGreaterThan(0);
		}
	});
});

describe("a gateway falls back to the shared pair", () => {
	/**
	 * Driven through the real discovery function with an injected fetcher, so this proves the wiring rather than
	 * re-asserting the constants against themselves. Antigravity's limit fields are frequently absent, so a row
	 * with none falls back while a row that DOES report keeps its own numbers. Both halves matter: a fallback that
	 * also overrode reported values would be worse than having no fallback at all.
	 *
	 * The ids are deliberately nonsense. This is the fallback path, and it is reached only for a model nothing
	 * known describes; a real model id would resolve through the catalog and never arrive here.
	 */
	it("falls back only when the endpoint reports nothing", async () => {
		const models = await fetchAntigravityDiscoveryModels({
			token: "test-token",
			endpoint: "https://antigravity.example",
			// `models` is a MAP keyed by model id, which is also why the ids come back verbatim.
			fetcher: respondWith({
				"silent-model": { displayName: "Silent" },
				"talkative-model": { displayName: "Talkative", maxTokens: 1_000_000, maxOutputTokens: 96_000 },
			}),
		});
		expect(models).not.toBeNull();
		const silent = models?.find(model => model.id === "silent-model");
		const talkative = models?.find(model => model.id === "talkative-model");
		expect(silent, "silent model missing").toBeDefined();
		expect(silent?.contextWindow).toBe(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
		expect(silent?.maxTokens).toBe(AGENT_GATEWAY_DEFAULT_MAX_TOKENS);
		expect(talkative?.contextWindow).toBe(1_000_000);
		expect(talkative?.maxTokens).toBe(96_000);
	});

	/**
	 * A reported zero is "not told" rather than a real limit, which is why the fallback is applied through a
	 * positive-number check rather than a nullish one. A zero window would make auto-compaction fire immediately
	 * and every turn would be compacted before it began.
	 */
	it("treats a reported zero as not told", async () => {
		const models = await fetchAntigravityDiscoveryModels({
			token: "test-token",
			endpoint: "https://antigravity.example",
			fetcher: respondWith({ "zero-model": { displayName: "Zero", maxTokens: 0, maxOutputTokens: 0 } }),
		});
		const zero = models?.find(model => model.id === "zero-model");
		expect(zero?.contextWindow).toBe(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
		expect(zero?.maxTokens).toBe(AGENT_GATEWAY_DEFAULT_MAX_TOKENS);
	});
});

describe("a module that assumes something else assumes it for its own reason", () => {
	/**
	 * Codex keeps a different pair on purpose: GPT-5-class Codex has a documented under-reporting quirk and a
	 * genuinely larger window, so the bug was the shared NAME rather than the different value. Driven with a model
	 * that reports no `context_window` at all, which is the only way to observe which pair the module holds. A
	 * non-5.6 slug is used because the 5.6 SKUs apply their own documented floor on top.
	 */
	it("gives Codex its own 272k/128k pair, not the gateway pair", async () => {
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			fetchFn: Object.assign(
				async () =>
					new Response(JSON.stringify({ models: [{ slug: "gpt-5.5", display_name: "GPT-5.5" }] }), {
						status: 200,
					}),
				{ preconnect() {} },
			),
		});
		const model = result?.models.find(candidate => candidate.id === "gpt-5.5");
		expect(model?.contextWindow).toBe(272_000);
		expect(model?.maxTokens).toBe(128_000);
		expect(model?.contextWindow).not.toBe(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
		expect(model?.maxTokens).not.toBe(AGENT_GATEWAY_DEFAULT_MAX_TOKENS);
	});

	/**
	 * GitLab Duo Workflow also assumes 200_000 and deliberately keeps its own constant, because its value has an
	 * independent reason: the Duo Workflow Service's own global fallback in
	 * `duo_workflow_service/conversation/trimmer.py`. Folding it in would tie two unrelated decisions together,
	 * and whoever next changed the gateway assumption would silently move GitLab off the number its upstream
	 * uses. What makes the coincidence observable is that GitLab's assumption is per-model where the gateway pair
	 * is not: a ref it recognizes gets its own window, and its output cap is null rather than 64k.
	 */
	it("leaves GitLab Duo Workflow its independently-reasoned copy", () => {
		const unrecognized = buildGitLabDuoWorkflowModelSpec({ name: "Unknown", ref: "duo-chat-unknown-model" });
		expect(unrecognized.contextWindow).toBe(200_000);
		expect(unrecognized.maxTokens).toBeNull();
		const recognized = buildGitLabDuoWorkflowModelSpec({ name: "Sonnet", ref: "claude_sonnet_4_6_vertex" });
		expect(recognized.contextWindow).toBe(1_000_000);
	});
});
