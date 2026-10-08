/**
 * WHY. Titling a session with a local tiny model streams the model's download progress into the
 * transcript. A cached model fires its file-load events in a short burst and then goes silent, so a
 * row that appeared on the first event flashed a bar for a download that never happened; a row that
 * stayed after the model was ready, or that stayed subscribed, left a dead bar and a listener behind.
 *
 * THE CLASS. Every event sequence a download can produce for the row: events for another model,
 * a remote model that downloads nothing, a burst that completes inside the grace window, a burst
 * that falls silent inside it, a download still running at the window's edge and past it, both
 * terminal statuses, a second terminal event, and events after the row left. For each, the row is
 * added at most once and only for a download still running at or past the grace window, repaints
 * while shown, leaves at once when it never appeared and a done-TTL after the last terminal event
 * when it did, and holds no progress subscription once it left.
 *
 * WHAT THIS SUITE DOES NOT CATCH. Motion is off here, so a removed row whose settle keeps asking
 * for frames is not observed. Which model key the controller passes is the controller's; this
 * suite drives the row through the same entry point the controller calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import {
	showTinyTitleDownloadRow,
	TINY_TITLE_PROGRESS_DONE_TTL_MS,
	TINY_TITLE_PROGRESS_REVEAL_DELAY_MS,
} from "@veyyon/coding-agent/modes/terminal/controllers/tiny-title-download-row";
import {
	DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY,
	ONLINE_TINY_TITLE_MODEL_KEY,
	type TinyTitleLocalModelKey,
} from "@veyyon/coding-agent/tiny/models";
import { tinyTitleClient } from "@veyyon/coding-agent/tiny/title-client";
import type { TinyTitleProgressEvent } from "@veyyon/coding-agent/tiny/title-protocol";
import type { Component } from "@veyyon/tui";

const MODEL: TinyTitleLocalModelKey = DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY;
const OTHER_MODEL: TinyTitleLocalModelKey = "lfm2-350m";

type ProgressListener = (event: TinyTitleProgressEvent) => void;

interface Harness {
	/** Components currently in the transcript, in the order they were added. */
	readonly children: Component[];
	/** Every add, including one of a component already present. */
	readonly adds: Component[];
	/** Every remove, including one of a component that was never added. */
	readonly removes: Component[];
	renders: number;
	/** Live progress subscriptions. */
	readonly listeners: Set<ProgressListener>;
	/** Every listener ever subscribed, live or released. */
	readonly subscribed: ProgressListener[];
	now: number;
	show(modelKey: string): void;
	emit(event: TinyTitleProgressEvent): void;
	/** Moves the clock and every timer forward by `ms`. */
	advance(ms: number): void;
}

function progress(percent: number, modelKey: TinyTitleLocalModelKey = MODEL): TinyTitleProgressEvent {
	return { modelKey, status: "progress", progress: percent };
}

function terminal(status: "ready" | "error", modelKey: TinyTitleLocalModelKey = MODEL): TinyTitleProgressEvent {
	return { modelKey, status };
}

function harness(): Harness {
	const h: Harness = {
		children: [],
		adds: [],
		removes: [],
		renders: 0,
		listeners: new Set(),
		subscribed: [],
		now: 1_000_000,
		show(modelKey) {
			showTinyTitleDownloadRow(
				{
					chatContainer: {
						addChild: component => {
							h.adds.push(component);
							h.children.push(component);
						},
						removeChild: component => {
							h.removes.push(component);
							const at = h.children.indexOf(component);
							if (at >= 0) h.children.splice(at, 1);
						},
					},
					ui: {
						requestRender: () => {
							h.renders++;
						},
					},
				},
				modelKey,
			);
		},
		emit(event) {
			for (const listener of [...h.listeners]) listener(event);
		},
		advance(ms) {
			h.now += ms;
			vi.advanceTimersByTime(ms);
		},
	};
	vi.spyOn(tinyTitleClient, "onProgress").mockImplementation(listener => {
		h.listeners.add(listener);
		h.subscribed.push(listener);
		return () => h.listeners.delete(listener);
	});
	vi.spyOn(performance, "now").mockImplementation(() => h.now);
	return h;
}

/** A download that has been running for the whole grace window, with its row shown. */
function shownRow(): Harness {
	const h = harness();
	h.show(MODEL);
	h.emit(progress(1));
	h.advance(TINY_TITLE_PROGRESS_REVEAL_DELAY_MS);
	h.emit(progress(40));
	expect(h.children).toHaveLength(1);
	return h;
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	settings.set("display.transitions", "off");
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("a tiny-title download row appears only for a download still running past its grace window", () => {
	it("a model that is not local subscribes to nothing and shows nothing", () => {
		const h = harness();
		h.show(ONLINE_TINY_TITLE_MODEL_KEY);
		expect(h.subscribed).toEqual([]);
	});

	it("a burst that completes inside the window never shows and stops listening at once", () => {
		for (const status of ["ready", "error"] as const) {
			const h = harness();
			h.show(MODEL);
			h.emit(progress(10));
			h.advance(TINY_TITLE_PROGRESS_REVEAL_DELAY_MS - 1);
			h.emit(progress(90));
			h.emit(terminal(status));
			expect(h.adds).toEqual([]);
			expect(h.removes).toEqual([]);
			expect(h.renders).toBe(0);
			expect(h.listeners.size).toBe(0);
			vi.restoreAllMocks();
		}
	});

	it("a burst that falls silent inside the window never shows, however long the silence lasts", () => {
		const h = harness();
		h.show(MODEL);
		h.emit(progress(10));
		h.advance(TINY_TITLE_PROGRESS_REVEAL_DELAY_MS * 10);
		expect(h.adds).toEqual([]);
		expect(h.renders).toBe(0);
		expect(h.listeners.size).toBe(1);
		h.emit(terminal("ready"));
		expect(h.adds).toEqual([]);
		expect(h.listeners.size).toBe(0);
	});

	it("an event still downloading at the window's edge shows the row once and repaints", () => {
		const h = harness();
		h.show(MODEL);
		h.emit(progress(1));
		h.advance(TINY_TITLE_PROGRESS_REVEAL_DELAY_MS);
		h.emit(progress(30));
		expect(h.adds).toHaveLength(1);
		expect(h.renders).toBe(1);
		h.emit(progress(60));
		h.advance(TINY_TITLE_PROGRESS_REVEAL_DELAY_MS);
		h.emit(progress(80));
		expect(h.adds).toHaveLength(1);
		expect(h.renders).toBe(3);
	});

	it("the window opens on the row's own first event, not on another model's", () => {
		const h = harness();
		h.show(MODEL);
		h.emit(progress(1, OTHER_MODEL));
		h.advance(TINY_TITLE_PROGRESS_REVEAL_DELAY_MS);
		h.emit(progress(2, OTHER_MODEL));
		h.emit(progress(5));
		expect(h.adds).toEqual([]);
		h.advance(TINY_TITLE_PROGRESS_REVEAL_DELAY_MS - 1);
		h.emit(progress(6));
		expect(h.adds).toEqual([]);
		h.advance(1);
		h.emit(progress(7));
		expect(h.adds).toHaveLength(1);
	});

	it("another model's terminal event leaves the row in place", () => {
		const h = shownRow();
		const renders = h.renders;
		h.emit(terminal("ready", OTHER_MODEL));
		h.advance(TINY_TITLE_PROGRESS_DONE_TTL_MS * 2);
		expect(h.children).toHaveLength(1);
		expect(h.renders).toBe(renders);
		expect(h.listeners.size).toBe(1);
	});

	it("a shown row stays a done-TTL past its terminal event, then leaves and repaints", () => {
		for (const status of ["ready", "error"] as const) {
			const h = shownRow();
			h.emit(terminal(status));
			const renders = h.renders;
			h.advance(TINY_TITLE_PROGRESS_DONE_TTL_MS - 1);
			expect(h.children).toHaveLength(1);
			expect(h.removes).toEqual([]);
			h.advance(1);
			expect(h.children).toEqual([]);
			expect(h.removes).toEqual(h.adds);
			expect(h.renders).toBe(renders + 1);
			expect(h.listeners.size).toBe(0);
			vi.restoreAllMocks();
		}
	});

	it("a second terminal event restarts the done-TTL and the row leaves once", () => {
		const h = shownRow();
		h.emit(terminal("ready"));
		h.advance(TINY_TITLE_PROGRESS_DONE_TTL_MS - 1);
		h.emit(terminal("ready"));
		h.advance(TINY_TITLE_PROGRESS_DONE_TTL_MS - 1);
		expect(h.children).toHaveLength(1);
		h.advance(1);
		expect(h.children).toEqual([]);
		expect(h.removes).toHaveLength(1);
	});

	it("a row that left ignores every later event", () => {
		const h = shownRow();
		const component = h.adds[0];
		h.emit(terminal("ready"));
		h.advance(TINY_TITLE_PROGRESS_DONE_TTL_MS);
		const renders = h.renders;
		// Deliver to the listener the row held, as a late event already in flight would arrive.
		expect(h.subscribed).toHaveLength(1);
		for (const listener of h.subscribed) {
			listener(progress(10));
			listener(terminal("ready"));
		}
		h.advance(TINY_TITLE_PROGRESS_DONE_TTL_MS * 2);
		expect(h.adds).toEqual([component]);
		expect(h.removes).toEqual([component]);
		expect(h.renders).toBe(renders);
	});
});
