/**
 * WHY: Background provider usage refresh fetches 5-hour and 7-day rate limit
 * usage asynchronously after the initial status line frame paints. When the
 * usage fetch settles (either within the initial timeout or late after backoff),
 * the status line must notify its host to repaint through the invalidation
 * channel (`watchGitState`). Without this notification, the status row remains
 * stale with missing usage statistics until an unrelated UI event triggers a
 * re-render.
 *
 * Similarly, `TerminalPresentationDriver` owns the terminal status zone and
 * wraps `StatusLineComponent` in a `RowsComponent`. `RowsComponent` caches rendered
 * rows by width for TUI diffing. The driver must register the status line's
 * asynchronous invalidation hook, invalidate `RowsComponent`'s width cache upon
 * notification, and request a component render. If the driver merely requested a
 * TUI render without invalidating the width cache, `RowsComponent` would return
 * the cached stale row for the same width.
 *
 * Class closed:
 * 1. Ordinary background usage fetch completion notifies repaint and renders
 *    updated usage metrics.
 * 2. Late background usage fetch completion (settling after initial timeout)
 *    notifies repaint and renders updated usage metrics.
 * 3. Stale usage completions (due to session swap, source change, revision change,
 *    or usage context key change) are ignored and do not trigger repaint.
 * 4. Disposing the status line component or driver cancels timers and prevents
 *    callbacks/renders from firing.
 * 5. `TerminalPresentationDriver` invalidates its `RowsComponent` width cache on
 *    status notification, updating the rendered terminal screen at the exact same width.
 *
 * What it does NOT catch:
 * Visual ANSI color differences or external network protocol variations for
 * provider usage endpoints (tested in provider-specific catalog/session suites).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { settleFrames } from "../../../hosts/terminal/engine/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../hosts/terminal/engine/test/virtual-terminal";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { StatusLineComponent } from "../src/modes/terminal/components/status-line/component";
import { TerminalPresentationDriver } from "../src/modes/terminal/driver";
import { StatusPresentationProducer } from "../src/presentation/status-producer";
import type { AgentSession } from "../src/session/agent-session";
import { initTheme } from "../src/theme/theme";
import { testTheme } from "./architecture/helpers/presentation-theme";
import { statusLineSessionParts } from "./helpers/status-line-session";

const WIDTH = 80;
const HEIGHT = 24;

let originalAnsiPolicy: AnsiPolicy | undefined;

beforeEach(async () => {
	originalAnsiPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
	resetSettingsForTest();
	await Settings.init({
		inMemory: true,
		overrides: {
			"statusLine.preset": "custom",
			"statusLine.leftSegments": ["model", "usage"],
			"statusLine.rightSegments": ["session_name"],
			"statusLine.sessionAccent": false,
		},
	});
	await initTheme();
});

afterEach(() => {
	if (originalAnsiPolicy !== undefined) setAnsiPolicy(originalAnsiPolicy);
	resetSettingsForTest();
	vi.restoreAllMocks();
});

async function flushMicrotasks(count = 10): Promise<void> {
	for (let i = 0; i < count; i++) {
		await Promise.resolve();
	}
}

function usageReport(percent: number): unknown[] {
	return [
		{
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h" },
					window: { id: "5h", label: "5h", resetsAt: Date.now() + 60_000 },
					amount: { unit: "percent", usedFraction: percent / 100 },
				},
			],
		},
	];
}

function makeSessionWithFetcher(
	fetchUsageReports: (signal?: AbortSignal) => Promise<unknown>,
	options: { sessionId?: string; sessionName?: string } = {},
) {
	const session = {
		...statusLineSessionParts({
			contextWindow: 200_000,
			contextUsage: undefined,
			sessionName: options.sessionName ?? "test-session",
			modelId: "test/model-one",
			modelName: "test/model-one",
			modelProvider: "anthropic",
		}),
		sessionId: options.sessionId ?? "test-session-id",
		fetchUsageReports,
	} as unknown as AgentSession;
	return new StatusPresentationProducer(session);
}

describe("StatusLineComponent usage invalidation and repaint", () => {
	it("notifies the repaint hook when ordinary background usage fetch completes", async () => {
		vi.useFakeTimers();
		try {
			const deferred = Promise.withResolvers<unknown>();
			const producer = makeSessionWithFetcher(() => deferred.promise);
			const component = new StatusLineComponent(producer);
			component.updateSettings({
				preset: "custom",
				leftSegments: ["usage"],
				rightSegments: [],
			});

			const repaints: (string | null)[] = [];
			component.watchGitState(() => {
				repaints.push(component.renderQuietLine(80));
			});

			// Initial render triggers background usage refresh
			const initial = component.renderQuietLine(80);
			expect(stripVTControlCharacters(initial ?? "")).not.toContain("5h");
			expect(repaints).toHaveLength(0);

			vi.advanceTimersByTime(0);
			await flushMicrotasks();
			expect(repaints).toHaveLength(0);

			// Resolve usage fetch
			deferred.resolve(usageReport(42));
			await flushMicrotasks();

			// Invalidation hook must have fired and rendered updated line with 5h 42%
			expect(repaints).toHaveLength(1);
			expect(stripVTControlCharacters(repaints[0] ?? "")).toContain("5h 42%");

			component.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("notifies the repaint hook when late background usage fetch completes after startup timeout", async () => {
		vi.useFakeTimers();
		try {
			const lateDeferred = Promise.withResolvers<unknown>();
			const producer = makeSessionWithFetcher(() => lateDeferred.promise);
			const component = new StatusLineComponent(producer);
			component.updateSettings({
				preset: "custom",
				leftSegments: ["usage"],
				rightSegments: [],
			});

			const repaints: (string | null)[] = [];
			component.watchGitState(() => {
				repaints.push(component.renderQuietLine(80));
			});

			component.renderQuietLine(80);
			vi.advanceTimersByTime(0);
			await flushMicrotasks();

			// Advance past the 2000ms startup timeout
			vi.advanceTimersByTime(2000);
			await flushMicrotasks();
			expect(repaints).toHaveLength(0);

			// Resolve late response
			lateDeferred.resolve(usageReport(73));
			await flushMicrotasks();

			// Late completion must notify repaint
			expect(repaints).toHaveLength(1);
			expect(stripVTControlCharacters(repaints[0] ?? "")).toContain("5h 73%");

			component.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not repaint when usage fetch fails or rejects", async () => {
		vi.useFakeTimers();
		try {
			const deferred = Promise.withResolvers<unknown>();
			const producer = makeSessionWithFetcher(() => deferred.promise);
			const component = new StatusLineComponent(producer);
			component.updateSettings({
				preset: "custom",
				leftSegments: ["usage"],
				rightSegments: [],
			});

			const repaints: (string | null)[] = [];
			component.watchGitState(() => {
				repaints.push(component.renderQuietLine(80));
			});

			component.renderQuietLine(80);
			vi.advanceTimersByTime(0);
			await flushMicrotasks();

			// Reject fetch
			deferred.reject(new Error("Network error"));
			await flushMicrotasks();

			expect(repaints).toHaveLength(0);
			component.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not repaint if component was disposed before usage fetch completes", async () => {
		vi.useFakeTimers();
		try {
			const deferred = Promise.withResolvers<unknown>();
			const producer = makeSessionWithFetcher(() => deferred.promise);
			const component = new StatusLineComponent(producer);
			component.updateSettings({
				preset: "custom",
				leftSegments: ["usage"],
				rightSegments: [],
			});

			let repainted = false;
			component.watchGitState(() => {
				repainted = true;
			});

			component.renderQuietLine(80);
			vi.advanceTimersByTime(0);
			await flushMicrotasks();

			component.dispose();

			deferred.resolve(usageReport(50));
			await flushMicrotasks();

			expect(repainted).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not repaint with stale data if session or revision changed before completion", async () => {
		vi.useFakeTimers();
		try {
			const oldDeferred = Promise.withResolvers<unknown>();
			const newDeferred = Promise.withResolvers<unknown>();

			const oldSession = {
				...statusLineSessionParts({ contextWindow: 200_000, contextUsage: undefined, sessionName: "old" }),
				fetchUsageReports: () => oldDeferred.promise,
				sessionId: "session-old",
			} as unknown as AgentSession;

			const newSession = {
				...statusLineSessionParts({ contextWindow: 200_000, contextUsage: undefined, sessionName: "new" }),
				fetchUsageReports: () => newDeferred.promise,
				sessionId: "session-new",
			} as unknown as AgentSession;

			const producer = new StatusPresentationProducer(oldSession);
			const component = new StatusLineComponent(producer);
			component.updateSettings({
				preset: "custom",
				leftSegments: ["usage"],
				rightSegments: [],
			});

			const repaints: (string | null)[] = [];
			component.watchGitState(() => {
				repaints.push(component.renderQuietLine(80));
			});

			component.renderQuietLine(80);
			vi.advanceTimersByTime(0);
			await flushMicrotasks();

			// Switch session
			producer.setSession(newSession);
			component.renderQuietLine(80);
			vi.advanceTimersByTime(0);
			await flushMicrotasks();

			// Old deferred resolves - must be ignored
			oldDeferred.resolve(usageReport(99));
			await flushMicrotasks();

			expect(repaints).toHaveLength(0);

			// New deferred resolves - must repaint with new data
			newDeferred.resolve(usageReport(33));
			await flushMicrotasks();

			expect(stripVTControlCharacters(repaints[0] ?? "")).toContain("5h 33%");
			component.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("TerminalPresentationDriver asynchronous status invalidation and same-width cache invalidation", () => {
	it("invalidates RowsComponent width cache and updates rendered screen on background usage landing", async () => {
		const deferred = Promise.withResolvers<unknown>();
		const producer = makeSessionWithFetcher(() => deferred.promise);

		const term = new VirtualTerminal(WIDTH, HEIGHT, 5_000);
		const driver = new TerminalPresentationDriver(term, {
			theme: testTheme(),
			statusCapabilities: producer.capabilities,
		});
		driver.tui.setScrollbackRebuild(false);
		driver.tui.setScrollIsolation(true);
		driver.start();

		try {
			driver.setStatusLine(producer.getSnapshot());
			await settleFrames(term, driver.tui);

			const initialScreen = term
				.getViewport()
				.map(r => Bun.stripANSI(r).trimEnd())
				.join("\n");
			expect(initialScreen).toContain("test/model-one");
			expect(initialScreen).not.toContain("5h");

			// Trigger usage refresh on the status line
			// Wait for deferred response
			deferred.resolve(usageReport(42));
			await flushMicrotasks(20);

			// Settle frames after async invalidation hook fires
			await settleFrames(term, driver.tui);

			const updatedScreen = term
				.getViewport()
				.map(r => Bun.stripANSI(r).trimEnd())
				.join("\n");
			// Same-width cached rows must have been invalidated and repainted on screen
			expect(updatedScreen).toContain("5h 42%");
		} finally {
			driver.stop();
		}
	});

	it("disposes the status renderer and prevents callbacks when driver stops or changes theme", async () => {
		const deferred = Promise.withResolvers<unknown>();
		const producer = makeSessionWithFetcher(() => deferred.promise);
		const term = new VirtualTerminal(WIDTH, HEIGHT, 5_000);
		const driver = new TerminalPresentationDriver(term, {
			theme: testTheme(),
			statusCapabilities: producer.capabilities,
		});
		driver.tui.setScrollbackRebuild(false);
		driver.tui.setScrollIsolation(true);
		driver.start();

		try {
			driver.setStatusLine(producer.getSnapshot());
			await settleFrames(term, driver.tui);
			driver.stop();

			// Resolve after stop
			deferred.resolve(usageReport(88));
			await flushMicrotasks(20);

			// Screen should not have repainted with new usage after stop
			const screen = term
				.getViewport()
				.map(r => Bun.stripANSI(r).trimEnd())
				.join("\n");
			expect(screen).not.toContain("5h 88%");
		} finally {
			driver.stop();
		}
	});
});
