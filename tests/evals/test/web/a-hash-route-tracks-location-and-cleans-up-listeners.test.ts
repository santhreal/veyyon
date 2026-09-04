/**
 * WHY:
 * Dashboard navigation relies entirely on URL hash routing to switch between
 * the experiments index, experiment detail views, run detail traces, and the launch form.
 * If useHashRoute fails to read the initial hash, ignores empty hash defaults ("#/"),
 * misses hashchange events, or leaks listeners across mounts, the dashboard will either
 * render the wrong view on deep-link, stay stuck on navigation, or trigger stale updates
 * and memory leaks after components unmount.
 *
 * WHAT THIS DOES NOT CATCH:
 * This suite does not validate path parsing (e.g. query string parameters or route segments)
 * performed by downstream consumers of the raw hash string.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useHashRoute } from "../../dashboard/hooks/use-hash-route";

interface RenderedHook<T> {
	readonly result: { current: T };
	readonly unmount: () => Promise<void>;
}

interface FakeLocation {
	hash: string;
}

interface FakeWindow {
	location: FakeLocation;
	addEventListener: (type: string, listener: () => void) => void;
	removeEventListener: (type: string, listener: () => void) => void;
	dispatchEvent: (event: unknown) => boolean;
}

interface FakeDocument {
	createElement: (tag: string) => FakeElement;
	body: FakeElement;
}

interface FakeElement {
	appendChild: (child: FakeElement) => FakeElement;
}

interface GlobalDomEnv {
	window?: FakeWindow;
	document?: FakeDocument;
	location?: FakeLocation;
	Event?: unknown;
	CustomEvent?: unknown;
	HTMLElement?: unknown;
	HTMLDivElement?: unknown;
	IS_REACT_ACT_ENVIRONMENT?: boolean;
}

let cleanupDom: (() => void) | null = null;
let activeRoots: Root[] = [];
let mockLocation: FakeLocation = { hash: "" };
let domWindow: FakeWindow | null = null;
const registeredListeners = new Set<() => void>();

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

	registeredListeners.clear();
	mockLocation = { hash: "" };
	const win: FakeWindow = {
		location: mockLocation,
		addEventListener: (_type, listener) => registeredListeners.add(listener),
		removeEventListener: (_type, listener) => registeredListeners.delete(listener),
		dispatchEvent: () => {
			for (const listener of Array.from(registeredListeners)) {
				listener();
			}
			return true;
		},
	};
	domWindow = win;

	g.IS_REACT_ACT_ENVIRONMENT = true;
	g.window = win;
	g.document = dom.document as unknown as FakeDocument;
	g.location = mockLocation;
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
		domWindow = null;
		registeredListeners.clear();
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
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
			const idx = activeRoots.indexOf(root);
			if (idx !== -1) activeRoots.splice(idx, 1);
		},
	};
}

describe("useHashRoute tracks location.hash and cleans up listeners on unmount", () => {
	it("reads the default route '#/' when location.hash is empty on mount", async () => {
		mockLocation.hash = "";
		const { result } = await renderHook(() => useHashRoute());
		expect(result.current).toBe("#/");
	});

	it("reads an existing hash location on initial mount", async () => {
		mockLocation.hash = "#/experiments/exp-123";
		const { result } = await renderHook(() => useHashRoute());
		expect(result.current).toBe("#/experiments/exp-123");
	});

	it("updates state when a hashchange event is dispatched on window", async () => {
		mockLocation.hash = "#/runs";
		const { result } = await renderHook(() => useHashRoute());
		expect(result.current).toBe("#/runs");

		await act(async () => {
			mockLocation.hash = "#/experiments/exp-456";
			domWindow?.dispatchEvent(
				new (globalThis as unknown as { Event: new (t: string) => unknown }).Event("hashchange"),
			);
		});

		expect(result.current).toBe("#/experiments/exp-456");
	});

	it("falls back to '#/' when hashchange transitions to an empty hash", async () => {
		mockLocation.hash = "#/runs";
		const { result } = await renderHook(() => useHashRoute());
		expect(result.current).toBe("#/runs");

		await act(async () => {
			mockLocation.hash = "";
			domWindow?.dispatchEvent(
				new (globalThis as unknown as { Event: new (t: string) => unknown }).Event("hashchange"),
			);
		});

		expect(result.current).toBe("#/");
	});

	it("removes the hashchange event listener on unmount so subsequent events do not trigger updates", async () => {
		mockLocation.hash = "#/initial";
		const { result, unmount } = await renderHook(() => useHashRoute());
		expect(result.current).toBe("#/initial");
		expect(registeredListeners.size).toBe(1);

		await unmount();

		// Listener must be removed from window on unmount
		expect(registeredListeners.size).toBe(0);

		// Dispatching hashchange after unmount must not change the last captured state
		await act(async () => {
			mockLocation.hash = "#/after-unmount";
			domWindow?.dispatchEvent(
				new (globalThis as unknown as { Event: new (t: string) => unknown }).Event("hashchange"),
			);
		});

		expect(result.current).toBe("#/initial");
	});
});
