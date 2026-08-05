/**
 * Bedrock anchors the stable system prefix separately from the volatile tail.
 *
 * WHY THIS SUITE EXISTS. `buildSystemPrompt` appended ONE `cachePoint` after
 * ALL system blocks, so the cached prefix ended at the last block. The system
 * prompt here is not one block: block 0 is the harness shared across parent and
 * subagent prompts, and project context, the assignment and the handle table
 * are appended after it and change constantly. With a single trailing
 * checkpoint, any edit to any later block invalidated the ENTIRE system prefix,
 * and the next turn re-read and re-wrote all of it at full input rate plus the
 * cache-write premium. The Anthropic provider anchors its own block 0 for
 * exactly this reason (`applyPromptCaching`, anthropic.ts), so the two
 * transports disagreed about the same conversation and only the bill showed it.
 *
 * WHAT IS PINNED. The POSITIONS of the cachePoints in the emitted Converse
 * payload, interleaved with the text blocks they terminate, because placement
 * is the entire content of the fix. A test that asserted "a cachePoint exists"
 * would have passed against the defect.
 *
 * The negative branches are pinned as hard as the positive one: a single-block
 * system prompt must NOT spend a second slot on a duplicate anchor, and
 * `cacheRetention: "none"` must emit no checkpoint at all. Both are the shapes
 * an over-eager fix breaks.
 */
import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@veyyon/ai/providers/amazon-bedrock";
import type { CacheRetention, Context, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

type SystemBlock = { text?: string; cachePoint?: { type: string; ttl?: string } };
type BedrockPayload = { system?: SystemBlock[]; messages?: Array<{ role: string; content: unknown[] }> };

/** A priced-as-cacheable Claude row, so `supportsBedrockPromptCaching` is true on the cost check. */
const model: Model<"bedrock-converse-stream"> = buildModel({
	id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
	name: "Claude Sonnet 4.5 (Bedrock)",
	api: "bedrock-converse-stream",
	provider: "bedrock",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 8192,
});

/** The real layout: a fixed harness, then blocks that change per session and per turn. */
const THREE_BLOCK_SYSTEM = ["stable harness", "agent-specific assignment", "changing handle table"];

function contextWith(systemPrompt: string[]): Context {
	return { systemPrompt, messages: [{ role: "user", content: "turn two", timestamp: 1 }] };
}

async function capture(systemPrompt: string[], cacheRetention?: CacheRetention): Promise<BedrockPayload> {
	const { promise, resolve } = Promise.withResolvers<BedrockPayload>();
	const aborted = new AbortController();
	aborted.abort();
	streamBedrock(model, contextWith(systemPrompt), {
		apiKey: "k",
		signal: aborted.signal,
		cacheRetention,
		fetch: async () => new Response("", { status: 200 }),
		onPayload: payload => {
			resolve(payload as BedrockPayload);
			return undefined;
		},
	});
	return promise;
}

describe("Bedrock system prompt cache anchoring", () => {
	it("anchors block 0 and still terminates the full system prefix", async () => {
		const payload = await capture(THREE_BLOCK_SYSTEM);

		// Exact wire array, so a moved, added or dropped checkpoint fails here.
		expect(payload.system).toEqual([
			{ text: "stable harness" },
			{ cachePoint: { type: "default" } },
			{ text: "agent-specific assignment" },
			{ text: "changing handle table" },
			{ cachePoint: { type: "default" } },
		]);
	});

	it("keeps the whole request inside Claude's four-checkpoint budget", async () => {
		const payload = await capture(THREE_BLOCK_SYSTEM);

		const systemPoints = (payload.system ?? []).filter(block => block.cachePoint !== undefined).length;
		const messagePoints = (payload.messages ?? []).reduce(
			(total, message) =>
				total + message.content.filter(block => (block as SystemBlock).cachePoint !== undefined).length,
			0,
		);

		expect(systemPoints).toBe(2);
		expect(messagePoints).toBe(1);
		expect(systemPoints + messagePoints).toBeLessThanOrEqual(4);
	});

	it("carries the one-hour ttl on both system checkpoints under cacheRetention long", async () => {
		const payload = await capture(THREE_BLOCK_SYSTEM, "long");

		// Same ttl on both, which satisfies Bedrock's rule that longer TTLs must
		// precede shorter ones without needing to reason about ordering.
		expect(payload.system).toEqual([
			{ text: "stable harness" },
			{ cachePoint: { type: "default", ttl: "1h" } },
			{ text: "agent-specific assignment" },
			{ text: "changing handle table" },
			{ cachePoint: { type: "default", ttl: "1h" } },
		]);
	});

	it("spends no second slot when the system prompt is one block", async () => {
		const payload = await capture(["single stable prompt"]);

		// The trailing checkpoint already ends at that same block, so an anchor
		// here would buy nothing and burn a checkpoint.
		expect(payload.system).toEqual([{ text: "single stable prompt" }, { cachePoint: { type: "default" } }]);
	});

	it("emits no checkpoint at all when the caller opted out", async () => {
		const payload = await capture(THREE_BLOCK_SYSTEM, "none");

		expect(payload.system).toEqual([
			{ text: "stable harness" },
			{ text: "agent-specific assignment" },
			{ text: "changing handle table" },
		]);
	});
});
