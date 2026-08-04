import { describe, expect, it } from "bun:test";
import { claudeCodeSystemInstruction, streamAnthropic } from "@veyyon/ai/providers/anthropic";
import type { Context, Model, ModelSpec } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

const MODEL_SPEC: ModelSpec<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const MODEL: Model<"anthropic-messages"> = buildModel(MODEL_SPEC);

type CacheControl = { type: "ephemeral"; ttl?: "1h" };
type WireBlock = { type?: string; text?: string; cache_control?: CacheControl };
type WireMessage = { content?: string | WireBlock[] };
type AnthropicPayload = { system?: WireBlock[]; messages?: WireMessage[] };

function capturePayload(context: Context, isOAuth: boolean): Promise<AnthropicPayload> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<AnthropicPayload>();
	streamAnthropic(MODEL, context, {
		apiKey: "sk-ant-test",
		isOAuth,
		signal: controller.signal,
		onPayload: payload => resolve(payload as AnthropicPayload),
	});
	return promise;
}

function cacheControls(payload: AnthropicPayload): CacheControl[] {
	const controls: CacheControl[] = [];
	for (const block of payload.system ?? []) {
		if (block.cache_control) controls.push(block.cache_control);
	}
	for (const message of payload.messages ?? []) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.cache_control) controls.push(block.cache_control);
		}
	}
	return controls;
}

describe("Anthropic stable system-prefix caching", () => {
	/**
	 * The harness block is shared across parent and subagent prompts. Project,
	 * assignment, and Argot suffix changes must not invalidate that prefix.
	 */
	it("anchors both the stable harness and final system blocks for API-key requests", async () => {
		const payload = await capturePayload(
			{
				systemPrompt: ["stable harness", "agent-specific assignment", "changing handle table"],
				messages: [{ role: "user", content: "Run the task", timestamp: 1 }],
			},
			false,
		);

		expect(payload.system).toEqual([
			{ type: "text", text: "stable harness", cache_control: { type: "ephemeral" } },
			{ type: "text", text: "agent-specific assignment" },
			{ type: "text", text: "changing handle table", cache_control: { type: "ephemeral" } },
		]);
	});

	/**
	 * OAuth adds billing and Claude Code instruction blocks ahead of Veyyon's
	 * prompt. Neither provider-owned prefix block should consume the new anchor.
	 */
	it("anchors Veyyon blocks without marking OAuth billing or instruction blocks", async () => {
		const payload = await capturePayload(
			{
				systemPrompt: ["stable harness", "changing project context"],
				messages: [{ role: "user", content: "Run the task", timestamp: 1 }],
			},
			true,
		);
		const system = payload.system ?? [];

		expect(system[0]?.text).toStartWith("x-anthropic-billing-header:");
		expect(system[0]?.cache_control).toBeUndefined();
		expect(system[1]).toEqual({ type: "text", text: claudeCodeSystemInstruction });
		expect(system[2]).toEqual({
			type: "text",
			text: "stable harness",
			cache_control: { type: "ephemeral", ttl: "1h" },
		});
		expect(system[3]).toEqual({
			type: "text",
			text: "changing project context",
			cache_control: { type: "ephemeral", ttl: "1h" },
		});
	});

	/**
	 * A single Veyyon system block has no earlier durable boundary. It must keep
	 * one system breakpoint instead of wasting a duplicate on OAuth chrome.
	 */
	it("does not add a redundant system anchor when only one Veyyon block exists", async () => {
		const payload = await capturePayload(
			{
				systemPrompt: ["single stable prompt"],
				messages: [{ role: "user", content: "Run the task", timestamp: 1 }],
			},
			true,
		);
		const systemControls = (payload.system ?? []).filter(block => block.cache_control);

		expect(systemControls).toHaveLength(1);
		expect(systemControls[0]?.text).toBe("single stable prompt");
		expect(systemControls[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	/**
	 * Anthropic accepts at most four breakpoints. Two system anchors plus the two
	 * trailing conversation anchors must fit exactly without truncating either.
	 */
	it("uses exactly four breakpoints when two trailing messages are cacheable", async () => {
		const payload = await capturePayload(
			{
				systemPrompt: ["stable harness", "stable project", "changing handles"],
				messages: [
					{ role: "user", content: "First turn", timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "text", text: "First answer" }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: MODEL.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2,
					},
					{ role: "user", content: "Second turn", timestamp: 3 },
				],
			},
			false,
		);

		expect(cacheControls(payload)).toHaveLength(4);
	});
});
