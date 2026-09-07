import type { Component } from "@veyyon/tui";
import type { ArgotSession } from "argot";
import {
	clampSliceEnd,
	createStringExtractor,
	displayArgsForPrefix,
	initialDisplayArgs,
	resetDisplayState,
	type StreamingJsonStringExtractor,
	sameStringKeys,
} from "../../../tools/core/streamed-tool-args";
import { nextStep, STREAMING_REVEAL_FRAME_MS } from "./streaming-reveal";

/** Minimal component surface the reveal pushes frames into. */
type ToolArgsRevealComponent = Component & {
	updateArgs(args: unknown, toolCallId?: string): void;
};

type ToolArgsRevealControllerOptions = {
	getSmoothStreaming(): boolean;
	/** Called after each reveal tick with the component whose subtree changed;
	 *  callers scope the render to that subtree instead of forcing a full-tree
	 *  walk at 30fps (issue #4377). */
	requestRender(component: Component): void;
};

type RevealEntry = {
	component: ToolArgsRevealComponent | undefined;
	/** Latest raw streamed argument text (JSON for function tools, raw text for custom tools). */
	target: string;
	/** Revealed UTF-16 code units of `target`. */
	revealed: number;
	/** Custom-tool raw input: display args are `{ input: prefix }`, never parsed as JSON. */
	rawInput: boolean;
	/** Whether the renderer observes fresh raw JSON prefixes directly. */
	exposeRawPartialJson: boolean;
	/** Last parsed JSON args from the revealed prefix. */
	parsedArgs: Record<string, unknown>;
	/** Prefix length covered by `parsedArgs`. */
	parsedLen: number;
	/** Last object handed to a component; reused when visible args have not changed. */
	displayArgs: Record<string, unknown>;
	/** Raw prefix carried by `displayArgs.__partialJson`. */
	displayPrefix: string;
	/** JSON string fields decoded incrementally between full JSON parses. */
	streamingStringKeys: readonly string[];
	stringExtractor: StreamingJsonStringExtractor | undefined;
	/** The session's argot codec, when one is armed. See {@link StreamedToolArgsSource.argot}. */
	argot: ArgotSession | undefined;
};

export type ToolArgsRevealTarget = {
	rawInput: boolean;
	exposeRawPartialJson: boolean;
	streamingStringKeys?: readonly string[];
	/** The session's argot codec, when one is armed. See {@link StreamedToolArgsSource.argot}. */
	argot?: ArgotSession;
};

/**
 * Paces streamed tool-call arguments the same way StreamingRevealController
 * paces assistant text: providers that deliver `partialJson` in large batches
 * (or throttle their partial parses) would otherwise make write/edit/bash
 * streaming previews jump in chunks. Each pending tool call reveals its raw
 * argument stream at the shared 30fps cadence with the same adaptive
 * catch-up step. JSON prefixes are parsed only when enough new bytes arrive to
 * change renderer-visible fields, while raw-prefix consumers still receive
 * fresh `__partialJson` on every reveal frame.
 *
 * Reveal units are UTF-16 code units of the raw stream, not graphemes —
 * the prefix goes through a JSON parser rather than straight to the screen,
 * so only surrogate-pair integrity matters (see {@link clampSliceEnd}).
 */
export class ToolArgsRevealController {
	readonly #getSmoothStreaming: () => boolean;
	readonly #requestRender: (component: Component) => void;
	readonly #entries = new Map<string, RevealEntry>();
	#timer: NodeJS.Timeout | undefined;

	constructor(options: ToolArgsRevealControllerOptions) {
		this.#getSmoothStreaming = options.getSmoothStreaming;
		this.#requestRender = options.requestRender;
	}

	/**
	 * Record the latest streamed argument text for a tool call and return the
	 * args to render right now. With smoothing disabled nothing is paced — the
	 * full received buffer decodes in one step — but the entry still runs the
	 * incremental string decoder + parse throttle, so streamed text fields
	 * (write `content`, edit bodies, eval `code`) stay fresh between the
	 * provider's own throttled full-JSON parses instead of lagging up to
	 * STREAMING_JSON_PARSE_MIN_GROWTH bytes behind.
	 */
	setTarget(id: string, partialJson: string, target: ToolArgsRevealTarget): Record<string, unknown> {
		const { rawInput, exposeRawPartialJson, streamingStringKeys, argot } = target;
		let entry = this.#entries.get(id);
		if (!entry) {
			entry = {
				component: undefined,
				target: partialJson,
				revealed: clampSliceEnd(partialJson, partialJson.length),
				rawInput,
				exposeRawPartialJson,
				parsedArgs: {},
				parsedLen: 0,
				displayArgs: initialDisplayArgs(),
				displayPrefix: "",
				streamingStringKeys: streamingStringKeys ?? [],
				stringExtractor: createStringExtractor(streamingStringKeys),
				argot,
			};
			this.#entries.set(id, entry);
		} else {
			if (
				entry.rawInput !== rawInput ||
				entry.exposeRawPartialJson !== exposeRawPartialJson ||
				!sameStringKeys(entry.streamingStringKeys, streamingStringKeys)
			) {
				entry.rawInput = rawInput;
				entry.exposeRawPartialJson = exposeRawPartialJson;
				resetDisplayState(entry);
				entry.streamingStringKeys = streamingStringKeys ?? [];
				entry.stringExtractor = createStringExtractor(streamingStringKeys);
			}
			// The codec is armed once per session but the entry outlives a settings
			// change, so it is refreshed rather than captured at creation.
			entry.argot = argot;
			// Streams only append; a non-prefix target means a rewind — snap into range.
			if (!partialJson.startsWith(entry.target)) {
				entry.revealed = Math.min(entry.revealed, partialJson.length);
				resetDisplayState(entry);
			}
			entry.target = partialJson;
		}
		// Toggle may flip mid-call: snap the reveal to everything received so
		// pacing stops (and never restarts while the toggle stays off).
		if (!this.#getSmoothStreaming()) entry.revealed = entry.target.length;
		entry.revealed = clampSliceEnd(entry.target, entry.revealed);
		this.#syncTimer();
		return displayArgsForPrefix(entry, entry.target.slice(0, entry.revealed)).args;
	}

	/** Attach the component future ticks push frames into. */
	bind(id: string, component: ToolArgsRevealComponent): void {
		const entry = this.#entries.get(id);
		if (entry) entry.component = component;
	}

	/** Final arguments arrived (the JSON closed): drop the reveal so the
	 *  caller's final-args render wins immediately, mirroring how assistant
	 *  text snaps to the full message at message_end. */
	finish(id: string): void {
		this.#entries.delete(id);
		if (this.#entries.size === 0) this.#stopTimer();
	}

	/** Snap every live entry to its full received stream and clear. Used at
	 *  message_end (abort/error mid-stream) so sealed components freeze showing
	 *  everything that arrived rather than a mid-reveal prefix. */
	flushAll(): void {
		for (const [id, entry] of this.#entries) {
			if (entry.component && entry.revealed < entry.target.length) {
				entry.component.updateArgs(displayArgsForPrefix(entry, entry.target, true).args, id);
			}
		}
		this.#entries.clear();
		this.#stopTimer();
	}

	/** Clear without pushing (teardown). */
	stop(): void {
		this.#entries.clear();
		this.#stopTimer();
	}

	#syncTimer(): void {
		for (const entry of this.#entries.values()) {
			if (entry.revealed < entry.target.length) {
				this.#startTimer();
				return;
			}
		}
		this.#stopTimer();
	}

	#startTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			this.#tick();
		}, STREAMING_REVEAL_FRAME_MS);
		this.#timer.unref?.();
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#tick(): void {
		let advanced = false;
		// Collect components with changed display args; render each subtree once
		// per tick even when multiple entries share a component (they don't
		// today, but the API contract doesn't prevent it).
		const rendered = new Set<ToolArgsRevealComponent>();
		for (const [id, entry] of this.#entries) {
			const backlog = entry.target.length - entry.revealed;
			if (backlog <= 0 || !entry.component) continue;
			entry.revealed = clampSliceEnd(entry.target, entry.revealed + nextStep(backlog));
			const display = displayArgsForPrefix(entry, entry.target.slice(0, entry.revealed));
			if (display.changed) {
				entry.component.updateArgs(display.args, id);
				rendered.add(entry.component);
			}
			advanced = true;
		}
		if (advanced) {
			for (const component of rendered) this.#requestRender(component);
		} else {
			// Every entry caught up (or unbound); setTarget restarts on growth.
			this.#stopTimer();
		}
	}
}
