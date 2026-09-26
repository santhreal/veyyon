import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/assistant-message";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { TERMINAL } from "@veyyon/tui";
import type { AssistantMessageView, AssistantSegment } from "@veyyon/wire/presentation";

// WHY THIS SUITE EXISTS
// ---------------------
// The streaming reveal paints an accent "liquid" sheen on the last row of the
// live turn (paintHotTail). The sheen band is positioned from wall-clock time
// (shimmerPhase), so it only visibly FLOWS if the row keeps repainting. During a
// token-burst lull the reveal controller issues no renders, which would freeze
// the phase and make the shimmer look chunky/dead — the exact "still chunked"
// complaint. The fix is a self-driven repaint ticker (#startShimmer) that runs at
// ~30fps for as long as, and only as long as, the trail is active.
//
// The bug this suite LOCKS OUT is a performance regression, not a visual one: the
// naive ticker repainted through the full-tree onImageUpdate callback, which walks
// the entire transcript every frame (issue #4377, 5-15% CPU at 30fps). The ticker
// MUST repaint through the SCOPED requestSelfRender callback (the TUI's
// requestComponentRender pre-bound to this one component) so a continuous 30fps
// flow costs one row, never the whole tree. It must also start ONLY while a
// streaming text partial is live, never after the block seals (finalize/dispose)
// and never when the newest content is a tool call (the text segment is frozen).

const W = 100;

function msg(
	content: Array<
		| { type: "text"; text: string }
		| { type: "thinking"; thinking: string }
		| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
	>,
): AssistantMessageView {
	const segments: AssistantSegment[] = [];
	for (const block of content) {
		if (block.type === "text") segments.push({ kind: "text", text: block.text });
		else if (block.type === "thinking") segments.push({ kind: "thinking", text: block.thinking, redacted: false });
		else if (block.type === "toolCall")
			segments.push({ kind: "tool-call", toolCallId: block.id, toolName: block.name, input: "{}" });
	}
	return {
		segments,
		model: "m",
		stopReason: "complete",
		timestamp: 0,
	};
}

/** trueColor is compile-time readonly on TerminalInfo but a plain runtime field;
 *  the sanctioned test path mutates it directly. We force it on because the
 *  shimmer (and its ticker) is a truecolor-only effect and CI terminals vary. */
const trueColorHandle = TERMINAL as unknown as { trueColor: boolean };
const originalTrueColor = trueColorHandle.trueColor;

/** Quiet window for the "never ticks" assertions: several ~33ms (30fps) frames. */
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Resolve once `count()` reaches `target`, failing after `deadlineMs`. The positive assertions wait
 * on the ticks themselves rather than a fixed window, so a loaded runner that delays a frame slows
 * the test instead of failing it, while a ticker that never fires still fails within the bound.
 */
async function waitForTicks(count: () => number, target: number, deadlineMs = 2_000): Promise<void> {
	const deadline = performance.now() + deadlineMs;
	while (count() < target) {
		if (performance.now() > deadline) {
			throw new Error(`ticker fired ${count()} of ${target} expected repaints within ${deadlineMs}ms`);
		}
		await sleep(10);
	}
}

beforeAll(async () => {
	await initTheme(false);
	trueColorHandle.trueColor = true;
});

afterAll(() => {
	trueColorHandle.trueColor = originalTrueColor;
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("AssistantMessageComponent streaming shimmer ticker", () => {
	it("repaints through the SCOPED callback, never the full-tree one, while streaming (issue #4377)", async () => {
		let fullTreeCalls = 0;
		let scopedCalls = 0;
		const component = new AssistantMessageComponent(
			undefined,
			false,
			() => {
				fullTreeCalls++;
			},
			[],
			undefined,
			true,
			() => {
				scopedCalls++;
			},
		);

		// A live streaming text partial: transient, newest content is text.
		component.updateContent(msg([{ type: "text", text: "streaming answer in flight" }]), { transient: true });
		// Render arms the trail; the ticker was started by updateContent.
		component.render(W);

		const scopedBefore = scopedCalls;
		await waitForTicks(() => scopedCalls - scopedBefore, 2);

		// The ticker fired repeatedly, and every one of those repaints was scoped.
		expect(scopedCalls - scopedBefore).toBeGreaterThanOrEqual(2);
		expect(fullTreeCalls).toBe(0);

		component.dispose();
	});

	it("stops ticking the instant the block is finalized (no repaints after seal)", async () => {
		let scopedCalls = 0;
		const component = new AssistantMessageComponent(undefined, false, undefined, [], undefined, true, () => {
			scopedCalls++;
		});

		component.updateContent(msg([{ type: "text", text: "streaming answer" }]), { transient: true });
		await waitForTicks(() => scopedCalls, 1);

		component.markTranscriptBlockFinalized();
		const frozenAt = scopedCalls;
		await sleep(120);

		// Sealed: the ticker is cleared, so the scoped count never grows again.
		expect(scopedCalls).toBe(frozenAt);

		component.dispose();
	});

	it("does not tick for a transient update whose newest content is a tool call", async () => {
		let scopedCalls = 0;
		const component = new AssistantMessageComponent(undefined, false, undefined, [], undefined, true, () => {
			scopedCalls++;
		});

		// The text segment is frozen once a tool call renders below it: no glow, no ticker.
		component.updateContent(
			msg([
				{ type: "text", text: "before the tool" },
				{ type: "toolCall", id: "t1", name: "read", arguments: {} },
			]),
			{ transient: true },
		);
		await sleep(100);

		expect(scopedCalls).toBe(0);

		component.dispose();
	});

	it("does not tick for a non-transient (finalized) update", async () => {
		let scopedCalls = 0;
		const component = new AssistantMessageComponent(undefined, false, undefined, [], undefined, true, () => {
			scopedCalls++;
		});

		// A persisted turn render (no transient flag) is not a live stream: no ticker.
		component.updateContent(msg([{ type: "text", text: "final answer" }]));
		await sleep(100);

		expect(scopedCalls).toBe(0);

		component.dispose();
	});

	it("clears the ticker on dispose so it cannot outlive the component", async () => {
		let scopedCalls = 0;
		const component = new AssistantMessageComponent(undefined, false, undefined, [], undefined, true, () => {
			scopedCalls++;
		});

		component.updateContent(msg([{ type: "text", text: "streaming" }]), { transient: true });
		await waitForTicks(() => scopedCalls, 1);

		component.dispose();
		const afterDispose = scopedCalls;
		await sleep(120);

		expect(scopedCalls).toBe(afterDispose);
	});
});
