/**
 * The reasoning label on visible thinking blocks.
 *
 * Why this suite exists: with thinking display enabled, a reasoning trace
 * rendered as bare italic prose with NO label, indistinguishable from the
 * answer until you read it (user defect #9, 2026-07-22 screenshots). The
 * first visible thinking block now carries a muted "Thinking" heading, the
 * same vocabulary as the hidden-thinking pulse label, so the transcript
 * separates reasoning from the answer at a glance.
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
	return component
		.render(60)
		.map(line => Bun.stripANSI(line).trimEnd())
		.filter(line => line.length > 0);
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

describe("assistant message thinking label", () => {
	/** The exact defect: reasoning must not render as unlabeled prose. The
	 * label sits directly above the first thinking line. */
	it("heads the first visible thinking block with a Thinking label", () => {
		const lines = renderLines(
			message([
				{ type: "thinking", thinking: "Let me look at the file." },
				{ type: "text", text: "Ready." },
			]),
		);
		expect(lines[0]).toBe(" Thinking");
		expect(lines[1]).toBe(" Let me look at the file.");
		expect(lines).toContain(" Ready.");
	});

	/** One label per message, not one per block — a label stutter between
	 * consecutive reasoning paragraphs would read as chrome noise. */
	it("labels only the first thinking block when several are visible", () => {
		const lines = renderLines(
			message([
				{ type: "thinking", thinking: "First pass." },
				{ type: "thinking", thinking: "Second pass." },
				{ type: "text", text: "Done." },
			]),
		);
		expect(lines.filter(line => line === " Thinking")).toHaveLength(1);
		expect(lines[0]).toBe(" Thinking");
	});

	/** Negative twin: hidden thinking renders no trace and therefore no
	 * label — a dangling "Thinking" heading over nothing is worse than none. */
	it("renders no label when the thinking block is hidden", () => {
		const lines = renderLines(
			message([
				{ type: "thinking", thinking: "hidden trace" },
				{ type: "text", text: "Answer." },
			]),
			true,
		);
		expect(lines).not.toContain(" Thinking");
		expect(lines).not.toContain(" hidden trace");
	});

	/** Negative twin: a pure text answer gains no reasoning chrome. */
	it("renders no label for a text-only answer", () => {
		const lines = renderLines(message([{ type: "text", text: "Just the answer." }]));
		expect(lines).toEqual([" Just the answer."]);
	});
});

describe("thinking label and the scrollback seam", () => {
	/** The label must not gate mid-stream native-scrollback commits: the
	 * settled-rows walk treats unknown children as unstable and stops, so an
	 * untracked label Text froze the seam at 0 and the whole stream stayed
	 * uncommitted (caught live by stream-reveal-monotonic.test.ts when the
	 * label first landed). The label is byte-stable and counts as settled. */
	it("does not freeze getTranscriptBlockSettledRows at zero", () => {
		const component = new AssistantMessageComponent(undefined, false, undefined, []);
		const thinking = Array.from({ length: 6 }, (_, i) => `Reasoning paragraph ${i} long enough to wrap.`).join(
			"\n\n",
		);
		component.updateContent(message([{ type: "thinking", thinking }]), { transient: true });
		component.render(60);
		component.updateContent(
			message([
				{ type: "thinking", thinking },
				{ type: "text", text: "The answer body streaming now." },
			]),
			{ transient: true },
		);
		component.render(60);
		expect(component.getTranscriptBlockSettledRows()).toBeGreaterThan(3);
	});
});
