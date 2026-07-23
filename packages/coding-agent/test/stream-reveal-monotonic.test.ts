/**
 * Stream reveal monotonicity (SCROLLBACK-DUP) — a streaming assistant block's
 * visible text must only ever GROW within one block, regardless of which
 * pacing governor owns the reveal.
 *
 * The bug this suite locks out (found live 2026-07-22, reproduced by
 * streaming-output-scrollback.test.ts): on the first delta after a content
 * rebuild (e.g. the answer text block appearing next to the thinking block),
 * the reveal pacer restarted at ZERO for a Markdown child that already
 * displayed hundreds of characters. The child was set back to a near-empty
 * slice, its rows collapsed (a 31-row block momentarily rendered 18 or even
 * 0 rows), the transcript's committed native-scrollback prefix diverged, and
 * with `tui.scrollbackRebuild` off (the default) the re-anchor appended a
 * SECOND copy of the block into terminal history — the duplicated thinking
 * paragraphs visible in real tmux scrollback.
 *
 * These tests are deliberately mechanism-agnostic: they drive the public
 * AssistantMessageComponent/TranscriptContainer surface only, so they hold
 * whether pacing lives in a component-local governor or in the
 * StreamingRevealController. Whatever owns the reveal, a takeover of a child
 * with visible text must never shrink it.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/components/assistant-message";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/components/transcript-container";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			reasoningTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function streamingPrefixes(text: string, step: number): string[] {
	const out: string[] = [];
	for (let end = Math.min(step, text.length); end < text.length; end += step) out.push(text.slice(0, end));
	out.push(text);
	return out;
}

const THINKING = Array.from(
	{ length: 6 },
	(_, i) => `Thinking paragraph ${i} streaming with plenty of words to wrap here.`,
).join("\n\n");
const TEXT = Array.from(
	{ length: 10 },
	(_, i) => `Answer paragraph ${i} with enough content to occupy a full row or two.`,
).join("\n\n");

describe("assistant streaming render monotonicity", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("never shrinks the rendered block across transient streaming updates", () => {
		// Walks the real streaming shape from the live bug: thinking-only
		// prefixes, then thinking+text prefixes (the shape change forces a
		// rebuild; the NEXT delta is the takeover that used to collapse rows).
		const assistant = new AssistantMessageComponent(undefined, false);
		const width = 60;
		let lastRows = 0;
		const feed = (content: AssistantMessage["content"]) => {
			assistant.updateContent(makeAssistantMessage(content), { transient: true });
			const rows = assistant.render(width).length;
			expect(rows).toBeGreaterThanOrEqual(lastRows);
			lastRows = rows;
		};
		for (const p of streamingPrefixes(THINKING, 300)) feed([{ type: "thinking", thinking: p }]);
		for (const p of streamingPrefixes(TEXT, 300)) {
			feed([
				{ type: "thinking", thinking: THINKING },
				{ type: "text", text: p },
			]);
		}
		// The full stream really did produce the whole block, not a paced tail:
		// 6 thinking + 10 answer paragraphs at width 60 span well over 20 rows.
		expect(lastRows).toBeGreaterThan(20);
	});

	it("keeps every settled transcript row byte-stable once declared final", () => {
		// The transcript commits rows below getNativeScrollbackLiveRegionStart()
		// to native scrollback as FINAL. If any such row later changes (or the
		// seam retreats past it and its content re-lays out), the TUI re-anchors
		// and — with scrollbackRebuild off, the default — appends a duplicate
		// copy into terminal history. Pre-fix the seam retreated from row 30 to
		// row 17 on the takeover delta.
		const transcript = new TranscriptContainer();
		const assistant = new AssistantMessageComponent(undefined, false);
		transcript.addChild(assistant);
		const width = 60;

		let committed: string[] = [];
		const feed = (content: AssistantMessage["content"], transient: boolean) => {
			assistant.updateContent(makeAssistantMessage(content), { transient });
			const lines = transcript.render(width);
			const seam = transcript.getNativeScrollbackLiveRegionStart() ?? lines.length;
			// The final prefix never retreats...
			expect(seam).toBeGreaterThanOrEqual(committed.length);
			// ...and rows already declared final keep their exact bytes.
			for (let i = 0; i < committed.length; i++) {
				expect(Bun.stripANSI(lines[i] ?? "")).toBe(Bun.stripANSI(committed[i] ?? ""));
			}
			committed = lines.slice(0, seam);
		};

		for (const p of streamingPrefixes(THINKING, 300)) feed([{ type: "thinking", thinking: p }], true);
		for (const p of streamingPrefixes(TEXT, 300)) {
			feed(
				[
					{ type: "thinking", thinking: THINKING },
					{ type: "text", text: p },
				],
				true,
			);
		}
		expect(committed.length).toBeGreaterThan(20);

		// Finalize: the seam contract ends here (the final render is audited by
		// the TUI's newly-final hard scan instead), but the rows the stream
		// already declared final must still be exactly what the finalized block
		// renders — a mismatch is precisely what sprays a duplicate copy.
		assistant.updateContent(
			makeAssistantMessage([
				{ type: "thinking", thinking: THINKING },
				{ type: "text", text: TEXT },
			]),
			{ transient: false },
		);
		assistant.markTranscriptBlockFinalized();
		const finalLines = transcript.render(width);
		for (let i = 0; i < committed.length; i++) {
			expect(Bun.stripANSI(finalLines[i] ?? "")).toBe(Bun.stripANSI(committed[i] ?? ""));
		}
	});
});
