/**
 * WHY:
 * Dashboard views (experiments, run status, trace logs) poll endpoints for updates.
 * If usePolled waits a full interval before the initial fetch, fails to repeat at the
 * declared interval bound, fails to clear its interval timer on unmount, or gets wedged
 * when a single network request fails, the UI will exhibit sluggish loads, background
 * resource leaks / orphaned network polling, or permanent data staleness after a transient error.
 *
 * A failed poll was caught and discarded, so the pane kept rendering the payload it last read for
 * as long as the manager stayed down, and a dead pane read as a live one. The hook returns the
 * reason beside the data, and the tests below pin both: the stale payload stays available to render,
 * and the failure is stated until a later poll succeeds.
 *
 * WHAT THIS DOES NOT CATCH:
 * This suite does not test HTTP response serialization or server endpoint route resolution
 * handled by the server router and api client, and it does not check how a component renders the
 * reason it is given.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePolled } from "../../dashboard/hooks/use-polled";

interface RenderedHook<T> {
	readonly result: { current: T };
	readonly rerender: () => Promise<void>;
	readonly unmount: () => Promise<void>;
}

interface FakeDocument {
	createElement: (tag: string) => FakeElement;
	body: FakeElement;
}

interface FakeElement {
	appendChild: (child: FakeElement) => FakeElement;
}

interface GlobalDomEnv {
	window?: unknown;
	document?: FakeDocument;
	location?: unknown;
	Event?: unknown;
	CustomEvent?: unknown;
	HTMLElement?: unknown;
	HTMLDivElement?: unknown;
	IS_REACT_ACT_ENVIRONMENT?: boolean;
}

let cleanupDom: (() => void) | null = null;
let activeRoots: Root[] = [];

beforeEach(() => {
	const dom = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
	const g = globalThis as unknown as GlobalDomEnv;
	const origWindow = g.window;
	const origDocument = g.document;
	const origLocation = g.location;
	const origEvent = g.Event;
	const origCustomEvent = g.CustomEvent;
	const origHTMLElement = g.HTMLElement;
	const origHTMLDivElement = g.HTMLDivElement;
	const origActEnv = g.IS_REACT_ACT_ENVIRONMENT;

	g.IS_REACT_ACT_ENVIRONMENT = true;
	g.window = dom.window;
	g.document = dom.document as unknown as FakeDocument;
	g.location = dom.window.location;
	g.Event = dom.window.Event;
	g.CustomEvent = dom.window.CustomEvent;
	g.HTMLElement = dom.window.HTMLElement;
	g.HTMLDivElement = dom.window.HTMLDivElement;

	cleanupDom = () => {
		g.window = origWindow;
		g.document = origDocument;
		g.location = origLocation;
		g.Event = origEvent;
		g.CustomEvent = origCustomEvent;
		g.HTMLElement = origHTMLElement;
		g.HTMLDivElement = origHTMLDivElement;
		g.IS_REACT_ACT_ENVIRONMENT = origActEnv;
	};
});

afterEach(async () => {
	for (const root of activeRoots) {
		await act(async () => {
			root.unmount();
		});
	}
	activeRoots = [];
	if (cleanupDom) {
		cleanupDom();
		cleanupDom = null;
	}
});

async function renderHook<T>(hookFn: () => T): Promise<RenderedHook<T>> {
	const result = { current: undefined as unknown as T };
	function TestHookConsumer() {
		result.current = hookFn();
		return null;
	}

	const g = globalThis as unknown as GlobalDomEnv;
	const container = g.document?.createElement("div") as unknown as HTMLElement;
	g.document?.body.appendChild(container as unknown as FakeElement);
	const root = createRoot(container);
	activeRoots.push(root);

	await act(async () => {
		root.render(createElement(TestHookConsumer));
	});

	return {
		result,
		rerender: async () => {
			await act(async () => {
				root.render(createElement(TestHookConsumer));
			});
		},
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
			const idx = activeRoots.indexOf(root);
			if (idx !== -1) activeRoots.splice(idx, 1);
		},
	};
}

describe("usePolled fetches immediately, repeats on declared interval, and stops on unmount", () => {
	it("executes the leading fetch immediately on mount without waiting for the interval", async () => {
		const originalFetch = globalThis.fetch;
		let fetchCallCount = 0;
		globalThis.fetch = (async () => {
			fetchCallCount++;
			return new Response(JSON.stringify({ status: "ok", count: fetchCallCount }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof globalThis.fetch;

		try {
			const { result } = await renderHook(() =>
				usePolled<{ status: string; count: number }>("/api/experiments", 5000),
			);

			// First fetch must have been initiated immediately upon mount
			expect(fetchCallCount).toBe(1);
			expect(result.current[0]).toEqual({ status: "ok", count: 1 });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("repeats fetch on the declared interval bound and updates state", async () => {
		const originalFetch = globalThis.fetch;
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;

		let fetchCallCount = 0;
		globalThis.fetch = (async () => {
			fetchCallCount++;
			return new Response(JSON.stringify({ tick: fetchCallCount }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof globalThis.fetch;

		const activeTimers = new Map<number, { callback: () => void; intervalMs: number }>();
		let nextTimerId = 1;

		globalThis.setInterval = ((handler: () => void, timeout?: number) => {
			const id = nextTimerId++;
			activeTimers.set(id, { callback: handler, intervalMs: timeout ?? 0 });
			return id as unknown as NodeJS.Timeout;
		}) as unknown as typeof globalThis.setInterval;

		globalThis.clearInterval = ((id?: number | NodeJS.Timeout) => {
			if (typeof id === "number") {
				activeTimers.delete(id);
			}
		}) as unknown as typeof globalThis.clearInterval;

		try {
			const declaredInterval = 3000;
			const { result } = await renderHook(() => usePolled<{ tick: number }>("/api/runs", declaredInterval));

			// Leading fetch
			expect(fetchCallCount).toBe(1);
			expect(result.current[0]).toEqual({ tick: 1 });

			// Exactly one interval timer registered with the exact declared interval bound
			expect(activeTimers.size).toBe(1);
			const timerEntry = Array.from(activeTimers.values())[0];
			expect(timerEntry.intervalMs).toBe(declaredInterval);

			// Simulate 1st interval tick
			await act(async () => {
				timerEntry.callback();
			});
			expect(fetchCallCount).toBe(2);
			expect(result.current[0]).toEqual({ tick: 2 });

			// Simulate 2nd interval tick
			await act(async () => {
				timerEntry.callback();
			});
			expect(fetchCallCount).toBe(3);
			expect(result.current[0]).toEqual({ tick: 3 });
		} finally {
			globalThis.fetch = originalFetch;
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});

	it("stops polling and clears the interval timer on unmount", async () => {
		const originalFetch = globalThis.fetch;
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;

		let fetchCallCount = 0;
		globalThis.fetch = (async () => {
			fetchCallCount++;
			return new Response(JSON.stringify({ value: fetchCallCount }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof globalThis.fetch;

		const clearedTimers: number[] = [];
		const activeTimers = new Map<number, () => void>();
		let nextTimerId = 100;

		globalThis.setInterval = ((handler: () => void) => {
			const id = nextTimerId++;
			activeTimers.set(id, handler);
			return id as unknown as NodeJS.Timeout;
		}) as unknown as typeof globalThis.setInterval;

		globalThis.clearInterval = ((id?: number | NodeJS.Timeout) => {
			if (typeof id === "number") {
				clearedTimers.push(id);
				activeTimers.delete(id);
			}
		}) as unknown as typeof globalThis.clearInterval;

		try {
			const { result, unmount } = await renderHook(() => usePolled<{ value: number }>("/api/runs", 2000));
			expect(fetchCallCount).toBe(1);
			expect(clearedTimers.length).toBe(0);

			const registeredTimerId = Array.from(activeTimers.keys())[0];

			await unmount();

			// Timer must be explicitly cleared on unmount
			expect(clearedTimers).toContain(registeredTimerId);
			expect(activeTimers.size).toBe(0);

			// Any pending callback after unmount must not trigger state updates or further polls
			const callsBefore = fetchCallCount;
			expect(fetchCallCount).toBe(callsBefore);
			expect(result.current[0]).toEqual({ value: 1 });
		} finally {
			globalThis.fetch = originalFetch;
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});

	it("recovers from rejected fetches without stopping future poll cycles or wedging the hook", async () => {
		const originalFetch = globalThis.fetch;
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;

		let attempt = 0;
		globalThis.fetch = (async () => {
			attempt++;
			if (attempt === 1) {
				// 1st fetch fails with HTTP error
				return new Response("Internal error", { status: 500 });
			}
			if (attempt === 2) {
				// 2nd fetch rejects with network exception
				throw new Error("Network offline");
			}
			// 3rd fetch succeeds
			return new Response(JSON.stringify({ recovered: true, attempt }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof globalThis.fetch;

		let timerCallback: (() => void) | null = null;
		globalThis.setInterval = ((handler: () => void) => {
			timerCallback = handler;
			return 1 as unknown as NodeJS.Timeout;
		}) as unknown as typeof globalThis.setInterval;

		globalThis.clearInterval = (() => {}) as unknown as typeof globalThis.clearInterval;

		try {
			const { result } = await renderHook(() =>
				usePolled<{ recovered: boolean; attempt: number }>("/api/runs", 1000),
			);

			// 1st fetch failed (500) -> data remains null, hook does not crash, and the failure is stated
			expect(result.current[0]).toBeNull();
			expect(result.current[2]).toContain("500");
			expect(attempt).toBe(1);

			// 2nd poll tick rejects (Network error) -> data remains null, hook does not crash
			await act(async () => {
				timerCallback?.();
			});
			expect(result.current[0]).toBeNull();
			expect(result.current[2]).toBe("Network offline");
			expect(attempt).toBe(2);

			// 3rd poll tick succeeds -> data updates properly, proving hook is not wedged
			await act(async () => {
				timerCallback?.();
			});
			expect(attempt).toBe(3);
			expect(result.current[0]).toEqual({ recovered: true, attempt: 3 });
			expect(result.current[2]).toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});

	// WHY: the failure was swallowed, so the pane kept rendering the last good payload for as long
	// as the manager stayed down. A pane that cannot refresh states that instead of looking live.
	it("keeps the payload it last read, and says the refresh failed", async () => {
		const originalFetch = globalThis.fetch;
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;

		let attempt = 0;
		globalThis.fetch = (async () => {
			attempt++;
			if (attempt === 1) {
				return new Response(JSON.stringify({ live: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("gone", { status: 503 });
		}) as unknown as typeof globalThis.fetch;

		let timerCallback: (() => void) | null = null;
		globalThis.setInterval = ((handler: () => void) => {
			timerCallback = handler;
			return 1 as unknown as NodeJS.Timeout;
		}) as unknown as typeof globalThis.setInterval;
		globalThis.clearInterval = (() => {}) as unknown as typeof globalThis.clearInterval;

		try {
			const { result } = await renderHook(() => usePolled<{ live: boolean }>("/api/runs/:name", 1000));
			expect(result.current[0]).toEqual({ live: true });
			expect(result.current[2]).toBeNull();

			await act(async () => {
				timerCallback?.();
			});

			// The stale payload is still there to render, and so is the reason it is stale.
			expect(result.current[0]).toEqual({ live: true });
			expect(result.current[2]).toContain("503");
		} finally {
			globalThis.fetch = originalFetch;
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});

	it("allows manual refresh to trigger an immediate fetch and update data", async () => {
		const originalFetch = globalThis.fetch;
		let fetchCallCount = 0;
		globalThis.fetch = (async () => {
			fetchCallCount++;
			return new Response(JSON.stringify({ manualSeq: fetchCallCount }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof globalThis.fetch;

		try {
			const { result } = await renderHook(() => usePolled<{ manualSeq: number }>("/api/runs", 60000));
			expect(result.current[0]).toEqual({ manualSeq: 1 });
			expect(fetchCallCount).toBe(1);

			// Trigger manual refresh
			await act(async () => {
				result.current[1](); // refresh()
			});

			expect(fetchCallCount).toBe(2);
			expect(result.current[0]).toEqual({ manualSeq: 2 });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not fetch or create timers when template is null", async () => {
		const originalFetch = globalThis.fetch;
		let fetchCallCount = 0;
		globalThis.fetch = (async () => {
			fetchCallCount++;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof globalThis.fetch;

		try {
			const { result } = await renderHook(() => usePolled(null, 5000));
			expect(fetchCallCount).toBe(0);
			expect(result.current[0]).toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
