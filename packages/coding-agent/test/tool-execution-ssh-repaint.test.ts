import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { ToolExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/tool-execution";
import { RAIL_SETTLE_FRAME_MS, RAIL_SETTLE_FRAMES } from "@veyyon/coding-agent/modes/terminal/draw/rail-motion";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { type Component, TUI } from "@veyyon/tui";
import { StressRenderScheduler } from "../../../hosts/terminal/engine/test/render-stress-scheduler";
import { VirtualTerminal } from "../../../hosts/terminal/engine/test/virtual-terminal";
import { createToolExecution } from "./helpers/tool-execution";

function sshResult(text: string) {
	return { content: [{ type: "text", text }] };
}

class Footer implements Component {
	constructor(readonly rows: number) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return Array.from({ length: this.rows }, (_, i) => `editor-${i}`);
	}
}

function plainBuffer(term: VirtualTerminal): string[] {
	return term
		.getScrollBuffer()
		.map(row => Bun.stripANSI(row).trimEnd())
		.filter(Boolean);
}

async function drain(scheduler: StressRenderScheduler, term: VirtualTerminal): Promise<void> {
	await scheduler.drain(term);
}

describe("ToolExecutionComponent SSH repaint seams", () => {
	const components: ToolExecutionComponent[] = [];

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		for (const component of components) component.stopAnimation();
		components.length = 0;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	function makeComponent(args: unknown) {
		const resetDisplay = vi.fn();
		const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay } as unknown as TUI;
		const component = createToolExecution("ssh", args, {}, undefined, ui);
		components.push(component);
		resetDisplay.mockClear();
		return { component, resetDisplay };
	}

	it("forces a viewport repaint when a painted streamed SSH placeholder receives its first result", () => {
		const { component, resetDisplay } = makeComponent({ __partialJson: '{"host"' });
		// A paint has to land for the placeholder to actually reach the terminal.
		component.render(80);

		component.updateResult(sshResult("partial output"), true);

		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not repaint when the streamed placeholder never reaches the terminal", () => {
		const { component, resetDisplay } = makeComponent({ __partialJson: '{"host"' });
		// The placeholder shape was built in memory but never painted — a
		// resetDisplay here would wipe scrollback for a shape the user never saw.

		component.updateResult(sshResult("partial output"), true);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("does not repaint complete SSH args on the first result", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.render(80);

		component.updateResult(sshResult("partial output"), true);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("forces a viewport repaint when a painted provisional SSH partial result settles", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(sshResult("partial output"), true);
		component.render(80);
		resetDisplay.mockClear();

		component.updateResult(sshResult("final output"), false);

		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not repaint when the provisional partial result never reaches the terminal", () => {
		const { component, resetDisplay } = makeComponent({ host: "router", command: "uptime" });
		component.updateResult(sshResult("partial output"), true);
		// No render() between the partial and the final update — the provisional
		// frame never reached the terminal, so no reset should fire.

		component.updateResult(sshResult("final output"), false);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("removes streamed SSH placeholder rows from the terminal buffer when the first result arrives", async () => {
		// Fake timers so the rail settle animation a coloured live card plays after
		// its final result can be run to its end; the stress scheduler drains
		// renders but never advances a real interval.
		vi.useFakeTimers();
		const term = new VirtualTerminal(90, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const component = createToolExecution("ssh", { __partialJson: '{"host"' }, {}, undefined, tui);
		components.push(component);
		tui.addChild(component);
		tui.addChild(new Footer(5));

		try {
			tui.start();
			await drain(scheduler, term);
			expect(plainBuffer(term).some(row => row.includes("SSH: […]"))).toBe(true);
			expect(plainBuffer(term).some(row => row.includes("$ …"))).toBe(true);

			component.updateArgs({
				host: "router",
				command: "uptime",
				__partialJson: '{"host":"router","command":"uptime"}',
			});
			component.setArgsComplete();
			tui.requestRender();
			await drain(scheduler, term);

			component.updateResult(sshResult("partial output"), true);
			tui.requestRender();
			await drain(scheduler, term);

			const rows = plainBuffer(term);
			expect(rows.some(row => row.includes("SSH: […]"))).toBe(false);
			expect(rows.some(row => row.includes("$ …"))).toBe(false);
			// The card is live and taller than the three rows above the editor, so
			// only its tail is on screen; its header is not final and stays out of
			// native scrollback until the result settles.
			expect(rows.filter(row => row.includes("SSH: [router]"))).toHaveLength(0);
			expect(rows.filter(row => row.includes("Output"))).toHaveLength(1);
			expect(rows.filter(row => row.includes("partial output"))).toHaveLength(1);

			component.updateResult(sshResult("partial output"), false);
			// A card that streamed under a coloured rail settles for RAIL_SETTLE_FRAMES
			// frames and stays in the live region until the last one. With no colour
			// (NO_COLOR) there is no rail to animate and the card is final at once.
			vi.advanceTimersByTime(RAIL_SETTLE_FRAME_MS * RAIL_SETTLE_FRAMES);
			tui.requestRender();
			await drain(scheduler, term);

			const settled = plainBuffer(term);
			expect(settled.some(row => row.includes("SSH: […]"))).toBe(false);
			expect(settled.some(row => row.includes("$ …"))).toBe(false);
			// Counted, not merely present. This is a REPAINT test: the failure it
			// exists to catch is the old rows surviving alongside the new ones, and
			// `some(...)` is true whether the header was repainted in place or drawn
			// a second time below the first. The placeholder checks above catch only
			// the case where the stale text differs; a header that repainted itself
			// verbatim twice was invisible to every assertion here.
			expect(settled.filter(row => row.includes("SSH: [router]"))).toHaveLength(1);
			expect(settled.filter(row => row.includes("Output"))).toHaveLength(1);
			expect(settled.filter(row => row.includes("partial output"))).toHaveLength(1);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("removes provisional SSH partial chrome from the terminal buffer when the result settles", async () => {
		vi.useFakeTimers();
		const term = new VirtualTerminal(90, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const component = createToolExecution("ssh", { host: "router", command: "uptime" }, {}, undefined, tui);
		components.push(component);
		tui.addChild(component);
		tui.addChild(new Footer(5));

		try {
			tui.start();
			await drain(scheduler, term);
			component.updateResult(sshResult("partial output"), true);
			tui.requestRender();
			await drain(scheduler, term);
			const partialRows = plainBuffer(term);
			// Counted for the same reason as above: a duplicated repaint is the bug.
			// The live card's header sits above the window and is not final yet, so
			// it is in neither the window nor native scrollback.
			expect(partialRows.filter(row => row.includes("SSH: [router]"))).toHaveLength(0);
			expect(partialRows.filter(row => row.includes("partial output"))).toHaveLength(1);

			component.updateResult(sshResult("final output"), false);
			vi.advanceTimersByTime(RAIL_SETTLE_FRAME_MS * RAIL_SETTLE_FRAMES);
			tui.requestRender();
			await drain(scheduler, term);

			const rows = plainBuffer(term);
			expect(rows.some(row => row.includes("partial output"))).toBe(false);
			expect(rows.filter(row => row.includes("SSH: [router]"))).toHaveLength(1);
			expect(rows.some(row => row.includes("Output"))).toBe(true);
			expect(rows.some(row => row.includes("final output"))).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});
