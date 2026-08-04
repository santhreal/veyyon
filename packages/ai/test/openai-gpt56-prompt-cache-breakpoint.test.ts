import { describe, expect, it } from "bun:test";
import { buildTransformedCodexRequestBody } from "@veyyon/ai/providers/openai-codex-responses";
import { buildParams } from "@veyyon/ai/providers/openai-responses";
import type { Context, Model, ModelSpec } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel, getBundledModels } from "@veyyon/catalog/models";

const directModel = getBundledModel("openai", "gpt-5.6-sol") as Model<"openai-responses">;
const codexModel = getBundledModel("openai-codex", "gpt-5.6-sol") as Model<"openai-codex-responses">;
const legacyDirectModel = getBundledModel("openai", "gpt-5.5") as Model<"openai-responses">;

const context: Context = {
	systemPrompt: ["stable harness prompt", "changing project context"],
	messages: [{ role: "user", content: "Run the task", timestamp: 1 }],
};

type CacheBreakpoint = { mode: "explicit" };
type InputText = { type?: string; text?: string; prompt_cache_breakpoint?: CacheBreakpoint };
type InputItem = { type?: string; role?: string; content?: string | InputText[] };

function inputItems(value: unknown): InputItem[] {
	return Array.isArray(value) ? (value as InputItem[]) : [];
}

function explicitBreakpoints(items: InputItem[]): InputText[] {
	const blocks: InputText[] = [];
	for (const item of items) {
		if (!Array.isArray(item.content)) continue;
		for (const block of item.content) {
			if (block.prompt_cache_breakpoint) blocks.push(block);
		}
	}
	return blocks;
}

describe("GPT-5.6 explicit stable-prefix caching", () => {
	/**
	 * GPT-5.6 no longer falls back to an earlier unmarked prefix. The direct
	 * Responses request must mark Veyyon's stable harness before dynamic context.
	 */
	it("marks only the first developer system block on official Responses requests", () => {
		const { params } = buildParams(directModel, context, { sessionId: "cache-route" }, undefined);
		const items = inputItems(params.input);

		expect(items[0]).toEqual({
			role: "developer",
			content: [
				{
					type: "input_text",
					text: "stable harness prompt",
					prompt_cache_breakpoint: { mode: "explicit" },
				},
			],
		});
		expect(items[1]).toEqual({ role: "developer", content: "changing project context" });
		expect(explicitBreakpoints(items)).toHaveLength(1);
		expect(params.prompt_cache_key).toBe("cache-route");
	});

	/**
	 * Reliable explicit matching requires a cache key. Calls without cache
	 * affinity must retain their normal payload instead of paying isolated writes.
	 */
	it("omits explicit breakpoints when no prompt cache key exists", () => {
		const { params } = buildParams(directModel, context, undefined, undefined);
		const items = inputItems(params.input);

		expect(explicitBreakpoints(items)).toHaveLength(0);
		expect(items.slice(0, 2)).toEqual([
			{ role: "developer", content: "stable harness prompt" },
			{ role: "developer", content: "changing project context" },
		]);
	});

	/**
	 * Older OpenAI models reject the GPT-5.6 breakpoint field with a 400. The
	 * version gate must preserve their existing developer-message wire shape.
	 */
	it("does not send breakpoints to pre-5.6 Responses models", () => {
		const { params } = buildParams(legacyDirectModel, context, { sessionId: "cache-route" }, undefined);
		const items = inputItems(params.input);

		expect(explicitBreakpoints(items)).toHaveLength(0);
		expect(items[0]).toEqual({ role: "developer", content: "stable harness prompt" });
	});

	/**
	 * A blank stable prefix can never reach the strict 1024-token cacheable-prefix
	 * floor, so marking it spends a marker slot for nothing and risks the 400 for a
	 * breakpoint on a non-cacheable block. Two layers must agree on that: prompt
	 * normalization drops the blank prompt, and the marker lands on the first block
	 * that actually carries text. This pins the composition of the two — if either
	 * layer stops enforcing it, the request ships a dead or rejected marker and the
	 * stable harness prefix goes unmarked. The request must still hold exactly one.
	 */
	it("marks the first non-blank system block when the leading prompt is blank", () => {
		const { params } = buildParams(
			directModel,
			{ ...context, systemPrompt: ["   \n\t ", "stable harness prompt", "changing project context"] },
			{ sessionId: "cache-route" },
			undefined,
		);
		const items = inputItems(params.input);

		expect(explicitBreakpoints(items)).toEqual([
			{ type: "input_text", text: "stable harness prompt", prompt_cache_breakpoint: { mode: "explicit" } },
		]);
		expect(items[0]).toEqual({
			role: "developer",
			content: [
				{
					type: "input_text",
					text: "stable harness prompt",
					prompt_cache_breakpoint: { mode: "explicit" },
				},
			],
		});
		expect(items[1]).toEqual({ role: "developer", content: "changing project context" });
	});

	/**
	 * `prompt_cache_retention: "24h"` is deprecated from the 5.6 generation onward.
	 * The suppression used to also require the official endpoint while its enabling
	 * compat flag is URL-keyed and provider-blind, so a 5.6+ id served from
	 * `api.openai.com` under a non-`openai` provider id put the deprecated field on
	 * the wire with no breakpoint beside it. If this regresses, that request carries
	 * a legacy retention control into the generation that replaced it.
	 */
	it("sends no retention field for a 5.6 id on an unofficial provider entry", () => {
		const compatibleHost = buildModel({
			...directModel,
			provider: "openai-compatible",
			compat: directModel.compatConfig,
		} as ModelSpec<"openai-responses">);

		const { params } = buildParams(
			compatibleHost,
			context,
			{ sessionId: "cache-route", cacheRetention: "long" },
			undefined,
		);

		expect(params.prompt_cache_retention).toBeUndefined();
		expect(explicitBreakpoints(inputItems(params.input))).toHaveLength(0);
		expect(params.prompt_cache_key).toBe("cache-route");
	});

	/**
	 * Boundary for the same suppression: pre-5.6 is the generation where `24h` is
	 * still the retention control, so the field must keep reaching the wire there.
	 * A blanket suppression would silently shorten every pre-5.6 cached prefix from
	 * 24h to the default window and re-prefill on every cold turn.
	 */
	it("still sends 24h retention for a pre-5.6 official request", () => {
		const { params } = buildParams(
			legacyDirectModel,
			context,
			{ sessionId: "cache-route", cacheRetention: "long" },
			undefined,
		);

		expect(params.prompt_cache_retention).toBe("24h");
		expect(explicitBreakpoints(inputItems(params.input))).toHaveLength(0);
	});
});

describe("Codex backend rejects prompt cache breakpoints", () => {
	/**
	 * Regression lock for the shipped outage: Responses Lite moves instructions
	 * into an `input_text` block, and a previous revision stamped
	 * `prompt_cache_breakpoint` on that block for any 5.6+ Codex id. The ChatGPT
	 * Codex backend answers `prompt_cache_breakpoint is not supported on this
	 * model (invalid_parameter)` and fails the entire turn, so every request on
	 * the Codex path died and no prefix was ever cached. `prompt_cache_breakpoint`
	 * is an api.openai.com field; codex-rs never sends it.
	 */
	it("keeps the Responses Lite instruction block free of breakpoints when keyed", async () => {
		const body = await buildTransformedCodexRequestBody(codexModel, context, {
			sessionId: "cache-route",
			responsesLite: true,
		});
		const items = inputItems(body.input);

		expect(explicitBreakpoints(items)).toHaveLength(0);
		expect(items[0]?.type).toBe("additional_tools");
		expect(items[1]).toEqual({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: "stable harness prompt" }],
		});
		expect(items[2]).toEqual({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: "changing project context" }],
		});
		// Cache affinity still ships: it is the only caching control the Codex
		// backend honors, so losing it would silently stop prefix reuse.
		expect(body.prompt_cache_key).toBe("cache-route");
	});

	/**
	 * The unkeyed Lite turn shares the marker-free shape. Asserted separately so a
	 * future revision cannot reintroduce the field behind a cache-key branch.
	 */
	it("keeps the Responses Lite instruction block free of breakpoints when unkeyed", async () => {
		const body = await buildTransformedCodexRequestBody(codexModel, context, { responsesLite: true });

		expect(body.prompt_cache_key).toBeUndefined();
		expect(explicitBreakpoints(inputItems(body.input))).toHaveLength(0);
	});

	/**
	 * Non-Lite Codex keeps instructions in a top-level string, where OpenAI accepts
	 * no block markers at all. The optimization must not emit an invalid field.
	 */
	it("keeps non-Lite Codex requests free of unsupported block markers", async () => {
		const body = await buildTransformedCodexRequestBody(codexModel, context, {
			sessionId: "cache-route",
			responsesLite: false,
		});

		expect(body.instructions).toBe("stable harness prompt");
		expect(explicitBreakpoints(inputItems(body.input))).toHaveLength(0);
	});

	/**
	 * Version-floor gates are the reason this shipped: `gpt-5.6-codex` parses as
	 * 5.6 and inherited a capability proven only on the platform API. Sweeping the
	 * whole bundled Codex catalog means a newly added 5.7/6.x Codex id cannot
	 * quietly re-enter the failing path.
	 */
	it("emits no breakpoint for any bundled Codex model", async () => {
		const codexModels = getBundledModels("openai-codex") as Model<"openai-codex-responses">[];
		expect(codexModels.length).toBeGreaterThan(0);

		for (const model of codexModels) {
			for (const responsesLite of [true, false]) {
				const body = await buildTransformedCodexRequestBody(model, context, {
					sessionId: "cache-route",
					responsesLite,
				});
				expect(explicitBreakpoints(inputItems(body.input))).toEqual([]);
			}
		}
	});
});
