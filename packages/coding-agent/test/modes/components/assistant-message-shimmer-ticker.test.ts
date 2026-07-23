import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/components/assistant-message";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { TERMINAL } from "@veyyon/tui";

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

function msg(content: AssistantMessage["content"]): AssistantMessage {
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
		timestamp: 0,
	};
}

/** trueColor is compile-time readonly on TerminalInfo but a plain runtime field;
 *  the sanctioned test path mutates it directly. We force it on because the
 *  shimmer (and its ticker) is a truecolor-only effect and CI terminals vary. */
const trueColorHandle = TERMINAL as unknown as { trueColor: boolean };
const originalTrueColor = trueColorHandle.trueColor;

/** One animation frame plus slack, so a ~33ms (30fps) ticker fires at least once. */
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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
		await sleep(120); // ~3-4 frames at 30fps
		const ticked = scopedCalls - scopedBefore;

		// The ticker fired repeatedly, and every one of those repaints was scoped.
		expect(ticked).toBeGreaterThanOrEqual(2);
		expect(fullTreeCalls).toBe(0);

		component.dispose();
	});

	it("stops ticking the instant the block is finalized (no repaints after seal)", async () => {
		let scopedCalls = 0;
		const component = new AssistantMessageComponent(undefined, false, undefined, [], undefined, true, () => {
			scopedCalls++;
		});

		component.updateContent(msg([{ type: "text", text: "streaming answer" }]), { transient: true });
		await sleep(80);
		expect(scopedCalls).toBeGreaterThanOrEqual(1);

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
		await sleep(60);
		expect(scopedCalls).toBeGreaterThanOrEqual(1);

		component.dispose();
		const afterDispose = scopedCalls;
		await sleep(120);

		expect(scopedCalls).toBe(afterDispose);
	});
});
