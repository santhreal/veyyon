/**
 * ONE-PLACE lock for the token limits assumed when an agent gateway does not publish its own.
 *
 * Why this suite exists: `DEFAULT_CONTEXT_WINDOW` and `DEFAULT_MAX_TOKENS` were each declared four times in
 * `src/discovery/`, and one of those four held DIFFERENT values under the same names. Antigravity, Cursor and
 * Devin all assumed 200_000 / 64_000; `codex.ts` assumed 272_000 / 128_000. One name meaning two values in one
 * directory is how a reader carries the wrong number across a file boundary, and these particular numbers feed
 * auto-compaction and the context panel, so a wrong one is not a cosmetic mistake.
 *
 * The three matching copies were one decision restated: all three are gateways that proxy Claude-class models and
 * report their limits unreliably, and all three also carry the same note that their zero prices mean "not told"
 * rather than "free". Raising the assumption when the proxied model class changes should be one edit.
 *
 * The cases below pin the pair, prove each discovery module actually falls back to it, and record the two places
 * that deliberately keep their own value along with the reason.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW,
	AGENT_GATEWAY_DEFAULT_MAX_TOKENS,
} from "../src/discovery/default-limits";

const DISCOVERY = path.resolve(import.meta.dir, "../src/discovery");
const SHARERS = ["antigravity.ts", "cursor.ts", "devin.ts"];

async function discoverySources(): Promise<ReadonlyArray<{ file: string; text: string }>> {
	const files = [...new Bun.Glob("**/*.ts").scanSync(DISCOVERY)]
		.map(file => file.split(path.sep).join("/"))
		.filter(file => file !== "default-limits.ts")
		.sort();
	return await Promise.all(
		files.map(async file => ({ file, text: await Bun.file(path.join(DISCOVERY, file)).text() })),
	);
}

describe("the agent-gateway default limits", () => {
	/**
	 * The Claude-class context window. Pinned because auto-compaction and the context panel read it: an
	 * over-estimate makes the agent fill a window the model does not have and the provider rejects the request,
	 * while an under-estimate only compacts earlier than needed. Too low is the safe direction, and 200k is the
	 * real Claude window rather than a round number chosen for comfort.
	 */
	it("assumes a 200k context window", () => {
		expect(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW).toBe(200_000);
	});

	/** The output cap, which is a budget rather than a share of the window. */
	it("assumes a 64k output cap", () => {
		expect(AGENT_GATEWAY_DEFAULT_MAX_TOKENS).toBe(64_000);
	});

	/**
	 * The output cap has to stay comfortably below the window, since a request is sent with both and a cap at or
	 * above the window leaves no room for the prompt at all.
	 */
	it("keeps the output cap well below the window", () => {
		expect(AGENT_GATEWAY_DEFAULT_MAX_TOKENS).toBeLessThan(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW / 2);
	});

	/** Both are positive integers, since they are serialised into a request and compared against token counts. */
	it("holds positive integers", () => {
		for (const value of [AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW, AGENT_GATEWAY_DEFAULT_MAX_TOKENS]) {
			expect(Number.isInteger(value)).toBeTrue();
			expect(value).toBeGreaterThan(0);
		}
	});
});

describe("a gateway falls back to the shared pair", () => {
	function respondWith(models: unknown): typeof globalThis.fetch {
		return (async () =>
			new Response(JSON.stringify({ models }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof globalThis.fetch;
	}

	/**
	 * Antigravity reports limit fields that are frequently absent, so an entry with none falls back to the assumed
	 * pair while an entry that DOES report them keeps its own numbers. Both halves matter: a fallback that also
	 * overrode reported values would be worse than having no fallback at all.
	 *
	 * Driven through the real discovery function with an injected fetcher, so this proves the wiring rather than
	 * re-asserting the constants against themselves.
	 */
	it("falls back only when the endpoint reports nothing", async () => {
		const { fetchAntigravityDiscoveryModels } = await import("../src/discovery/antigravity");
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
		const silent = models?.find(model => model.id.includes("silent"));
		const talkative = models?.find(model => model.id.includes("talkative"));
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
		const { fetchAntigravityDiscoveryModels } = await import("../src/discovery/antigravity");
		const models = await fetchAntigravityDiscoveryModels({
			token: "test-token",
			endpoint: "https://antigravity.example",
			fetcher: respondWith({ "zero-model": { displayName: "Zero", maxTokens: 0, maxOutputTokens: 0 } }),
		});
		const zero = models?.find(model => model.id.includes("zero"));
		expect(zero?.contextWindow).toBe(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
		expect(zero?.maxTokens).toBe(AGENT_GATEWAY_DEFAULT_MAX_TOKENS);
	});
});

describe("the discovery limits have one owner", () => {
	/**
	 * The ratchet on the retired names. They were bare `DEFAULT_CONTEXT_WINDOW` and `DEFAULT_MAX_TOKENS` in four
	 * modules, so the check is that no module in this directory declares either bare name again, whatever value it
	 * would give it. That covers both the duplication and the divergence in one rule.
	 */
	it("declares no bare default-limit name anywhere under discovery", async () => {
		const offenders: string[] = [];
		for (const { file, text } of await discoverySources()) {
			for (const name of ["DEFAULT_CONTEXT_WINDOW", "DEFAULT_MAX_TOKENS"]) {
				if (new RegExp(`^\\s*(?:export )?const ${name}\\b`, "m").test(text)) offenders.push(`${file}: ${name}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * The non-vacuity twin: prove the scan reaches all five modules that were involved, so a broken glob cannot
	 * satisfy the ratchet by reading nothing.
	 */
	it("scans the five modules that were involved", async () => {
		const files = (await discoverySources()).map(entry => entry.file);
		for (const file of [...SHARERS, "codex.ts", "gitlab-duo-workflow.ts"]) {
			expect(files).toContain(file);
		}
	});

	/** The positive half: all three gateways read the shared pair. */
	it("has all three gateways importing the owner", async () => {
		for (const file of SHARERS) {
			const text = await Bun.file(path.join(DISCOVERY, file)).text();
			expect(text, file).toContain("AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW");
			expect(text, file).toContain("AGENT_GATEWAY_DEFAULT_MAX_TOKENS");
			expect(text, file).toMatch(/from "\.\/default-limits";/);
		}
	});

	/**
	 * Codex keeps a different pair on purpose, so the requirement is that it is provider-prefixed rather than that
	 * it is absent. GPT-5-class Codex has a documented under-reporting quirk and a genuinely larger window; the
	 * bug was the shared NAME, not the different value.
	 */
	it("keeps Codex's different pair under provider-prefixed names", async () => {
		const codex = await Bun.file(path.join(DISCOVERY, "codex.ts")).text();
		expect(codex).toContain("const CODEX_DEFAULT_CONTEXT_WINDOW = 272_000;");
		expect(codex).toContain("const CODEX_DEFAULT_MAX_TOKENS = 128_000;");
		expect(codex).not.toContain("AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW");
	});

	/**
	 * GitLab Duo Workflow also assumes 200_000 and deliberately keeps its own constant, because its value has an
	 * independent reason recorded beside it: the Duo Workflow Service's own global fallback in
	 * `duo_workflow_service/conversation/trimmer.py`. Folding it in would tie two unrelated decisions together, and
	 * whoever next changed the gateway assumption would silently move GitLab off the number its upstream uses.
	 * Asserted, with the reason, so the exemption is a recorded decision rather than an oversight.
	 */
	it("leaves GitLab Duo Workflow its independently-reasoned copy", async () => {
		const gitlab = await Bun.file(path.join(DISCOVERY, "gitlab-duo-workflow.ts")).text();
		expect(gitlab).toContain("const GITLAB_DUO_WORKFLOW_DEFAULT_CONTEXT_WINDOW = 200_000;");
		expect(gitlab).toContain("trimmer.py");
		expect(gitlab).not.toContain("AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW");
	});

	/**
	 * The owner is a leaf, so a discovery module pays nothing to read the pair. Every copy in this codebase existed
	 * because importing cost more than retyping.
	 */
	it("imports nothing", async () => {
		const owner = await Bun.file(path.join(DISCOVERY, "default-limits.ts")).text();
		expect(owner).not.toMatch(/^\s*import\s/m);
		expect(owner).not.toMatch(/\bfrom\s+"/);
	});
});
