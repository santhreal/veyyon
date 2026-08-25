/**
 * Thinking block spacing: the `hasVisibleContentAfter` check that decides
 * whether a blank line follows a visible thinking block.
 *
 * Why this suite exists: the check was rewritten from `.slice(i + 1).some(...)`
 * (which allocated a temporary array per thinking block) to a direct `for` loop.
 * The contract is unchanged: a spacer appears only when another visible content
 * block (text or thinking) follows the current thinking block, and never when
 * the thinking block is the last visible element.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/components/assistant-message";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function renderLines(msg: AssistantMessage, hideThinking = false): string[] {
	const component = new AssistantMessageComponent(msg, hideThinking, undefined, []);
	return component.render(60).map(line => Bun.stripANSI(line).trimEnd());
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("thinking block spacing after visible content", () => {
	/** A thinking block followed by text gets a spacer between them. */
	it("adds a blank line between thinking and following text", () => {
		const lines = renderLines(
			message([
				{ type: "thinking", thinking: "Reasoning here." },
				{ type: "text", text: "Answer." },
			]),
		);
		const thinkingIdx = lines.findIndex(l => l.includes("Reasoning here."));
		const answerIdx = lines.findIndex(l => l.includes("Answer."));
		expect(thinkingIdx).toBeGreaterThanOrEqual(0);
		expect(answerIdx).toBeGreaterThan(thinkingIdx);
		// At least one blank line between thinking and answer.
		const between = lines.slice(thinkingIdx + 1, answerIdx);
		expect(between.some(l => l.trim() === "")).toBe(true);
	});

	/** A thinking block as the last visible block does not trail a spacer. */
	it("does not add a trailing blank line when thinking is the last block", () => {
		const lines = renderLines(message([{ type: "thinking", thinking: "Only reasoning, no answer." }]));
		const thinkingIdx = lines.findIndex(l => l.includes("Only reasoning"));
		expect(thinkingIdx).toBeGreaterThanOrEqual(0);
		// No blank lines after the thinking content.
		const after = lines.slice(thinkingIdx + 1);
		expect(after.every(l => l.trim() === "")).toBe(true);
	});

	/** Two consecutive thinking blocks: the first sees the second as visible
	 * content after, so a spacer appears between them. */
	it("adds a spacer between consecutive thinking blocks", () => {
		const lines = renderLines(
			message([
				{ type: "thinking", thinking: "First pass." },
				{ type: "thinking", thinking: "Second pass." },
				{ type: "text", text: "Done." },
			]),
		);
		const firstIdx = lines.findIndex(l => l.includes("First pass."));
		const secondIdx = lines.findIndex(l => l.includes("Second pass."));
		expect(firstIdx).toBeGreaterThanOrEqual(0);
		expect(secondIdx).toBeGreaterThan(firstIdx);
		const between = lines.slice(firstIdx + 1, secondIdx);
		expect(between.some(l => l.trim() === "")).toBe(true);
	});

	/** A thinking block followed by an empty text block (which is not visible)
	 * should NOT get a spacer — the empty text block is not visible content. */
	it("does not add a spacer when the only following text block is empty", () => {
		const lines = renderLines(
			message([
				{ type: "thinking", thinking: "Reasoning." },
				{ type: "text", text: "" },
			]),
		);
		const thinkingIdx = lines.findIndex(l => l.includes("Reasoning."));
		expect(thinkingIdx).toBeGreaterThanOrEqual(0);
		// No non-blank content after the thinking block.
		const after = lines.slice(thinkingIdx + 1);
		expect(after.every(l => l.trim() === "")).toBe(true);
	});

	/** A thinking block followed by a toolCall block: tool calls are rendered
	 * by separate ToolExecutionComponent blocks, not as assistant content, so
	 * the thinking block should NOT see them as visible content after. */
	it("does not count toolCall blocks as visible content after thinking", () => {
		const lines = renderLines(
			message([
				{ type: "thinking", thinking: "I will read the file." },
				{
					type: "toolCall",
					id: "call_1",
					name: "read",
					arguments: { path: "src/foo.ts" },
				},
			]),
		);
		const thinkingIdx = lines.findIndex(l => l.includes("I will read"));
		expect(thinkingIdx).toBeGreaterThanOrEqual(0);
		// The toolCall is not text/thinking, so no visible content after.
		// The thinking block is effectively the last visible block.
		const after = lines.slice(thinkingIdx + 1);
		expect(after.every(l => l.trim() === "" || !l.includes("read"))).toBe(true);
	});

	/** Hidden thinking does not trigger the spacing logic at all. */
	it("renders no thinking content or spacer when thinking is hidden", () => {
		const lines = renderLines(
			message([
				{ type: "thinking", thinking: "hidden trace" },
				{ type: "text", text: "Answer." },
			]),
			true,
		);
		expect(lines).not.toContain("  hidden trace");
		expect(lines).not.toContain(" Thinking");
		expect(lines.some(l => l.includes("Answer."))).toBe(true);
	});

	/** Multiple thinking blocks followed by text: each thinking block except
	 * the last should see the next thinking as visible content after. */
	it("handles three thinking blocks followed by text", () => {
		const lines = renderLines(
			message([
				{ type: "thinking", thinking: "Step one." },
				{ type: "thinking", thinking: "Step two." },
				{ type: "thinking", thinking: "Step three." },
				{ type: "text", text: "Final answer." },
			]),
		);
		expect(lines.some(l => l.includes("Step one."))).toBe(true);
		expect(lines.some(l => l.includes("Step two."))).toBe(true);
		expect(lines.some(l => l.includes("Step three."))).toBe(true);
		expect(lines.some(l => l.includes("Final answer."))).toBe(true);
		// Only one "Thinking" label for the first block.
		expect(lines.filter(l => l === "  Thinking")).toHaveLength(1);
	});
});
