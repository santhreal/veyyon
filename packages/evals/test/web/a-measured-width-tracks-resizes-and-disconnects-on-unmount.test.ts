/**
 * WHY:
 * Charts and comparison plots in the dashboard render in pixel space using D3 scales.
 * If useMeasuredWidth reports stale dimensions, fails to track element resizes,
 * fails to attach its ResizeObserver, or fails to disconnect the observer on unmount,
 * charts will render with clipped/distorted SVG geometry, overflow their containers,
 * or leak DOM observer subscriptions across route transitions.
 *
 * WHAT THIS DOES NOT CATCH:
 * This suite does not test browser layout reflow calculations or D3 SVG path generation.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useMeasuredWidth } from "../../dashboard/hooks/use-measured-width";

interface FakeResizeObserverEntry {
	readonly target: unknown;
	readonly contentRect: {
		readonly width: number;
		readonly height: number;
	};
}

type ResizeCallback = (entries: FakeResizeObserverEntry[], observer: MockResizeObserver) => void;

class MockResizeObserver {
	static readonly instances: MockResizeObserver[] = [];
	readonly observedElements = new Set<unknown>();
	disconnected = false;

	constructor(readonly callback: ResizeCallback) {
		MockResizeObserver.instances.push(this);
	}

	observe(target: unknown): void {
		this.observedElements.add(target);
	}

	unobserve(target: unknown): void {
		this.observedElements.delete(target);
	}

	disconnect(): void {
		this.disconnected = true;
		this.observedElements.clear();
	}

	triggerResize(target: unknown, width: number, height = 100): void {
		this.callback(
			[
				{
					target,
					contentRect: { width, height },
				},
			],
			this,
		);
	}
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
	ResizeObserver?: typeof MockResizeObserver;
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
	const origResizeObserver = g.ResizeObserver;
	const origActEnv = g.IS_REACT_ACT_ENVIRONMENT;

	MockResizeObserver.instances.length = 0;

	g.IS_REACT_ACT_ENVIRONMENT = true;
	g.window = dom.window;
	g.document = dom.document as unknown as FakeDocument;
	g.location = dom.window.location;
	g.Event = dom.window.Event;
	g.CustomEvent = dom.window.CustomEvent;
	g.HTMLElement = dom.window.HTMLElement;
	g.HTMLDivElement = dom.window.HTMLDivElement;
	g.ResizeObserver = MockResizeObserver;

	cleanupDom = () => {
		g.window = origWindow;
		g.document = origDocument;
		g.location = origLocation;
		g.Event = origEvent;
		g.CustomEvent = origCustomEvent;
		g.HTMLElement = origHTMLElement;
		g.HTMLDivElement = origHTMLDivElement;
		g.ResizeObserver = origResizeObserver;
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

describe("useMeasuredWidth tracks container resizes and cleans up observers on unmount", () => {
	it("starts with width 0 and attaches observer to the referenced DOM element", async () => {
		let measuredWidth = -1;
		function ChartContainer() {
			const [ref, width] = useMeasuredWidth();
			measuredWidth = width;
			return createElement("div", { ref, className: "chart-wrapper" });
		}

		const g = globalThis as unknown as GlobalDomEnv;
		const container = g.document?.createElement("div") as unknown as HTMLElement;
		g.document?.body.appendChild(container as unknown as FakeElement);
		const root = createRoot(container);
		activeRoots.push(root);

		await act(async () => {
			root.render(createElement(ChartContainer));
		});

		expect(measuredWidth).toBe(0);
		expect(MockResizeObserver.instances.length).toBe(1);

		const observer = MockResizeObserver.instances[0];
		expect(observer.observedElements.size).toBe(1);
		expect(observer.disconnected).toBe(false);
	});

	it("updates width when the observer reports a resize entry", async () => {
		let measuredWidth = -1;
		function ChartContainer() {
			const [ref, width] = useMeasuredWidth();
			measuredWidth = width;
			return createElement("div", { ref, className: "chart-wrapper" });
		}

		const g = globalThis as unknown as GlobalDomEnv;
		const container = g.document?.createElement("div") as unknown as HTMLElement;
		g.document?.body.appendChild(container as unknown as FakeElement);
		const root = createRoot(container);
		activeRoots.push(root);

		await act(async () => {
			root.render(createElement(ChartContainer));
		});

		const observer = MockResizeObserver.instances[0];
		const targetElement = Array.from(observer.observedElements)[0];

		// Trigger initial resize to 640px
		await act(async () => {
			observer.triggerResize(targetElement, 640);
		});
		expect(measuredWidth).toBe(640);

		// Trigger subsequent resize to 1024px
		await act(async () => {
			observer.triggerResize(targetElement, 1024);
		});
		expect(measuredWidth).toBe(1024);

		// Trigger responsive resize to 320px
		await act(async () => {
			observer.triggerResize(targetElement, 320);
		});
		expect(measuredWidth).toBe(320);
	});

	it("disconnects the ResizeObserver on component unmount", async () => {
		function ChartContainer() {
			const [ref] = useMeasuredWidth();
			return createElement("div", { ref });
		}

		const g = globalThis as unknown as GlobalDomEnv;
		const container = g.document?.createElement("div") as unknown as HTMLElement;
		g.document?.body.appendChild(container as unknown as FakeElement);
		const root = createRoot(container);
		activeRoots.push(root);

		await act(async () => {
			root.render(createElement(ChartContainer));
		});

		const observer = MockResizeObserver.instances[0];
		expect(observer.disconnected).toBe(false);

		await act(async () => {
			root.unmount();
		});
		const idx = activeRoots.indexOf(root);
		if (idx !== -1) activeRoots.splice(idx, 1);

		expect(observer.disconnected).toBe(true);
		expect(observer.observedElements.size).toBe(0);
	});

	it("does not attach an observer if the ref is never attached to a DOM node", async () => {
		let measuredWidth = -1;
		function UnattachedContainer() {
			const [, width] = useMeasuredWidth();
			measuredWidth = width;
			return null;
		}

		const g = globalThis as unknown as GlobalDomEnv;
		const container = g.document?.createElement("div") as unknown as HTMLElement;
		g.document?.body.appendChild(container as unknown as FakeElement);
		const root = createRoot(container);
		activeRoots.push(root);

		await act(async () => {
			root.render(createElement(UnattachedContainer));
		});

		expect(measuredWidth).toBe(0);
		expect(MockResizeObserver.instances.length).toBe(0);
	});
});
