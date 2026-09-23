/**
 * Regression: a guest that received `agent_start` over the wire but missed
 * the matching `agent_end` across a reconnect must close its UI state when
 * the next host `state` frame reports the session idle. Without this, the
 * per-session `time_spent` meter (`#activeStartedAt`) and the `Working…`
 * loader linger after the host has yielded, so `time_spent` ticks forever
 * and the spinner never stops.
 *
 * The `state`-frame reconciler runs inside `CollabGuestLink.#applyFrame`,
 * which is private — exercising it through the full host/relay/welcome
 * train is heavyweight. The host-idle close logic is therefore extracted
 * as {@link reconcileGuestIdleHostState}; this test drives it directly.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, type Mock, mock, vi } from "bun:test";
import {
	type CollabGuestSurface,
	createTerminalCollabGuestSurface,
	type TerminalGuestSurfaceContext,
} from "@veyyon/coding-agent/collab/guest-surface";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line";
import type { StatusDataSource } from "@veyyon/wire/presentation";
import { makeStatusLineProducer } from "../helpers/status-line-session";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
});

interface Fixture {
	surface: CollabGuestSurface;
	markActivityStart: Mock<() => void>;
	markActivityEnd: Mock<() => void>;
	loaderStop: Mock<() => void>;
	isLoaderArmed: () => boolean;
}

function makeCtx(hasLoader: boolean): Fixture {
	const markActivityStart: Mock<() => void> = mock(() => {});
	const markActivityEnd: Mock<() => void> = mock(() => {});
	const loaderStop: Mock<() => void> = mock(() => {});
	// The real one-owner clear no-ops when no loader is armed and drops the
	// reference after stopping — model both so idempotency stays observable.
	let loaderArmed = hasLoader;
	const clearWorkingLoader: Mock<() => void> = mock(() => {
		if (!loaderArmed) return;
		loaderStop();
		loaderArmed = false;
	});
	const ctx = {
		statusLine: { markActivityStart, markActivityEnd },
		clearWorkingLoader,
	} as unknown as TerminalGuestSurfaceContext;
	const surface = createTerminalCollabGuestSurface(ctx);
	return { surface, markActivityStart, markActivityEnd, loaderStop, isLoaderArmed: () => loaderArmed };
}

function makeSession(): StatusDataSource {
	return makeStatusLineProducer({ sessionName: "collab guest idle test" });
}

describe("setHostStreaming", () => {
	it("closes the active-time window and stops the loader when the host reports idle", () => {
		const { surface, markActivityEnd, loaderStop, isLoaderArmed } = makeCtx(true);
		surface.setHostStreaming(false);
		expect(markActivityEnd).toHaveBeenCalledTimes(1);
		expect(loaderStop).toHaveBeenCalledTimes(1);
		// Loader is cleared so a second reconciliation does not re-stop it.
		expect(isLoaderArmed()).toBe(false);
	});

	it("marks activity start when the host is streaming so live turns keep the meter open", () => {
		const { surface, markActivityStart, markActivityEnd, loaderStop, isLoaderArmed } = makeCtx(true);
		surface.setHostStreaming(true);
		expect(markActivityStart).toHaveBeenCalledTimes(1);
		expect(markActivityEnd).not.toHaveBeenCalled();
		expect(loaderStop).not.toHaveBeenCalled();
		expect(isLoaderArmed()).toBe(true);
	});

	it("still closes the active window when no loader is present so the meter stops independently", () => {
		// The `time_spent` leak (#3681 review follow-up) does not require a
		// live loader: a state frame can arrive after the loader is already
		// stopped while the meter is still open.
		const { surface, markActivityEnd } = makeCtx(false);
		surface.setHostStreaming(false);
		expect(markActivityEnd).toHaveBeenCalledTimes(1);
	});

	it("can run twice in a row without double-stopping the loader", () => {
		// markActivityEnd is idempotent on the StatusLineComponent side, but
		// the loader is cleared after the first close so a stale state frame
		// arriving later does not call `.stop()` on a disposed loader.
		const { surface, loaderStop } = makeCtx(true);
		surface.setHostStreaming(false);
		surface.setHostStreaming(false);
		expect(loaderStop).toHaveBeenCalledTimes(1);
	});

	it("stops the active meter when an idle welcome snapshot finalizes after reconnect", () => {
		const statusLine = new StatusLineComponent(makeSession());
		let now = 10_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		statusLine.markActivityStart();
		now += 5_000;
		expect(statusLine.getActiveMs()).toBe(5_000);

		const ctx = {
			statusLine,
			clearWorkingLoader: () => {},
		} as unknown as TerminalGuestSurfaceContext;
		const surface = createTerminalCollabGuestSurface(ctx);
		surface.setHostStreaming(false);
		const stoppedAt = statusLine.getActiveMs();
		now += 60_000;
		expect(statusLine.getActiveMs()).toBe(stoppedAt);
	});
});
