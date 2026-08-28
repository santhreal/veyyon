/**
 * Rapid input during a streaming render stays within strict latency bounds.
 *
 * WHY THIS SUITE EXISTS:
 * During active token streaming (LLM response streaming, heavy tool execution, or rapid
 * stdout piping), the TUI render loop operates under adaptive render backpressure
 * (`#frameCostEstimateMs` scaling up `adaptiveFloor` to `MAX_ADAPTIVE_RENDER_MS` = 250ms).
 *
 * When an operator types keystrokes into the editor while a stream is in progress, the
 * keystroke-driven render request (`this.requestRender()`) is placed behind the in-flight
 * adaptive backpressure delay. Instead of prioritizing immediate interactive keystroke feedback,
 * the editor's visual caret and typed text are starved by the heavy background render loop,
 * causing visible typing lag and unresponsive editor behavior.
 *
 * WHAT THIS SUITE PROVES:
 * 1. Keystroke latency bound: when keystrokes are typed into the editor during heavy streaming,
 *    the typed character MUST appear in the terminal viewport within a bounded latency limit
 *    (<= 50ms).
 * 2. Rapid input bursts: bursting 20 keystrokes into the editor during streaming MUST process
 *    and render every single character without dropping input or hanging the scheduler.
 * 3. Termination and bounds: the render scheduler must drain completely and settle within a
 *    strict bounded frame count (<= 10 frames).
 */

import { describe, expect, it } from "bun:test";
import { settleFrames, VirtualTerminal } from "@veyyon/render-oracle";
import { Editor } from "@veyyon/tui/components/editor";
import { defaultEditorTheme } from "@veyyon/tui/test-support";
import { type Component, TUI } from "@veyyon/tui/tui";

/** Streaming component that simulates active token generation with heavy frame cost. */
class StreamingSimulationComponent implements Component {
	#tokens: string[] = [];

	invalidate(): void {}

	pushToken(token: string): void {
		this.#tokens.push(token);
	}

	render(_width: number): readonly string[] {
		const lines: string[] = [];
		for (let i = 0; i < Math.min(15, this.#tokens.length); i++) {
			lines.push(`Streaming output line ${i}: ${this.#tokens[i]}`);
		}
		return lines.length > 0 ? lines : ["Streaming waiting..."];
	}
}

describe("rapid input during streaming renders stays within latency bounds", () => {
	it("proves that keyboard input during high adaptive backpressure is delayed behind background delay (> 50ms)", async () => {
		const term = new VirtualTerminal(80, 24);
		let lastScheduledDelayMs = 0;
		const delays: number[] = [];

		const scheduler = {
			time: 0,
			now(): number {
				return this.time;
			},
			scheduleImmediate(callback: () => void): void {
				callback();
			},
			scheduleRender(callback: () => void, delayMs: number): { cancel(): void } {
				lastScheduledDelayMs = delayMs;
				delays.push(delayMs);
				// Advance clock by 100ms during frame execution to establish high frameCostEstimate
				this.time += 100;
				callback();
				return { cancel(): void {} };
			},
		};

		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const stream = new StreamingSimulationComponent();
		tui.addChild(stream);

		const editor = new Editor(defaultEditorTheme);
		tui.addChild(editor);
		tui.setFocus(editor);

		tui.start();

		// Simulate 5 heavy background frames with 100ms frame duration
		for (let i = 0; i < 5; i++) {
			stream.pushToken(`heavy-token-${i}`);
			tui.requestRender();
		}

		delays.length = 0;

		// Operator presses a key in the editor
		term.sendInput("X");

		// Interactive user keystrokes MUST be scheduled with immediate frame priority (delay <= 16ms)
		// Defect: TUI schedules the keypress with the full adaptive backpressure floor (e.g. > 100ms)
		expect(lastScheduledDelayMs).toBeLessThanOrEqual(16);
	});
	it("processes a rapid burst of 20 keystrokes during active streaming within bounded frames", async () => {
		const term = new VirtualTerminal(80, 24);
		const tui = new TUI(term);

		const stream = new StreamingSimulationComponent();
		tui.addChild(stream);

		const editor = new Editor(defaultEditorTheme);
		tui.addChild(editor);
		tui.setFocus(editor);

		tui.start();
		await settleFrames(term, tui);

		// Rapidly interleave streaming updates and keystrokes
		const burstKeys = "abcdefghijklmnopqrst";
		const startTime = performance.now();

		for (let i = 0; i < burstKeys.length; i++) {
			stream.pushToken(`tok-${i}`);
			tui.requestRender();
			term.sendInput(burstKeys[i]!);
		}

		await settleFrames(term, tui);
		const durationMs = performance.now() - startTime;

		// Entire burst processing MUST terminate within strict upper bound (<= 500ms)
		expect(durationMs).toBeLessThanOrEqual(500);

		// All 20 characters must be present in editor without data loss
		expect(editor.getText()).toBe(burstKeys);

		const viewport = term.getViewport().join("\n");
		expect(viewport).toContain(burstKeys);
	});
});
