import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { CountdownTimer } from "@veyyon/coding-agent/modes/components/countdown-timer";
import type { Component, TUI } from "@veyyon/tui";

describe("CountdownTimer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("expires using precise sub-second timeout instead of second rounding", () => {
		const onTick = vi.fn();
		const onExpire = vi.fn();
		new CountdownTimer(250, undefined, undefined, onTick, onExpire);

		expect(onTick).toHaveBeenCalledWith(1);
		vi.advanceTimersByTime(249);
		expect(onExpire).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(onExpire).toHaveBeenCalledTimes(1);
	});

	it("reset restarts precise timeout window", () => {
		const onExpire = vi.fn();
		const timer = new CountdownTimer(300, undefined, undefined, () => {}, onExpire);

		vi.advanceTimersByTime(200);
		timer.reset();
		vi.advanceTimersByTime(299);
		expect(onExpire).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(onExpire).toHaveBeenCalledTimes(1);
	});

	it("ticks the per-second repaint via requestComponentRender(component), not the full requestRender (BACKLOG Perf)", () => {
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const tui = { requestRender, requestComponentRender } as unknown as TUI;
		const component = { render: () => [], invalidate: () => {} } as unknown as Component;

		new CountdownTimer(
			3000,
			tui,
			component,
			() => {},
			() => {},
		);
		requestRender.mockClear();
		requestComponentRender.mockClear();

		vi.advanceTimersByTime(2000);

		expect(requestRender).not.toHaveBeenCalled();
		expect(requestComponentRender.mock.calls.length).toBeGreaterThan(0);
		for (const call of requestComponentRender.mock.calls) {
			expect(call[0]).toBe(component);
		}
	});

	it("falls back to the full requestRender when no component is supplied", () => {
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const tui = { requestRender, requestComponentRender } as unknown as TUI;

		new CountdownTimer(
			3000,
			tui,
			undefined,
			() => {},
			() => {},
		);
		requestRender.mockClear();
		requestComponentRender.mockClear();

		vi.advanceTimersByTime(2000);

		expect(requestComponentRender).not.toHaveBeenCalled();
		expect(requestRender.mock.calls.length).toBeGreaterThan(0);
	});
});
