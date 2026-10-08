/**
 * Pointer, wheel and keyboard input paced the way a person produces it, for `tab.click`, `tab.type`,
 * `tab.fill`, `tab.drag`, `tab.scrollIntoView` and a handle's `click`, `hover` and `type` while
 * `browser.naturalInput` is on.
 *
 * The pointer moves from where it last was on the page along a bent path, slow at either end and fast
 * in the middle, taking longer the farther and the smaller its target (Fitts's law). It rests on the
 * target before it presses and holds the press. Keys go down and up one at a time with a hold and a
 * pause between them, a shifted character under Shift. The wheel scrolls in notches. Every delay is
 * drawn from a bounded range in {@link NATURAL_INPUT} by a seeded generator, so a test bounds each one.
 */

import { setTimeout as delay } from "node:timers/promises";
import { clampLow, untilAborted } from "@veyyon/utils";
import { bestEffort } from "@veyyon/utils/discarded-fault";
import type { ElementHandle, KeyInput, MouseButton, Page } from "puppeteer-core";
import { DETACHED_NODE_MESSAGE, RELOCATION_ATTEMPTS } from "./element-identity";
import { releaseHandles } from "./handle-release";

/** A point in the page's top-level viewport, in CSS pixels. */
export interface ViewportPoint {
	readonly x: number;
	readonly y: number;
}

/** A width and a height in CSS pixels. */
export interface Extent {
	readonly width: number;
	readonly height: number;
}

/** An inclusive range, `[low, high]`. */
export type Bounds = readonly [number, number];

/** A source of floats in `[0, 1)`. */
export type Random = () => number;

/**
 * Every range natural input draws from. Times are milliseconds, lengths CSS pixels.
 *
 * A click adds at most `moveMs[1] + dwellMs[1] + holdMs[1]` (350 ms) to the instant press, and the
 * one look at the element it takes before pressing. `fillTypedMaxChars` is the longest value `fill`
 * types: a name, an email address, a username, a password, a search query, a postcode, a phone or card
 * number. Its worst case, 24 keys at `keyHoldMs[1] + keyGapMs[1]` each (3,960 ms), is under half the
 * 8 s action deadline; a longer value is pasted, as a person pastes it.
 */
export const NATURAL_INPUT = {
	/** The pointer's travel to its target, the Fitts's-law estimate varied and held to this range. */
	moveMs: [70, 180],
	/** How many pointer samples a travel dispatches. */
	moveSteps: [5, 12],
	/** Rest on the target between arriving and pressing, before the look that checks the point again. */
	dwellMs: [40, 85],
	/** A press held between `mousedown` and `mouseup`. */
	holdMs: [40, 85],
	/** Pause between the presses of a double or triple click. */
	clickGapMs: [70, 120],
	/** A key held between `keydown` and `keyup`. */
	keyHoldMs: [30, 75],
	/** Pause between a key's `keyup` and the next key's `keydown`. */
	keyGapMs: [25, 90],
	/** Shift held before the key of a shifted character goes down. */
	shiftLeadMs: [15, 40],
	/** A drag's travel with the button held. */
	dragMs: [200, 450],
	/** The button held on the drag's start before the pointer moves. */
	dragHoldMs: [60, 120],
	/** One wheel notch. */
	wheelNotchPx: 100,
	/** Wheel events in one flick; a longer scroll puts more notches into each. */
	wheelEventsMax: 8,
	/** Pause between the wheel events of a flick. */
	wheelGapMs: [16, 40],
	/** Flicks one scroll makes before it leaves the rest to an instant scroll. */
	wheelPasses: 2,
	/** How long a scroll waits for the page to move and come to rest after a flick. */
	wheelSettleMs: 300,
	/** Longest value `fill` types key by key. */
	fillTypedMaxChars: 24,
	/** How far from the centre a press aims, as a share of the half extent of the element's box. */
	aimSpread: 0.6,
} as const;

/** Fitts's-law intercept and slope: the travel time is `a + b · log2(distance / size + 1)`. */
const FITTS_BASE_MS = 40;
const FITTS_MS_PER_BIT = 45;
/** Factor one travel's speed varies by. */
const SPEED_VARIATION: Bounds = [0.85, 1.15];
/** The interval between two pointer samples the step count aims for, about one frame. */
const SAMPLE_MS = 17;
/** Factor one sample interval varies by around the travel's mean. */
const INTERVAL_VARIATION: Bounds = [0.75, 1.25];
/** How far a path bends away from the straight line, as a share of its length, and at most. */
const BEND: Bounds = [0.08, 0.22];
const BEND_MAX_PX = 160;
/** Factor each control point's offset varies by around the bend. */
const CONTROL_SPREAD: Bounds = [0.7, 1.3];
/** Tremor across the path, largest in the middle of a travel, none at either end. */
const WOBBLE_MAX_PX = 1.5;
/** Poll interval while a scroll comes to rest. */
const SETTLE_POLL_MS = 20;
/** Characters typed under Shift on a US layout. */
const SHIFTED = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/;

/**
 * A generator of floats in `[0, 1)` (sfc32), seeded from `seed`, or from the platform's cryptographic
 * source when no seed is given.
 */
export function seededRandom(seed?: number): Random {
	const state = new Uint32Array(4);
	if (seed === undefined) crypto.getRandomValues(state);
	else state.set([seed, seed ^ 0x9e3779b9, seed ^ 0x85ebca6b, seed ^ 0xc2b2ae35]);
	let [a = 0, b = 0, c = 0, d = 0] = state;
	const next = (): number => {
		const t = (((a + b) | 0) + d) | 0;
		d = (d + 1) | 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) | 0;
		c = (c << 21) | (c >>> 11);
		c = (c + t) | 0;
		return (t >>> 0) / 4_294_967_296;
	};
	for (let i = 0; i < 15; i++) next();
	return next;
}

/** A draw from `bounds`, likelier near the middle than near either end, never outside. */
export function between(bounds: Bounds, random: Random): number {
	const [low, high] = bounds;
	return low + ((high - low) * (random() + random())) / 2;
}

/** The share of a travel covered at time share `t`: minimum jerk, still at both ends. */
function minimumJerk(t: number): number {
	return t * t * t * (10 - 15 * t + 6 * t * t);
}

function cubic(p0: ViewportPoint, p1: ViewportPoint, p2: ViewportPoint, p3: ViewportPoint, s: number): ViewportPoint {
	const u = 1 - s;
	const w0 = u * u * u;
	const w1 = 3 * u * u * s;
	const w2 = 3 * u * s * s;
	const w3 = s * s * s;
	return { x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x, y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y };
}

/** One pointer position of a travel, `atMs` after the travel began. */
export interface PathSample extends ViewportPoint {
	readonly atMs: number;
}

/**
 * The samples a pointer travel from `from` to `to` dispatches: a cubic curve bent to one side of the
 * straight line, walked with a minimum-jerk profile, with a tremor that vanishes at both ends. The
 * last sample is `to` exactly, at the travel's full duration, which `travelMs` bounds; every other
 * sample lies inside `bounds`. A pointer already on `to` travels nowhere.
 */
export function planPointerPath(
	from: ViewportPoint,
	to: ViewportPoint,
	target: Extent,
	bounds: Extent,
	travelMs: Bounds,
	random: Random,
): PathSample[] {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const distance = Math.hypot(dx, dy);
	if (distance < 0.5) return [];
	const size = clampLow(Math.min(target.width, target.height), 1, Number.POSITIVE_INFINITY);
	const estimate = FITTS_BASE_MS + FITTS_MS_PER_BIT * Math.log2(distance / size + 1);
	const duration = clampLow(estimate * between(SPEED_VARIATION, random), travelMs[0], travelMs[1]);
	const [fewest, most] = NATURAL_INPUT.moveSteps;
	const steps = clampLow(Math.round(duration / SAMPLE_MS), fewest, most);
	const weights = Array.from({ length: steps }, () => between(INTERVAL_VARIATION, random));
	const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
	const normal = { x: -dy / distance, y: dx / distance };
	const bend = Math.min(distance * between(BEND, random), BEND_MAX_PX) * (random() < 0.5 ? -1 : 1);
	const control = (along: Bounds): ViewportPoint => {
		const t = between(along, random);
		const offset = bend * between(CONTROL_SPREAD, random);
		return { x: from.x + dx * t + normal.x * offset, y: from.y + dy * t + normal.y * offset };
	};
	const first = control([0.2, 0.4]);
	const second = control([0.6, 0.8]);
	const wobble = Math.min(WOBBLE_MAX_PX, distance / 100);
	const samples: PathSample[] = [];
	let elapsed = 0;
	for (const weight of weights.slice(0, -1)) {
		elapsed += (duration * weight) / weightSum;
		const s = minimumJerk(elapsed / duration);
		const point = cubic(from, first, second, to, s);
		const tremor = wobble * Math.sin(Math.PI * s) * between([-1, 1], random);
		samples.push({
			x: clampLow(point.x + normal.x * tremor, 0, bounds.width - 1),
			y: clampLow(point.y + normal.y * tremor, 0, bounds.height - 1),
			atMs: elapsed,
		});
	}
	samples.push({ x: to.x, y: to.y, atMs: duration });
	return samples;
}

/** One key of a typed text: Shift held first for a shifted character, the key held, then a pause. */
export interface Keystroke {
	readonly char: string;
	readonly shift: boolean;
	readonly shiftLeadMs: number;
	readonly holdMs: number;
	/** Pause after the key before the next one; none after the last. */
	readonly gapMs: number;
}

/** The longest `text` can take to type at the slowest pace {@link NATURAL_INPUT} allows. */
export function worstCaseTypingMs(text: string): number {
	let total = 0;
	for (const char of text) {
		total += NATURAL_INPUT.keyHoldMs[1] + NATURAL_INPUT.keyGapMs[1];
		if (SHIFTED.test(char)) total += NATURAL_INPUT.shiftLeadMs[1];
	}
	return total;
}

/**
 * The keystrokes that type `text`, one per character. When the slowest pace would take longer than
 * `withinMs`, every delay shrinks by the same factor so the whole text fits; the keys stay separate.
 */
export function planKeystrokes(text: string, withinMs: number, random: Random): Keystroke[] {
	const worst = worstCaseTypingMs(text);
	const scale = worst > withinMs ? Math.max(0, withinMs) / worst : 1;
	const chars = Array.from(text);
	return chars.map((char, index) => {
		const shift = SHIFTED.test(char);
		return {
			char,
			shift,
			shiftLeadMs: shift ? between(NATURAL_INPUT.shiftLeadMs, random) * scale : 0,
			holdMs: between(NATURAL_INPUT.keyHoldMs, random) * scale,
			gapMs: index === chars.length - 1 ? 0 : between(NATURAL_INPUT.keyGapMs, random) * scale,
		};
	});
}

/**
 * Whether `fill` types `value` key by key rather than pasting it: a value of one line, no longer than
 * {@link NATURAL_INPUT.fillTypedMaxChars}, that the slowest pace types within `withinMs`. An empty
 * value is one deletion, and a line break or a tab typed as a key would submit a form or move focus.
 */
export function fillTypesKeyByKey(value: string, withinMs: number): boolean {
	const chars = Array.from(value);
	return (
		chars.length > 0 &&
		chars.length <= NATURAL_INPUT.fillTypedMaxChars &&
		!chars.some(char => char.charCodeAt(0) < 0x20 || char === "\u007f") &&
		worstCaseTypingMs(value) <= withinMs
	);
}

/** One wheel event of a flick, `gapMs` after the one before it. */
export interface WheelStep {
	readonly deltaX: number;
	readonly deltaY: number;
	readonly gapMs: number;
}

/** `total` split over `count` parts, the middle ones larger, as a flick speeds up and slows down. */
function spreadNotches(total: number, count: number): number[] {
	const parts = new Array<number>(count).fill(Math.floor(total / count));
	const middle = (count - 1) / 2;
	const order = Array.from({ length: count }, (_, index) => index).sort(
		(a, b) => Math.abs(a - middle) - Math.abs(b - middle),
	);
	for (const index of order.slice(0, total % count)) parts[index] = (parts[index] ?? 0) + 1;
	return parts;
}

/**
 * The wheel events of one flick scrolling about `dx`, `dy` pixels: whole notches of
 * {@link NATURAL_INPUT.wheelNotchPx}, at most {@link NATURAL_INPUT.wheelEventsMax} events, the middle
 * ones carrying more. A distance under half a notch on both axes scrolls nothing.
 */
export function planWheel(dx: number, dy: number, random: Random): WheelStep[] {
	const notch = NATURAL_INPUT.wheelNotchPx;
	const across = Math.round(dx / notch);
	const down = Math.round(dy / notch);
	const notches = Math.max(Math.abs(across), Math.abs(down));
	if (notches === 0) return [];
	const count = Math.min(notches, NATURAL_INPUT.wheelEventsMax);
	const xs = spreadNotches(Math.abs(across), count);
	const ys = spreadNotches(Math.abs(down), count);
	return xs.map((x, index) => ({
		deltaX: Math.sign(across) * x * notch,
		deltaY: Math.sign(down) * (ys[index] ?? 0) * notch,
		gapMs: index === 0 ? 0 : between(NATURAL_INPUT.wheelGapMs, random),
	}));
}

/** An element's box against its document's viewport and scroll, measured in the page. */
interface ScrollMeasure {
	/** The element's centre in the viewport. */
	readonly x: number;
	readonly y: number;
	/** The viewport's size, scrollbars aside. */
	readonly width: number;
	readonly height: number;
	readonly scrollLeft: number;
	readonly scrollTop: number;
	readonly scrollWidth: number;
	readonly scrollHeight: number;
	/** The element lies in the viewport: whole when it fits, in part when it is larger. */
	readonly visible: boolean;
}

/** Measure an element against its document's viewport; null for an element that left its document. Serialized into the page. */
function measureScroll(element: unknown): ScrollMeasure | null {
	interface Box {
		readonly left: number;
		readonly top: number;
		readonly right: number;
		readonly bottom: number;
		readonly width: number;
		readonly height: number;
	}
	interface Scroller {
		readonly scrollLeft: number;
		readonly scrollTop: number;
		readonly scrollWidth: number;
		readonly scrollHeight: number;
		readonly clientWidth: number;
		readonly clientHeight: number;
	}
	const el = element as {
		readonly isConnected: boolean;
		getBoundingClientRect(): Box;
		readonly ownerDocument: { readonly scrollingElement: Scroller | null; readonly documentElement: Scroller };
	};
	if (!el.isConnected) return null;
	const box = el.getBoundingClientRect();
	const root = el.ownerDocument.scrollingElement ?? el.ownerDocument.documentElement;
	const width = root.clientWidth;
	const height = root.clientHeight;
	const fits = box.width <= width && box.height <= height;
	return {
		x: box.left + box.width / 2,
		y: box.top + box.height / 2,
		width,
		height,
		scrollLeft: root.scrollLeft,
		scrollTop: root.scrollTop,
		scrollWidth: root.scrollWidth,
		scrollHeight: root.scrollHeight,
		visible: fits
			? box.left >= 0 && box.top >= 0 && box.right <= width && box.bottom <= height
			: box.right > 0 && box.bottom > 0 && box.left < width && box.top < height,
	};
}

/** What a scroll still needs to bring an element's centre to the viewport's, and where it stands. */
interface ScrollNeed {
	/** The scroll, within what the document can still scroll, that centres the element. */
	readonly dx: number;
	readonly dy: number;
	readonly width: number;
	readonly height: number;
	readonly visible: boolean;
}

function scrollNeedOf(measure: ScrollMeasure): ScrollNeed {
	const { width, height } = measure;
	return {
		dx: clampLow(
			measure.x - width / 2,
			-measure.scrollLeft,
			Math.max(0, measure.scrollWidth - width - measure.scrollLeft),
		),
		dy: clampLow(
			measure.y - height / 2,
			-measure.scrollTop,
			Math.max(0, measure.scrollHeight - height - measure.scrollTop),
		),
		width,
		height,
		visible: measure.visible,
	};
}

/** Whether a scroll has done what a wheel can: the element in view, its centre near the viewport's. */
function scrolledIn(need: ScrollNeed): boolean {
	const notch = NATURAL_INPUT.wheelNotchPx;
	return (
		need.visible &&
		Math.abs(need.dx) <= Math.max(notch / 2, need.width / 10) &&
		Math.abs(need.dy) <= Math.max(notch / 2, need.height / 10)
	);
}

/** A press at the pointer: which button, how many times, and for how long when the caller says so. */
export interface PressGesture {
	readonly button?: MouseButton;
	readonly count?: number;
	readonly holdMs?: number;
}

/**
 * Natural input on one page. It follows every move of the page's mouse, the instant one of a press
 * made with natural input off included, so a travel starts where the pointer last was.
 */
export class NaturalInput {
	readonly #page: Page;
	readonly #random: Random;
	/** Where the page's pointer is in its top-level viewport; unset until the first move on the page. */
	#pointer: ViewportPoint | undefined;

	constructor(page: Page, random: Random = seededRandom()) {
		this.#page = page;
		this.#random = random;
		const mouse = page.mouse;
		const move = mouse.move.bind(mouse);
		mouse.move = async (x, y, options) => {
			await move(x, y, options);
			this.#pointer = { x, y };
		};
	}

	/** Where a press aims inside an element's box, as shares of its half extent from the centre. */
	aim(): { readonly fx: number; readonly fy: number } {
		return {
			fx: between([-1, 1], this.#random) * NATURAL_INPUT.aimSpread,
			fy: between([-1, 1], this.#random) * NATURAL_INPUT.aimSpread,
		};
	}

	/** Move the pointer to `to`, a target of `target`'s size, along a person's path. */
	async moveTo(to: ViewportPoint, target: Extent, signal?: AbortSignal): Promise<void> {
		const bounds = await this.#viewport(signal);
		const from = this.#pointer ?? this.#entry(bounds);
		await this.#follow(planPointerPath(from, to, target, bounds, NATURAL_INPUT.moveMs, this.#random), signal);
	}

	/** Rest on the target before pressing it. */
	async dwell(signal?: AbortSignal): Promise<void> {
		await delay(between(NATURAL_INPUT.dwellMs, this.#random), undefined, { signal });
	}

	/** Press where the pointer is. A press, once down, is always released. */
	async click(gesture: PressGesture, signal?: AbortSignal): Promise<void> {
		const mouse = this.#page.mouse;
		const count = Math.max(1, Math.floor(gesture.count ?? 1));
		for (let clickCount = 1; clickCount <= count; clickCount++) {
			const gap = clickCount === 1 ? 0 : between(NATURAL_INPUT.clickGapMs, this.#random);
			await delay(gap, undefined, { signal });
			// Puppeteer's mouse reads `clickCount`, which its public `MouseOptions` leaves out; without it a
			// double click is two single clicks and no `dblclick` fires.
			const press = { button: gesture.button, clickCount };
			await mouse.down(press);
			await delay(gesture.holdMs ?? between(NATURAL_INPUT.holdMs, this.#random));
			await mouse.up(press);
		}
	}

	/**
	 * Type `text` into whatever holds focus, a key at a time, within `withinMs` ({@link planKeystrokes}).
	 * Shift, once down for a character, is always released. `send` presses one character's key and holds
	 * it `holdMs`; puppeteer's layout by default, whose keys outside it insert text without a `keypress`.
	 */
	async type(
		text: string,
		withinMs: number,
		signal?: AbortSignal,
		send?: (char: string, holdMs: number) => Promise<void>,
	): Promise<void> {
		const keyboard = this.#page.keyboard;
		const press = send ?? ((char: string, holdMs: number) => keyboard.type(char, { delay: holdMs }));
		for (const stroke of planKeystrokes(text, withinMs, this.#random)) {
			await delay(0, undefined, { signal });
			if (stroke.shift) {
				await keyboard.down("Shift");
				await delay(stroke.shiftLeadMs);
			}
			try {
				await press(stroke.char, stroke.holdMs);
			} finally {
				if (stroke.shift) {
					await bestEffort(keyboard.up("Shift"), "puppeteer clears Shift from its own state before it sends");
				}
			}
			if (stroke.gapMs > 0) await delay(stroke.gapMs, undefined, { signal });
		}
	}

	/**
	 * Press each of `keys` (Home, PageUp, Backspace …) in turn at a person's pace, within `withinMs`: held
	 * and spaced as {@link planKeystrokes} holds and spaces a typed character.
	 */
	async pressKeys(keys: readonly KeyInput[], withinMs: number, signal?: AbortSignal): Promise<void> {
		const keyboard = this.#page.keyboard;
		const pace = planKeystrokes("k".repeat(keys.length), withinMs, this.#random);
		for (let index = 0; index < keys.length; index++) {
			await delay(0, undefined, { signal });
			await keyboard.press(keys[index]!, { delay: pace[index]!.holdMs });
			if (pace[index]!.gapMs > 0) await delay(pace[index]!.gapMs, undefined, { signal });
		}
	}

	/**
	 * Scroll `element`'s document with the wheel until the element's centre is near the viewport's.
	 * True when the element is then in view, near the centre or as near as the document scrolls; false
	 * for an element inside a frame, whose document the wheel does not reach from here, and for one the
	 * wheel did not bring in (a scroller of its own, a page that ignores the wheel), which the caller
	 * scrolls instantly.
	 *
	 * An element that leaves the document while the wheel turns is measured again on the element
	 * `relocate` returns, up to {@link RELOCATION_ATTEMPTS} times in a row; without `relocate`, or with
	 * no replacement, the scroll fails with puppeteer's detached-node message.
	 */
	async scrollIntoView(
		element: ElementHandle,
		signal?: AbortSignal,
		relocate?: () => Promise<ElementHandle | null>,
	): Promise<boolean> {
		if (element.frame.parentFrame() !== null) return false;
		let current = element;
		const replacements: ElementHandle[] = [];
		const measure = async (): Promise<ScrollNeed> => {
			for (let attempt = 0; ; attempt++) {
				const measured = await untilAborted(signal, () => current.evaluate(measureScroll));
				if (measured) return scrollNeedOf(measured);
				const fresh = relocate && attempt < RELOCATION_ATTEMPTS ? await relocate() : null;
				if (!fresh) throw new Error(DETACHED_NODE_MESSAGE);
				replacements.push(fresh);
				current = fresh;
			}
		};
		try {
			return await this.#wheelIntoView(measure, signal);
		} finally {
			await releaseHandles(replacements);
		}
	}

	/** Turn the wheel until `measure` reports the element near the viewport's centre ({@link scrollIntoView}). */
	async #wheelIntoView(measure: () => Promise<ScrollNeed>, signal?: AbortSignal): Promise<boolean> {
		let need = await measure();
		if (scrolledIn(need)) return true;
		// The wheel turns where the pointer is, and a page that has seen no pointer has it at its corner.
		if (this.#pointer === undefined) {
			const bounds = await this.#viewport(signal);
			await this.moveTo(this.#entry(bounds), { width: bounds.width / 2, height: bounds.height / 2 }, signal);
		}
		for (let pass = 0; pass < NATURAL_INPUT.wheelPasses && !scrolledIn(need); pass++) {
			const flick = planWheel(need.dx, need.dy, this.#random);
			if (flick.length === 0) break;
			for (const step of flick) {
				await delay(step.gapMs, undefined, { signal });
				await untilAborted(signal, () => this.#page.mouse.wheel({ deltaX: step.deltaX, deltaY: step.deltaY }));
			}
			const before = need;
			need = await this.#settle(measure, before, signal);
			// The wheel moved nothing: the pointer is over something that scrolls no further.
			if (Math.abs(need.dx - before.dx) < 1 && Math.abs(need.dy - before.dy) < 1) break;
		}
		return scrolledIn(need);
	}

	/** Press on `from`, travel to `to` with the button held, and release it there. */
	async drag(
		from: ViewportPoint,
		to: ViewportPoint,
		sizes: { readonly from: Extent; readonly to: Extent },
		signal?: AbortSignal,
	): Promise<void> {
		await this.moveTo(from, sizes.from, signal);
		await this.dwell(signal);
		const mouse = this.#page.mouse;
		await mouse.down();
		try {
			await delay(between(NATURAL_INPUT.dragHoldMs, this.#random), undefined, { signal });
			const bounds = await this.#viewport(signal);
			const path = planPointerPath(this.#pointer ?? from, to, sizes.to, bounds, NATURAL_INPUT.dragMs, this.#random);
			await this.#follow(path, signal);
			await delay(between(NATURAL_INPUT.dwellMs, this.#random), undefined, { signal });
		} finally {
			await bestEffort(mouse.up(), "a button left down would make the page's next press fail");
		}
	}

	/** Dispatch each sample at its time from now. */
	async #follow(samples: readonly PathSample[], signal?: AbortSignal): Promise<void> {
		const mouse = this.#page.mouse;
		const started = performance.now();
		for (const sample of samples) {
			await delay(Math.max(0, sample.atMs - (performance.now() - started)), undefined, { signal });
			await untilAborted(signal, () => mouse.move(sample.x, sample.y));
		}
	}

	/** Measure until the scroll has moved from `before` and come to rest, or the settle time is up. */
	async #settle(measure: () => Promise<ScrollNeed>, before: ScrollNeed, signal?: AbortSignal): Promise<ScrollNeed> {
		const started = performance.now();
		let last = before;
		let moved = false;
		while (performance.now() - started < NATURAL_INPUT.wheelSettleMs) {
			await delay(SETTLE_POLL_MS, undefined, { signal });
			const next = await measure();
			const still = Math.abs(next.dx - last.dx) < 0.5 && Math.abs(next.dy - last.dy) < 0.5;
			if (moved && still) return next;
			moved ||= !still;
			last = next;
		}
		return last;
	}

	/** Where a page that has seen no pointer has it: somewhere in the middle of its viewport. */
	#entry(bounds: Extent): ViewportPoint {
		return {
			x: bounds.width * between([0.25, 0.75], this.#random),
			y: bounds.height * between([0.25, 0.75], this.#random),
		};
	}

	async #viewport(signal?: AbortSignal): Promise<Extent> {
		const set = this.#page.viewport();
		if (set) return { width: set.width, height: set.height };
		return await untilAborted(signal, () =>
			this.#page.evaluate(() => {
				const view = globalThis as unknown as { innerWidth: number; innerHeight: number };
				return { width: view.innerWidth, height: view.innerHeight };
			}),
		);
	}
}
