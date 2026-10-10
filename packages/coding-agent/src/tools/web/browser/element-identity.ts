import { errorMessage } from "@veyyon/utils";
import { optionalResult } from "@veyyon/utils/discarded-fault";
import type { ElementHandle, Offset, Page, Point } from "puppeteer-core";
import type { ToolError } from "../../core/tool-errors";
import { releaseHandle, releaseHandles } from "./handle-release";

/**
 * An element handed out by a `tab.observe()` id or an ARIA ref, as its role and accessible name.
 *
 * A page that re-renders replaces nodes with equivalent ones: a framework re-mounts a component, a
 * list redraws, a polling view rewrites its markup. The handle an id or ref resolved to then points
 * at a node that left the document, and every action on it fails with puppeteer's "Node is detached
 * from document" or "Node is either not clickable or not an Element", whether the re-render happened
 * between two tool calls or between the lookup and the click. When the role and name were unique in
 * the page the id or ref came from, and are unique in the page now, the element that holds them is
 * the replacement, and the action runs on it. Any other count means the page changed in a way a role
 * and name cannot follow, and the action fails naming the id or ref as stale.
 *
 * Only a node that left a document that still exists is relocated. A handle whose document was
 * replaced by a navigation can no longer be evaluated at all, and an element with the same role and
 * name on the next page is a different element.
 */
export interface ElementIdentity {
	readonly role: string;
	readonly name: string;
}

/** How an id or ref handle finds the element that replaced its node, and the error it raises when none did. */
export interface HandleRelocation {
	/** The replacement, or null when there is no single one. */
	relocate(): Promise<ElementHandle | null>;
	stale(cause: string): ToolError;
}

/** The message puppeteer raises for an action on a node that left the document. */
export const DETACHED_NODE_MESSAGE = "Node is detached from document";

/** The message puppeteer raises for an action on a node with no box to aim at. */
const UNCLICKABLE_NODE_MESSAGE = "Node is either not clickable or not an Element";

/** Messages puppeteer raises for an action on a node that left the document. */
const DETACHED_ELEMENT_MESSAGES = [
	DETACHED_NODE_MESSAGE,
	UNCLICKABLE_NODE_MESSAGE,
	"Node is either not visible or not an HTMLElement",
];

/** Relocations one action makes before it reports the element as stale. */
export const RELOCATION_ATTEMPTS = 3;

/**
 * Puppeteer `aria/` selector for exactly this role and name. Null when the name holds both quote
 * characters, which the selector grammar cannot express.
 */
export function ariaSelectorFor(identity: ElementIdentity): string | null {
	const quote = !identity.name.includes('"') ? '"' : !identity.name.includes("'") ? "'" : null;
	if (quote === null) return null;
	return `aria/[name=${quote}${identity.name}${quote}][role="${identity.role}"]`;
}

/** The single element of `page` with this role and accessible name, or null when there are none or several. */
export async function relocateElement(page: Page, identity: ElementIdentity): Promise<ElementHandle | null> {
	const selector = ariaSelectorFor(identity);
	if (selector === null) return null;
	const matches = await page.$$(selector);
	if (matches.length === 1) return matches[0]!;
	await releaseHandles(matches);
	return null;
}

/*
 * Scroll, focus and select check that the node is in its document in the same evaluation that acts
 * on it, and throw puppeteer's detached-node error when it is not. Puppeteer checks and acts in two
 * round trips, or acts without checking: scrolling, focusing or selecting a detached node succeeds
 * and changes nothing the page shows, so a page that replaced the node between the two round trips
 * left the action reporting success having done nothing.
 */

/** Scrolls `target` to the centre of the viewport, as puppeteer's `scrollIntoView()` does. */
export async function scrollConnected(target: ElementHandle): Promise<void> {
	const connected = await target.evaluate(node => {
		const el = node as unknown as PointerProbeElement;
		if (!el.isConnected) return false;
		el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		return true;
	});
	if (!connected) throw new Error(DETACHED_NODE_MESSAGE);
}

/** Focuses `target`, as puppeteer's `focus()` does for an HTML element, and an SVG element too. */
export async function focusConnected(target: ElementHandle): Promise<void> {
	const connected = await target.evaluate(node => {
		const el = node as unknown as { readonly isConnected: boolean; focus(): void };
		if (!el.isConnected) return false;
		el.focus();
		return true;
	});
	if (!connected) throw new Error(DETACHED_NODE_MESSAGE);
}

/**
 * Selects `values` on the `<select>` `target` and returns the values it selected, as puppeteer's
 * `select()` does: a single select takes the first option whose value is listed, a multiple select
 * takes every one, and the element then receives `input` and `change`.
 */
export async function selectConnected(target: ElementHandle, values: string[]): Promise<string[]> {
	for (const value of values) {
		if (typeof value !== "string") {
			throw new Error(`Values must be strings. Found value "${value}" of type "${typeof value}"`);
		}
	}
	const outcome = await target.evaluate((node, wanted): string[] | "detached" | "not-select" => {
		interface SelectOption {
			readonly value: string;
			selected: boolean;
		}
		const el = node as unknown as {
			readonly isConnected: boolean;
			readonly multiple: boolean;
			readonly options: ArrayLike<SelectOption>;
			dispatchEvent(event: unknown): boolean;
		};
		if (!el.isConnected) return "detached";
		const page = globalThis as unknown as {
			HTMLSelectElement: abstract new () => object;
			Event: new (type: string, init: { bubbles: boolean }) => unknown;
		};
		if (!(el instanceof page.HTMLSelectElement)) return "not-select";
		const listed = new Set(wanted);
		const selected = new Set<string>();
		const options = Array.from(el.options);
		for (const option of options) {
			option.selected = el.multiple && listed.has(option.value);
			if (option.selected) selected.add(option.value);
		}
		const first = el.multiple ? undefined : options.find(option => listed.has(option.value));
		if (first) {
			first.selected = true;
			selected.add(first.value);
		}
		el.dispatchEvent(new page.Event("input", { bubbles: true }));
		el.dispatchEvent(new page.Event("change", { bubbles: true }));
		return [...selected];
	}, values);
	if (outcome === "detached") throw new Error(DETACHED_NODE_MESSAGE);
	if (outcome === "not-select") throw new Error("Element is not a <select> element.");
	return outcome;
}

/** The DOM an element exposes to {@link pointerPoint}'s page-side probe. */
interface PointerProbeElement {
	readonly isConnected: boolean;
	readonly ownerDocument: {
		readonly documentElement: { readonly clientWidth: number; readonly clientHeight: number };
	};
	getBoundingClientRect(): { left: number; top: number; right: number; bottom: number };
	getClientRects(): ArrayLike<{ x: number; y: number; width: number; height: number }>;
	getRootNode(): { elementFromPoint?(x: number, y: number): unknown };
	contains(other: unknown): boolean;
	scrollIntoView(options: { block: "center"; inline: "center"; behavior: "instant" }): void;
}

/**
 * The viewport point a click, hover or tap on `target` aims at, read in one evaluation: puppeteer's
 * `clickablePoint()`, the centre of the first client rect at least one pixel each way after clipping
 * to the viewport, or `offset` from that rect's top-left corner. The element is scrolled to the centre
 * first when it is not wholly inside the viewport or another element covers that point.
 *
 * Puppeteer reads the same point over several round trips, the first of which waits a frame for an
 * IntersectionObserver, and a page that replaces the node within that frame fails the action: on a
 * page that redraws every 20 ms, 78 of 100 `ElementHandle.click()` calls fail. The point is in the
 * coordinates of the frame `target` is in, which are the page's only for the main frame.
 */
export async function pointerPoint(target: ElementHandle, offset?: Offset): Promise<Point> {
	const probe = await target.evaluate((node, offset): Point | "detached" | "unclickable" => {
		const el = node as unknown as PointerProbeElement;
		if (!el.isConnected) return "detached";
		const viewport = el.ownerDocument.documentElement;
		const visibleBox = () => {
			for (const rect of Array.from(el.getClientRects())) {
				const x = Math.max(rect.x, 0);
				const y = Math.max(rect.y, 0);
				const width = Math.min(rect.x + rect.width, viewport.clientWidth) - x;
				const height = Math.min(rect.y + rect.height, viewport.clientHeight) - y;
				if (width >= 1 && height >= 1) return { x, y, width, height };
			}
			return null;
		};
		let box = visibleBox();
		const bounds = el.getBoundingClientRect();
		const whole =
			bounds.left >= 0 &&
			bounds.top >= 0 &&
			bounds.right <= viewport.clientWidth &&
			bounds.bottom <= viewport.clientHeight;
		const hit = box && el.getRootNode().elementFromPoint?.(box.x + box.width / 2, box.y + box.height / 2);
		if (!box || !whole || !hit || !el.contains(hit)) {
			el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
			box = visibleBox();
		}
		if (!box) return "unclickable";
		return offset
			? { x: box.x + offset.x, y: box.y + offset.y }
			: { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	}, offset ?? null);
	if (probe === "detached") throw new Error(DETACHED_NODE_MESSAGE);
	if (probe === "unclickable") throw new Error(UNCLICKABLE_NODE_MESSAGE);
	return probe;
}

/**
 * Whether `error` from an action on `target` means its node left a document that still exists:
 * a detached-node message, and a node that evaluates as disconnected. A connected node that cannot
 * be clicked, and a node whose document is gone, both fail the evaluation and keep their error.
 */
export async function leftTheDocument(target: ElementHandle, error: unknown): Promise<boolean> {
	const message = errorMessage(error);
	if (!DETACHED_ELEMENT_MESSAGES.some(fragment => message.includes(fragment))) return false;
	const disconnected = await optionalResult(
		target.evaluate(el => !el.isConnected),
		"a node whose document was replaced did not leave it in a re-render",
	);
	return disconnected === true;
}

/**
 * Run `act` on `handle`; when it fails because the node left the document, run it on the element
 * `relocation` resolves, up to {@link RELOCATION_ATTEMPTS} times. A relocated handle is released after
 * its attempt. Throws `relocation.stale(cause)` when there is no single replacement or every
 * replacement left the document too.
 */
export async function withRelocation<T>(
	handle: ElementHandle,
	relocation: HandleRelocation,
	act: (target: ElementHandle) => Promise<T>,
): Promise<T> {
	try {
		return await act(handle);
	} catch (error) {
		if (!(await leftTheDocument(handle, error))) throw error;
		let cause = errorMessage(error);
		for (let attempt = 0; attempt < RELOCATION_ATTEMPTS; attempt++) {
			const fresh = await relocation.relocate();
			if (!fresh) break;
			try {
				return await act(fresh);
			} catch (retryError) {
				if (!(await leftTheDocument(fresh, retryError))) throw retryError;
				cause = errorMessage(retryError);
			} finally {
				await releaseHandle(fresh);
			}
		}
		throw relocation.stale(cause);
	}
}
