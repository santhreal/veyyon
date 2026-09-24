/**
 * The room view: every conversation in the terminal as a window, side by side
 * or all at once, and the motion between them and the screen.
 *
 * The stage is a fullscreen overlay whose frame is a function of three animated
 * numbers (see `room-geometry.ts`): `zoom` from the screen to the overview,
 * `scroll` along the side-by-side row, and `mix` between the two layouts. Every
 * gesture is one of those numbers moving:
 *
 * - Opening: the screen the operator was on pulls back into its window
 *   (`zoom` 1 → 0), its real rows cropped to the shrinking window until the
 *   window is small enough to be a card.
 * - Browsing: `scroll` glides between members on a spring, so a key pressed
 *   mid-glide carries its velocity instead of restarting; `mix` flips layouts.
 * - Entering: the chosen window pushes forward (`zoom` → 1) while the host puts
 *   that conversation on the screen under the stage and hands back its composed
 *   rows, so the last frame of the zoom is the screen the terminal shows once
 *   the stage lifts, cell for cell.
 * - Travel (the quick switch): the screen pulls back a little, the row slides
 *   to the next member, and it pushes in, with no chrome at all.
 *
 * Nothing on the stage moves unless a gesture is running or a conversation on
 * it is working: an overview of idle conversations is byte-stable.
 */

import type { Component, OverlayFocusOwner } from "@veyyon/tui";
import { matchesKey } from "@veyyon/utils/keys";
import { clamp, clamp01 } from "@veyyon/utils/math";
import { type Animation, type AnimationCurve, MOTION, type MotionClock, motionClock } from "@veyyon/utils/motion";
import { parseSgrMouse, type SgrMouseEvent } from "@veyyon/utils/mouse";
import { errorMessage } from "@veyyon/utils/type-guards";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { theme } from "../../../../theme/theme";
import { pointerMotionEnabled } from "../chrome/modal-shell";
import {
	moveGridSelection,
	placeRoomWindows,
	type RoomPlacement,
	type RoomViewport,
	roomChromeStrength,
	roomSlotAt,
} from "./room-geometry";
import type { RoomStageMember } from "./room-view-model";
import { paintRoomNewSlot, paintRoomWindow, RoomInk } from "./room-window";

/** The two arrangements of the room view; `room.view` selects the one it opens in. */
export type RoomLayout = "side-by-side" | "all-windows";

/** What the stage asks of the terminal that hosts it. */
export interface RoomStageHost {
	requestRender(): void;
	/** Terminal rows; the width arrives with each render. */
	rows(): number;
	members(): readonly RoomStageMember[];
	/**
	 * Put member `id` on the screen under the stage and return the rows it
	 * composes there. Rejects when the conversation cannot be shown, in which
	 * case the screen under the stage is unchanged.
	 */
	prepare(id: string): Promise<readonly string[] | undefined>;
	/**
	 * The stage has landed on `id` at full size. Remove it. Called at most once.
	 * `failure` is set when a quick switch could not put its target on screen
	 * and pushed back into the conversation it left: the reason to report.
	 */
	land(id: string, failure?: unknown): void;
	/** Open a conversation beside the others; resolves with its registry id. */
	create(): Promise<string>;
	/** End conversation `id` and take it out of the room; resolves with the reason when refused. */
	close(id: string): Promise<string | undefined>;
	/** Whether `data` is the key that opened the view, which closes it the same way. */
	isToggle(data: string): boolean;
}

export type RoomStageMode = { readonly kind: "overview" } | { readonly kind: "travel"; readonly targetId: string };

export interface RoomStageOptions {
	readonly originId: string;
	/** The screen the operator was looking at, when the engine could capture it. */
	readonly originScreen: readonly string[] | undefined;
	readonly layout: RoomLayout;
	readonly mode: RoomStageMode;
	/** Defaults to the product clock; a test drives its own. */
	readonly clock?: MotionClock;
	/** Defaults to truecolor with `display.transitions` on. */
	readonly motion?: boolean;
	/** Defaults to `Date.now`. */
	readonly now?: () => number;
}

type Phase = "overview" | "entering" | "travel" | "landed";

/** How far the screen pulls back during a quick switch. */
const TRAVEL_DIP = 0.86;
/** How far an entering window zooms before it waits for the conversation it is entering. */
const ENTER_HOLD = 0.72;
/** One wheel notch, in windows: a trackpad swipe sends several notches per window. */
const WHEEL_STEP = 0.34;
/** Quiet time after the last notch before the row settles on the nearest window. */
const WHEEL_SETTLE_MS = 140;
/** Spinner cadence while a conversation on the stage is working (the house spinner rate). */
const SPINNER_REPAINT_MS = 80;
/** How long a notice stays in the pager row. */
const NOTICE_MS = 4000;
/** How long a first `x` on a working conversation waits for the second. */
const CLOSE_CONFIRM_MS = 3000;
const SEPARATOR = "  ·  ";

/** Where the screen's rows dissolve into a card, by how much of the terminal's width a window spans. */
function screenMixAt(scale: number): number {
	return clamp01((scale - 0.45) / 0.35);
}

interface Layer {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly rows: readonly string[];
}

/**
 * Composite window layers onto a `width`×`height` frame, later layers on top.
 * Each row is built from the topmost layer at every column, cut with strict
 * grapheme boundaries and closed with a reset, so two windows that overlap
 * mid-transition never bleed colour into each other. Returns the rows and, per
 * row, whether any window covers it.
 */
export function compositeRoomLayers(
	layers: readonly Layer[],
	width: number,
	height: number,
): { rows: string[]; covered: boolean[] } {
	const rows: string[] = new Array(height);
	const covered: boolean[] = new Array(height).fill(false);
	const owner = new Int16Array(Math.max(0, width));
	for (let y = 0; y < height; y++) {
		owner.fill(-1);
		let any = false;
		for (let i = 0; i < layers.length; i++) {
			const layer = layers[i]!;
			if (y < layer.y || y >= layer.y + layer.rows.length) continue;
			const from = Math.max(0, layer.x);
			const to = Math.min(width, layer.x + layer.width);
			if (from >= to) continue;
			owner.fill(i, from, to);
			any = true;
		}
		covered[y] = any;
		if (!any) {
			rows[y] = "";
			continue;
		}
		let row = "";
		let col = 0;
		while (col < width) {
			const who = owner[col]!;
			let end = col + 1;
			while (end < width && owner[end] === who) end++;
			const span = end - col;
			if (who < 0) {
				row += " ".repeat(span);
			} else {
				const layer = layers[who]!;
				const source = layer.rows[y - layer.y] ?? "";
				const start = col - layer.x;
				const piece = sliceByColumn(source, start, span, true);
				const pieceWidth = visibleWidth(piece);
				// A cut through the second half of a wide glyph drops the glyph, and the
				// cell it leaves blank is at the FRONT of the piece: padding it at the
				// end instead would pull every later cell of the window one column left.
				const lead =
					pieceWidth < span && start > 0
						? Math.min(
								span - pieceWidth,
								Math.max(0, visibleWidth(sliceByColumn(source, 0, start, false)) - start),
							)
						: 0;
				row += `${" ".repeat(lead)}${piece}\x1b[0m${" ".repeat(Math.max(0, span - pieceWidth - lead))}`;
			}
			col = end;
		}
		rows[y] = row;
	}
	return { rows, covered };
}

export class RoomStage implements Component, OverlayFocusOwner {
	readonly #host: RoomStageHost;
	readonly #clock: MotionClock;
	readonly #motion: boolean;
	readonly #now: () => number;
	readonly #originId: string;
	readonly #screens = new Map<string, readonly string[]>();
	#layout: RoomLayout;
	#phase: Phase;
	#zoom: Animation;
	#scroll: Animation;
	#mix: Animation;
	/** Slot under the cursor: the highlighted window, and the one the row glides to. */
	#selected = 0;
	#entering: { readonly id: string; ready: boolean; zoomed: boolean } | undefined;
	#travel:
		| {
				readonly from: number;
				readonly to: number;
				readonly targetId: string;
				ready: boolean;
				pulled: boolean;
				sliding: boolean;
		  }
		| undefined;
	#creating = false;
	#notice: { readonly text: string; readonly tone: "error" | "info"; readonly until: number } | undefined;
	#closeArmed: { readonly id: string; readonly until: number } | undefined;
	#wheelTarget: number | undefined;
	#wheelTimer: NodeJS.Timeout | undefined;
	#spinnerTimer: NodeJS.Timeout | undefined;
	#noticeTimer: NodeJS.Timeout | undefined;
	#placements: readonly RoomPlacement[] = [];
	#width = 0;
	readonly #paintCache = new Map<number, { snapshot: unknown; key: string; rows: string[] }>();

	constructor(host: RoomStageHost, options: RoomStageOptions) {
		this.#host = host;
		this.#clock = options.clock ?? motionClock;
		this.#motion = options.motion ?? pointerMotionEnabled();
		this.#now = options.now ?? Date.now;
		this.#originId = options.originId;
		this.#layout = options.layout;
		if (options.originScreen) this.#screens.set(options.originId, options.originScreen);
		const originSlot = Math.max(0, this.#slotOf(options.originId));
		this.#selected = originSlot;
		this.#mix = this.#still(options.layout === "all-windows" ? 1 : 0);
		this.#scroll = this.#still(originSlot);
		if (options.mode.kind === "travel") {
			const to = this.#slotOf(options.mode.targetId);
			this.#phase = "travel";
			this.#travel = {
				from: originSlot,
				to: Math.max(0, to),
				targetId: options.mode.targetId,
				ready: false,
				pulled: false,
				sliding: false,
			};
			// A quick switch is always side by side: it is the row sliding, not the grid.
			this.#mix = this.#still(0);
			this.#zoom = this.#animate(MOTION.expand, 1, TRAVEL_DIP, () => {
				if (this.#travel) this.#travel.pulled = true;
				this.#advanceTravel();
			});
			this.#prepare(
				options.mode.targetId,
				rows => {
					if (!this.#travel) return;
					if (rows) this.#screens.set(this.#travel.targetId, rows);
					this.#travel.ready = true;
					this.#advanceTravel();
				},
				error => {
					if (!this.#travel) return;
					// Nothing moved under the stage: push back into the conversation the
					// switch left, from wherever the pull back got to, and land there.
					this.#travel = undefined;
					this.#zoom.cancel();
					this.#zoom = this.#animate(MOTION.expand, this.#zoom.value, 1, () => this.#land(this.#originId, error));
				},
			);
		} else {
			this.#phase = "overview";
			this.#zoom = this.#animate(MOTION.zoom, 1, 0);
		}
	}

	/** The id of the conversation the stage is entering or travelling to, if any. */
	get destination(): string | undefined {
		return this.#entering?.id ?? this.#travel?.targetId;
	}

	get layout(): RoomLayout {
		return this.#layout;
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		return component === this;
	}

	invalidate(): void {
		this.#paintCache.clear();
	}

	dispose(): void {
		this.#phase = "landed";
		clearTimeout(this.#wheelTimer);
		clearInterval(this.#spinnerTimer);
		clearTimeout(this.#noticeTimer);
		this.#wheelTimer = undefined;
		this.#spinnerTimer = undefined;
		this.#noticeTimer = undefined;
		this.#zoom.cancel();
		this.#scroll.cancel();
		this.#mix.cancel();
	}

	// ---------------------------------------------------------------- motion

	#still(value: number): Animation {
		return this.#clock.animate(MOTION.expand, { from: value, to: value });
	}

	#animate(curve: AnimationCurve, from: number, to: number, onDone?: () => void): Animation {
		// The clock may land a disabled animation synchronously, inside this call;
		// deferring the callback keeps it from running before the caller has
		// stored the animation it belongs to.
		let reported = false;
		const animation = this.#clock.animate(curve, {
			from,
			to,
			enabled: this.#motion,
			onFrame: () => this.#host.requestRender(),
			onDone: onDone
				? () => {
						reported = true;
						queueMicrotask(onDone);
					}
				: undefined,
		});
		// A value already at its target is born settled: it never registers with the clock, never
		// ticks, and never reports done, so a gesture waiting on it would wait forever.
		if (onDone && animation.done && !reported) queueMicrotask(onDone);
		return animation;
	}

	/** Glide the row to `slot`, keeping whatever velocity it has. */
	#glideTo(slot: number): void {
		if (this.#motion && !this.#scroll.done) {
			this.#scroll.retarget(slot);
			return;
		}
		this.#scroll.cancel();
		this.#scroll = this.#animate(MOTION.move, this.#scroll.value, slot);
	}

	#displayZoom(): number {
		const zoom = this.#zoom.value;
		const entering = this.#entering;
		if (entering && !entering.ready) return Math.min(zoom, ENTER_HOLD);
		return zoom;
	}

	// ---------------------------------------------------------------- members

	#members(): readonly RoomStageMember[] {
		return this.#host.members();
	}

	#slotOf(id: string): number {
		return this.#members().findIndex(member => member.id === id);
	}

	#slotCount(): number {
		return this.#members().length + (this.#phase === "travel" ? 0 : 1);
	}

	// ---------------------------------------------------------------- gestures

	#prepare(id: string, done: (rows: readonly string[] | undefined) => void, failed?: (error: unknown) => void): void {
		this.#host.prepare(id).then(
			rows => {
				if (this.#phase === "landed") return;
				done(rows);
				this.#host.requestRender();
			},
			error => {
				if (this.#phase === "landed") return;
				failed?.(error);
				this.#host.requestRender();
			},
		);
	}

	#advanceTravel(): void {
		const travel = this.#travel;
		if (!travel || this.#phase !== "travel") return;
		if (travel.pulled && travel.ready && !travel.sliding) {
			travel.sliding = true;
			this.#scroll.cancel();
			this.#scroll = this.#animate(MOTION.travel, travel.from, travel.to, () => this.#land(travel.targetId));
		}
	}

	/** Zoom into member `id`; the stage lands once the conversation is on screen under it. */
	#enter(id: string): void {
		if (this.#phase === "entering" || this.#phase === "landed" || this.#phase === "travel") return;
		const slot = this.#slotOf(id);
		if (slot < 0) return;
		this.#phase = "entering";
		const entering = { id, ready: false, zoomed: false };
		this.#entering = entering;
		this.#selected = slot;
		this.#wheelTarget = undefined;
		// The row and the zoom arrive together: a spring still gliding when the
		// zoom lands would leave a neighbour's edge on the final frame.
		this.#scroll.cancel();
		this.#scroll = this.#animate(MOTION.zoom, this.#scroll.value, slot);
		this.#zoom.cancel();
		this.#zoom = this.#animate(MOTION.zoom, this.#zoom.value, 1, () => {
			entering.zoomed = true;
			this.#finishEnter(entering);
		});
		this.#prepare(
			id,
			rows => {
				if (this.#entering !== entering) return;
				if (rows) this.#screens.set(id, rows);
				entering.ready = true;
				// The window was drawn at the hold while this conversation came on
				// screen, whatever the curve underneath reached; the zoom resumes from
				// the hold rather than jumping to where the curve got to.
				if (this.#zoom.value > ENTER_HOLD) {
					entering.zoomed = false;
					this.#zoom.cancel();
					this.#zoom = this.#animate(MOTION.expand, ENTER_HOLD, 1, () => {
						entering.zoomed = true;
						this.#finishEnter(entering);
					});
					return;
				}
				this.#finishEnter(entering);
			},
			error => {
				if (this.#entering !== entering) return;
				this.#entering = undefined;
				this.#phase = "overview";
				this.#zoom.cancel();
				this.#zoom = this.#animate(MOTION.zoom, Math.min(this.#zoom.value, ENTER_HOLD), 0);
				this.#flash(`Could not switch: ${errorMessage(error)}`, "error");
			},
		);
	}

	#finishEnter(entering: { readonly id: string; ready: boolean; zoomed: boolean }): void {
		if (this.#entering !== entering || !entering.ready || !entering.zoomed) return;
		this.#land(entering.id);
	}

	#land(id: string, failure?: unknown): void {
		if (this.#phase === "landed") return;
		this.dispose();
		this.#host.land(id, failure);
	}

	async #create(): Promise<void> {
		if (this.#creating || this.#phase !== "overview") return;
		this.#creating = true;
		const newSlot = this.#members().length;
		this.#select(newSlot);
		this.#syncSpinner();
		try {
			const id = await this.#host.create();
			this.#creating = false;
			if (this.#phase !== "overview") return;
			this.#paintCache.clear();
			this.#enter(id);
		} catch (error) {
			this.#creating = false;
			this.#flash(`Could not open a conversation: ${errorMessage(error)}`, "error");
		}
	}

	async #close(): Promise<void> {
		const member = this.#members()[this.#selected];
		if (!member) return;
		if (member.id === this.#originId) {
			this.#flash("This is the conversation on screen. Enter another one, then close this one from there.", "info");
			return;
		}
		const now = this.#now();
		const working = member.snapshot().state.kind === "working";
		const armed = this.#closeArmed;
		if (working && !(armed && armed.id === member.id && now < armed.until)) {
			this.#closeArmed = { id: member.id, until: now + CLOSE_CONFIRM_MS };
			this.#flash(`Conversation ${this.#selected + 1} is working. Press x again to stop it and close it.`, "info");
			return;
		}
		this.#closeArmed = undefined;
		const refusal = await this.#host.close(member.id);
		if (refusal) {
			this.#flash(refusal, "error");
			return;
		}
		this.#paintCache.clear();
		this.#select(Math.min(this.#selected, this.#slotCount() - 1));
	}

	#toggleLayout(): void {
		this.#layout = this.#layout === "side-by-side" ? "all-windows" : "side-by-side";
		this.#mix.cancel();
		this.#mix = this.#animate(MOTION.reflow, this.#mix.value, this.#layout === "all-windows" ? 1 : 0);
		if (this.#layout === "side-by-side") this.#glideTo(this.#selected);
	}

	#select(slot: number): void {
		const count = this.#slotCount();
		if (count === 0) return;
		const next = clamp(slot, 0, count - 1);
		if (next !== this.#selected) this.#closeArmed = undefined;
		this.#selected = next;
		this.#wheelTarget = undefined;
		this.#glideTo(next);
		this.#host.requestRender();
	}

	#flash(text: string, tone: "error" | "info"): void {
		this.#notice = { text, tone, until: this.#now() + NOTICE_MS };
		clearTimeout(this.#noticeTimer);
		this.#noticeTimer = setTimeout(() => {
			this.#noticeTimer = undefined;
			this.#host.requestRender();
		}, NOTICE_MS);
		this.#noticeTimer.unref?.();
		this.#host.requestRender();
	}

	/** Slide the row by a fraction of a window, as a trackpad does; settles on the nearest window once quiet. */
	#wheel(delta: number): void {
		const count = this.#slotCount();
		const base = this.#wheelTarget ?? this.#selected;
		const target = clamp(base + delta, 0, count - 1);
		this.#wheelTarget = target;
		this.#selected = Math.round(target);
		this.#glideTo(target);
		clearTimeout(this.#wheelTimer);
		this.#wheelTimer = setTimeout(() => {
			this.#wheelTimer = undefined;
			if (this.#wheelTarget === undefined || this.#phase !== "overview") return;
			this.#wheelTarget = undefined;
			this.#glideTo(this.#selected);
		}, WHEEL_SETTLE_MS);
		this.#wheelTimer.unref?.();
		this.#host.requestRender();
	}

	#enterSlot(slot: number): void {
		const members = this.#members();
		if (slot >= members.length) {
			void this.#create();
			return;
		}
		const member = members[slot];
		if (member) this.#enter(member.id);
	}

	#mouse(event: SgrMouseEvent): void {
		if (this.#phase !== "overview") return;
		const grid = this.#layout === "all-windows";
		if (event.hwheel !== null) {
			if (grid)
				this.#select(
					moveGridSelection(
						this.#viewport(),
						this.#slotCount(),
						this.#selected,
						event.hwheel > 0 ? "right" : "left",
					),
				);
			else this.#wheel(event.hwheel * WHEEL_STEP);
			return;
		}
		if (event.wheel !== null) {
			if (grid && !event.shift) {
				this.#select(
					moveGridSelection(this.#viewport(), this.#slotCount(), this.#selected, event.wheel > 0 ? "down" : "up"),
				);
			} else {
				this.#wheel(event.wheel * WHEEL_STEP);
			}
			return;
		}
		const slot = roomSlotAt(this.#placements, event.col, event.row);
		if (event.motion) {
			// The grid follows the pointer; the row does not, since sliding it
			// under a still pointer would move the window being pointed at.
			if (grid && slot !== undefined && slot !== this.#selected) {
				this.#selected = slot;
				this.#host.requestRender();
			}
			return;
		}
		if (event.leftClick && slot !== undefined) this.#enterSlot(slot);
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (event) this.#mouse(event);
			return;
		}
		// Keys wait while the stage is in flight: the gesture under way lands
		// first, and a key meant for the conversation must not reach the stage.
		if (this.#phase !== "overview") return;
		if (matchesKey(data, "escape") || this.#host.isToggle(data)) {
			this.#enter(this.#originId);
			return;
		}
		const grid = this.#layout === "all-windows";
		const count = this.#slotCount();
		if (matchesKey(data, "tab")) this.#toggleLayout();
		else if (matchesKey(data, "enter") || matchesKey(data, "return") || matchesKey(data, "space")) {
			this.#enterSlot(this.#selected);
		} else if (matchesKey(data, "left")) {
			this.#select(grid ? moveGridSelection(this.#viewport(), count, this.#selected, "left") : this.#selected - 1);
		} else if (matchesKey(data, "right")) {
			this.#select(grid ? moveGridSelection(this.#viewport(), count, this.#selected, "right") : this.#selected + 1);
		} else if (matchesKey(data, "up")) {
			if (grid) this.#select(moveGridSelection(this.#viewport(), count, this.#selected, "up"));
		} else if (matchesKey(data, "down")) {
			if (grid) this.#select(moveGridSelection(this.#viewport(), count, this.#selected, "down"));
		} else if (matchesKey(data, "home")) {
			this.#select(0);
		} else if (matchesKey(data, "end")) {
			this.#select(count - 1);
		} else if (matchesKey(data, "n")) {
			void this.#create();
		} else if (matchesKey(data, "x") || matchesKey(data, "delete")) {
			void this.#close();
		} else if (/^[1-9]$/.test(data)) {
			const slot = Number(data) - 1;
			if (slot < this.#members().length) this.#enterSlot(slot);
		}
		this.#host.requestRender();
	}

	// ---------------------------------------------------------------- frame

	#viewport(): RoomViewport {
		return { width: this.#width, height: this.#host.rows() };
	}

	/** Keep the spinner ticking while, and only while, a conversation on the stage is working. */
	#syncSpinner(): void {
		const live =
			this.#phase === "overview" &&
			(this.#creating || this.#members().some(member => member.snapshot().state.kind === "working"));
		if (live && !this.#spinnerTimer) {
			this.#spinnerTimer = setInterval(() => this.#host.requestRender(), SPINNER_REPAINT_MS);
			this.#spinnerTimer.unref?.();
		} else if (!live && this.#spinnerTimer) {
			clearInterval(this.#spinnerTimer);
			this.#spinnerTimer = undefined;
		}
	}

	#paintSlot(
		placement: RoomPlacement,
		members: readonly RoomStageMember[],
		viewport: RoomViewport,
		now: number,
	): string[] {
		const { rect, slot, strength, framed } = placement;
		const selected = slot === this.#selected && this.#phase !== "travel";
		if (slot >= members.length) {
			return paintRoomNewSlot({ width: rect.w, height: rect.h, strength, selected, starting: this.#creating, now });
		}
		const member = members[slot]!;
		const snapshot = member.snapshot();
		const rows = this.#screens.get(member.id);
		const screenMix = rows ? screenMixAt(rect.w / Math.max(1, viewport.width)) : 0;
		const working = snapshot.state.kind === "working";
		const key = `${rect.w}x${rect.h}|${strength.toFixed(3)}|${selected}|${framed}|${member.waitingDialogs}|${screenMix.toFixed(3)}|${slot}|${working ? Math.floor(now / SPINNER_REPAINT_MS) : 0}|${rows ? rows.length : 0}`;
		const cached = this.#paintCache.get(slot);
		if (cached && cached.snapshot === snapshot && cached.key === key) return cached.rows;
		const painted = paintRoomWindow({
			width: rect.w,
			height: rect.h,
			snapshot,
			ordinal: slot + 1,
			strength,
			selected,
			framed,
			waitingDialogs: member.waitingDialogs,
			screen: rows ? { rows, mix: screenMix } : undefined,
			now,
		});
		this.#paintCache.set(slot, { snapshot, key, rows: painted });
		return painted;
	}

	render(width: number): readonly string[] {
		this.#width = Math.max(1, width);
		const viewport = this.#viewport();
		const height = Math.max(1, viewport.height);
		const members = this.#members();
		const now = this.#now();
		const zoom = this.#displayZoom();
		const travel = this.#travel;
		let zoomNow = zoom;
		if (travel?.sliding && travel.to !== travel.from) {
			// The push in rides the slide: flat for its first half, then back to
			// full size as the next window arrives.
			const progress = clamp01((this.#scroll.value - travel.from) / (travel.to - travel.from));
			const t = clamp01((progress - 0.5) / 0.5);
			zoomNow = TRAVEL_DIP + (1 - TRAVEL_DIP) * t * t * (3 - 2 * t);
		} else if (travel?.sliding) {
			zoomNow = 1;
		}
		const placements = placeRoomWindows(viewport, {
			count: this.#slotCount(),
			scroll: this.#scroll.value,
			selected: this.#selected,
			zoom: zoomNow,
			mix: this.#mix.value,
		});
		this.#placements = placements;
		const layers: Layer[] = placements.map(placement => ({
			x: placement.rect.x,
			y: placement.rect.y,
			width: placement.rect.w,
			rows: this.#paintSlot(placement, members, viewport, now),
		}));
		const { rows, covered } = compositeRoomLayers(layers, this.#width, height);
		if (this.#phase !== "travel") this.#paintChrome(rows, covered, roomChromeStrength(zoomNow), members, now);
		this.#syncSpinner();
		return rows;
	}

	#paintChrome(
		rows: string[],
		covered: readonly boolean[],
		strength: number,
		members: readonly RoomStageMember[],
		now: number,
	): void {
		if (strength <= 0.01) return;
		const width = this.#width;
		const height = rows.length;
		const ink = new RoomInk(strength, theme.visibleGroundHex());
		const put = (row: number, text: string): void => {
			if (row < 0 || row >= height || covered[row]) return;
			rows[row] = truncateToWidth(text, width);
		};

		// Title: what this is, how many, and what needs attention. A conversation
		// holding a question is counted as needing you and not also as working,
		// and it comes first, the way the status line's room segment reads.
		const waiting = members.filter(member => member.waitingDialogs > 0).length;
		const working = members.filter(
			member => member.waitingDialogs === 0 && member.snapshot().state.kind === "working",
		).length;
		const parts = [
			ink.bold(ink.token("text", "Room")),
			ink.token("muted", `${members.length} conversation${members.length === 1 ? "" : "s"}`),
		];
		if (waiting > 0) parts.push(ink.token("borderAccent", `${theme.status.warning} ${waiting} needs you`));
		if (working > 0) parts.push(ink.token("accent", `${working} working`));
		const left = `  ${parts.join(ink.token("dim", SEPARATOR))}`;
		const layoutName = this.#layout === "side-by-side" ? "side by side" : "all windows";
		const right = `${ink.token("dim", layoutName)}  `;
		const gap = width - visibleWidth(left) - visibleWidth(right);
		put(0, gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : left);

		// Pager: every window's ordinal, the selected one lit; or the notice, while one stands.
		const notice = this.#notice && now < this.#notice.until ? this.#notice : undefined;
		if (notice) {
			const text = ink.token(notice.tone === "error" ? "error" : "warning", notice.text);
			const w = Math.min(width, visibleWidth(notice.text));
			put(height - 3, `${" ".repeat(Math.max(0, Math.floor((width - w) / 2)))}${text}`);
		} else {
			const ticks: string[] = [];
			let tickWidth = 0;
			const count = this.#slotCount();
			for (let slot = 0; slot < count; slot++) {
				const label = slot < members.length ? String(slot + 1) : "+";
				const member = members[slot];
				const mark = member && member.waitingDialogs > 0 ? theme.status.warning : "";
				const plain = `${label}${mark}`;
				const styled =
					slot === this.#selected
						? ink.bold(ink.token("borderAccent", plain))
						: mark
							? `${ink.token("muted", label)}${ink.token("borderAccent", mark)}`
							: ink.token(slot < members.length ? "muted" : "dim", label);
				ticks.push(styled);
				tickWidth += visibleWidth(plain);
			}
			const joined = ticks.join("   ");
			const w = tickWidth + Math.max(0, ticks.length - 1) * 3;
			put(height - 3, `${" ".repeat(Math.max(0, Math.floor((width - w) / 2)))}${joined}`);
		}

		// Keys, dropped from the right until the row fits. The digit jump is named
		// only when there is somewhere to jump, with the digits the room takes.
		const grid = this.#layout === "all-windows";
		const jumpable = Math.min(9, members.length);
		const hints: Array<[string, string]> = [
			[grid ? "←↑↓→" : "←→", "move"],
			["enter", "open"],
		];
		if (jumpable > 1) hints.push([`1–${jumpable}`, "jump"]);
		hints.push(["n", "new"], ["x", "close"], ["tab", grid ? "side by side" : "all windows"], ["esc", "back"]);
		const sep = ink.token("dim", SEPARATOR);
		let shown = hints.length;
		const plainWidth = (n: number): number =>
			hints.slice(0, n).reduce((sum, [key, label]) => sum + visibleWidth(key) + 1 + visibleWidth(label), 0) +
			Math.max(0, n - 1) * SEPARATOR.length;
		while (shown > 1 && plainWidth(shown) > width - 4) shown--;
		const hintText = hints
			.slice(0, shown)
			.map(([key, label]) => `${ink.token("dim", key)} ${ink.token("muted", label)}`)
			.join(sep);
		const hintWidth = plainWidth(shown);
		put(height - 1, `${" ".repeat(Math.max(0, Math.floor((width - hintWidth) / 2)))}${hintText}`);
	}
}
