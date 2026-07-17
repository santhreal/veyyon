/**
 * Contract: tool schema token estimation reflects the wire JSON Schema.
 *
 * Tools authored with arktype must be counted by the JSON Schema providers
 * actually receive — not by stringifying the arktype instance's enumerable
 * internals, which massively overcounts.
 */
import { describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/pi-agent-core";
import * as compactionModule from "@veyyon/pi-agent-core/compaction";
import { arkToWireSchema } from "@veyyon/pi-ai/utils/schema";
import {
	type ContextBreakdown,
	computeNonMessageBreakdown,
	computeNonMessageTokens,
	computeStoredMessagesTokens,
	estimateToolSchemaTokens,
	renderContextUsage,
} from "@veyyon/pi-coding-agent/modes/utils/context-usage";
import { type } from "arktype";

describe("estimateToolSchemaTokens", () => {
	it("counts arktype tool schemas by their wire JSON Schema, not arktype internals", () => {
		const parameters = type({
			"query /** search query */": "string",
			"limit?": "number",
		});
		const arktypeEstimate = estimateToolSchemaTokens([
			{ name: "web_search", description: "Searches the web.", parameters } as never,
		]);
		const wireEstimate = estimateToolSchemaTokens([
			{ name: "web_search", description: "Searches the web.", parameters: arkToWireSchema(parameters) } as never,
		]);
		expect(arktypeEstimate).toBe(wireEstimate);
	});
});

/**
 * Contract: the /context panel surfaces estimated snapcompact wire savings —
 * applied swaps show "saves" figures, inactive states say why.
 */
describe("renderContextUsage snapcompact section", () => {
	const themeStub = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as never;

	function breakdownWith(snapcompact: ContextBreakdown["snapcompact"]): ContextBreakdown {
		return {
			model: { id: "test-model", name: "Test Model", contextWindow: 200000 } as never,
			contextWindow: 200000,
			categories: [],
			usedTokens: 27929,
			autoCompactBufferTokens: 0,
			freeTokens: 172071,
			snapcompact,
		};
	}

	it("renders savings, skip reasons, and the wire total", () => {
		const output = renderContextUsage(
			breakdownWith({
				visionCapable: true,
				systemPrompt: {
					applied: true,
					scope: "all",
					textTokens: 9768,
					frames: 2,
					imageTokens: 6600,
					savedTokens: 3168,
				},
				toolResults: { total: 3, swapped: 0, textTokens: 0, frames: 0, imageTokens: 0, savedTokens: 0 },
				savedTokens: 3168,
			}),
			themeStub,
		);
		expect(output).toContain("Snapcompact (estimated wire savings)");
		expect(output).toContain("System prompt (all): saves ~3.2K (9.8K text → 2 frames ≈ 6.6K)");
		expect(output).toContain("Tool results: none imaged (3 in history)");
		// 27929 logical − 3168 saved ≈ 25K on the wire.
		expect(output).toContain("Next request: ~25K tokens on the wire");
	});

	it("reports text-only models as inactive", () => {
		const output = renderContextUsage(breakdownWith({ visionCapable: false, savedTokens: 0 }), themeStub);
		expect(output).toContain("Snapcompact: inactive (model has no image input)");
	});

	it("renders the context grid with non-empty category glyphs", () => {
		const output = renderContextUsage(
			{
				model: { id: "test-model", name: "Test Model", contextWindow: 200000 } as never,
				contextWindow: 200000,
				categories: [{ id: "systemPrompt", label: "System prompt", tokens: 1000, color: "accent", glyph: "⛁" }],
				usedTokens: 1000,
				autoCompactBufferTokens: 0,
				freeTokens: 199000,
			},
			themeStub,
		);
		expect(output).toContain("⛁");
	});

	it("omits the section entirely when no snapcompact setting is on", () => {
		const output = renderContextUsage(breakdownWith(undefined), themeStub);
		expect(output).not.toContain("Snapcompact");
	});
});

/**
 * Contract: the non-message token totals reflect the CURRENT system prompt,
 * tools, and skills — including after they change via reference replacement
 * (the setSystemPrompt/setTools pattern), and stay stable while those inputs
 * hold the same identity. The memo must never serve a stale value for changed
 * inputs.
 */
describe("computeNonMessageTokens / computeNonMessageBreakdown memoization", () => {
	function makeSession(systemPrompt: string[], tools: unknown[] = [], skills: unknown[] = []) {
		return { systemPrompt, agent: { state: { tools } }, skills };
	}

	it("recomputes when the system prompt reference changes and caches otherwise", () => {
		const session = makeSession(["system prompt alpha"]);
		const first = computeNonMessageTokens(session as never);
		// Same inputs (identical refs) → cached, identical value.
		expect(computeNonMessageTokens(session as never)).toBe(first);
		// Replace the system prompt reference (mirrors setSystemPrompt).
		session.systemPrompt = ["system prompt beta with more tokens than alpha"];
		const afterChange = computeNonMessageTokens(session as never);
		expect(afterChange).toBeGreaterThan(first);
		// Cached on the new inputs.
		expect(computeNonMessageTokens(session as never)).toBe(afterChange);
	});

	it("recomputes the breakdown when the tools reference changes", () => {
		const session = makeSession(["base"], []);
		const before = computeNonMessageBreakdown(session as never);
		expect(before.toolsTokens).toBe(0);
		// New tools array reference (mirrors setTools).
		session.agent.state.tools = [{ name: "search", description: "search the web", parameters: {} }];
		const after = computeNonMessageBreakdown(session as never);
		expect(after.toolsTokens).toBeGreaterThan(0);
		// Cached on the new tools.
		expect(computeNonMessageBreakdown(session as never).toolsTokens).toBe(after.toolsTokens);
	});

	it("shares one cache entry so tokens and breakdown invalidate together", () => {
		const session = makeSession(["shared prompt"]);
		const tokens = computeNonMessageTokens(session as never);
		const breakdown = computeNonMessageBreakdown(session as never);
		// Changing the system prompt ref must invalidate BOTH fields, not just
		// the one most recently touched.
		session.systemPrompt = ["shared prompt but longer now to shift the count"];
		expect(computeNonMessageTokens(session as never)).not.toBe(tokens);
		expect(computeNonMessageBreakdown(session as never).systemPromptTokens).not.toBe(breakdown.systemPromptTokens);
	});

	it("reuses wire-schema JSON for stable tool parameter identity", () => {
		const parameters = { type: "object", properties: { path: { type: "string" } } };
		const tool = { name: "read", description: "Read a file.", parameters };
		const stringifySpy = vi.spyOn(JSON, "stringify");
		estimateToolSchemaTokens([tool as never]);
		const afterFirst = stringifySpy.mock.calls.length;
		estimateToolSchemaTokens([tool as never]);
		expect(stringifySpy.mock.calls.length).toBe(afterFirst);
		stringifySpy.mockRestore();
	});
});

/**
 * Contract (BACKLOG P5): the hot compaction path (`#estimatePrePromptContextTokens`
 * and friends on AgentSession) must not re-walk the full stored-message history
 * on every call. A second estimate against the SAME `session.messages` array
 * must not re-measure messages already accounted for.
 */
describe("computeStoredMessagesTokens incremental cache", () => {
	function userMessage(text: string): AgentMessage {
		return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
	}

	function makeSession(messages: AgentMessage[]) {
		return { messages };
	}

	it("does not re-walk unchanged messages on a second estimate", () => {
		const messages = [userMessage("one"), userMessage("two"), userMessage("three")];
		const session = makeSession(messages);
		const estimateSpy = vi.spyOn(compactionModule, "estimateTokens");

		const first = computeStoredMessagesTokens(session as never);
		expect(estimateSpy).toHaveBeenCalledTimes(messages.length);

		estimateSpy.mockClear();
		const second = computeStoredMessagesTokens(session as never);

		// Only the volatile last slot is re-read; the settled prefix (indices
		// before the last message) is served from the cached running sum.
		expect(estimateSpy).toHaveBeenCalledTimes(1);
		expect(estimateSpy).toHaveBeenCalledWith(messages[messages.length - 1], undefined);
		expect(second).toBe(first);

		estimateSpy.mockRestore();
	});

	it("walks only the newly appended tail when messages grow", () => {
		const messages = [userMessage("one"), userMessage("two")];
		const session = makeSession(messages);
		computeStoredMessagesTokens(session as never);

		const estimateSpy = vi.spyOn(compactionModule, "estimateTokens");
		messages.push(userMessage("three"));
		computeStoredMessagesTokens(session as never);

		// The newly-settled second message ("two") and the new last message
		// ("three") are measured; the already-settled first message ("one")
		// is not re-measured.
		expect(estimateSpy).toHaveBeenCalledTimes(2);
		expect(estimateSpy).not.toHaveBeenCalledWith(messages[0], undefined);
		expect(estimateSpy).toHaveBeenCalledWith(messages[1], undefined);
		expect(estimateSpy).toHaveBeenCalledWith(messages[2], undefined);

		estimateSpy.mockRestore();
	});

	it("re-measures the last slot when it is replaced in place (streaming partial → final)", () => {
		const partial = userMessage("partial reply");
		const messages = [userMessage("prompt"), partial];
		const session = makeSession(messages);
		computeStoredMessagesTokens(session as never);

		const estimateSpy = vi.spyOn(compactionModule, "estimateTokens");
		// Mirrors agent-loop.ts: `context.messages[context.messages.length - 1] = finalMessage`.
		const final = userMessage("partial reply, now complete");
		messages[messages.length - 1] = final;
		const result = computeStoredMessagesTokens(session as never);

		expect(estimateSpy).toHaveBeenCalledTimes(1);
		expect(estimateSpy).toHaveBeenCalledWith(final, undefined);
		expect(estimateSpy).not.toHaveBeenCalledWith(partial, undefined);
		expect(result).toBeGreaterThan(0);

		estimateSpy.mockRestore();
	});
});
