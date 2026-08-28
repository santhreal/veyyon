import { afterEach, describe, expect, it, vi } from "bun:test";
import { VirtualTerminal } from "@veyyon/render-oracle";
import { TUI } from "@veyyon/tui";

/**
 * WHY: `TUI.start()` ends in `requestRender(true, …)`, and even that forced
 * request does not write — it composes and hands the write to
 * `RenderScheduler.scheduleImmediate`, which is `setImmediate`. Nothing is on
 * the terminal when `start()` returns.
 *
 * `coding-agent`'s launch path depends on exactly that timing. It paints the
 * launch card and then immediately evaluates the agent runtime graph, which
 * holds the event loop for roughly 200ms. It yields one `setImmediate` turn
 * between the two so the composed frame reaches the terminal first; without the
 * yield the card was ready at ~111ms and did not appear until ~310ms.
 *
 * The class this closes is "the first frame's delivery phase changed and the
 * launch path kept yielding to the wrong one". Moving `scheduleImmediate` to a
 * timer, a microtask, or a synchronous write would leave every rendering test
 * green while the card silently went back to arriving 200ms late, because no
 * other test asserts WHEN the first write lands.
 *
 * NOT COVERED: the wall-clock time to card, which is a property of the compiled
 * binary and is measured against it, not here.
 */
describe("delivery of the first frame", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not deliver the frame during start(), delivers it on the next immediate turn", async () => {
		const terminal = new VirtualTerminal(80, 24);
		// Spies the instance so the real write still runs; never `mock.module`,
		// which leaks across files.
		const write = vi.spyOn(terminal, "write");
		const tui = new TUI(terminal);
		try {
			tui.start();
			// The frame is composed but unwritten: a caller that blocks the loop
			// here (which the launch path does, importing the runtime graph)
			// leaves the terminal showing whatever preceded it for as long as it
			// blocks. Baseline rather than zero, because `start()` legitimately
			// writes its own setup sequences before the render is queued.
			const synchronous = write.mock.calls.length;

			const flushed = Promise.withResolvers<void>();
			setImmediate(flushed.resolve);
			await flushed.promise;

			// One turn is enough because the render was queued first and the
			// check phase is FIFO. If this ever needs two, the launch path's
			// single yield is no longer sufficient.
			expect(write.mock.calls.length).toBeGreaterThan(synchronous);
		} finally {
			tui.stop();
		}
	});
});
