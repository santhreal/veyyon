// WHY: prose-only thinking display elides fenced code, and it used to elide it
// into the previous sentence as a bare "...". A reasoning trace that opens a
// fence and then emits a document for minutes therefore rendered as a sentence
// that simply stops -- "Acceptance criteria:" then "1..." and nothing more for
// the rest of the turn -- which reads as an answer that was truncated or killed
// rather than reasoning that is still arriving. Worse, a fence the model never
// closes (still streaming, or nested fences of equal length that flip the
// parity) hides every line after it permanently, with nothing on screen saying
// so.
//
// The class this closes: an elision that is indistinguishable from a
// truncation. Every elided fence now names the number of lines it hid, for
// every fence spelling the formatter accepts, and the count grows on each
// streamed line so the block visibly keeps moving.
//
// What it does NOT catch: it does not recover the hidden lines. A fence whose
// closing marker is ambiguous (an inner ``` inside an outer ```md) is ambiguous
// in the model's text too, and prose-only mode is a display preference -- the
// marker is what makes the hidden content discoverable, and turning the
// preference off is what reveals it.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/components/assistant-message";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import {
	formatThinkingForDisplay,
	hasDisplayableThinking,
	messageHasDisplayableThinking,
} from "@veyyon/coding-agent/utils/thinking-display";

/**
 * Every fence spelling the formatter treats as a code fence: both delimiter
 * characters, every delimiter length it accepts, with and without an info
 * string. Generated rather than listed, so each test sweeps the whole space
 * instead of the one spelling someone had in mind.
 */
const FENCE_VARIANTS: Array<{ name: string; open: string; close: string }> = [];
for (const ch of ["`", "~"]) {
	for (const len of [3, 4, 5, 6]) {
		const delimiter = ch.repeat(len);
		for (const info of ["", "md", "go"]) {
			FENCE_VARIANTS.push({
				name: `${delimiter}${info === "" ? "" : ` info=${info}`}`,
				open: `${delimiter}${info}`,
				close: delimiter,
			});
		}
	}
}

function thinkingMessage(thinking: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking }],
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
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("an elided thinking fence says how much it hid", () => {
	it("names the hidden line count for every fence spelling, and keeps the prose around it", () => {
		expect(FENCE_VARIANTS.length).toBe(24);
		const unswept: string[] = [];
		for (const variant of FENCE_VARIANTS) {
			const hidden = ["one();", "two();", "three();"];
			const text = ["Before the fence:", variant.open, ...hidden, variant.close, "After the fence."].join("\n");
			const formatted = formatThinkingForDisplay(text, true);
			if (formatted !== `Before the fence:... (${hidden.length} lines of code)\nAfter the fence.`) {
				unswept.push(`${variant.name} -> ${JSON.stringify(formatted)}`);
			}
		}
		expect(unswept).toEqual([]);
	});

	it("names what an unterminated fence is hiding instead of ending on a truncated sentence", () => {
		const unswept: string[] = [];
		for (const variant of FENCE_VARIANTS) {
			const hidden = ["# Spec", "", "body", "more body"];
			const text = ["Acceptance criteria:", "", "1.", "", variant.open, ...hidden].join("\n");
			const formatted = formatThinkingForDisplay(text, true).trim();
			if (formatted !== `Acceptance criteria:\n\n1... (${hidden.length} lines of code)`) {
				unswept.push(`${variant.name} -> ${JSON.stringify(formatted)}`);
			}
		}
		expect(unswept).toEqual([]);
	});

	it("advances on every streamed line while the fence is open", () => {
		// The freeze is the defect: with a bare ellipsis the formatted text was
		// byte-identical for every line the model emitted inside the fence, so
		// the block sat still for the whole document.
		const opening = ["Rewriting the plan.", "", "```md"];
		const frames: string[] = [];
		for (let extra = 0; extra <= 40; extra++) {
			const body = Array.from({ length: extra }, (_, i) => `spec line ${i}`);
			frames.push(formatThinkingForDisplay([...opening, ...body].join("\n"), true));
		}
		const stalled: number[] = [];
		for (let i = 1; i < frames.length; i++) {
			if (frames[i] === frames[i - 1]) stalled.push(i);
		}
		expect(stalled).toEqual([]);
		expect(frames.at(-1)?.trim()).toBe("Rewriting the plan... (40 lines of code)");
	});

	it("counts the content lines exactly, never the fence delimiters", () => {
		for (const hiddenCount of [0, 1, 2, 17]) {
			const body = Array.from({ length: hiddenCount }, (_, i) => `line ${i}`);
			const text = ["Prose.", "```", ...body, "```"].join("\n");
			const expected =
				hiddenCount === 0
					? "Prose..."
					: `Prose... (${hiddenCount} ${hiddenCount === 1 ? "line" : "lines"} of code)`;
			expect(formatThinkingForDisplay(text, true)).toBe(expected);
		}
	});

	it("sums consecutive fences onto one marker rather than stacking ellipses", () => {
		const text = ["Plan:", "```js", "a", "```", "", "```js", "b", "c", "```", "done."].join("\n");
		expect(formatThinkingForDisplay(text, true)).toBe("Plan:... (3 lines of code)\n\ndone.");
	});

	it("leaves a fence-only trailer and inline code alone", () => {
		expect(formatThinkingForDisplay("Writing bla.\n`", true)).toBe("Writing bla.\n`");
		expect(formatThinkingForDisplay("Writing bla.\n``", true)).toBe("Writing bla.\n``");
		expect(formatThinkingForDisplay("Use `readString` here", true)).toBe("Use `readString` here");
	});

	it("never touches raw mode", () => {
		const text = ["Before:", "```md", "# Spec", "body"].join("\n");
		expect(formatThinkingForDisplay(text, false)).toBe(text);
		// Raw mode short-circuits on text with no comment sentinel, so a case
		// without one proves nothing about the fence walk. This one carries a
		// sentinel, which is what a gpt-5.x reasoning summary looks like: the
		// sentinel goes, every fence line stays verbatim.
		const withSentinel = ["Before:", "<!-- -->", "```md", "# Spec", "body", "```", "After."].join("\n");
		expect(formatThinkingForDisplay(withSentinel, false)).toBe(
			["Before:", "```md", "# Spec", "body", "```", "After."].join("\n"),
		);
		expect(formatThinkingForDisplay(withSentinel, true)).toBe("Before:... (2 lines of code)\nAfter.");
	});

	it("keeps a marker-only block displayable and puts the marker on screen", () => {
		const text = "```js\nconst x = 1;\nconst y = 2;\n```";
		const formatted = formatThinkingForDisplay(text, true);
		expect(formatted).toBe("... (2 lines of code)");
		expect(hasDisplayableThinking(text, formatted)).toBe(true);
		expect(messageHasDisplayableThinking(thinkingMessage(text), true)).toBe(true);

		const component = new AssistantMessageComponent(
			thinkingMessage("Rewriting the plan.\n```md\n# Spec\nbody\nmore"),
		);
		const rendered = Bun.stripANSI(component.render(80).join("\n"));
		expect(rendered).toContain("(3 lines of code)");
	});
});
