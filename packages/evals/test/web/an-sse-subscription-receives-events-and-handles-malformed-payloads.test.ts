/**
 * WHY:
 * The live run list in the dashboard streams state changes in real time via Server-Sent Events (SSE).
 * If useRunsSse fails to connect to the declared /api/events endpoint, subscribes multiple times,
 * fails to close the EventSource connection on unmount, or crashes when a malformed event payload
 * is received, the dashboard will leak open HTTP streaming connections to the server, consume
 * unbounded background sockets, or break the entire UI runtime upon encountering corrupted SSE frames.
 *
 * WHAT THIS DOES NOT CATCH:
 * This suite does not test backend SSE keep-alive heartbeats or HTTP chunked transport buffering.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRunsSse } from "../../src/web/hooks/use-runs-sse";
import type { RunRow } from "../../src/wire";

interface FakeMessageEvent {
	readonly data: string;
}

class MockEventSource {
	static readonly instances: MockEventSource[] = [];
	onmessage: ((event: FakeMessageEvent) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	closed = false;

	constructor(readonly url: string) {
		MockEventSource.instances.push(this);
	}

	close(): void {
		this.closed = true;
	}

	emitMessage(data: string): void {
		if (this.onmessage && !this.closed) {
			this.onmessage({ data });
		}
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
	EventSource?: typeof MockEventSource;
	IS_REACT_ACT_ENVIRONMENT?: boolean;
}

function makeRunRow(overrides: Partial<RunRow> = {}): RunRow {
	return {
		schemaVersion: 1,
		suite: "deep-swe",
		backend: "in-process",
		benchmark: "harbor",
		jobName: "job-1",
		experiment: "exp-1",
		arm: "baseline",
		dataset: "tasks",
		agent: "agent-a",
		models: "deepseek-v3",
		prewalk: null,
		config: {},
		role: "baseline",
		note: "",
		label: "Baseline Run",
		status: "complete",
		pid: null,
		exitCode: 0,
		createdAt: 1000,
		finishedAt: 2000,
		nTotal: 10,
		done: 10,
		pass: 8,
		fail: 2,
		error: 0,
		running: 0,
		costUsd: null,
		tokIn: 1000,
		tokOut: 500,
		tokCache: null,
		score: 0.8,
		metrics: {},
		...overrides,
	};
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
	const origEventSource = g.EventSource;
	const origActEnv = g.IS_REACT_ACT_ENVIRONMENT;

	MockEventSource.instances.length = 0;

	g.IS_REACT_ACT_ENVIRONMENT = true;
	g.window = dom.window;
	g.document = dom.document as unknown as FakeDocument;
	g.location = dom.window.location;
	g.Event = dom.window.Event;
	g.CustomEvent = dom.window.CustomEvent;
	g.HTMLElement = dom.window.HTMLElement;
	g.HTMLDivElement = dom.window.HTMLDivElement;
	g.EventSource = MockEventSource;

	cleanupDom = () => {
		g.window = origWindow;
		g.document = origDocument;
		g.location = origLocation;
		g.Event = origEvent;
		g.CustomEvent = origCustomEvent;
		g.HTMLElement = origHTMLElement;
		g.HTMLDivElement = origHTMLDivElement;
		g.EventSource = origEventSource;
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

describe("useRunsSse connects to /api/events, applies payloads, and closes on unmount", () => {
	it("subscribes once on mount to the declared /api/events route", async () => {
		let currentRuns: RunRow[] | null = null;
		function SseConsumer() {
			currentRuns = useRunsSse();
			return null;
		}

		const g = globalThis as unknown as GlobalDomEnv;
		const container = g.document?.createElement("div") as unknown as HTMLElement;
		g.document?.body.appendChild(container as unknown as FakeElement);
		const root = createRoot(container);
		activeRoots.push(root);

		await act(async () => {
			root.render(createElement(SseConsumer));
		});

		expect(currentRuns).toBeNull();
		expect(MockEventSource.instances.length).toBe(1);

		const instance = MockEventSource.instances[0];
		expect(instance.url).toBe("/api/events");
		expect(instance.closed).toBe(false);
		expect(typeof instance.onmessage).toBe("function");
	});

	it("applies incoming valid RunRow[] event payloads to state", async () => {
		let currentRuns: RunRow[] | null = null;
		function SseConsumer() {
			currentRuns = useRunsSse();
			return null;
		}

		const g = globalThis as unknown as GlobalDomEnv;
		const container = g.document?.createElement("div") as unknown as HTMLElement;
		g.document?.body.appendChild(container as unknown as FakeElement);
		const root = createRoot(container);
		activeRoots.push(root);

		await act(async () => {
			root.render(createElement(SseConsumer));
		});

		const instance = MockEventSource.instances[0];
		const sampleRuns: RunRow[] = [
			makeRunRow({ jobName: "run-a", pass: 10 }),
			makeRunRow({ jobName: "run-b", pass: 5 }),
		];

		await act(async () => {
			instance.emitMessage(JSON.stringify(sampleRuns));
		});

		expect<RunRow[] | null>(currentRuns).toEqual(sampleRuns);
	});

	it("handles malformed JSON payloads gracefully without throwing or closing the stream", async () => {
		let currentRuns: RunRow[] | null = null;
		function SseConsumer() {
			currentRuns = useRunsSse();
			return null;
		}

		const g = globalThis as unknown as GlobalDomEnv;
		const container = g.document?.createElement("div") as unknown as HTMLElement;
		g.document?.body.appendChild(container as unknown as FakeElement);
		const root = createRoot(container);
		activeRoots.push(root);

		await act(async () => {
			root.render(createElement(SseConsumer));
		});

		const instance = MockEventSource.instances[0];
		const initialRuns: RunRow[] = [makeRunRow({ jobName: "run-init", pass: 1 })];

		// Valid message
		await act(async () => {
			instance.emitMessage(JSON.stringify(initialRuns));
		});
		expect<RunRow[] | null>(currentRuns).toEqual(initialRuns);

		// Malformed JSON message - must not throw and must not close the EventSource
		await act(async () => {
			instance.emitMessage("invalid json {not valid}");
		});
		expect(instance.closed).toBe(false);
		expect<RunRow[] | null>(currentRuns).toEqual(initialRuns); // Retains prior valid data

		// Next valid message arrives successfully
		const nextRuns: RunRow[] = [makeRunRow({ jobName: "run-recovered", pass: 9 })];
		await act(async () => {
			instance.emitMessage(JSON.stringify(nextRuns));
		});
		expect<RunRow[] | null>(currentRuns).toEqual(nextRuns);
	});

	it("closes the EventSource connection when the component unmounts", async () => {
		function SseConsumer() {
			useRunsSse();
			return null;
		}

		const g = globalThis as unknown as GlobalDomEnv;
		const container = g.document?.createElement("div") as unknown as HTMLElement;
		g.document?.body.appendChild(container as unknown as FakeElement);
		const root = createRoot(container);
		activeRoots.push(root);

		await act(async () => {
			root.render(createElement(SseConsumer));
		});

		const instance = MockEventSource.instances[0];
		expect(instance.closed).toBe(false);

		await act(async () => {
			root.unmount();
		});
		const idx = activeRoots.indexOf(root);
		if (idx !== -1) activeRoots.splice(idx, 1);

		expect(instance.closed).toBe(true);
	});
});
