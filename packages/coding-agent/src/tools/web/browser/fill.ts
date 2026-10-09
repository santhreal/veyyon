/**
 * `tab.fill` and a handle's `fill()`: the plan made in the page for an element and a value, and the
 * trusted edits that carry it out ({@link fillViaHandle}).
 */

import { untilAborted } from "@veyyon/utils";
import type { CDPSession, ElementHandle, KeyInput } from "puppeteer-core";
import { ToolError } from "../../core/tool-errors";
import { DETACHED_NODE_MESSAGE } from "./element-identity";
import { type CdpNode, collectDateFields, planDateKeys } from "./field-keys";
import { fillTypesKeyByKey, type NaturalInput } from "./natural-input";

/** What `fill` does with an element, decided in the page. */
type FillPlan =
	| { readonly kind: "insert" }
	/** The input holds the value already: a person changes nothing. */
	| { readonly kind: "held" }
	/** A date or time input, whose editor's fields take `value`'s parts ({@link planDateKeys}). */
	| { readonly kind: "fields"; readonly type: string; readonly value: string }
	/** A range, which these keys move to `value`. */
	| { readonly kind: "keys"; readonly keys: readonly KeyInput[]; readonly value: string }
	/** An input no key reaches `value` on (a colour, a range too far for keys); the script sets it. */
	| { readonly kind: "script"; readonly value: string }
	| { readonly kind: "refuse"; readonly reason: string }
	/** The element left its document, so a re-rendered element's replacement takes the fill instead. */
	| { readonly kind: "detached" };

/** An element as `activeElement` returns it: what took focus in a document or shadow root. */
interface FocusHolder {
	readonly isContentEditable?: boolean;
	contains(node: unknown): boolean;
}

/** The parts of an element `fill` touches, typed here because this package compiles without the DOM lib. */
interface FillTarget extends FocusHolder {
	readonly tagName: string;
	readonly isConnected: boolean;
	readonly type?: string;
	readonly disabled?: boolean;
	readonly readOnly?: boolean;
	readonly min?: string;
	readonly max?: string;
	readonly step?: string;
	value?: string;
	focus(): void;
	select?(): void;
	cloneNode(deep: boolean): FillTarget;
	dispatchEvent(event: unknown): boolean;
	/** The document or shadow root the element is in. */
	getRootNode(): { readonly activeElement: FocusHolder | null };
	readonly ownerDocument: {
		createRange(): { selectNodeContents(node: unknown): void };
		readonly defaultView: {
			getSelection(): { removeAllRanges(): void; addRange(range: unknown): void } | null;
			getComputedStyle(element: unknown): { readonly writingMode: string };
			readonly Event: new (type: string, init?: { bubbles?: boolean; composed?: boolean }) => unknown;
		} | null;
	};
}

/**
 * Decide in the page how to fill `element` with `value`, and do the part that happens there. A text
 * field has its contents selected so the insertion, or the first typed key, replaces them. An input
 * whose value is a date, time, colour or number range is assigned `value` and given its old value back,
 * which fires no event, to learn the form it holds `value` in; one it cannot hold is refused. A range's
 * keys are planned here. Anything else is refused with what to use instead.
 * Serialized into the page, so it reaches nothing outside itself.
 *
 * It runs in puppeteer's isolated world, as every element handle's evaluation does, where a property
 * a framework defines on the element in the page's own world (React's value tracker) is not visible.
 */
function planFill(element: unknown, value: string): FillPlan {
	const el = element as FillTarget;
	if (!el.isConnected) return { kind: "detached" };
	const tag = el.tagName.toLowerCase();
	const refuse = (reason: string): FillPlan => ({ kind: "refuse", reason });
	// The insertion goes to whatever holds focus: an element that did not take it (hidden, inert, not
	// rendered) would have its value typed into another field.
	const unfocusable = (): FillPlan => refuse(`the <${tag}> cannot take focus: it is hidden, inert or not rendered`);
	const selectAll = (): FillPlan => {
		el.focus();
		if (el.getRootNode().activeElement !== el) return unfocusable();
		el.select?.();
		return { kind: "insert" };
	};
	if (tag === "input") {
		const type = (el.type ?? "text").toLowerCase();
		if (type === "checkbox" || type === "radio") return refuse(`an <input type="${type}"> is set by clicking it`);
		if (type === "file") return refuse(`an <input type="file"> takes files through tab.uploadFile`);
		if (["button", "hidden", "image", "reset", "submit"].includes(type)) {
			return refuse(`an <input type="${type}"> holds no text`);
		}
		if (el.disabled) return refuse("the <input> is disabled");
		if (el.readOnly) return refuse("the <input> is read-only");
		if (["color", "date", "datetime-local", "month", "range", "time", "week"].includes(type)) {
			const previous = el.value ?? "";
			el.value = value;
			// An input keeps a value it holds in its own form: a colour in lower case, a local date and time
			// without zero seconds, a range as the number it is. One it cannot hold is replaced: a colour by
			// black, a range by its nearest step or bound, a date or a time by nothing.
			const now = el.value ?? "";
			el.value = previous;
			const held =
				type === "color"
					? now === value.toLowerCase()
					: type === "range"
						? value.trim() !== "" && Number(now) === Number(value)
						: now !== "" || value === "";
			if (!held) return refuse(`${JSON.stringify(value)} is not a value an <input type="${type}"> holds`);
			if (now === previous) return { kind: "held" };
			if (type === "color") return { kind: "script", value: now };
			if (type !== "range") return { kind: "fields", type, value: now };
			// The keys Chromium's range takes (`RangeInputType::HandleKeydownEvent`): Home and End go to the
			// ends, PageUp and PageDown move a tenth of the range, and the arrows a step, each clamped and
			// aligned as an assigned value is, which a detached copy of the input computes. ArrowUp steps up
			// in a horizontal slider only.
			const probe = el.cloneNode(false);
			const settle = (candidate: number): string => {
				probe.value = String(candidate);
				return probe.value ?? "";
			};
			const number = (text: string | undefined, fallback: number): number => {
				const parsed = Number(text);
				return text !== undefined && text.trim() !== "" && Number.isFinite(parsed) ? parsed : fallback;
			};
			const minimum = number(el.min, 0);
			const maximum = Math.max(number(el.max, 100), minimum);
			const stepText = (el.step ?? "").trim().toLowerCase();
			const stepNumber = number(el.step, 1);
			const step = stepText === "any" ? (maximum - minimum) / 100 : stepNumber > 0 ? stepNumber : 1;
			const bigStep = Math.max((maximum - minimum) / 10, step);
			const horizontal = el.ownerDocument.defaultView?.getComputedStyle(el).writingMode === "horizontal-tb";
			const moves: Array<[KeyInput, (from: string) => string]> = [
				["Home", () => settle(minimum)],
				["End", () => settle(maximum)],
				["PageUp", from => settle(Number(from) + bigStep)],
				["PageDown", from => settle(Number(from) - bigStep)],
			];
			if (horizontal) {
				moves.push(
					["ArrowUp", from => settle(Number(from) + step)],
					["ArrowDown", from => settle(Number(from) - step)],
				);
			}
			const paths = new Map<string, KeyInput[]>([[previous, []]]);
			const queue = [previous];
			while (queue.length > 0 && paths.size < 4_000) {
				const from = queue.shift()!;
				const path = paths.get(from)!;
				if (path.length >= 40) continue;
				for (const [key, move] of moves) {
					const to = move(from);
					if (paths.has(to)) continue;
					const next = [...path, key];
					if (to === now) return { kind: "keys", keys: next, value: now };
					paths.set(to, next);
					queue.push(to);
				}
			}
			return { kind: "script", value: now };
		}
		return selectAll();
	}
	if (tag === "textarea") {
		if (el.disabled) return refuse("the <textarea> is disabled");
		if (el.readOnly) return refuse("the <textarea> is read-only");
		return selectAll();
	}
	if (tag === "select") return refuse("a <select> is set with tab.select(selector, ...values)");
	if (el.isContentEditable) {
		el.focus();
		const range = el.ownerDocument.createRange();
		range.selectNodeContents(el);
		const selection = el.ownerDocument.defaultView?.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		// An element inside an editor is edited through the editor's host, which the selection focuses.
		const active = el.getRootNode().activeElement;
		if (active?.isContentEditable !== true || !active.contains(el)) return unfocusable();
		return { kind: "insert" };
	}
	return refuse(`a <${tag}> is not an <input>, a <textarea> or contenteditable`);
}

/** Natural input for a fill, and the time its typing may take. */
export interface FillTyping {
	readonly input: NaturalInput;
	readonly withinMs: number;
}

/**
 * Replace an element's value, shared by `tab.fill` and enriched handles. The new value goes into the
 * selected contents as trusted edits: key by key when `typing` is given and {@link fillTypesKeyByKey}
 * holds for the value, as a person types a short one; otherwise in one text insertion, the one a paste
 * makes, which costs one round trip at any length. React, Vue and every other framework that listens
 * for `input` sees a real edit either way. `change` fires when focus leaves, as it does for a person.
 *
 * A date or time input is pressed and typed field by field, and a range moved with keys, so its
 * `input` and `change` are the browser's own. What they leave short of the value, and a colour, which
 * no key sets, is assigned in the page with the two events dispatched.
 */
export async function fillViaHandle(
	handle: ElementHandle,
	value: string,
	signal: AbortSignal | undefined,
	typing: FillTyping | null,
): Promise<void> {
	const plan = await untilAborted(signal, () => handle.evaluate(planFill, value));
	if (plan.kind === "detached") throw new Error(DETACHED_NODE_MESSAGE);
	if (plan.kind === "refuse") throw new ToolError(`fill: ${plan.reason}`);
	if (plan.kind === "held") return;
	if (plan.kind === "insert") {
		// The first key replaces the selection, as it does when a person types over selected text.
		if (typing && fillTypesKeyByKey(value, typing.withinMs)) {
			await typing.input.type(value, typing.withinMs, signal);
			return;
		}
		// An empty insertion deletes the selection, so clearing a field is the same one edit.
		await untilAborted(signal, () => handle.frame.page().keyboard.sendCharacter(value));
		return;
	}
	if (plan.kind === "fields") await typeDateFields(handle, plan.type, plan.value, signal, typing);
	if (plan.kind === "keys") {
		const keyboard = handle.frame.page().keyboard;
		await untilAborted(signal, () => handle.focus());
		if (typing) await typing.input.pressKeys(plan.keys, typing.withinMs, signal);
		else for (const key of plan.keys) await untilAborted(signal, () => keyboard.press(key));
	}
	await untilAborted(signal, () => handle.evaluate(settleFieldValue, plan.value));
}

/**
 * Leave `value` in an input whose keys may have left it short: assign it and dispatch `input` and
 * `change` when the input holds another value. Serialized into the page.
 */
function settleFieldValue(element: unknown, value: string): boolean {
	const el = element as FillTarget;
	if (el.value === value) return false;
	el.focus();
	el.value = value;
	const view = el.ownerDocument.defaultView;
	if (view) {
		el.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
		el.dispatchEvent(new view.Event("change", { bubbles: true }));
	}
	return true;
}

/**
 * Press each field of a date or time input's editor and type its part of `value` ({@link planDateKeys}),
 * or clear it with Backspace for an empty value. The fields are read from the user-agent shadow tree
 * over the handle's own session, which holds its object id; their boxes are placed on the page by the
 * input's own box, which puppeteer places across frames.
 */
async function typeDateFields(
	handle: ElementHandle,
	type: string,
	value: string,
	signal: AbortSignal | undefined,
	typing: FillTyping | null,
): Promise<void> {
	const client = (handle as unknown as { client?: CDPSession }).client;
	const objectId = handle.remoteObject().objectId;
	if (!client || !objectId) return;
	const described = (await untilAborted(signal, () =>
		client.send("DOM.describeNode", { objectId, depth: -1, pierce: true }),
	)) as { node: CdpNode };
	const fields = collectDateFields(described.node);
	const keys = planDateKeys(type, value, fields);
	if (!keys) return;
	const page = handle.frame.page();
	const input = typing?.input ?? null;
	if (!(await untilAborted(signal, () => handle.isIntersectingViewport({ threshold: 1 })))) {
		if (!(input && (await input.scrollIntoView(handle, signal)))) {
			await untilAborted(signal, () => handle.scrollIntoView());
		}
	}
	const box = await untilAborted(signal, () => handle.boundingBox());
	const model = (await untilAborted(signal, () => client.send("DOM.getBoxModel", { objectId }))) as {
		model: { border: number[] };
	};
	if (!box) return;
	const offsetX = box.x - (model.model.border[0] ?? 0);
	const offsetY = box.y - (model.model.border[1] ?? 0);
	const withinMs = typing ? typing.withinMs / fields.length : 0;
	for (let index = 0; index < fields.length; index++) {
		const found = (await untilAborted(signal, () =>
			client.send("DOM.getContentQuads", { backendNodeId: fields[index]!.backendNodeId }),
		)) as { quads: number[][] };
		const quad = found.quads[0];
		if (!quad) return;
		const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
		const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
		const extent = { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
		const point = {
			x: offsetX + Math.min(...xs) + extent.width / 2,
			y: offsetY + Math.min(...ys) + extent.height / 2,
		};
		if (input) {
			await input.moveTo(point, extent, signal);
			await input.dwell(signal);
			await input.click({}, signal);
		} else {
			await untilAborted(signal, () => page.mouse.click(point.x, point.y));
		}
		const text = keys[index]!;
		if (text === "") {
			if (input) await input.pressKeys(["Backspace"], withinMs, signal);
			else await untilAborted(signal, () => page.keyboard.press("Backspace"));
		} else if (input) {
			await input.type(text, withinMs, signal);
		} else {
			await untilAborted(signal, () => page.keyboard.type(text));
		}
	}
}
