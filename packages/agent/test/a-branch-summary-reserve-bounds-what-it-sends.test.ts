/**
 * WHY: `branchSummary.reserveTokens` is the knob that decides how much of a branch
 * reaches the summarizer. It shipped declared but unwired: nothing read the setting, so
 * every session summarized at the hardcoded 16384 default and the knob was dead.
 *
 * Wiring it exposed a second defect in the same line of code. The budget is
 * `contextWindow - reserveTokens`, and `prepareBranchEntriesForProvider` enforces a
 * budget only `if (tokenBudget > 0)` — a non-positive budget means "no limit". So a
 * reserve at or above the window did not clamp the prompt, it removed the bound
 * entirely and sent the WHOLE branch, on exactly the small-window models that need the
 * reserve most. That inversion was reachable from configuration the moment the setting
 * was wired.
 *
 * The class this closes: every way the reserve can fail to bound what is sent —
 * ignored, inverted at the window boundary, or silently replaced by a different value
 * than the caller asked for.
 *
 * Boundaries are derived from the fixture's own measured token cost rather than
 * hardcoded, so a tokenizer change moves the fixture and the expectations together
 * instead of turning the suite green by accident.
 *
 * What this does not catch: whether `AgentSession` reads the setting at all. That is a
 * text-level wiring question owned by `every-settings-key-has-a-reader.test.ts`, which
 * is the lock that caught the dead flag in the first place.
 */

import { describe, expect, test } from "bun:test";
import {
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	prepareBranchEntries,
	type SessionEntry,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model, Usage } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function modelWithWindow(contextWindow: number): Model {
	return buildModel({
		id: "mock-model",
		name: "mock-model",
		api: "mock",
		provider: "mock",
		baseUrl: "mock://",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 1024,
	});
}

/** Four user turns, oldest first, each carrying a marker the prompt either keeps or drops. */
const ENTRIES: SessionEntry[] = [1, 2, 3, 4].map(index => ({
	type: "message",
	id: `u${index}`,
	parentId: index === 1 ? null : `u${index - 1}`,
	timestamp: new Date(index * 1000).toISOString(),
	message: {
		role: "user",
		content: `MARK_${index} ${"lorem ipsum dolor sit amet consectetur ".repeat(60)}`,
		timestamp: index * 1000,
	},
}));

const OLDEST = "MARK_1";
const NEWEST = "MARK_4";

/**
 * What the whole fixture costs with no budget at all (`prepareBranchEntries` treats 0 as
 * unlimited). Every window and reserve below is placed relative to this.
 */
const FIXTURE_TOKENS = prepareBranchEntries(ENTRIES).totalTokens;

/** Runs a summary and returns the prompt text the provider was handed. */
async function promptFor(options: Partial<GenerateBranchSummaryOptions> & { model: Model }): Promise<string> {
	let captured = "";
	const completeImpl: GenerateBranchSummaryOptions["completeImpl"] = async (_model, context) => {
		const message = context.messages[0];
		if (message?.role !== "user") throw new Error("branch summary request carried no user prompt");
		captured =
			typeof message.content === "string"
				? message.content
				: message.content.map(block => (block.type === "text" ? block.text : "")).join("");
		return {
			role: "assistant",
			content: [{ type: "text", text: "summary" }],
			api: "mock",
			provider: "mock",
			model: "mock-model",
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: 0,
		} as AssistantMessage;
	};
	const result = await generateBranchSummary(ENTRIES, {
		apiKey: "test-api-key",
		signal: new AbortController().signal,
		completeImpl,
		...options,
	});
	expect(result.error).toBeUndefined();
	expect(captured).not.toBe("");
	return captured;
}

describe("the branch summary reserve bounds what the summarizer is sent", () => {
	test("the fixture is large enough for a budget to bite", () => {
		// Without this the suite could pass by sending everything every time.
		expect(FIXTURE_TOKENS).toBeGreaterThan(40);
	});

	test("a reserve that leaves room for the whole branch sends all of it", async () => {
		const prompt = await promptFor({ model: modelWithWindow(FIXTURE_TOKENS * 2), reserveTokens: 1 });
		expect(prompt).toContain(OLDEST);
		expect(prompt).toContain(NEWEST);
	});

	test("a larger reserve drops the oldest turns and keeps the newest", async () => {
		const window = FIXTURE_TOKENS * 2;
		const prompt = await promptFor({
			model: modelWithWindow(window),
			// Leaves half the fixture's cost as budget, so the oldest turn cannot fit.
			reserveTokens: window - Math.floor(FIXTURE_TOKENS / 2),
		});
		expect(prompt).not.toContain(OLDEST);
		expect(prompt).toContain(NEWEST);
	});

	test("a reserve equal to the window still bounds the prompt instead of removing the bound", async () => {
		// The inversion: `contextWindow - reserveTokens` is 0 here, and 0 means "no
		// limit" downstream. Without the clamp this sends the entire branch.
		const prompt = await promptFor({
			model: modelWithWindow(FIXTURE_TOKENS),
			reserveTokens: FIXTURE_TOKENS,
		});
		expect(prompt).not.toContain(OLDEST);
		expect(prompt).toContain(NEWEST);
	});

	test("a reserve larger than the window is bounded the same way", async () => {
		// The negative-budget half of the same boundary.
		const prompt = await promptFor({
			model: modelWithWindow(FIXTURE_TOKENS),
			reserveTokens: FIXTURE_TOKENS * 10,
		});
		expect(prompt).not.toContain(OLDEST);
		expect(prompt).toContain(NEWEST);
	});

	test("an omitted reserve is the documented 16384 default, not an unbounded prompt", async () => {
		// Placed so 16384 is the value that decides what fits: if the default changed or
		// were ignored, these two prompts would differ.
		const window = 16384 + Math.floor(FIXTURE_TOKENS / 2);
		const defaulted = await promptFor({ model: modelWithWindow(window) });
		const explicit = await promptFor({ model: modelWithWindow(window), reserveTokens: 16384 });
		expect(defaulted).toBe(explicit);
		expect(defaulted).not.toContain(OLDEST);
		expect(defaulted).toContain(NEWEST);
	});
});
