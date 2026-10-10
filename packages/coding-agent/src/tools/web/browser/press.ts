/**
 * A click or hover that presses only its own element: the check in the element's frame and every frame
 * above it that the point it presses belongs to the element, and the loop that scrolls, centres and
 * waits out a cover before pressing ({@link pressUncovered}).
 */

import { setTimeout as delay } from "node:timers/promises";
import { untilAborted } from "@veyyon/utils";
import { optionalResult } from "@veyyon/utils/discarded-fault";
import type { ElementHandle, Frame } from "puppeteer-core";
import { ToolError } from "../../core/tool-errors";
import { type HandleRelocation, leftTheDocument, RELOCATION_ATTEMPTS, scrollConnected } from "./element-identity";
import { releaseHandle } from "./handle-release";
import type { Extent, NaturalInput, PressGesture } from "./natural-input";

/**
 * How long a click or hover waits for whatever covers its element (a menu closing, a fade, a toast)
 * to go before it fails naming it. A cover that outlasts this is one the page expects dismissed.
 */
const COVERED_WAIT_MS = 2_500;
/** Poll cadence while a click or hover waits for its element to be uncovered. */
const COVERED_POLL_MS = 100;

/** A point in a frame's viewport, in CSS pixels. */
interface FramePoint {
	readonly x: number;
	readonly y: number;
}

/**
 * Where a natural press aims on its element: `spread` from the centre of the element's clipped box, as
 * shares of its half extent, or `at` one point of the frame's viewport, the one the pointer went to,
 * checked as strictly as when it was chosen.
 */
type PressAim =
	| { readonly kind: "spread"; readonly fx: number; readonly fy: number }
	| { readonly kind: "at"; readonly x: number; readonly y: number; readonly strict: boolean };

/**
 * What a click or hover would reach on an element, decided in the page. A clear press states its point,
 * the centre of the element's clipped box, and that box's size; with an aim whose point is the
 * element's own, it states that point as `aimed`.
 */
type PressProbe =
	| { readonly kind: "clear"; readonly point?: FramePoint; readonly aimed?: FramePoint; readonly size?: Extent }
	| { readonly kind: "covered"; readonly by: string }
	| { readonly kind: "disabled" }
	| { readonly kind: "detached" };

/**
 * Decide in the element's frame whether a press on it would reach it.
 *
 * The point is the one puppeteer's `clickablePoint` presses: the centre of the first client rect that,
 * clipped to the frame's viewport, is at least 1×1 px. What `elementFromPoint` finds there, followed
 * into open shadow roots, reaches the element when it is the element or inside it, inside one of the
 * element's labels (a styled checkbox drawn over its input), or holds the element (a closed shadow
 * host hides what is beneath it, and a click there still lands on the host's content). Anything else
 * takes the press. With `requireEnabled`, a disabled form control is reported as such first.
 *
 * An `aim` names a second point, inside the same box, that a natural press goes to instead. It is
 * `aimed` only when what it hits is the element, inside it or inside one of its labels; an ancestor
 * holding the element there is its padding or a rounded corner, not the element. The verdict is the
 * centre's either way, so an aim never presses what the centre's check refuses.
 * Serialized into the page, so it reaches nothing outside itself.
 */
function probePress(element: unknown, requireEnabled: boolean, aim: PressAim | null): PressProbe {
	interface Rect {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	}
	interface PressNode {
		readonly isConnected: boolean;
		readonly parentNode: PressNode | null;
		readonly host?: PressNode;
		readonly shadowRoot?: { elementFromPoint(x: number, y: number): PressNode | null } | null;
		readonly tagName?: string;
		readonly id?: string;
		readonly classList?: ArrayLike<string>;
		readonly textContent: string | null;
		readonly labels?: ArrayLike<PressNode> | null;
		matches?(selector: string): boolean;
		getClientRects(): ArrayLike<Rect>;
		readonly ownerDocument: {
			readonly documentElement: { readonly clientWidth: number; readonly clientHeight: number };
			elementFromPoint(x: number, y: number): PressNode | null;
		};
	}
	const el = element as PressNode;
	if (!el.isConnected) return { kind: "detached" };
	if (requireEnabled && el.matches?.(":disabled")) return { kind: "disabled" };
	const doc = el.ownerDocument;
	const width = doc.documentElement.clientWidth;
	const height = doc.documentElement.clientHeight;
	let box: { x: number; y: number; width: number; height: number } | undefined;
	for (const rect of Array.from(el.getClientRects())) {
		const w = Math.max(rect.x >= 0 ? Math.min(width - rect.x, rect.width) : Math.min(width, rect.width + rect.x), 0);
		const h = Math.max(
			rect.y >= 0 ? Math.min(height - rect.y, rect.height) : Math.min(height, rect.height + rect.y),
			0,
		);
		if (w >= 1 && h >= 1) {
			box = { x: Math.max(rect.x, 0), y: Math.max(rect.y, 0), width: w, height: h };
			break;
		}
	}
	// No rect to press: puppeteer's own click reports that.
	if (!box) return { kind: "clear" };
	const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	const size = { width: box.width, height: box.height };
	const hitAt = (x: number, y: number): PressNode | null => {
		let hit = doc.elementFromPoint(x, y);
		while (hit?.shadowRoot) {
			const inner = hit.shadowRoot.elementFromPoint(x, y);
			if (!inner || inner === hit) break;
			hit = inner;
		}
		return hit;
	};
	const within = (inner: PressNode, outer: PressNode): boolean => {
		for (let node: PressNode | null | undefined = inner; node; node = node.parentNode ?? node.host) {
			if (node === outer) return true;
		}
		return false;
	};
	const reaches = (target: PressNode, strict: boolean): boolean =>
		within(target, el) ||
		(!strict && within(el, target)) ||
		Array.from(el.labels ?? []).some(label => within(target, label));
	let aimed: FramePoint | undefined;
	if (aim) {
		const at =
			aim.kind === "at"
				? { x: aim.x, y: aim.y }
				: { x: point.x + (aim.fx * box.width) / 2, y: point.y + (aim.fy * box.height) / 2 };
		const hitAtAim = hitAt(at.x, at.y);
		if (hitAtAim && reaches(hitAtAim, aim.kind === "spread" || aim.strict)) aimed = at;
	}
	const target = hitAt(point.x, point.y);
	if (!target || reaches(target, false)) return { kind: "clear", point, aimed, size };
	const tag = (target.tagName ?? "node").toLowerCase();
	const id = target.id ? `#${target.id}` : "";
	const classes = Array.from(target.classList ?? [])
		.slice(0, 2)
		.map(name => `.${name}`)
		.join("");
	const text = (target.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
	return { kind: "covered", by: `<${tag}${id}${classes}>${text ? ` "${text}"` : ""}` };
}

/** What a press at a point inside a frame meets in the frame's parent: the frame itself, or a cover. */
type FrameHit =
	| { readonly kind: "clear"; readonly point?: FramePoint }
	| { readonly kind: "covered"; readonly by: string };

/**
 * Decide, in the parent of a frame, whether a press at `x`,`y` in the frame's viewport reaches the frame.
 *
 * The point moves into the parent's viewport by the frame element's content box. What `elementFromPoint`
 * finds there, followed into open shadow roots, is the frame element, or holds it, when the press
 * reaches the frame; anything else (a banner, a dialog, a cookie wall over the frame) takes it. A point
 * outside the parent's viewport is left to the press. Serialized into the page, so it reaches nothing
 * outside itself.
 */
function probeFrameHit(element: unknown, x: number, y: number): FrameHit {
	interface HitNode {
		readonly parentNode: HitNode | null;
		readonly host?: HitNode;
		readonly shadowRoot?: { elementFromPoint(x: number, y: number): HitNode | null } | null;
		readonly tagName?: string;
		readonly id?: string;
		readonly classList?: ArrayLike<string>;
		readonly textContent: string | null;
	}
	interface FrameNode extends HitNode {
		readonly clientLeft: number;
		readonly clientTop: number;
		getBoundingClientRect(): { readonly left: number; readonly top: number };
		readonly ownerDocument: {
			readonly documentElement: { readonly clientWidth: number; readonly clientHeight: number };
			readonly defaultView: { getComputedStyle(node: unknown): { paddingLeft: string; paddingTop: string } } | null;
			elementFromPoint(x: number, y: number): HitNode | null;
		};
	}
	const frame = element as FrameNode;
	const doc = frame.ownerDocument;
	const box = frame.getBoundingClientRect();
	const style = doc.defaultView?.getComputedStyle(frame);
	const point = {
		x: box.left + frame.clientLeft + (Number.parseFloat(style?.paddingLeft ?? "0") || 0) + x,
		y: box.top + frame.clientTop + (Number.parseFloat(style?.paddingTop ?? "0") || 0) + y,
	};
	const { clientWidth, clientHeight } = doc.documentElement;
	if (point.x < 0 || point.y < 0 || point.x >= clientWidth || point.y >= clientHeight) return { kind: "clear" };
	let hit = doc.elementFromPoint(point.x, point.y);
	while (hit?.shadowRoot) {
		const inner = hit.shadowRoot.elementFromPoint(point.x, point.y);
		if (!inner || inner === hit) break;
		hit = inner;
	}
	if (!hit) return { kind: "clear", point };
	for (let node: HitNode | null | undefined = frame; node; node = node.parentNode ?? node.host) {
		if (node === hit) return { kind: "clear", point };
	}
	const tag = (hit.tagName ?? "node").toLowerCase();
	const id = hit.id ? `#${hit.id}` : "";
	const classes = Array.from(hit.classList ?? [])
		.slice(0, 2)
		.map(name => `.${name}`)
		.join("");
	const text = (hit.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
	return { kind: "covered", by: `<${tag}${id}${classes}>${text ? ` "${text}"` : ""} over its frame` };
}

/** What a press at a point meets on its way up to the top document. */
type FrameReach = { readonly cover: string } | { readonly cover: null; readonly at?: FramePoint };

/**
 * What a press at `point` in `frame` meets from the frames above it: the cover one of them takes it
 * with, or none, and then the point in the top document's viewport. A point that leaves some frame's
 * viewport on the way up is left to the press, and has no `at`.
 */
async function reachThroughFrames(frame: Frame, point: FramePoint | undefined): Promise<FrameReach> {
	let child = frame;
	let at = point;
	while (at && child.parentFrame()) {
		const owner = await child.frameElement();
		if (!owner) return { cover: null };
		let hit: FrameHit;
		try {
			hit = (await owner.evaluate(probeFrameHit, at.x, at.y)) as FrameHit;
		} finally {
			await releaseHandle(owner);
		}
		if (hit.kind === "covered") return { cover: hit.by };
		at = hit.point;
		const parent = child.parentFrame();
		if (!parent) return { cover: null };
		child = parent;
	}
	return { cover: null, at };
}

/**
 * The longest a press waits for one frame to draw before it goes on: a frame the browser draws nothing
 * for, as in a page in the background, is not waited out.
 */
const FRAME_DRAW_WAIT_MS = 250;

/** Resolve once the frame has run two animation frames, by when it has drawn one. Serialized into the page. */
function twoAnimationFrames(): Promise<void> {
	const view = globalThis as unknown as { requestAnimationFrame(callback: () => void): number };
	const drawn = Promise.withResolvers<void>();
	view.requestAnimationFrame(() => view.requestAnimationFrame(() => drawn.resolve()));
	return drawn.promise;
}

/**
 * Let `frame` and every frame above it draw before a press reaches into it. The browser sends a press
 * to the frame its last drawn picture shows at the point, and a frame in another process that has not
 * drawn since it loaded is not in that picture yet: the press goes to the document above it, though
 * every document places the element at the point and the probes find it clear.
 */
async function drawnThroughFrames(frame: Frame, signal: AbortSignal | undefined): Promise<void> {
	for (let at: Frame | null = frame; at; at = at.parentFrame()) {
		const drawing = at;
		await untilAborted(signal, () =>
			Promise.race([
				optionalResult(
					drawing.evaluate(twoAnimationFrames),
					"a frame that navigates or detaches has nothing left to draw before the press",
				),
				delay(FRAME_DRAW_WAIT_MS, undefined, { signal }),
			]),
		);
	}
}

/** The element a press was waiting on left the page before it was pressed; nothing was pressed. */
export class DetachedPressTarget extends ToolError {}

/**
 * How long before its op's deadline a press gives up with its own reason, so the reason (covered,
 * disabled) reaches the caller rather than the op's generic timeout.
 */
export const PRESS_REPORT_MARGIN_MS = 500;

/** Centre an element in its scrollers and the viewport, which `DOM.scrollIntoViewIfNeeded` skips for one already visible. */
function centreInView(element: unknown): void {
	(element as { scrollIntoView(options: object): void }).scrollIntoView({
		block: "center",
		inline: "center",
		behavior: "instant",
	});
}

/** What a press does at its point: a click, with the options of a handle's `click`, or a hover, which only arrives. */
export type Gesture = ({ readonly kind: "click" } & PressGesture) | { readonly kind: "hover" };

/** How far apart two points of the top document may be and still be the point the pointer rests on. */
const SAME_POINT_PX = 0.5;

/**
 * The clicks the page dispatched for a natural press: how many, how many went past the element to an
 * ancestor, and whether the element had left the document when the press ended.
 */
interface ClickTally {
	readonly fired: number;
	readonly missed: number;
	readonly left: boolean;
}

/**
 * Count, in the element's window, the clicks a press sends.
 *
 * Chromium sends no click when the node the button went down on leaves the document before it comes
 * up, and a browser that sends one sends it to an ancestor of the node under the pointer. A click is
 * missed when its target is a proper ancestor of the node under its point and its path does not hold
 * the element. A click on the element, on a child the page replaced, or on the element's replacement
 * is not. Returns the watch, which stays in the page until {@link readClicks} stops it. Serialized
 * into the page, so it reaches nothing outside itself.
 */
function watchClicks(element: unknown): unknown {
	interface ClickNode {
		readonly parentNode: ClickNode | null;
		readonly host?: ClickNode;
		readonly shadowRoot?: { elementFromPoint(x: number, y: number): ClickNode | null } | null;
	}
	interface ClickEvent {
		readonly clientX: number;
		readonly clientY: number;
		composedPath(): readonly unknown[];
	}
	interface WatchedNode {
		readonly isConnected: boolean;
		readonly ownerDocument: {
			elementFromPoint(x: number, y: number): ClickNode | null;
			readonly defaultView: {
				addEventListener(type: string, listener: (event: ClickEvent) => void, capture: boolean): void;
				removeEventListener(type: string, listener: (event: ClickEvent) => void, capture: boolean): void;
			} | null;
		};
	}
	const el = element as WatchedNode;
	const doc = el.ownerDocument;
	const view = doc.defaultView;
	let fired = 0;
	let missed = 0;
	const listener = (event: ClickEvent): void => {
		fired++;
		const path = event.composedPath();
		if (path.includes(element)) return;
		let hit = doc.elementFromPoint(event.clientX, event.clientY);
		while (hit?.shadowRoot) {
			const inner = hit.shadowRoot.elementFromPoint(event.clientX, event.clientY);
			if (!inner || inner === hit) break;
			hit = inner;
		}
		if (!hit || hit === path[0]) return;
		for (let node = hit.parentNode ?? hit.host; node; node = node.parentNode ?? node.host) {
			if (node === path[0]) {
				missed++;
				return;
			}
		}
	};
	view?.addEventListener("click", listener, true);
	return {
		read: (): ClickTally => {
			view?.removeEventListener("click", listener, true);
			return { fired, missed, left: !el.isConnected };
		},
	};
}

/** Stop a {@link watchClicks} watch and read what it counted. Serialized into the page. */
function readClicks(watch: unknown): ClickTally {
	// The object watchClicks returned, which this runs against in the same page.
	const own = watch as { read(): ClickTally };
	return own.read();
}

/**
 * Press `gesture` where the pointer rests on `target` and answer whether the page took the element
 * away while the button was down: it left the document and no click reached it ({@link watchClicks}).
 * A watch the page no longer holds, as after a click that navigated, counts as reached.
 */
async function clickWatched(
	target: ElementHandle,
	input: NaturalInput,
	gesture: PressGesture,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	const watch = await untilAborted(signal, () => target.evaluateHandle(watchClicks));
	let tally: ClickTally | undefined;
	try {
		await untilAborted(signal, () => input.click(gesture, signal));
	} finally {
		tally = await optionalResult(watch.evaluate(readClicks), "a click that navigated took the watch with it");
		await releaseHandle(watch);
	}
	return tally?.left === true && tally.missed === tally.fired;
}

/**
 * Run `press` once the point it presses on `handle` is the element's own.
 *
 * A press whose point something else holds (an open menu, a dialog, a banner, a toast) lands on that
 * instead, and nothing says so. For an element inside a frame, the point is checked in the element's
 * frame and then in every frame above it, so a banner over the frame counts too. The element is
 * scrolled into view, then centred once if covered, which clears a sticky header; a cover still there
 * after {@link COVERED_WAIT_MS}, or `timeoutMs` when shorter, fails the action naming it. A click waits
 * for a disabled form control until `timeoutMs`. In every failure nothing is pressed.
 *
 * With `input`, the press is a person's instead of `press`: the scrolls turn the wheel (an instant
 * scroll finishes what the wheel cannot), and once the centre's check passes the pointer travels to a
 * point of the element's own inside its box (the centre when the aimed point is not), rests there, and
 * that point is checked again before the button goes down on it. A point the element has left by then
 * is aimed at afresh, and one it keeps leaving past `timeoutMs` fails the action.
 *
 * With `relocation`, which an id or ARIA ref handle carries, an element that leaves the document is
 * replaced by the element `relocation` resolves, up to {@link RELOCATION_ATTEMPTS} times in a row,
 * and the press goes on at the point it reached; with no replacement it fails naming the id or ref
 * as stale.
 * A natural click whose element the page replaced while the button was down reaches nothing; it is
 * made again on the element `relocation` resolves, at the point the pointer rests on when the
 * replacement holds it and with the button released at once, up to {@link RELOCATION_ATTEMPTS} times
 * in a row or until `timeoutMs`, and fails past that. With no replacement the element is gone and the
 * press ends.
 */
export async function pressUncovered(
	handle: ElementHandle,
	label: string,
	press: (target: ElementHandle) => Promise<void>,
	timeoutMs: number,
	options: {
		readonly signal?: AbortSignal;
		readonly gesture: Gesture;
		readonly input: NaturalInput | null;
		readonly relocation?: HandleRelocation;
	},
): Promise<void> {
	const { signal, gesture, input, relocation } = options;
	const spread: PressAim | null = input ? { kind: "spread", ...input.aim() } : null;
	const started = Date.now();
	let centred = false;
	let placed = false;
	/** Whether the element's frame and the frames above it have drawn since this press began. */
	let drawn = false;
	/** The point the pointer went to for this press: the aim that finds it again, and where it is in the top document. */
	let arrived: { readonly aim: PressAim; readonly at: FramePoint } | null = null;
	let target = handle;
	/** The element that replaced `handle`, released once the press ends. */
	let replacement: ElementHandle | null = null;
	/** Detachments since the last probe that found the element in the document. */
	let detachments = 0;
	/** Natural clicks in a row the page took the element away under, each pressed again on its replacement ({@link clickWatched}). */
	let redrawnClicks = 0;
	try {
		for (;;) {
			try {
				const aim = arrived?.aim ?? spread;
				const probe = (await untilAborted(signal, () =>
					target.evaluate(probePress, gesture.kind === "click", aim),
				)) as PressProbe;
				const elapsed = Date.now() - started;
				if (probe.kind === "detached") {
					const fresh = relocation && detachments < RELOCATION_ATTEMPTS ? await relocation.relocate() : null;
					if (!fresh) {
						const cause = `${label}: the element left the page before it was pressed, so nothing was pressed.`;
						throw relocation ? relocation.stale(cause) : new DetachedPressTarget(cause);
					}
					detachments++;
					await releaseHandle(replacement);
					replacement = target = fresh;
					continue;
				}
				detachments = 0;
				if (!placed) {
					placed = true;
					if (!(await untilAborted(signal, () => target.isIntersectingViewport({ threshold: 1 })))) {
						if (!(input && (await input.scrollIntoView(target, signal, relocation?.relocate)))) {
							await untilAborted(signal, () => (relocation ? scrollConnected(target) : target.scrollIntoView()));
						}
						continue;
					}
				}
				let cover = probe.kind === "covered" ? probe.by : null;
				if (probe.kind === "clear") {
					// A point clear in the element's own frame can still be covered by the page above that frame.
					const centre = await untilAborted(signal, () => reachThroughFrames(target.frame, probe.point));
					cover = centre.cover;
					if (centre.cover === null) {
						// Once per press, and only for an element in a frame: the frames draw, then the point is checked again.
						if (!drawn && target.frame.parentFrame()) {
							drawn = true;
							await drawnThroughFrames(target.frame, signal);
							continue;
						}
						if (!input || !aim || !probe.point || !centre.at) {
							await untilAborted(signal, () => press(target));
							return;
						}
						const aimed = probe.aimed;
						const aimedReach = aimed
							? await untilAborted(signal, () => reachThroughFrames(target.frame, aimed))
							: undefined;
						const aimedAt = aimedReach?.cover === null ? aimedReach.at : undefined;
						if (arrived) {
							const rest = arrived.at;
							if (aimedAt && Math.hypot(aimedAt.x - rest.x, aimedAt.y - rest.y) <= SAME_POINT_PX) {
								if (gesture.kind === "hover") return;
								// A press again after a redraw goes down and up at once, as puppeteer's does, unless the caller set the hold.
								const quick = redrawnClicks > 0 && gesture.holdMs === undefined;
								const taken = await clickWatched(
									target,
									input,
									quick ? { ...gesture, holdMs: 0 } : gesture,
									signal,
								);
								// An element with no replacement is gone for good, as a menu item its press closes is.
								const fresh = taken && relocation ? await relocation.relocate() : null;
								if (!fresh) return;
								await releaseHandle(replacement);
								replacement = target = fresh;
								redrawnClicks++;
								if (redrawnClicks > RELOCATION_ATTEMPTS || Date.now() - started >= timeoutMs) {
									throw new ToolError(
										`${label}: the page replaced the element while the button was down on ${redrawnClicks} presses in a row, so no click reached it. Press it again once the page holds it still.`,
									);
								}
								// The pointer stays where it rests: a replacement at that point is pressed there at once,
								// and one drawn elsewhere fails the check above and is travelled to.
								continue;
							}
							if (elapsed >= timeoutMs) {
								throw new ToolError(
									`${label}: the element kept moving from under the pointer for ${timeoutMs} ms, so nothing was pressed.`,
								);
							}
							arrived = null;
							continue;
						}
						const next: { readonly aim: PressAim; readonly at: FramePoint } =
							aimed && aimedAt
								? { aim: { kind: "at", x: aimed.x, y: aimed.y, strict: true }, at: aimedAt }
								: { aim: { kind: "at", x: probe.point.x, y: probe.point.y, strict: false }, at: centre.at };
						await input.moveTo(next.at, probe.size ?? { width: 1, height: 1 }, signal);
						if (gesture.kind === "click") await input.dwell(signal);
						arrived = next;
						continue;
					}
				}
				if (cover !== null && !centred) {
					centred = true;
					arrived = null;
					if (!(input && (await input.scrollIntoView(target, signal)))) {
						await untilAborted(signal, () => target.evaluate(centreInView));
					}
					continue;
				}
				if (cover !== null && elapsed >= Math.min(timeoutMs, COVERED_WAIT_MS)) {
					throw new ToolError(
						`${label}: ${cover} covers the point it would press, so nothing was pressed. Dismiss it (tab.press("Escape"), or a click outside it) or act on it instead.`,
					);
				}
				if (probe.kind === "disabled" && elapsed >= timeoutMs) {
					throw new ToolError(
						`${label}: the element stayed disabled for ${timeoutMs} ms, so nothing was pressed.`,
					);
				}
				await delay(COVERED_POLL_MS, undefined, { signal });
			} catch (error) {
				// A node the page replaced between the probe and the press: the next probe relocates it.
				if (!relocation || !(await leftTheDocument(target, error))) throw error;
			}
		}
	} finally {
		await releaseHandle(replacement);
	}
}
