/**
 * Assistant answer prose carries the theme's text color.
 *
 * WHAT THIS CLOSES. The answer's Markdown was constructed with no
 * `defaultTextStyle`, so every plain paragraph fell to the terminal's default
 * foreground and only tokens with their own role (bold, headings, code spans,
 * links) were painted. On a terminal whose default foreground is gray, an
 * answer written in sparse markup — few bold spans, no headings, the shape a
 * local or non-Anthropic model often produces — read as one unstyled gray
 * slab, while a dense-markup answer looked crisp. The thinking block beside it
 * always had a default style ({ thinkingText, italic }); the answer now has
 * one too ({ text }), so body prose is themed everywhere instead of by
 * accident of markup density.
 *
 * WHAT IT DOES NOT CATCH. Per-role colors (bold, codespan, list bullets) are
 * the markdown theme's own contract, pinned elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/components/assistant-message";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";

let previousPolicy: AnsiPolicy;

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

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	previousPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
	await initTheme();
});

afterAll(() => {
	setAnsiPolicy(previousPolicy);
});

describe("assistant answer text styling", () => {
	it("paints plain prose with the theme's text color", () => {
		const component = new AssistantMessageComponent(
			message([{ type: "text", text: "one plain sentence." }]),
			false,
			undefined,
			[],
		);
		const textFg = theme.getFgAnsi("text");
		expect(textFg.length).toBeGreaterThan(0);
		const line = component.render(60).find(l => l.includes("one plain sentence."));
		expect(line).toBeDefined();
		expect(line).toContain(textFg);
	});

	it("keeps the thinking block on the thinking color, not the answer color", () => {
		const component = new AssistantMessageComponent(
			message([
				{ type: "thinking", thinking: "reasoning trace here" },
				{ type: "text", text: "the answer" },
			]),
			false,
			undefined,
			[],
		);
		const thinkingFg = theme.getFgAnsi("thinkingText");
		const line = component.render(60).find(l => l.includes("reasoning trace here"));
		expect(line).toBeDefined();
		expect(line).toContain(thinkingFg);
	});
});
