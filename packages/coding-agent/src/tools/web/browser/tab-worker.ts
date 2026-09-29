import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { errorMessage, isTimeoutError, postmortem, Snowflake, untilAborted } from "@veyyon/utils";
// The owner, not the barrel: this module reaches the two discard contracts and nothing else.
import { bestEffort, optionalResult } from "@veyyon/utils/discarded-fault";
import type { HTMLElement } from "linkedom";
import type {
	Browser,
	CDPSession,
	ClickOptions,
	Dialog,
	ElementHandle,
	ElementScreenshotOptions,
	FileChooser,
	Frame,
	HTTPResponse,
	ImageFormat,
	KeyboardTypeOptions,
	KeyInput,
	Page,
	SerializedAXNode,
	Target,
} from "puppeteer-core";
import { JsRuntime, type RuntimeHooks } from "../../../eval/js/shared/runtime";
import { scopedTimeoutSignal } from "../../../utils/fetch-timeout";
import { resizeImage } from "../../../utils/image-resize";
import { resolveToCwd } from "../../core/path-utils";
import { formatScreenshot } from "../../core/render-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "../../core/tool-errors";
import {
	type AriaSnapshotOptions,
	captureAriaSnapshot,
	parseAriaRefSelector,
	resolveAriaRefHandle,
} from "./aria-snapshot";
import { type ChainedHandle, chainHandle } from "./chained-handle";
import { PortTransport } from "./connection-relay";
import { type CdpNode, collectDateFields, planDateKeys } from "./field-keys";
import { releaseHandle, releaseHandles } from "./handle-release";
import { hasTextSelector } from "./has-text";
import {
	applyStealthPatches,
	applyViewport,
	BROWSER_PROTOCOL_TIMEOUT_MS,
	DEFAULT_VIEWPORT,
	loadPuppeteer,
} from "./launch";
import { type Extent, fillTypesKeyByKey, NaturalInput, type PressGesture } from "./natural-input";
import { extractReadableFromHtml, type ReadableFormat } from "./readable";
import {
	CELL_BUDGET_SLACK_MS,
	markHandled,
	resolvePredicateTimeout,
	type WaitPredicateOptions,
	waitForBrowserRun,
} from "./run-cancellation";
import { cloneSafe, RunOutput } from "./run-output";
import { planSelect, readSelectState, type SelectPlan, type SelectState, settleSelection } from "./select-keys";
import {
	applyStorageState,
	captureStorageState,
	parseStorageState,
	readStorageStateFile,
	type StorageState,
	type StorageStateLoaded,
	writeStorageStateFile,
} from "./storage-state";
import { guardTabApi } from "./tab-api-guard";
import type {
	Observation,
	ObservationEntry,
	ReadyInfo,
	ScreenshotResult,
	SessionSnapshot,
	TabRunErrorPayload,
	TabWorkerInbound,
	TabWorkerTransport,
	ToolReply,
	WorkerInitPayload,
} from "./tab-protocol";
import { targetIdForPage, targetIdForTarget } from "./target-id";

declare module "puppeteer-core" {
	interface Frame {
		/** Puppeteer's main JavaScript realm, retained by our pinned runtime patch. */
		mainRealm(): Realm;
	}
}

declare global {
	interface Element extends HTMLElement {}
	function getComputedStyle(element: Element): Record<string, unknown>;
	var innerWidth: number;
	var innerHeight: number;
	var document: {
		elementFromPoint(x: number, y: number): Element | null;
	};
}

const INTERACTIVE_AX_ROLES = new Set([
	"button",
	"link",
	"textbox",
	"combobox",
	"listbox",
	"option",
	"checkbox",
	"radio",
	"switch",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"slider",
	"spinbutton",
	"searchbox",
	"treeitem",
]);

const LEGACY_SELECTOR_PREFIXES = ["p-aria/", "p-text/", "p-xpath/", "p-pierce/"] as const;

const SELECTOR_HANDLER_PREFIXES = [
	"aria/",
	"text/",
	"xpath/",
	"pierce/",
	"aria-ref=",
	"aria-ref/",
	"ariaref/",
	"p-",
] as const;

/**
 * Playwright-only selector engines/pseudos puppeteer cannot parse. Without this guard a
 * `tab.click(":has-text(...)")` would wait the full action timeout and fail opaquely;
 * fail fast instead with a pointer to the puppeteer-native alternative. Skipped for
 * explicit query-handler prefixes (`text/`, `aria/`, …) whose payload is literal text.
 */
const PLAYWRIGHT_ONLY_SELECTOR_RE =
	/:has-text\(|:text\(|:text-is\(|:text-matches\(|:visible\b|:hidden\b|:nth-match\(|:near\(|:above\(|:below\(|:right-of\(|:left-of\(/;

/**
 * A snapshot line's own form, `role "name"` (`textbox "Email"`), which a model copies from
 * `tab.ariaSnapshot()`. It is no CSS, and it names one element exactly: the one with that role and
 * that accessible name, which puppeteer's aria handler finds.
 */
const SNAPSHOT_LINE_SELECTOR = /^([a-z]+) "((?:[^"\\]|\\.)*)"$/;

/**
 * A role and a name in attribute form: `textbox[name="Email"]`, or Playwright's
 * `role=button[name="Sign in"]`. Without `role=` the word must be one of the roles below, so a CSS
 * selector such as `input[name="q"]` keeps its meaning.
 */
const ROLE_NAME_SELECTOR = /^(role=)?([a-z]+)\[name=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\]$/;

/**
 * Playwright's `css:has-text("text")`, the pseudo-class ending the selector: the elements the CSS
 * matches whose text holds the text, case and spacing aside. It resolves through the query handler
 * `has-text.ts` registers with puppeteer.
 */
const HAS_TEXT_SELECTOR = /^(.*?):has-text\((?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^"')]*))\)$/;

/**
 * ARIA roles no HTML element is named after, plus `link`, whose `<link>` element takes no `name`
 * attribute: `<role>[name=…]` matches nothing as CSS and can only mean the role.
 */
const ROLES_WITHOUT_AN_ELEMENT = new Set([
	"alert",
	"cell",
	"checkbox",
	"columnheader",
	"combobox",
	"gridcell",
	"heading",
	"link",
	"listbox",
	"listitem",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"radio",
	"row",
	"rowheader",
	"searchbox",
	"slider",
	"spinbutton",
	"switch",
	"tab",
	"textbox",
	"treeitem",
]);

/** Puppeteer's aria selector for the element with `role` and the exact name `quoted` unescapes to. */
function ariaRoleSelector(role: string, quoted: string): string {
	return `aria/${quoted.replace(/\\(.)/g, "$1")}[role="${role}"]`;
}

type DialogPolicy = "accept" | "dismiss";
type DragTarget = string | { readonly x: number; readonly y: number };
type ActionabilityResult = { ok: true; x: number; y: number } | { ok: false; reason: string };
/** Last JS dialog seen on the page; kept for timeout attribution until handled or navigation. */
interface OpenDialogInfo {
	type: string;
	message: string;
}

/**
 * Per-op fail-fast ceilings for `tab.*` helpers. All are kept strictly under the cell
 * budget (`timeoutMs - OP_DEADLINE_SLACK_MS`) so a stalled helper rejects with a named,
 * attributable error that leaves recovery budget — never the opaque whole-cell
 * "Browser code execution timed out" path that consumed the entire run.
 *
 * - `QUICK_OP_TIMEOUT_MS`: page-coupled reads that should resolve fast (`observe`,
 *   `screenshot`, `extract`, `ariaSnapshot`).
 * - `ACTION_OP_TIMEOUT_MS`: interactive point actions (`click`, `fill`, `type`, …) and
 *   the default for wait helpers when no explicit `{ timeout }` is given. Selector ops
 *   additionally fail fast after `ZERO_MATCH_FAIL_FAST_MS` of confirmed zero matches
 *   (see `#zeroMatchWatchdog`), so the full ceiling is only spent on elements that
 *   exist but are not yet actionable.
 *
 * `goto` and `evaluate` stay uncapped (`Number.POSITIVE_INFINITY`): navigation and user
 * code legitimately use the full cell budget.
 */
const QUICK_OP_TIMEOUT_MS = 20_000;
const ACTION_OP_TIMEOUT_MS = 8_000;
/** Headroom subtracted from the cell budget so a per-op deadline fires before it. */
const OP_DEADLINE_SLACK_MS = CELL_BUDGET_SLACK_MS;
/**
 * A selector op whose selector has matched nothing for this long fails fast with the
 * zero-match hint instead of burning the rest of its deadline: a wrong selector or a
 * wrong page (consent wall, pre-navigation document) is the common agent failure and
 * should cost ~2s, not the full action ceiling. Explicit `{ timeout }` waits opt out.
 */
const ZERO_MATCH_FAIL_FAST_MS = 2_000;
/** Poll cadence for the zero-match watchdog. */
const ZERO_MATCH_POLL_MS = 250;
/** How long a failed run waits for the page to say whether it has a name the run could not find. */
const PAGE_GLOBAL_PROBE_MS = 1_000;
/** The ops that wait for a navigation themselves, by label: one after them is not waiting on theirs. */
const NAVIGATING_OP = /^tab\.(?:goto|reload|waitForNavigation|waitForUrl)\(/;
/** The ops that read or wait and change no page, by label: they never start a navigation. */
const READ_ONLY_OP =
	/^(?:wait\(|tab\.(?:title|observe|ariaSnapshot|screenshot|extract|waitFor|waitForSelector|waitForResponse|storageState)\()/;
/**
 * How long a click or hover waits for whatever covers its element (a menu closing, a fade, a toast)
 * to go before it fails naming it. A cover that outlasts this is one the page expects dismissed.
 */
const COVERED_WAIT_MS = 2_500;
/** Poll cadence while a click or hover waits for its element to be uncovered. */
const COVERED_POLL_MS = 100;

export interface OpTimeouts {
	/** Largest per-op deadline allowed — strictly below the cell budget. */
	budgetBound: number;
	/** Ceiling for quick page reads. */
	quickOpMs: number;
	/** Ceiling for interactive actions + default for waits. */
	actionOpMs: number;
}

/** Resolve the per-op fail-fast ceilings for a given cell budget. */
export function resolveOpTimeouts(cellTimeoutMs: number): OpTimeouts {
	const budgetBound = Math.max(1, cellTimeoutMs - OP_DEADLINE_SLACK_MS);
	return {
		budgetBound,
		quickOpMs: Math.min(budgetBound, QUICK_OP_TIMEOUT_MS),
		actionOpMs: Math.min(budgetBound, ACTION_OP_TIMEOUT_MS),
	};
}

/**
 * Effective timeout for a wait helper (`waitFor*`). A positive explicit `{ timeout }` is
 * honored but clamped to the cell budget so it still fails fast + named; raising the tool
 * `timeout` raises that cap, so a longer budget stays meaningful. No `{ timeout }` → the
 * action ceiling. Puppeteer's `{ timeout: 0 }` / `Infinity` ("disable") maps to the largest
 * bounded wait (`budgetBound`) — the harness never permits an unbounded wait. Garbage input
 * (negative, `NaN`) falls back to the action ceiling rather than the longest wait.
 */
export function resolveWaitTimeout(cellTimeoutMs: number, explicit?: number): number {
	const { budgetBound, actionOpMs } = resolveOpTimeouts(cellTimeoutMs);
	if (explicit === undefined) return actionOpMs;
	// Puppeteer "disable" sentinels — still bounded by the budget here.
	if (explicit === 0 || explicit === Number.POSITIVE_INFINITY) return budgetBound;
	// Positive finite → honored + clamped. Negative/NaN garbage → default, not the longest wait.
	if (Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, budgetBound);
	return actionOpMs;
}

interface ScreenshotOptions {
	selector?: string;
	fullPage?: boolean;
	save?: string;
	silent?: boolean;
}

export interface TabApi {
	readonly name: string;
	readonly page: Page;
	readonly signal?: AbortSignal;
	url(): string;
	title(): Promise<string>;
	goto(
		url: string,
		opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2" },
	): Promise<void>;
	/** Load the current URL again, with `goto`'s waiting and deadline. */
	reload(opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2" }): Promise<void>;
	observe(opts?: { includeAll?: boolean; viewportOnly?: boolean }): Promise<Observation>;
	ariaSnapshot(selector?: string, opts?: AriaSnapshotOptions): Promise<string>;
	screenshot(opts?: ScreenshotOptions): Promise<ScreenshotResult>;
	extract(format?: ReadableFormat): Promise<string>;
	click(selector: string): Promise<void>;
	type(selector: string, text: string): Promise<void>;
	fill(selector: string, value: string): Promise<void>;
	press(key: KeyInput, opts?: { selector?: string }): Promise<void>;
	scroll(deltaX: number, deltaY: number): Promise<void>;
	drag(from: DragTarget, to: DragTarget): Promise<void>;
	waitFor(selector: string, opts?: { timeout?: number }): Promise<ActionableHandle>;
	evaluate<TResult, TArgs extends unknown[]>(
		fn: string | ((...args: TArgs) => TResult | Promise<TResult>),
		...args: TArgs
	): Promise<TResult>;
	scrollIntoView(selector: string): Promise<void>;
	select(selector: string, ...values: string[]): Promise<string[]>;
	uploadFile(selector: string, ...filePaths: string[]): Promise<void>;
	waitForUrl(pattern: string | RegExp, opts?: { timeout?: number }): Promise<string>;
	waitForResponse(
		pattern: string | RegExp | ((response: HTTPResponse) => boolean | Promise<boolean>),
		opts?: { timeout?: number },
	): Promise<HTTPResponse>;
	waitForSelector(
		selector: string,
		opts?: { timeout?: number; visible?: boolean; hidden?: boolean },
	): Promise<ActionableHandle | null>;
	waitForNavigation(opts?: {
		waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
		timeout?: number;
	}): Promise<HTTPResponse | null>;
	id(n: number): ChainedHandle<ActionableHandle>;
	ref(id: string): ChainedHandle<ActionableHandle>;
	/** The tab's context: every cookie it holds and the localStorage of every origin open in it; `path` also writes it there. */
	storageState(opts?: { path?: string }): Promise<StorageState>;
	/** Load a state, or the state file at a path, into the tab's context. */
	loadStorageState(stateOrPath: string | StorageState): Promise<StorageStateLoaded>;
}

export function normalizeSelector(selector: string): string {
	if (!selector) return selector;
	const trimmed = selector.trim();
	const line = SNAPSHOT_LINE_SELECTOR.exec(trimmed);
	if (line?.[1]) return ariaRoleSelector(line[1], line[2] ?? "");
	const named = ROLE_NAME_SELECTOR.exec(trimmed);
	if (named?.[2] && (named[1] || ROLES_WITHOUT_AN_ELEMENT.has(named[2])))
		return ariaRoleSelector(named[2], named[3] ?? named[4] ?? "");
	const hasText = HAS_TEXT_SELECTOR.exec(trimmed);
	const hasTextCss = hasText?.[1]?.trim() ?? "";
	if (
		hasText &&
		!SELECTOR_HANDLER_PREFIXES.some(prefix => trimmed.startsWith(prefix)) &&
		!PLAYWRIGHT_ONLY_SELECTOR_RE.test(hasTextCss)
	) {
		const text = (hasText[2] ?? hasText[3] ?? hasText[4] ?? "").replace(/\\(.)/g, "$1");
		return hasTextSelector({ css: hasTextCss || "*", text });
	}
	if (
		!SELECTOR_HANDLER_PREFIXES.some(prefix => selector.startsWith(prefix)) &&
		PLAYWRIGHT_ONLY_SELECTOR_RE.test(selector)
	) {
		throw new ToolError(
			`Playwright-only selector ${JSON.stringify(selector)} is not supported by the browser tool. ` +
				`Use css:has-text("…") at the end of a selector, a puppeteer text selector ("text/Allow all"), an aria selector ("aria/Name"), CSS, or "xpath/...".`,
		);
	}
	if (selector.startsWith("p-") && !LEGACY_SELECTOR_PREFIXES.some(prefix => selector.startsWith(prefix))) {
		throw new ToolError(
			`Unsupported selector prefix. Use CSS or puppeteer query handlers (aria/, text/, xpath/, pierce/). Got: ${selector}`,
		);
	}
	if (selector.startsWith("p-text/")) return `text/${selector.slice("p-text/".length)}`;
	if (selector.startsWith("p-xpath/")) return `xpath/${selector.slice("p-xpath/".length)}`;
	if (selector.startsWith("p-pierce/")) return `pierce/${selector.slice("p-pierce/".length)}`;
	if (selector.startsWith("p-aria/")) {
		const rest = selector.slice("p-aria/".length);
		const nameMatch = rest.match(/\[\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]]+))\s*\]/);
		const name = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
		if (name) return `aria/${name.trim()}`;
		return `aria/${rest}`;
	}
	return selector;
}

/**
 * The alternatives of a comma list that uses a form CSS does not have (`aria-ref=e5`, `[ref=e5]`,
 * `textbox "Email"`, `text/Sign in`), in the order written; null for any other selector, a plain CSS
 * list included, which the browser matches itself. A selector that starts with a query handler
 * (`text/`, `aria/`, …) is that handler's payload to its end, commas included. Commas inside
 * brackets, parentheses or quotes do not split.
 */
export function selectorAlternatives(selector: string): string[] | null {
	const trimmed = selector.trim();
	if (SELECTOR_HANDLER_PREFIXES.some(prefix => trimmed.startsWith(prefix))) return null;
	const parts: string[] = [];
	let depth = 0;
	let quote = "";
	let start = 0;
	for (let index = 0; index < trimmed.length; index++) {
		const char = trimmed[index];
		if (quote !== "") {
			if (char === "\\") index++;
			else if (char === quote) quote = "";
		} else if (char === '"' || char === "'") quote = char;
		else if (char === "(" || char === "[") depth++;
		else if (char === ")" || char === "]") depth--;
		else if (char === "," && depth === 0) {
			parts.push(trimmed.slice(start, index).trim());
			start = index + 1;
		}
	}
	parts.push(trimmed.slice(start).trim());
	if (parts.length < 2 || parts.includes("")) return null;
	const plainCss = (part: string): boolean =>
		parseAriaRefSelector(part) === null &&
		!SELECTOR_HANDLER_PREFIXES.some(prefix => part.startsWith(prefix)) &&
		normalizeSelector(part) === part;
	return parts.every(plainCss) ? null : parts;
}

/** Whether a query failed because its selector does not parse, which waiting cannot change. */
function isInvalidSelector(error: unknown): boolean {
	return /is not a valid selector/.test(errorMessage(error));
}

/** The failure for a selector that does not parse, with the forms a selector may take instead. */
function invalidSelectorMessage(label: string, selector: string): string {
	return `${label}: ${JSON.stringify(selector)} is not a valid selector. Use CSS, aria-ref=eN, role "name", text/… or aria/…, alone or as alternatives of a comma list.`;
}

function isInteractiveNode(node: SerializedAXNode): boolean {
	if (INTERACTIVE_AX_ROLES.has(node.role)) return true;
	return (
		node.checked !== undefined ||
		node.pressed !== undefined ||
		node.selected !== undefined ||
		node.expanded !== undefined ||
		node.focused === true
	);
}

function asElementHandle(handle: unknown): ElementHandle | null {
	return handle ? (handle as ElementHandle) : null;
}

/**
 * ElementHandle enriched with the `fill()` the tool docs promise on handles from `tab.id()`/`tab.ref()`/`tab.waitFor()`,
 * with a `click()` and `hover()` that never press what covers the element, and a `type()` at a person's pace.
 */
export type ActionableHandle = ElementHandle & { fill(value: string): Promise<void> };

/** What a handle's actions reach of the run in progress on its tab. */
interface HandleActions {
	/**
	 * Run a handle's action as an op of the run in progress on its tab, given that run's action deadline, so
	 * the action ends with its run and fails naming itself before the run's own deadline.
	 */
	run(label: string, action: (signal: AbortSignal, timeoutMs: number) => Promise<void>): Promise<void>;
	/** The natural input of the run in progress, or null when that run has it off or no run is in progress. */
	input(): NaturalInput | null;
}

/** A handle's own `click`, `hover` and `type`, kept at its first enrichment so a later one wraps puppeteer's, not a wrapper. */
interface OwnActions {
	click(options?: Readonly<ClickOptions>): Promise<void>;
	hover(): Promise<void>;
	type(text: string, options?: Readonly<KeyboardTypeOptions>): Promise<void>;
}

const ownActions = new WeakMap<ElementHandle, OwnActions>();

/**
 * Attach `fill()` to a puppeteer ElementHandle before handing it to user code, route its `click()` and
 * `hover()` through {@link pressUncovered}, and pace its `type()` when natural input is on, each as an
 * action `actions` runs. Puppeteer handles expose `type()` but no `fill()`; the semantics are the
 * selector-based `tab.fill()`'s.
 */
function toActionableHandle(handle: ElementHandle, actions: HandleActions): ActionableHandle {
	const own = ownActions.get(handle) ?? {
		click: handle.click.bind(handle),
		hover: handle.hover.bind(handle),
		type: handle.type.bind(handle),
	};
	ownActions.set(handle, own);
	const enriched = handle as ActionableHandle;
	enriched.fill = value =>
		actions.run("handle.fill()", (signal, timeoutMs) => {
			const input = actions.input();
			return fillViaHandle(handle, value, signal, input && { input, withinMs: timeoutMs / 2 });
		});
	// The press gives up before its op's deadline, so the reason it waited (a cover, a disabled control) is reported.
	enriched.click = options =>
		actions.run("handle.click()", (signal, timeoutMs) =>
			pressUncovered(
				handle,
				"handle.click()",
				() => own.click(options),
				Math.max(1, timeoutMs - PRESS_REPORT_MARGIN_MS),
				{
					signal,
					gesture: {
						kind: "click",
						button: options?.button,
						count: options?.count,
						holdMs: options?.delay,
					},
					// A fixed offset or a highlighted press is puppeteer's own; a natural press aims for itself.
					input: options?.offset === undefined && !options?.debugHighlight ? actions.input() : null,
				},
			),
		);
	enriched.hover = () =>
		actions.run("handle.hover()", (signal, timeoutMs) =>
			pressUncovered(handle, "handle.hover()", () => own.hover(), Math.max(1, timeoutMs - PRESS_REPORT_MARGIN_MS), {
				signal,
				gesture: { kind: "hover" },
				input: actions.input(),
			}),
		);
	enriched.type = (text, options) => {
		const input = actions.input();
		// A caller that sets its own pace types at that pace, as puppeteer does.
		if (input === null || options?.delay !== undefined) return own.type(text, options);
		return actions.run("handle.type()", async (signal, timeoutMs) => {
			await untilAborted(signal, () => handle.focus());
			await input.type(text, timeoutMs / 2, signal);
		});
	};
	return enriched;
}

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
	| { readonly kind: "refuse"; readonly reason: string };

/** An element as `activeElement` returns it: what took focus in a document or shadow root. */
interface FocusHolder {
	readonly isContentEditable?: boolean;
	contains(node: unknown): boolean;
}

/** The parts of an element `fill` touches, typed here because this package compiles without the DOM lib. */
interface FillTarget extends FocusHolder {
	readonly tagName: string;
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
interface FillTyping {
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
async function fillViaHandle(
	handle: ElementHandle,
	value: string,
	signal: AbortSignal | undefined,
	typing: FillTyping | null,
): Promise<void> {
	const plan = await untilAborted(signal, () => handle.evaluate(planFill, value));
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

/**
 * Strip `user:pass@` from a URL before surfacing it in tool outputs / details
 * so Basic Auth credentials don't leak into transcripts. Returns the original
 * string verbatim when it doesn't parse as a URL or when there are no
 * credentials to redact.
 */
function redactUrlCredentials(url: string): string {
	if (!url || (!url.includes("@") && !url.includes("//"))) return url;
	try {
		const parsed = new URL(url);
		if (!parsed.username && !parsed.password) return url;
		parsed.username = "";
		parsed.password = "";
		return parsed.toString();
	} catch {
		return url;
	}
}

function errorPayload(error: unknown): TabRunErrorPayload {
	if (error instanceof ToolAbortError) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: true };
	}
	if (error instanceof ToolError) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: true, isAbort: false };
	}
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: false };
	}
	return { name: "Error", message: errorMessage(error), isToolError: false, isAbort: false };
}

function replyError(payload: TabRunErrorPayload): Error {
	if (payload.isAbort) {
		const err = new ToolAbortError(payload.message || "Tool call aborted");
		if (payload.stack) err.stack = payload.stack;
		return err;
	}
	const Ctor = payload.isToolError ? ToolError : Error;
	const err = new Ctor(payload.message);
	if (payload.name) err.name = payload.name;
	if (payload.stack) err.stack = payload.stack;
	return err;
}

async function collectObservationEntries(
	core: WorkerCore,
	node: SerializedAXNode,
	entries: ObservationEntry[],
	options: { viewportOnly: boolean; includeAll: boolean },
): Promise<void> {
	if (options.includeAll || isInteractiveNode(node)) {
		// A node of a popup the page opened (a date or colour picker) belongs to no document of the page:
		// its element resolves to nothing, puppeteer's lookup throws, and it cannot be acted on by id.
		const handle = await optionalResult(node.elementHandle(), "a node in a picker popup has no element in the page");
		if (handle) {
			let inViewport = true;
			if (options.viewportOnly) {
				try {
					inViewport = await handle.isIntersectingViewport();
				} catch {
					inViewport = false;
				}
			}
			if (inViewport) {
				const id = core.nextElementId();
				const states: string[] = [];
				if (node.disabled) states.push("disabled");
				if (node.checked !== undefined) states.push(`checked=${String(node.checked)}`);
				if (node.pressed !== undefined) states.push(`pressed=${String(node.pressed)}`);
				if (node.selected !== undefined) states.push(`selected=${String(node.selected)}`);
				if (node.expanded !== undefined) states.push(`expanded=${String(node.expanded)}`);
				if (node.required) states.push("required");
				if (node.readonly) states.push("readonly");
				if (node.multiselectable) states.push("multiselectable");
				if (node.multiline) states.push("multiline");
				if (node.modal) states.push("modal");
				if (node.focused) states.push("focused");
				core.cacheElement(id, handle as ElementHandle);
				entries.push({
					id,
					role: node.role,
					name: node.name,
					value: node.value,
					description: node.description,
					keyshortcuts: node.keyshortcuts,
					states,
				});
			} else {
				await handle.dispose();
			}
		}
	}
	for (const child of node.children ?? []) {
		await collectObservationEntries(core, child, entries, options);
	}
}

/**
 * Which of the matched elements to click, and what happened to the ones that were not chosen.
 *
 * `probeFailures` is separate from "not visible" on purpose. Probing an element means evaluating in
 * the page, which throws when the node was detached between the query and the check, which is
 * routine on a re-rendering page. Both outcomes remove a candidate, but they mean opposite things to
 * whoever reads the timeout: a genuinely invisible element is a page or selector problem, while a
 * failed probe says the element was there and the check lost the race. Reporting both as
 * "no-visible-candidate" sent the reader after CSS for a re-render race.
 */
interface ClickTargetResolution {
	target: ElementHandle | null;
	/** Elements examined, which is every handle the selector matched. */
	probed: number;
	/** Elements dropped because a probe threw rather than because they were unclickable. */
	probeFailures: number;
	/** The first probe error's message, so the timeout can name the cause and not just count it. */
	firstProbeError: string | null;
}

async function resolveActionableQueryHandlerClickTarget(handles: ElementHandle[]): Promise<ClickTargetResolution> {
	const candidates: Array<{
		handle: ElementHandle;
		rect: { x: number; y: number; w: number; h: number };
		ownedProxy?: ElementHandle;
	}> = [];
	let probeFailures = 0;
	let firstProbeError: string | null = null;
	for (const handle of handles) {
		let clickable: ElementHandle = handle;
		let clickableProxy: ElementHandle | null = null;
		try {
			const proxy = await handle.evaluateHandle(el => {
				const target =
					(el as Element).closest(
						'a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]',
					) ?? el;
				return target;
			});
			clickableProxy = asElementHandle(proxy.asElement());
			if (clickableProxy) clickable = clickableProxy;
		} catch {
			// Looking for the clickable ancestor failed (detached node, or a frame that will not run
			// script). Clicking the matched element itself is the right degrade and is usually the same
			// thing: the ancestor lookup only matters when the match is a span inside a button. Not
			// counted as a probe failure, because the element is still a candidate.
		}
		try {
			const intersecting = await clickable.isIntersectingViewport();
			if (!intersecting) continue;
			const rect = (await clickable.evaluate(el => {
				const r = (el as Element).getBoundingClientRect();
				return { x: r.left, y: r.top, w: r.width, h: r.height };
			})) as { x: number; y: number; w: number; h: number };
			if (rect.w < 1 || rect.h < 1) continue;
			candidates.push({ handle: clickable, rect, ownedProxy: clickableProxy ?? undefined });
		} catch (err) {
			// The visibility probe threw, so this element is dropped without ever being judged. Counted
			// and reported: dropping it silently is what made a detached-node race read as an invisible
			// element in the timeout message.
			probeFailures += 1;
			firstProbeError ??= errorMessage(err);
		} finally {
			if (clickableProxy && clickableProxy !== handle && clickable !== clickableProxy) {
				await releaseHandle(clickableProxy);
			}
		}
	}
	const resolution = { probed: handles.length, probeFailures, firstProbeError };
	if (!candidates.length) return { target: null, ...resolution };
	candidates.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
	const winner = candidates[0]?.handle ?? null;
	for (let i = 1; i < candidates.length; i++) {
		const candidate = candidates[i]!;
		await releaseHandle(candidate.ownedProxy);
	}
	return { target: winner, ...resolution };
}

async function isClickActionable(handle: ElementHandle): Promise<ActionabilityResult> {
	return (await handle.evaluate(el => {
		const element = el as HTMLElement;
		const style = globalThis.getComputedStyle(element);
		if (style.display === "none") return { ok: false as const, reason: "display:none" };
		if (style.visibility === "hidden") return { ok: false as const, reason: "visibility:hidden" };
		if (style.pointerEvents === "none") return { ok: false as const, reason: "pointer-events:none" };
		if (Number(style.opacity) === 0) return { ok: false as const, reason: "opacity:0" };
		const r = element.getBoundingClientRect();
		if (r.width < 1 || r.height < 1) return { ok: false as const, reason: "zero-size" };
		// Inline clamp (not @veyyon/utils clampLow): this function is serialized and
		// injected into the page's own JS context, which has no access to workspace
		// modules — an import here would throw at evaluation time in the browser.
		const left = Math.max(0, Math.min(globalThis.innerWidth, r.left));
		const right = Math.max(0, Math.min(globalThis.innerWidth, r.right));
		const top = Math.max(0, Math.min(globalThis.innerHeight, r.top));
		const bottom = Math.max(0, Math.min(globalThis.innerHeight, r.bottom));
		if (right - left < 1 || bottom - top < 1) return { ok: false as const, reason: "off-viewport" };
		const x = Math.floor((left + right) / 2);
		const y = Math.floor((top + bottom) / 2);
		const topEl = globalThis.document.elementFromPoint(x, y);
		if (!topEl) return { ok: false as const, reason: "elementFromPoint-null" };
		if (topEl === element || element.contains(topEl) || (topEl as Element).contains(element))
			return { ok: true as const, x, y };
		return { ok: false as const, reason: "obscured" };
	})) as ActionabilityResult;
}

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

/** The element a press was waiting on left the page before it was pressed; nothing was pressed. */
class DetachedPressTarget extends ToolError {}

/**
 * How long before its op's deadline a press gives up with its own reason, so the reason (covered,
 * disabled) reaches the caller rather than the op's generic timeout.
 */
const PRESS_REPORT_MARGIN_MS = 500;

/** How long a `<select>` joins typed keys into one type-ahead search (`kTypeAheadTimeout`), and a margin. */
const TYPE_AHEAD_SESSION_MS = 1_100;

/** How long `tab.uploadFile` waits, after pressing a control, for the file chooser it opens. */
const CHOOSER_WAIT_MS = 2_000;

/** The target a natural drag's travel time takes a bare `{ x, y }` point to be. */
const DRAG_POINT_TARGET: Extent = { width: 20, height: 20 };

/** Centre an element in its scrollers and the viewport, which `DOM.scrollIntoViewIfNeeded` skips for one already visible. */
function centreInView(element: unknown): void {
	(element as { scrollIntoView(options: object): void }).scrollIntoView({
		block: "center",
		inline: "center",
		behavior: "instant",
	});
}

/** What a press does at its point: a click, with the options of a handle's `click`, or a hover, which only arrives. */
type Gesture = ({ readonly kind: "click" } & PressGesture) | { readonly kind: "hover" };

/** How far apart two points of the top document may be and still be the point the pointer rests on. */
const SAME_POINT_PX = 0.5;

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
 */
async function pressUncovered(
	handle: ElementHandle,
	label: string,
	press: () => Promise<void>,
	timeoutMs: number,
	options: { readonly signal?: AbortSignal; readonly gesture: Gesture; readonly input: NaturalInput | null },
): Promise<void> {
	const { signal, gesture, input } = options;
	const spread: PressAim | null = input ? { kind: "spread", ...input.aim() } : null;
	const started = Date.now();
	let centred = false;
	let placed = false;
	/** The point the pointer went to for this press: the aim that finds it again, and where it is in the top document. */
	let arrived: { readonly aim: PressAim; readonly at: FramePoint } | null = null;
	for (;;) {
		const aim = arrived?.aim ?? spread;
		const probe = (await untilAborted(signal, () =>
			handle.evaluate(probePress, gesture.kind === "click", aim),
		)) as PressProbe;
		const elapsed = Date.now() - started;
		if (probe.kind === "detached") {
			throw new DetachedPressTarget(
				`${label}: the element left the page before it was pressed, so nothing was pressed.`,
			);
		}
		if (!placed) {
			placed = true;
			if (!(await untilAborted(signal, () => handle.isIntersectingViewport({ threshold: 1 })))) {
				if (!(input && (await input.scrollIntoView(handle, signal)))) {
					await untilAborted(signal, () => handle.scrollIntoView());
				}
				continue;
			}
		}
		let cover = probe.kind === "covered" ? probe.by : null;
		if (probe.kind === "clear") {
			// A point clear in the element's own frame can still be covered by the page above that frame.
			const centre = await untilAborted(signal, () => reachThroughFrames(handle.frame, probe.point));
			cover = centre.cover;
			if (centre.cover === null) {
				if (!input || !aim || !probe.point || !centre.at) {
					await untilAborted(signal, press);
					return;
				}
				const aimed = probe.aimed;
				const aimedReach = aimed
					? await untilAborted(signal, () => reachThroughFrames(handle.frame, aimed))
					: undefined;
				const aimedAt = aimedReach?.cover === null ? aimedReach.at : undefined;
				if (arrived) {
					const rest = arrived.at;
					if (aimedAt && Math.hypot(aimedAt.x - rest.x, aimedAt.y - rest.y) <= SAME_POINT_PX) {
						if (gesture.kind === "click") await untilAborted(signal, () => input.click(gesture, signal));
						return;
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
			if (!(input && (await input.scrollIntoView(handle, signal)))) {
				await untilAborted(signal, () => handle.evaluate(centreInView));
			}
			continue;
		}
		if (cover !== null && elapsed >= Math.min(timeoutMs, COVERED_WAIT_MS)) {
			throw new ToolError(
				`${label}: ${cover} covers the point it would press, so nothing was pressed. Dismiss it (tab.press("Escape"), or a click outside it) or act on it instead.`,
			);
		}
		if (probe.kind === "disabled" && elapsed >= timeoutMs) {
			throw new ToolError(`${label}: the element stayed disabled for ${timeoutMs} ms, so nothing was pressed.`);
		}
		await delay(COVERED_POLL_MS, undefined, { signal });
	}
}

async function clickQueryHandlerText(
	page: Page,
	selector: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	input: NaturalInput | null,
): Promise<void> {
	const clickTimeout = scopedTimeoutSignal(timeoutMs, signal);
	const clickSignal = clickTimeout.signal;
	const start = Date.now();
	let lastSeen = 0;
	let lastReason: string | null = null;
	while (Date.now() - start < timeoutMs) {
		throwIfAborted(clickSignal);
		const handles = (await untilAborted(clickSignal, () => page.$$(selector))) as ElementHandle[];
		try {
			lastSeen = handles.length;
			const resolved = await resolveActionableQueryHandlerClickTarget(handles);
			const target = resolved.target;
			if (!target) {
				lastReason = describeMissingClickTarget(resolved);
				await untilAborted(clickSignal, () => Bun.sleep(100));
				continue;
			}
			const actionability = await isClickActionable(target);
			if (!actionability.ok) {
				lastReason = actionability.reason;
				await untilAborted(clickSignal, () => Bun.sleep(100));
				continue;
			}
			try {
				// The target passed the actionability check above; a natural press also checks the point it goes to.
				await (input
					? pressUncovered(
							target,
							`tab.click(${JSON.stringify(selector)})`,
							() => target.click(),
							Math.max(1, timeoutMs - (Date.now() - start)),
							{ signal: clickSignal, gesture: { kind: "click" }, input },
						)
					: untilAborted(clickSignal, () => target.click()));
				return;
			} catch (err) {
				lastReason = errorMessage(err);
				await untilAborted(clickSignal, () => Bun.sleep(100));
			}
		} finally {
			await releaseHandles(handles);
		}
	}
	clickTimeout.cancel();
	throw new ToolError(
		`Timed out clicking ${selector} (seen ${lastSeen} matches; last reason: ${lastReason ?? "unknown"}). ` +
			"If there are multiple matching elements, use observe + tab.id() or a more specific selector.",
	);
}

/**
 * Why no click target was chosen, in the words the timeout message needs.
 *
 * A probe that threw is called out separately from an element that was simply not visible, because
 * the two send the reader in opposite directions: "no-visible-candidate" for a detached-node race
 * had them inspecting CSS for an element that was on screen the whole time.
 */
export function describeMissingClickTarget(resolution: {
	probed: number;
	probeFailures: number;
	firstProbeError: string | null;
}): string {
	if (resolution.probed === 0) return "no-matches";
	if (resolution.probeFailures === 0) return "no-visible-candidate";
	const detail = resolution.firstProbeError ? `: ${resolution.firstProbeError}` : "";
	if (resolution.probeFailures === resolution.probed) {
		return `every candidate probe failed (${resolution.probeFailures} of ${resolution.probed})${detail}`;
	}
	return `no-visible-candidate, and ${resolution.probeFailures} of ${resolution.probed} probes failed${detail}`;
}

/**
 * Hint appended to a selector op's fail-fast timeout, given the selector's current
 * match count: a missing element (consent wall, wrong page) reads differently from
 * a present-but-unactionable one.
 */
export function formatSelectorMatchHint(count: number): string {
	return count === 0
		? "; selector currently matches no elements — run tab.observe() or tab.ariaSnapshot() to inspect the page"
		: `; selector currently matches ${count} element(s) but the action never became possible — the element may be hidden or covered (try tab.scrollIntoView() or a more specific selector)`;
}

export interface InflightOp {
	label: string;
	startedAt: number;
}

interface ActiveRun {
	id: string;
	ac: AbortController;
	signal: AbortSignal;
	output: RunOutput;
	screenshots: ScreenshotResult[];
	pendingTools: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>;
	/** Helper invocations currently awaiting the page/network, keyed by op id. */
	inflight: Map<number, InflightOp>;
	opCounter: number;
	/** The run's deadline for one interactive action (`resolveOpTimeouts`). */
	actionOpMs: number;
	/** The name the run's code runs under, which a rejection that code floated carries in its stack. */
	filename: string;
	/** Rejections the run's code floated, calls it did not await, claimed while the run is in progress. */
	floatingRejections: unknown[];
	/**
	 * The last op in this run that could change the page (reads and `wait` are skipped): whether it waits
	 * for a navigation itself (`goto`, `reload`, `waitForNavigation`, `waitForUrl`), and how many main-frame
	 * navigations had happened when it began.
	 */
	lastOp: { readonly navigating: boolean; readonly navigationsAtStart: number } | null;
	/** The page's natural input when the run's session has `browser.naturalInput` on, else null for instant input. */
	input: NaturalInput | null;
}

/**
 * Where a tab's core runs. In the tab's own worker thread only run code and the core float promises, so
 * the core claims every unhandled rejection there. Inline, on the main thread, it shares the realm with
 * the session and claims, through postmortem, only a rejection whose stack names a run's code.
 */
export type WorkerCoreOptions =
	| { readonly realm: "thread" }
	| {
			readonly realm: "inline";
			interceptUnhandledRejections(handler: (reason: unknown) => boolean): () => void;
	  };

/** How many ended runs' file names stay known, so a rejection one of them floats late is traced to it. */
const RECENT_RUN_FILES_MAX = 64;

/**
 * Run code's `fetch` is the tab worker's, which has no page URL to resolve a path such as
 * `/api/items` against and none of the page's cookies: the call fails as a bare "URL is invalid".
 * The failure says where a request the page would make belongs.
 */
function explainRelativeFetch(error: unknown): unknown {
	if (
		!(error instanceof Error) ||
		error.name !== "TypeError" ||
		!/^fetch\(\) URL is invalid|^Failed to parse URL from /.test(error.message)
	)
		return error;
	const explained = new ToolError(
		`${error.message}: run code executes in the tab worker, whose \`fetch\` has no page URL to resolve a path against and none of the page's cookies. Make the page's own request with \`await tab.evaluate(() => fetch("/path").then(r => r.json()))\`, or pass an absolute URL.`,
	);
	explained.stack = error.stack;
	return explained;
}

/** Report the rejections a run's code floated, beyond the one its result carries, in its output. */
function reportFloatingRejections(output: RunOutput, reasons: readonly unknown[]): void {
	for (const reason of reasons) {
		output.push({ type: "text", text: `[unhandled rejection (missing await?)] ${errorMessage(reason)}` });
	}
}

/** Human-readable label for a screenshot op, used in op tracking + timeout errors. */
export function describeScreenshot(opts?: ScreenshotOptions): string {
	if (opts?.selector) return `tab.screenshot({ selector: ${JSON.stringify(opts.selector)} })`;
	if (opts?.fullPage) return "tab.screenshot({ fullPage: true })";
	return "tab.screenshot()";
}

/** Map an explicit save path's extension to a puppeteer capture format (default png). */
export function imageFormatForPath(filePath: string): ImageFormat {
	switch (path.extname(filePath).toLowerCase()) {
		case ".webp":
			return "webp";
		case ".jpg":
		case ".jpeg":
			return "jpeg";
		default:
			return "png";
	}
}

/** Summarize still-running helpers (oldest first) so a cell timeout names what stalled. */
export function describeInflight(inflight: Map<number, InflightOp>): string {
	const now = Date.now();
	return Array.from(inflight.values())
		.sort((a, b) => a.startedAt - b.startedAt)
		.map(op => `${op.label} (${((now - op.startedAt) / 1000).toFixed(1)}s)`)
		.join(", ");
}

export class WorkerCore {
	#transport: TabWorkerTransport;
	#browser?: Browser;
	#page?: Page;
	#targetId?: string;
	#elementCache = new Map<number, ElementHandle>();
	#elementCounter = 0;
	#active: ActiveRun | null = null;
	#runtime: JsRuntime | null = null;
	#unsub: () => void;
	#mode?: WorkerInitPayload["mode"];
	/** Whether the page is in a browser window, whose content area is its viewport. */
	#visible = false;
	/** The content area and scale last read from a page no viewport is emulated on. */
	#windowViewport?: ReadyInfo["viewport"];
	#dialogPolicy?: DialogPolicy;
	#dialogHandler?: (dialog: Dialog) => void;
	#openDialog?: OpenDialogInfo;
	/** Main-frame navigations the page has made, which `tab.waitForNavigation()` compares against. */
	#mainNavigations = 0;
	/** The file names of runs that have ended, most recent last, at most {@link RECENT_RUN_FILES_MAX}. */
	#recentRunFiles = new Set<string>();
	/** The frames the latest `tab.ariaSnapshot()` followed, by the prefix of their refs (`f1`). */
	#snapshotFrames: ReadonlyMap<string, Frame> = new Map();
	#uninstallRejectionGuard: () => void;
	/** The page's natural input, which follows the page's pointer from the moment the page opens. */
	#naturalInput?: NaturalInput;
	/** When `tab.select` last typed type-ahead keys on the page, whose session the next select waits out. */
	#typeAheadAt = 0;
	/**
	 * What a handle's actions reach of the run in progress on this tab. A handle outlives the run that
	 * made it, so an action belongs to the run it is called in and ends with that run; one called when no
	 * run is in progress, by code a finished or cancelled run left behind, does nothing.
	 */
	#handleActions: HandleActions = {
		run: (label, action) => {
			const active = this.#active;
			if (!active) {
				return markHandled(
					Promise.reject(new ToolError(`${label}: no run is in progress on this tab, so nothing was done.`)),
				);
			}
			return markHandled(
				this.#runOp(active, label, active.signal, active.actionOpMs, signal => action(signal, active.actionOpMs)),
			);
		},
		input: () => this.#active?.input ?? null,
	};

	constructor(transport: TabWorkerTransport, options: WorkerCoreOptions) {
		this.#transport = transport;
		this.#unsub = this.#transport.onMessage(msg => {
			void this.#handleMessage(msg as TabWorkerInbound);
		});
		this.#uninstallRejectionGuard =
			options.realm === "inline"
				? options.interceptUnhandledRejections(reason => this.#claimRejection(reason, false))
				: this.#listenForRejections();
	}

	/** The tab thread's own unhandled-rejection listener: every rejection in that thread is the core's. */
	#listenForRejections(): () => void {
		const onRejection = (reason: unknown): void => {
			this.#claimRejection(reason, true);
		};
		process.on("unhandledRejection", onRejection);
		return () => {
			process.off("unhandledRejection", onRejection);
		};
	}

	/**
	 * Claim an unhandled rejection run code floated, a call it did not await, so that it fails the run in
	 * progress or, once its run has ended, is logged, instead of ending the worker and leaving the tab to
	 * hang until it is killed. A rejection whose stack names a run belongs to that run. In the tab's own
	 * thread (`ownsRealm`) any other rejection belongs to the run in progress, or is logged when none is.
	 * Returns false for a rejection that is not the core's, which keeps its default fatal path.
	 */
	#claimRejection(reason: unknown, ownsRealm: boolean): boolean {
		// A teardown abort nobody consumed; the main thread's handler drops these before asking.
		if (postmortem.isExpectedCleanupError(reason)) return ownsRealm;
		const stack = reason instanceof Error && typeof reason.stack === "string" ? reason.stack : "";
		const fromEndedRun = Array.from(this.#recentRunFiles).some(file => stack.includes(file));
		const active = this.#active;
		if (active && (stack.includes(active.filename) || (ownsRealm && !fromEndedRun))) {
			active.floatingRejections.push(reason);
			return true;
		}
		if (!ownsRealm && !fromEndedRun) return false;
		this.#log("warn", "Unhandled rejection from a browser run that has ended (missing await?)", {
			error: errorPayload(reason),
		});
		return true;
	}

	nextElementId(): number {
		this.#elementCounter += 1;
		return this.#elementCounter;
	}

	cacheElement(id: number, handle: ElementHandle): void {
		this.#elementCache.set(id, handle);
	}

	async #handleMessage(msg: TabWorkerInbound): Promise<void> {
		switch (msg.type) {
			case "init":
				await this.#init(msg.payload, msg.port);
				return;
			case "run":
				await this.#run(msg);
				return;
			case "abort":
				if (this.#active?.id === msg.id) {
					const reason = msg.expectedCleanup
						? postmortem.markExpectedCleanupError(new ToolAbortError())
						: new ToolAbortError();
					this.#active.ac.abort(reason);
				}
				return;
			case "tool-reply":
				this.#deliverToolReply(msg.id, msg.reply);
				return;
			case "close":
				await this.#close();
				return;
		}
	}

	async #init(payload: WorkerInitPayload, port: MessagePort | undefined): Promise<void> {
		try {
			// A tab of a browser this process launched stays one when a new worker re-adopts it.
			this.#mode = payload.mode === "attach" && payload.present ? "headless" : payload.mode;
			this.#visible = payload.mode === "headless" ? payload.visible === true : payload.present?.visible === true;
			const puppeteer = await loadPuppeteer();
			this.#browser = await puppeteer.connect({
				...(port ? { transport: new PortTransport(port) } : { browserWSEndpoint: payload.browserWSEndpoint }),
				defaultViewport: null,
				protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
			});
			if (payload.mode === "headless") {
				const context =
					payload.browserContextId === undefined
						? this.#browser.defaultBrowserContext()
						: this.#browser.browserContexts().find(candidate => candidate.id === payload.browserContextId);
				if (!context) throw new ToolError("The tab's browser context closed before its page opened");
				this.#page = await context.newPage();
				this.#observeDialogs();
				await applyStealthPatches(this.#page, payload.identity);
				await applyViewport(this.#page, payload.viewport, this.#visible);
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);

				if (payload.url) {
					await this.#page.goto(payload.url, {
						// Default to "load" because dev servers with HMR/WS never reach networkidle.
						waitUntil: payload.waitUntil ?? "load",
						timeout: payload.timeoutMs,
					});
				}
			} else {
				const target = await this.#findAttachedTarget(payload.targetId);
				// Post-timeout recycle: unblock the target BEFORE adopting the page — an open
				// modal dialog or hung navigation can stall `target.page()` / ready info, and a
				// stalled init used to time out and force-kill the tab.
				if (payload.recover) await this.#recoverAttachedTarget(target);
				const page = await target.page();
				if (!page) throw new ToolError(`Target ${payload.targetId} is no longer available on the attached browser`);
				this.#page = page;
				this.#observeDialogs();
				if (payload.present) {
					// The page's overrides and scripts went with the old worker's connection, which the
					// replacement closed; this connection sends them again before the next document loads.
					// A window keeps the size it has, which a person may have given it.
					await applyStealthPatches(page, payload.present.identity);
					if (!payload.present.visible) await applyViewport(page, payload.present.viewport, false);
				}
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);
			}
			this.#naturalInput = new NaturalInput(this.#page);
			this.#targetId = await targetIdForPage(this.#page);
			this.#transport.send({ type: "ready", info: await this.#currentReadyInfo() });
		} catch (error) {
			this.#transport.send({ type: "init-failed", error: errorPayload(error) });
		}
	}

	async #findAttachedTarget(targetId: string): Promise<Target> {
		if (!this.#browser) throw new ToolError("Browser is not connected");
		for (const target of this.#browser.targets()) {
			// A target that will not report its id is not the one being looked for; the empty string cannot match
			// a real id, and exhausting the loop throws the named "no longer available" error below.
			if ((await targetIdForTarget(target).catch(() => "")) !== targetId) continue;
			return target;
		}
		throw new ToolError(`Target ${targetId} is no longer available on the attached browser`);
	}

	/**
	 * Best-effort unblocking of a wedged target during post-timeout recovery: dismiss any
	 * open JS dialog and stop a pending navigation over a raw CDP session (created on the
	 * target, not the page, so it works while the page itself is unresponsive). Every step
	 * tolerates "nothing to do".
	 */
	async #recoverAttachedTarget(target: Target): Promise<void> {
		let session: CDPSession | undefined;
		try {
			session = await target.createCDPSession();
			await bestEffort(session.send("Page.enable"), "a target that refuses Page.enable is still worth nudging");
			await bestEffort(
				session.send("Page.handleJavaScriptDialog", { accept: false }),
				"there may be no dialog open, which is the common case",
			);
			await bestEffort(session.send("Page.stopLoading"), "the load may already have stopped");
		} catch (error) {
			this.#log("debug", "Recovery CDP session failed; proceeding with attach", {
				error: errorMessage(error),
			});
		} finally {
			if (session) await bestEffort(session.detach(), "the session may already be gone with its target");
		}
	}

	/**
	 * Record JS dialogs for timeout attribution without handling them (semantics of an
	 * unset `dialogs` policy are unchanged — the page stays blocked until user code or
	 * the policy handler acts). Cleared when the policy handler settles the dialog or a
	 * main-frame navigation proves the modal is gone. Main-frame navigations are counted.
	 */
	#observeDialogs(): void {
		const page = this.#requirePage();
		page.on("dialog", dialog => {
			this.#openDialog = { type: dialog.type(), message: dialog.message() };
		});
		page.on("framenavigated", frame => {
			if (frame !== page.mainFrame()) return;
			this.#openDialog = undefined;
			this.#mainNavigations++;
		});
	}

	async #currentReadyInfo(): Promise<ReadyInfo> {
		const page = this.#requirePage();
		const targetId = this.#targetId ?? (await targetIdForPage(page));
		this.#targetId = targetId;
		return {
			url: redactUrlCredentials(page.url()),
			// Reported to the operator for display; `undefined` is distinct from an empty string, which would
			// claim the page has no title.
			title: await optionalResult(page.title(), "a page mid-navigation has no title yet"),
			viewport: await this.#viewportNow(page),
			targetId,
		};
	}

	/**
	 * The page's viewport: the emulated one, or, where none is emulated (a visible tab, an attached app), its
	 * window's content area at the display's scale, read in the isolated world. A page that cannot be read
	 * mid-navigation reports the last size read.
	 */
	async #viewportNow(page: Page): Promise<ReadyInfo["viewport"]> {
		const emulated = page.viewport();
		if (emulated) return emulated;
		const read = await optionalResult(
			page.evaluate(() => {
				const view = globalThis as unknown as { innerWidth: number; innerHeight: number; devicePixelRatio: number };
				return { width: view.innerWidth, height: view.innerHeight, deviceScaleFactor: view.devicePixelRatio };
			}),
			"a page mid-navigation has no window to read; the last size read stands",
		);
		if (read) this.#windowViewport = read;
		return this.#windowViewport ?? DEFAULT_VIEWPORT;
	}

	#applyDialogPolicy(policy: DialogPolicy): void {
		const page = this.#requirePage();
		if (this.#dialogPolicy === policy && this.#dialogHandler) return;
		if (this.#dialogHandler) page.off("dialog", this.#dialogHandler);
		const handler = (dialog: Dialog): void => {
			const action = policy === "accept" ? dialog.accept() : dialog.dismiss();
			void action.then(
				() => {
					this.#openDialog = undefined;
				},
				err =>
					this.#log("debug", "Dialog auto-handler failed", {
						policy,
						error: errorMessage(err),
					}),
			);
		};
		page.on("dialog", handler);
		this.#dialogPolicy = policy;
		this.#dialogHandler = handler;
	}

	async #postReadyInfo(): Promise<void> {
		try {
			this.#transport.send({ type: "ready", info: await this.#currentReadyInfo() });
		} catch (error) {
			this.#log("debug", "Failed to refresh tab info", {
				error: errorMessage(error),
			});
		}
	}

	async #run(msg: Extract<TabWorkerInbound, { type: "run" }>): Promise<void> {
		if (this.#active) {
			this.#transport.send({
				type: "result",
				id: msg.id,
				ok: false,
				error: errorPayload(new ToolError("Tab worker is busy")),
			});
			return;
		}
		const cellTimeout = scopedTimeoutSignal(msg.timeoutMs);
		const ac = new AbortController();
		const runAc = new AbortController();
		const signal = AbortSignal.any([cellTimeout.signal, ac.signal, runAc.signal]);
		const output = new RunOutput();
		const screenshots: ScreenshotResult[] = [];
		const active: ActiveRun = {
			id: msg.id,
			ac,
			signal,
			output,
			screenshots,
			pendingTools: new Map(),
			inflight: new Map(),
			opCounter: 0,
			actionOpMs: resolveOpTimeouts(msg.timeoutMs).actionOpMs,
			filename: `browser-run-${msg.id}.js`,
			floatingRejections: [],
			lastOp: null,
			input: msg.session.naturalInput ? (this.#naturalInput ?? null) : null,
		};
		this.#active = active;
		try {
			throwIfAborted(signal);
			const page = this.#requirePage();
			// Chromium runs no animation frames in a background page, and a locator's click, hover and
			// drag wait on two of them: with several tabs on one headless browser, a run in any tab but
			// the newest stalled until its action timed out. The run activates its own tab first.
			if (this.#mode === "headless") {
				await bestEffort(
					untilAborted(signal, () => page.bringToFront()),
					"a page that is already active or closing runs as it is",
				);
			}
			const viewport = msg.viewport;
			if (viewport) await untilAborted(signal, () => applyViewport(page, viewport, this.#visible));
			const browser = this.#requireBrowser();
			const tabApi = guardTabApi(
				this.#createTabApi(msg.name, msg.timeoutMs, signal, msg.session, output, screenshots, active),
			);
			const runtime = this.#ensureRuntime(msg.session);
			runtime.setCwd(msg.session.cwd);
			runtime.setRunScope({
				page,
				browser,
				tab: tabApi,
				assert: (cond: unknown, text?: string): void => {
					if (!cond) throw new ToolError(text ?? "Assertion failed");
				},
				// Both wait forms register in the in-flight map so a cell that dies while
				// sleeping/polling names the culprit instead of a bare whole-cell timeout.
				wait: (msOrPredicate: number | (() => unknown), opts?: WaitPredicateOptions): Promise<unknown> => {
					const label = typeof msOrPredicate === "number" ? `wait(${msOrPredicate}ms)` : "wait(predicate)";
					const resolved =
						typeof msOrPredicate === "number"
							? undefined
							: { timeout: resolvePredicateTimeout(msg.timeoutMs, opts?.timeout), interval: opts?.interval };
					return markHandled(
						this.#runOp(active, label, signal, Number.POSITIVE_INFINITY, sig =>
							waitForBrowserRun(msOrPredicate, sig, resolved),
						),
					);
				},
			});
			const { promise: cancelRejection, reject: rejectCancel } = Promise.withResolvers<never>();
			const onCancel = (): void => {
				const abortError =
					signal.reason instanceof ToolAbortError
						? signal.reason
						: new ToolAbortError(undefined, { cause: signal.reason });
				if (cellTimeout.signal.aborted) {
					const stalled = describeInflight(active.inflight);
					const dialog = this.#openDialog;
					const dialogNote = dialog
						? `; a ${dialog.type}(${JSON.stringify(dialog.message.slice(0, 80))}) dialog opened during this run and may still block the page — reopen the tab with dialogs:"accept"|"dismiss" or handle page.on('dialog')`
						: "";
					rejectCancel(
						new ToolError(
							`Browser code execution timed out after ${msg.timeoutMs}ms${stalled ? ` (stalled on ${stalled})` : ""}${dialogNote}`,
						),
					);
				} else {
					rejectCancel(abortError);
				}
				// Cancel in-flight tool calls so user code's awaited proxies reject promptly.
				const toolAbort = cellTimeout.signal.aborted
					? postmortem.markExpectedCleanupError(
							new ToolAbortError(undefined, { cause: cellTimeout.signal.reason }),
						)
					: abortError;
				for (const pending of active.pendingTools.values()) {
					pending.reject(toolAbort);
				}
				active.pendingTools.clear();
			};
			if (signal.aborted) onCancel();
			else signal.addEventListener("abort", onCancel, { once: true });
			try {
				const hooks = this.#hooksForActiveRun();
				if (!hooks) throw new ToolError("Browser runtime started without an active run");
				const returnValue = await Promise.race([
					runtime.run(msg.code, active.filename, hooks, { runId: msg.id, cwd: msg.session.cwd }),
					cancelRejection,
				]);
				await this.#postReadyInfo();
				// One turn more, so a rejection the code floated just before it returned is still this run's.
				await delay(0);
				// A call the code did not await failed: the run failed, and says what it forgot to await.
				const floated = active.floatingRejections.splice(0);
				if (floated.length > 0) {
					reportFloatingRejections(output, floated.slice(1));
					throw new ToolError(`Unhandled rejection (missing await?): ${errorMessage(floated[0])}`);
				}
				this.#transport.send({
					type: "result",
					id: msg.id,
					ok: true,
					payload: { displays: output.finish(), returnValue: cloneSafe(returnValue), screenshots },
				});
			} finally {
				signal.removeEventListener("abort", onCancel);
			}
		} catch (error) {
			// The run's own output goes back WITH the failure. `output.finish()` drains whatever
			// `display()` produced before the throw, and those lines are usually the only evidence
			// of why it threw; dropping them left a timed-out cell reporting a bare deadline and
			// nothing that explains it. Screenshots ride along for the same reason.
			const failure = explainRelativeFetch(await this.#explainPageGlobal(error));
			reportFloatingRejections(output, active.floatingRejections.splice(0));
			this.#transport.send({
				type: "result",
				id: msg.id,
				ok: false,
				error: errorPayload(failure),
				partial: { displays: output.finish(), screenshots },
			});
		} finally {
			cellTimeout.cancel();
			if (this.#active?.id === msg.id) this.#active = null;
			this.#recentRunFiles.add(active.filename);
			if (this.#recentRunFiles.size > RECENT_RUN_FILES_MAX) {
				const oldest = this.#recentRunFiles.values().next().value;
				if (oldest !== undefined) this.#recentRunFiles.delete(oldest);
			}
			runAc.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Browser run ended")));
		}
	}

	/**
	 * Run code executes in the tab worker, and a model that reaches for `document`, `window` or a
	 * page's own global (`jQuery`, an app object) gets a bare "X is not defined". When the page has
	 * that name, the error says where it lives and how to reach it, so the next attempt is right.
	 */
	async #explainPageGlobal(error: unknown): Promise<unknown> {
		if (!(error instanceof Error) || error.name !== "ReferenceError" || !this.#page) return error;
		const name = /^(?:Can't find variable: )?([A-Za-z_$][\w$]*)(?: is not defined)?$/.exec(error.message)?.[1];
		if (!name) return error;
		const probe = Promise.withResolvers<boolean | undefined>();
		const timer = setTimeout(() => probe.resolve(undefined), PAGE_GLOBAL_PROBE_MS);
		// The main world, as `tab.evaluate` uses: a page's own globals are not visible from the isolated one.
		void optionalResult(
			this.#page
				.mainFrame()
				.mainRealm()
				.evaluate(global => global in globalThis, name),
			"a page that cannot answer leaves the error as it was",
		).then(probe.resolve);
		const inPage = await probe.promise;
		clearTimeout(timer);
		if (inPage !== true) return error;
		const explained = new ToolError(
			`${error.message}: \`${name}\` exists in the page, but run code executes in the tab worker. Use it inside \`await tab.evaluate(() => …)\`.`,
		);
		explained.stack = error.stack;
		return explained;
	}

	#ensureRuntime(session: SessionSnapshot): JsRuntime {
		if (this.#runtime) return this.#runtime;
		this.#runtime = new JsRuntime({
			initialCwd: session.cwd,
			sessionId: `browser-tab-${this.#targetId ?? "unknown"}`,
		});
		return this.#runtime;
	}

	#hooksForActiveRun(): RuntimeHooks | null {
		const active = this.#active;
		if (!active) return null;
		return {
			onText: chunk => {
				throwIfAborted(active.signal);
				active.output.pushText(chunk);
				this.#log("debug", chunk.replace(/\n$/, ""));
			},
			onDisplay: output => {
				throwIfAborted(active.signal);
				active.output.pushDisplay(output);
			},
			callTool: (name, args) => {
				throwIfAborted(active.signal);
				return this.#callTool(active, name, args);
			},
		};
	}

	async #callTool(active: ActiveRun, name: string, args: unknown): Promise<unknown> {
		const id = `tab-tc-${active.id}-${crypto.randomUUID()}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, { resolve, reject });
		this.#transport.send({ type: "tool-call", id, runId: active.id, name, args });
		return await promise;
	}

	#deliverToolReply(id: string, reply: ToolReply): void {
		const active = this.#active;
		if (!active) return;
		const pending = active.pendingTools.get(id);
		if (!pending) return;
		active.pendingTools.delete(id);
		if (reply.ok) pending.resolve(reply.value);
		else pending.reject(replyError(reply.error));
	}

	/**
	 * Wrap a tab helper so it (a) registers in the active run's in-flight map for
	 * timeout diagnostics and (b) honors an optional per-op deadline that fails fast
	 * with a named error instead of silently consuming the whole cell budget. Pass
	 * `Number.POSITIVE_INFINITY` for `perOpTimeoutMs` to bound the op only by the cell
	 * budget (used for `evaluate` running user code and for locator helpers that already
	 * carry puppeteer's own `.setTimeout(timeoutMs)`). When the op targets a `selector`,
	 * the fail-fast timeout carries a best-effort match-count hint, and — when
	 * `zeroMatchAfterMs` is set — a watchdog aborts the op early once the selector has
	 * matched nothing for that long.
	 */
	async #runOp<T>(
		active: ActiveRun,
		label: string,
		cellSignal: AbortSignal,
		perOpTimeoutMs: number,
		fn: (signal: AbortSignal, selector: string | undefined) => Promise<T>,
		opts?: { selector?: string; zeroMatchAfterMs?: number },
	): Promise<T> {
		const opId = active.opCounter++;
		active.inflight.set(opId, { label, startedAt: Date.now() });
		// A read or a sleep between an action and the wait on its navigation leaves the action as the one waited on.
		if (!READ_ONLY_OP.test(label)) {
			active.lastOp = { navigating: NAVIGATING_OP.test(label), navigationsAtStart: this.#mainNavigations };
		}
		const capped = Number.isFinite(perOpTimeoutMs) && perOpTimeoutMs > 0;
		const opTimeout = capped ? scopedTimeoutSignal(perOpTimeoutMs) : undefined;
		const opSignal = opTimeout ? AbortSignal.any([cellSignal, opTimeout.signal]) : cellSignal;
		let selector = opts?.selector;
		// Fired when the watchdog wins the race (tears down the in-flight action) and in
		// the finally (stops the watchdog's polling once the op settles either way).
		const earlyAc = new AbortController();
		try {
			// A list mixing the tool's own forms is decided here, so the op and its watchdog see one selector.
			const alternatives = selector === undefined ? null : selectorAlternatives(selector);
			if (alternatives !== null) {
				selector = await this.#firstMatchingAlternative(
					alternatives,
					label,
					opts?.zeroMatchAfterMs ?? perOpTimeoutMs,
					opSignal,
				);
			}
			const watchdog =
				selector !== undefined && opts?.zeroMatchAfterMs !== undefined && parseAriaRefSelector(selector) === null
					? { selector, afterMs: opts.zeroMatchAfterMs }
					: undefined;
			if (!watchdog) return await fn(opSignal, selector);
			const racedSignal = AbortSignal.any([opSignal, earlyAc.signal]);
			return await Promise.race([
				fn(racedSignal, selector),
				this.#zeroMatchWatchdog(watchdog.selector, label, watchdog.afterMs, racedSignal),
			]);
		} catch (err) {
			// Fail fast with a named, attributable error instead of the opaque whole-cell timeout:
			// our per-op deadline fired, or puppeteer's own (equal) timeout fired first — having
			// already torn down the CDP action via the op signal, so no work is left dangling.
			// Cell-budget aborts and uncapped helpers (goto/evaluate) keep their native errors.
			if (capped && !cellSignal.aborted && (opTimeout?.signal.aborted || isTimeoutError(err))) {
				const hint = selector ? await this.#selectorTimeoutHint(selector) : "";
				throw new ToolError(`${label} timed out after ${perOpTimeoutMs}ms${hint}`);
			}
			throw err;
		} finally {
			opTimeout?.cancel();
			earlyAc.abort();
			active.inflight.delete(opId);
		}
	}

	/**
	 * Fail-fast arm raced against a selector op: rejects once the selector has matched
	 * nothing for the whole `afterMs` window, so a wrong selector or wrong page (consent
	 * wall, pre-navigation document) costs ~2s instead of the full action deadline.
	 * Disarms — hangs until the settled race drops it — the moment at least one element
	 * matches; an inconclusive probe (mid-navigation, detached frame) never counts
	 * toward the zero-match window.
	 */
	async #zeroMatchWatchdog(selector: string, label: string, afterMs: number, signal: AbortSignal): Promise<never> {
		const page = this.#requirePage();
		const resolved = normalizeSelector(selector);
		const deadline = Date.now() + afterMs;
		while (!signal.aborted) {
			let count: number | null = null;
			try {
				const handles = await page.$$(resolved);
				count = handles.length;
				for (const handle of handles) void releaseHandle(handle);
			} catch (error) {
				// A selector that does not parse never will: fail now instead of at the op's deadline.
				if (isInvalidSelector(error)) throw new ToolError(invalidSelectorMessage(label, selector));
				// Inconclusive probe — keep polling without advancing toward failure.
			}
			if (count !== null && count > 0) break;
			if (count === 0 && Date.now() >= deadline) {
				throw new ToolError(`${label} failed fast after ${afterMs}ms${formatSelectorMatchHint(0)}`);
			}
			try {
				await untilAborted(signal, () => Bun.sleep(ZERO_MATCH_POLL_MS));
			} catch {
				break;
			}
		}
		return await new Promise<never>(() => {});
	}

	/**
	 * The first alternative of a selector list, in the order written, that matches an element, tried
	 * until one does or `withinMs` passes. A ref alternative matches when the latest snapshot's ref
	 * resolves.
	 */
	async #firstMatchingAlternative(
		alternatives: readonly string[],
		label: string,
		withinMs: number,
		signal: AbortSignal,
	): Promise<string> {
		const page = this.#requirePage();
		const deadline = Date.now() + withinMs;
		for (;;) {
			for (const alternative of alternatives) {
				const ref = parseAriaRefSelector(alternative);
				let handle: ElementHandle | null = null;
				try {
					handle =
						ref === null
							? ((await untilAborted(signal, () =>
									page.$(normalizeSelector(alternative)),
								)) as ElementHandle | null)
							: await untilAborted(signal, () => resolveAriaRefHandle(page, ref, this.#snapshotFrames));
				} catch (error) {
					if (signal.aborted) throw error;
					if (isInvalidSelector(error)) throw new ToolError(invalidSelectorMessage(label, alternative));
					// A probe that fails mid-navigation counts as no match this round.
				}
				if (handle !== null) {
					void releaseHandle(handle);
					return alternative;
				}
			}
			if (Date.now() >= deadline) {
				throw new ToolError(
					`${label} failed fast after ${withinMs}ms; no alternative of the list matches an element — run tab.ariaSnapshot() to inspect the page`,
				);
			}
			await untilAborted(signal, () => delay(ZERO_MATCH_POLL_MS));
		}
	}

	/**
	 * Best-effort match-count probe for a timed-out selector op. Never throws;
	 * empty string when the probe fails, stalls, or the selector is an aria-ref.
	 */
	async #selectorTimeoutHint(selector: string): Promise<string> {
		if (parseAriaRefSelector(selector) !== null) return "";
		try {
			const handles = await Promise.race([
				this.#requirePage().$$(normalizeSelector(selector)),
				Bun.sleep(1_000).then(() => null),
			]);
			if (!handles) return "";
			const count = handles.length;
			for (const handle of handles) void releaseHandle(handle);
			return formatSelectorMatchHint(count);
		} catch {
			return "";
		}
	}

	#createTabApi(
		name: string,
		timeoutMs: number,
		signal: AbortSignal,
		session: SessionSnapshot,
		output: RunOutput,
		screenshots: ScreenshotResult[],
		active: ActiveRun,
	): TabApi {
		const page = this.#requirePage();
		const { budgetBound, quickOpMs, actionOpMs } = resolveOpTimeouts(timeoutMs);
		const waitMs = (explicit?: number): number => resolveWaitTimeout(timeoutMs, explicit);
		const INF = Number.POSITIVE_INFINITY;
		// Typing takes at most half of what an action that began at `started` has left of its deadline.
		const typingWithin = (started: number): number => Math.max(0, actionOpMs - (Date.now() - started)) / 2;
		const op = <T>(
			label: string,
			perOpMs: number,
			// `target` is the selector the op acts on: the one given, or the alternative of a list that matched.
			fn: (sig: AbortSignal, target: string | undefined) => Promise<T>,
			selectorOpts?: { selector?: string; zeroMatchAfterMs?: number },
		): Promise<T> => markHandled(this.#runOp(active, label, signal, perOpMs, fn, selectorOpts));
		type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
		const load = (label: string, url: string, waitUntil: WaitUntil | undefined): Promise<void> =>
			op(label, INF, async sig => {
				this.#clearElementCache();
				try {
					// Default to "load" because dev servers with HMR/WS never reach networkidle.
					// budgetBound (not the full cell) so a hung navigation fails named and
					// catchable inside the run instead of dying with the whole cell.
					await untilAborted(sig, () => page.goto(url, { waitUntil: waitUntil ?? "load", timeout: budgetBound }));
				} catch (err) {
					if (isTimeoutError(err)) {
						// Abandon the hung navigation NOW — a still-pending load stalls every
						// later op on this page and cascades into more opaque timeouts.
						await this.#stopLoading();
						throw new ToolError(
							`${label} timed out after ${budgetBound}ms; pending navigation stopped — retry with a longer tool timeout or waitUntil:"domcontentloaded"`,
						);
					}
					throw err;
				}
			});
		return {
			name,
			page,
			signal,
			url: () => page.url(),
			title: () => op("tab.title()", INF, sig => untilAborted(sig, () => page.title())),
			goto: (url, opts) => load(`tab.goto(${JSON.stringify(url)})`, url, opts?.waitUntil),
			// Loading the URL again rather than `page.reload()`, which would post a submitted form a second time.
			reload: opts => load("tab.reload()", page.url(), opts?.waitUntil),
			observe: opts => op("tab.observe()", quickOpMs, sig => this.#collectObservation({ ...opts, signal: sig })),
			ariaSnapshot: (selector, opts) =>
				op(
					selector ? `tab.ariaSnapshot(${JSON.stringify(selector)})` : "tab.ariaSnapshot()",
					quickOpMs,
					async sig => {
						let root: ElementHandle | null = null;
						if (selector) {
							root = (await untilAborted(sig, () =>
								page.$(normalizeSelector(selector)),
							)) as ElementHandle | null;
							if (!root)
								throw new ToolError(
									`tab.ariaSnapshot: selector ${JSON.stringify(selector)} matched no element`,
								);
						}
						try {
							const capture = await untilAborted(sig, () => captureAriaSnapshot(page, root, opts));
							this.#snapshotFrames = capture.frames;
							return capture.text;
						} finally {
							await releaseHandle(root);
						}
					},
				),
			screenshot: opts =>
				op(describeScreenshot(opts), quickOpMs, sig =>
					this.#captureScreenshot(session, output, screenshots, sig, opts),
				),
			extract: (format = "markdown") =>
				op(`tab.extract(${JSON.stringify(format)})`, quickOpMs, async sig => {
					const html = (await untilAborted(sig, () => page.content())) as string;
					const result = await extractReadableFromHtml(html, page.url(), format);
					if (!result) {
						throw new ToolError(
							`tab.extract(${JSON.stringify(format)}) found no readable content on ${page.url()}`,
						);
					}
					const content = format === "markdown" ? result.markdown : result.text;
					if (!content) {
						throw new ToolError(
							`tab.extract(${JSON.stringify(format)}) produced empty ${format} content for ${page.url()}`,
						);
					}
					return content;
				}),
			click: selector =>
				op(
					`tab.click(${JSON.stringify(selector)})`,
					actionOpMs,
					(sig, target = selector) =>
						this.#click(target, `tab.click(${JSON.stringify(selector)})`, actionOpMs, sig, active.input),
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			type: (selector, text) =>
				op(
					`tab.type(${JSON.stringify(selector)})`,
					actionOpMs,
					async (sig, target = selector) => {
						const started = Date.now();
						const handle = await this.#resolveActionHandle(target, actionOpMs, sig);
						try {
							const input = active.input;
							if (input === null) {
								await untilAborted(sig, () => handle.type(text, { delay: 0 }));
							} else {
								await untilAborted(sig, () => handle.focus());
								await input.type(text, typingWithin(started), sig);
							}
						} finally {
							await releaseHandle(handle);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			fill: (selector, value) =>
				op(
					`tab.fill(${JSON.stringify(selector)})`,
					actionOpMs,
					async (sig, target = selector) => {
						const started = Date.now();
						// Visible before it is filled, as a click waits: a field that is still animating in is waited
						// for rather than refused for not taking focus.
						const handle = await this.#resolveActionHandle(target, actionOpMs, sig, { visible: true });
						try {
							const input = active.input;
							await fillViaHandle(handle, value, sig, input && { input, withinMs: typingWithin(started) });
						} finally {
							await releaseHandle(handle);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			press: (key, opts) => {
				const selector = opts?.selector;
				return op(
					`tab.press(${JSON.stringify(key)})`,
					actionOpMs,
					async (sig, target) => {
						// The element takes focus as a click's does, so a ref or a snapshot line's form reaches it too.
						if (target !== undefined) {
							const handle = await this.#resolveActionHandle(target, actionOpMs, sig);
							try {
								await untilAborted(sig, () => handle.focus());
							} finally {
								await releaseHandle(handle);
							}
						}
						await untilAborted(sig, () => page.keyboard.press(key));
					},
					selector ? { selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS } : undefined,
				);
			},
			scroll: (deltaX, deltaY) =>
				op("tab.scroll()", actionOpMs, sig => untilAborted(sig, () => page.mouse.wheel({ deltaX, deltaY }))),
			drag: (from, to) => op("tab.drag()", actionOpMs, sig => this.#drag(from, to, sig, active.input)),
			waitFor: (selector, opts) => {
				const w = waitMs(opts?.timeout);
				return op(
					`tab.waitFor(${JSON.stringify(selector)})`,
					w,
					async (sig, target = selector) =>
						toActionableHandle(await this.#resolveActionHandle(target, w, sig), this.#handleActions),
					{ selector, zeroMatchAfterMs: opts?.timeout === undefined ? ZERO_MATCH_FAIL_FAST_MS : undefined },
				);
			},
			waitForSelector: (selector, opts) => {
				const w = waitMs(opts?.timeout);
				return op(
					`tab.waitForSelector(${JSON.stringify(selector)})`,
					w,
					async (sig, target = selector) => {
						if (parseAriaRefSelector(target) !== null)
							return toActionableHandle(await this.#resolveAriaRef(target), this.#handleActions);
						const handle = (await untilAborted(sig, () =>
							page.waitForSelector(normalizeSelector(target), {
								timeout: w,
								visible: opts?.visible,
								hidden: opts?.hidden,
								signal: sig,
							}),
						)) as ElementHandle | null;
						return handle ? toActionableHandle(handle, this.#handleActions) : null;
					},
					{
						// A list waited on for its absence is not narrowed to the one alternative present now.
						selector: opts?.hidden ? undefined : selector,
						// `hidden: true` waits for zero matches — that is success, never a fast-fail.
						zeroMatchAfterMs: opts?.timeout === undefined && !opts?.hidden ? ZERO_MATCH_FAIL_FAST_MS : undefined,
					},
				);
			},
			waitForNavigation: opts => {
				const w = waitMs(opts?.timeout);
				// Read before the op below replaces it: the action this wait is meant to follow.
				const previous = active.lastOp;
				return op("tab.waitForNavigation()", w, async sig => {
					// `await tab.click(…); await tab.waitForNavigation()` starts waiting after the click's navigation
					// began, and puppeteer's wait would then time out on a navigation that already happened.
					if (previous && !previous.navigating && this.#mainNavigations > previous.navigationsAtStart) {
						await this.#waitForLoadState(opts?.waitUntil ?? "load", w, sig);
						return null;
					}
					return await untilAborted(sig, () =>
						page.waitForNavigation({ waitUntil: opts?.waitUntil ?? "load", timeout: w, signal: sig }),
					);
				});
			},
			evaluate: (fn, ...args) =>
				op("tab.evaluate()", INF, sig =>
					untilAborted(sig, () =>
						typeof fn === "string"
							? page.mainFrame().mainRealm().evaluate(fn)
							: page
									.mainFrame()
									.mainRealm()
									.evaluate(fn as (...a: unknown[]) => unknown, ...args),
					),
				) as never,
			scrollIntoView: selector =>
				op(
					`tab.scrollIntoView(${JSON.stringify(selector)})`,
					actionOpMs,
					async (sig, target = selector) => {
						const handle = await this.#resolveActionHandle(target, actionOpMs, sig);
						try {
							// The wheel brings the element near the centre; an instant scroll centres one it cannot.
							const input = active.input;
							if (input && (await input.scrollIntoView(handle, sig))) return;
							await untilAborted(sig, () => handle.evaluate(centreInView));
						} finally {
							await releaseHandle(handle);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			select: (selector, ...values) =>
				op(
					`tab.select(${JSON.stringify(selector)})`,
					actionOpMs,
					(sig, target = selector) => {
						const started = Date.now();
						return this.#select(target, values, actionOpMs, sig, active.input, () => typingWithin(started));
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			uploadFile: (selector, ...filePaths) =>
				op(
					`tab.uploadFile(${JSON.stringify(selector)})`,
					actionOpMs,
					(sig, target = selector) => this.#uploadFile(target, filePaths, actionOpMs, sig, session, active.input),
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			waitForUrl: (pattern, opts) => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForUrl()", w, sig => this.#waitForUrl(pattern, w, sig));
			},
			waitForResponse: (pattern, opts) => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForResponse()", w, sig => this.#waitForResponse(pattern, w, sig));
			},
			id: id =>
				chainHandle(this.#resolveCachedHandle(id).then(handle => toActionableHandle(handle, this.#handleActions))),
			ref: id =>
				chainHandle(this.#resolveAriaRef(id).then(handle => toActionableHandle(handle, this.#handleActions))),
			storageState: opts =>
				op("tab.storageState()", actionOpMs, sig => this.#storageState(opts?.path, sig, session)),
			loadStorageState: stateOrPath =>
				op("tab.loadStorageState()", actionOpMs, sig => this.#loadStorageState(stateOrPath, sig, session)),
		};
	}

	async #collectObservation(options: {
		includeAll?: boolean;
		viewportOnly?: boolean;
		signal?: AbortSignal;
	}): Promise<Observation> {
		const page = this.#requirePage();
		this.#clearElementCache();
		const includeAll = options.includeAll ?? false;
		const viewportOnly = options.viewportOnly ?? false;
		const snapshot = (await untilAborted(options.signal, () =>
			page.accessibility.snapshot({ interestingOnly: !includeAll }),
		)) as SerializedAXNode | null;
		if (!snapshot) throw new ToolError("Accessibility snapshot unavailable");
		const entries: ObservationEntry[] = [];
		await collectObservationEntries(this, snapshot, entries, { includeAll, viewportOnly });
		const { dpr, ...scroll } = (await untilAborted(options.signal, () =>
			page.evaluate(() => {
				const win = globalThis as unknown as {
					scrollX: number;
					scrollY: number;
					innerWidth: number;
					innerHeight: number;
					devicePixelRatio: number;
					document: { documentElement: { scrollWidth: number; scrollHeight: number } };
				};
				const doc = win.document.documentElement;
				return {
					x: win.scrollX,
					y: win.scrollY,
					width: win.innerWidth,
					height: win.innerHeight,
					scrollWidth: doc.scrollWidth,
					scrollHeight: doc.scrollHeight,
					dpr: win.devicePixelRatio,
				};
			}),
		)) as Observation["scroll"] & { dpr: number };
		return {
			url: page.url(),
			title: (await untilAborted(options.signal, () => page.title())) as string,
			// Where no viewport is emulated (a visible tab, an attached app), the window's content area is the viewport.
			viewport: page.viewport() ?? { width: scroll.width, height: scroll.height, deviceScaleFactor: dpr },
			scroll,
			elements: entries,
		};
	}

	async #captureScreenshot(
		session: SessionSnapshot,
		output: RunOutput,
		screenshots: ScreenshotResult[],
		signal: AbortSignal | undefined,
		opts: ScreenshotOptions = {},
	): Promise<ScreenshotResult> {
		const page = this.#requirePage();
		// Multiple tabs can share one Chromium (sibling headless tabs on a shared
		// endpoint, cdp/app attach). CDP `Page.captureScreenshot` reads the
		// compositor surface, which follows the *active* target — a backgrounded
		// page can stall waiting for a fresh frame (the 20s screenshot timeouts)
		// or hand back a sibling tab's pixels. Activate first.
		await bestEffort(
			untilAborted(signal, () => page.bringToFront()),
			"an already-active or freshly-closed target never fails the capture",
		);
		const fullPage = opts.selector ? false : (opts.fullPage ?? false);
		// An explicit save path picks the full-res capture format: puppeteer encodes
		// png/jpeg/webp natively, so `save: "shot.webp"` gets real WebP bytes instead
		// of PNG bytes hiding behind a .webp name. Unknown/missing extensions stay PNG.
		const explicitPath = opts.save ? resolveToCwd(opts.save, session.cwd) : undefined;
		const captureType = explicitPath ? imageFormatForPath(explicitPath) : "png";
		const captureMime = `image/${captureType}` as const;
		let buffer: Buffer;
		if (opts.selector) {
			const handle = (await untilAborted(signal, () =>
				page.$(normalizeSelector(opts.selector!)),
			)) as ElementHandle | null;
			if (!handle) throw new ToolError("Screenshot selector did not resolve to an element");
			try {
				// Bring the element into view with a single instant scroll instead of puppeteer's
				// scrollIntoViewIfNeeded(), whose IntersectionObserver promise can stall indefinitely
				// on continuously-animating pages (WebGL / backdrop-filter "glass" effects). Best-effort.
				await bestEffort(
					untilAborted(signal, () =>
						handle.evaluate(el => {
							const target = el as unknown as {
								scrollIntoView: (opts: { behavior: string; block: string; inline: string }) => void;
							};
							target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
						}),
					),
					"the capture renders the clipped region whether or not the scroll landed",
				);
				// scrollIntoView:false skips the same IntersectionObserver check inside screenshot();
				// captureBeyondViewport (puppeteer's default) still renders the clipped region.
				const shotOpts: ElementScreenshotOptions = { type: captureType, scrollIntoView: false };
				buffer = (await untilAborted(signal, () => handle.screenshot(shotOpts))) as Buffer;
			} finally {
				await releaseHandle(handle);
			}
		} else {
			buffer = (await untilAborted(signal, () => page.screenshot({ type: captureType, fullPage }))) as Buffer;
		}
		const resized = await resizeImage(
			{ type: "image", data: buffer.toBase64(), mimeType: captureMime },
			{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70, excludeWebP: session.excludeWebP },
		);
		const saveFullRes = !!(explicitPath || session.browserScreenshotDir);
		const savedBuffer = saveFullRes ? buffer : resized.buffer;
		const savedMimeType = saveFullRes ? captureMime : resized.mimeType;
		// Names must match the bytes we actually write: full-res follows the capture
		// format, the resized buffer is whichever of PNG/JPEG/WebP encoded smallest.
		const ext = savedMimeType === "image/webp" ? "webp" : savedMimeType === "image/jpeg" ? "jpg" : "png";
		const dest =
			explicitPath ??
			(session.browserScreenshotDir
				? path.join(
						session.browserScreenshotDir,
						`screenshot-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1)}.${ext}`,
					)
				: path.join(os.tmpdir(), `veyyon-sshots-${Snowflake.next()}.${ext}`));
		await fs.promises.mkdir(path.dirname(dest), { recursive: true });
		await Bun.write(dest, savedBuffer);
		const info: ScreenshotResult = {
			dest,
			mimeType: savedMimeType,
			bytes: savedBuffer.length,
			width: resized.width,
			height: resized.height,
		};
		screenshots.push(info);
		if (!opts.silent) {
			const lines = formatScreenshot({
				saveFullRes,
				savedMimeType,
				savedByteLength: savedBuffer.length,
				dest,
				resized,
			});
			output.push({ type: "text", text: lines.join("\n") });
			output.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		}
		return info;
	}

	/**
	 * Press the element `selector` names once nothing covers it ({@link pressUncovered}). A CSS or handler
	 * selector is resolved again when its element leaves the page before the press, as a re-rendering
	 * framework replaces it; an `aria-ref` names one snapshot's element and is not.
	 */
	async #click(
		selector: string,
		label: string,
		timeoutMs: number,
		signal: AbortSignal,
		input: NaturalInput | null,
	): Promise<void> {
		const pressMs = Math.max(1, timeoutMs - PRESS_REPORT_MARGIN_MS);
		if (parseAriaRefSelector(selector) !== null) {
			const handle = await this.#resolveAriaRef(selector);
			try {
				await pressUncovered(handle, label, () => handle.click(), pressMs, {
					signal,
					gesture: { kind: "click" },
					input,
				});
			} finally {
				await releaseHandle(handle);
			}
			return;
		}
		const resolved = normalizeSelector(selector);
		if (resolved.startsWith("text/")) {
			await clickQueryHandlerText(this.#requirePage(), resolved, timeoutMs, signal, input);
			return;
		}
		const started = Date.now();
		for (;;) {
			const remaining = Math.max(1, pressMs - (Date.now() - started));
			const handle = await this.#resolveActionHandle(selector, remaining, signal, { visible: true });
			try {
				await pressUncovered(handle, label, () => handle.click(), remaining, {
					signal,
					gesture: { kind: "click" },
					input,
				});
				return;
			} catch (err) {
				if (!(err instanceof DetachedPressTarget) || Date.now() - started >= pressMs) throw err;
			} finally {
				await releaseHandle(handle);
			}
		}
	}

	async #drag(from: DragTarget, to: DragTarget, signal: AbortSignal, input: NaturalInput | null): Promise<void> {
		const page = this.#requirePage();
		const resolveDragPoint = async (
			target: DragTarget,
			role: "from" | "to",
		): Promise<{ x: number; y: number; size?: Extent; handle?: ElementHandle }> => {
			if (typeof target === "string") {
				const handle = (await untilAborted(signal, () =>
					page.$(normalizeSelector(target)),
				)) as ElementHandle | null;
				if (!handle) throw new ToolError(`Drag ${role} selector did not resolve: ${target}`);
				const box = (await untilAborted(signal, () => handle.boundingBox())) as {
					x: number;
					y: number;
					width: number;
					height: number;
				} | null;
				if (!box) {
					await releaseHandle(handle);
					throw new ToolError(`Drag ${role} element has no bounding box (likely not visible): ${target}`);
				}
				return { x: box.x + box.width / 2, y: box.y + box.height / 2, size: box, handle };
			}
			if (
				target !== null &&
				typeof target === "object" &&
				typeof (target as { x: unknown }).x === "number" &&
				typeof (target as { y: unknown }).y === "number"
			) {
				return { x: (target as { x: number }).x, y: (target as { y: number }).y };
			}
			throw new ToolError(
				`Drag ${role} must be a selector string or { x: number, y: number } point. Got: ${typeof target}`,
			);
		};
		const start = await resolveDragPoint(from, "from");
		let end: { x: number; y: number; size?: Extent; handle?: ElementHandle } | undefined;
		try {
			end = await resolveDragPoint(to, "to");
			if (input) {
				await input.drag(
					start,
					end,
					{ from: start.size ?? DRAG_POINT_TARGET, to: end.size ?? DRAG_POINT_TARGET },
					signal,
				);
				return;
			}
			await untilAborted(signal, () => page.mouse.move(start.x, start.y));
			await untilAborted(signal, () => page.mouse.down());
			await untilAborted(signal, () => page.mouse.move(end!.x, end!.y, { steps: 12 }));
			await untilAborted(signal, () => page.mouse.up());
		} finally {
			await releaseHandle(start.handle);
			await releaseHandle(end?.handle);
		}
	}

	/**
	 * Select `values` in a `<select>` by type-ahead, then by a modified click for each further option of
	 * a multiple select ({@link planSelect}), so the page gets the trusted events a person's input sends.
	 * A state no key or click reaches is set by script, with the events dispatched, as before.
	 */
	async #select(
		selector: string,
		values: string[],
		timeoutMs: number,
		signal: AbortSignal,
		input: NaturalInput | null,
		typingMs: () => number,
	): Promise<string[]> {
		const handle = await this.#resolveActionHandle(selector, timeoutMs, signal);
		try {
			const state = (await untilAborted(signal, () => handle.evaluate(readSelectState))) as SelectState;
			if (!state.isSelect) throw new ToolError("tab.select() requires a <select> element");
			const plan = planSelect(state, values);
			if (plan.kind === "input")
				await this.#selectByInput(handle, state, plan, input, typingMs(), timeoutMs, signal);
			const settled = (await untilAborted(signal, () => handle.evaluate(settleSelection, values))) as {
				selected: string[];
				scripted: boolean;
			};
			if (settled.scripted) {
				this.#log("debug", "tab.select() set the selection by script", {
					reason: plan.kind === "script" ? plan.reason : "the keys and clicks left another selection",
				});
			}
			return settled.selected;
		} finally {
			await releaseHandle(handle);
		}
	}

	async #selectByInput(
		handle: ElementHandle,
		state: SelectState,
		plan: Extract<SelectPlan, { kind: "input" }>,
		input: NaturalInput | null,
		typingMs: number,
		timeoutMs: number,
		signal: AbortSignal,
	): Promise<void> {
		const page = this.#requirePage();
		// Keys reach an open drop-down's popup, where they move a highlight; Escape closes it unchanged.
		if (state.open) await untilAborted(signal, () => page.keyboard.press("Escape"));
		// A session the select keeps from keys typed a moment ago would join these keys to those. Natural
		// input waits it out, at a person's pace; instant input ends it with a blur, which resets it.
		const since = Date.now() - this.#typeAheadAt;
		if (state.focused && since < TYPE_AHEAD_SESSION_MS) {
			if (input) await delay(TYPE_AHEAD_SESSION_MS - since, undefined, { signal });
			else await untilAborted(signal, () => handle.evaluate(el => (el as unknown as { blur(): void }).blur()));
		}
		await untilAborted(signal, () => handle.focus());
		await this.#typeKeys(plan.keys, input, typingMs, signal);
		this.#typeAheadAt = Date.now();
		for (const index of plan.extra) {
			const found = await untilAborted(signal, () =>
				handle.evaluateHandle(
					(el, at) => (el as unknown as { options: ArrayLike<unknown> }).options[at as number],
					index,
				),
			);
			const option = found.asElement() as ElementHandle | null;
			if (!option) {
				await releaseHandle(found);
				continue;
			}
			try {
				await untilAborted(signal, () => page.keyboard.down(plan.modifier));
				try {
					await pressUncovered(
						option,
						"tab.select()",
						() => option.click(),
						Math.max(1, timeoutMs - PRESS_REPORT_MARGIN_MS),
						{ signal, gesture: { kind: "click" }, input },
					);
				} finally {
					await bestEffort(
						page.keyboard.up(plan.modifier),
						"puppeteer clears a modifier from its own state before it sends",
					);
				}
			} finally {
				await releaseHandle(option);
			}
		}
	}

	/**
	 * Type `text` at the focused element as keys that each send a `keypress`, which type-ahead reads: a
	 * character of puppeteer's layout through its keyboard, any other through `Input.dispatchKeyEvent`,
	 * as puppeteer inserts such a character as text without one.
	 */
	async #typeKeys(text: string, input: NaturalInput | null, withinMs: number, signal: AbortSignal): Promise<void> {
		const page = this.#requirePage();
		let session: CDPSession | undefined;
		const send = async (char: string, holdMs: number): Promise<void> => {
			if (char >= " " && char <= "~") {
				await page.keyboard.type(char, { delay: holdMs });
				return;
			}
			session ??= await page.createCDPSession();
			await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char, unmodifiedText: char });
			if (holdMs > 0) await delay(holdMs);
			await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
		};
		try {
			if (input) await input.type(text, withinMs, signal, send);
			else for (const char of text) await untilAborted(signal, () => send(char, 0));
		} finally {
			if (session) await bestEffort(session.detach(), "a session goes with its page");
		}
	}

	/**
	 * Attach files to an `<input type="file">`, or press the control that opens a file chooser (a button,
	 * a label, a drop zone that clicks a hidden input) and hand the chooser the files.
	 */
	async #uploadFile(
		selector: string,
		filePaths: string[],
		timeoutMs: number,
		signal: AbortSignal,
		session: SessionSnapshot,
		input: NaturalInput | null,
	): Promise<void> {
		if (!filePaths.length) throw new ToolError("tab.uploadFile() requires at least one file path");
		const page = this.#requirePage();
		const label = `tab.uploadFile(${JSON.stringify(selector)})`;
		const started = Date.now();
		const handle = await this.#resolveActionHandle(selector, timeoutMs, signal);
		try {
			const absolute = filePaths.map(filePath => resolveToCwd(filePath, session.cwd));
			const kind = (await untilAborted(signal, () =>
				handle.evaluate(el => {
					const element = el as unknown as { tagName: string; type?: string };
					const tag = element.tagName.toLowerCase();
					return tag === "input" ? `input:${(element.type ?? "text").toLowerCase()}` : tag;
				}),
			)) as string;
			if (kind === "input:file") {
				const upload = handle as unknown as { uploadFile: (...paths: string[]) => Promise<void> };
				await untilAborted(signal, () => upload.uploadFile(...absolute));
				return;
			}
			if (kind.startsWith("input:")) {
				throw new ToolError(
					`${label}: an <input type="${kind.slice("input:".length)}"> takes no files. Pass the <input type="file">, or the control that opens its chooser.`,
				);
			}
			const remaining = Math.max(1, timeoutMs - PRESS_REPORT_MARGIN_MS - (Date.now() - started));
			const chooser = markHandled(page.waitForFileChooser({ timeout: remaining, signal }));
			await pressUncovered(handle, label, () => handle.click(), remaining, {
				signal,
				gesture: { kind: "click" },
				input,
			});
			let opened: FileChooser | null;
			try {
				opened = await untilAborted(signal, () =>
					Promise.race([chooser, delay(CHOOSER_WAIT_MS, null, { signal })]),
				);
			} catch (err) {
				if (!isTimeoutError(err)) throw err;
				opened = null;
			}
			if (!opened) {
				throw new ToolError(
					`${label}: pressing the <${kind}> opened no file chooser. Pass the <input type="file">, or the control that opens its chooser.`,
				);
			}
			await untilAborted(signal, () => opened.accept(absolute));
		} finally {
			await releaseHandle(handle);
		}
	}

	/**
	 * Wait until the page that a navigation already committed reaches `waitUntil`, the state
	 * `page.waitForNavigation` would have waited for had it started before the navigation.
	 */
	async #waitForLoadState(
		waitUntil: "load" | "domcontentloaded" | "networkidle0" | "networkidle2",
		timeout: number,
		signal: AbortSignal,
	): Promise<void> {
		const page = this.#requirePage();
		if (waitUntil === "networkidle0" || waitUntil === "networkidle2") {
			await untilAborted(signal, () =>
				page.waitForNetworkIdle({ concurrency: waitUntil === "networkidle0" ? 0 : 2, timeout, signal }),
			);
			return;
		}
		await untilAborted(signal, () =>
			page.waitForFunction(
				(complete: boolean) => {
					const state = (globalThis as unknown as { document: { readyState: string } }).document.readyState;
					return complete ? state === "complete" : state !== "loading";
				},
				{ timeout, signal, polling: 50 },
				waitUntil === "load",
			),
		);
	}

	async #waitForUrl(pattern: string | RegExp, timeout: number, signal: AbortSignal): Promise<string> {
		const page = this.#requirePage();
		const isRegex = pattern instanceof RegExp;
		const matcher = isRegex ? pattern.source : pattern;
		const flags = isRegex ? pattern.flags : "";
		await untilAborted(signal, () =>
			page.waitForFunction(
				(m: string, isRe: boolean, fl: string) => {
					const url = (globalThis as unknown as { location: { href: string } }).location.href;
					return isRe ? new RegExp(m, fl).test(url) : url.includes(m);
				},
				{ timeout, polling: 200, signal },
				matcher,
				isRegex,
				flags,
			),
		);
		return page.url();
	}

	async #waitForResponse(
		pattern: string | RegExp | ((response: HTTPResponse) => boolean | Promise<boolean>),
		timeout: number,
		signal: AbortSignal,
	): Promise<HTTPResponse> {
		const page = this.#requirePage();
		const predicate: (response: HTTPResponse) => boolean | Promise<boolean> =
			typeof pattern === "function"
				? pattern
				: pattern instanceof RegExp
					? response => pattern.test(response.url())
					: response => response.url().includes(pattern);
		return (await untilAborted(signal, () => page.waitForResponse(predicate, { timeout, signal }))) as HTTPResponse;
	}

	async #resolveCachedHandle(id: number): Promise<ElementHandle> {
		const handle = this.#elementCache.get(id);
		if (!handle) throw new ToolError(`Unknown element id ${id}. Run tab.observe() to refresh the element list.`);
		try {
			const isConnected = (await handle.evaluate(el => el.isConnected)) as boolean;
			if (!isConnected) {
				this.#clearElementCache();
				throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
			}
		} catch (err) {
			if (err instanceof ToolError) throw err;
			this.#clearElementCache();
			throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
		}
		return handle;
	}

	async #resolveAriaRef(id: string): Promise<ElementHandle> {
		const ref = parseAriaRefSelector(id) ?? id.trim();
		const handle = await resolveAriaRefHandle(this.#requirePage(), ref, this.#snapshotFrames);
		if (!handle) {
			throw new ToolError(
				`Unknown ARIA ref ${JSON.stringify(ref)}. Run tab.ariaSnapshot() to refresh refs (they renumber each snapshot).`,
			);
		}
		return handle;
	}

	/**
	 * Resolve a selector to an ElementHandle for handle-based actions. An
	 * `aria-ref=eN` selector resolves against the latest ariaSnapshot's refs
	 * (main world); anything else goes through the normal locator wait, which
	 * also waits for the element to be visible when `visible` is set.
	 */
	async #resolveActionHandle(
		selector: string,
		timeoutMs: number,
		sig: AbortSignal,
		opts?: { visible?: boolean },
	): Promise<ElementHandle> {
		if (parseAriaRefSelector(selector) !== null) return this.#resolveAriaRef(selector);
		const locator = this.#requirePage().locator(normalizeSelector(selector)).setTimeout(timeoutMs);
		return (await untilAborted(sig, () =>
			(opts?.visible ? locator.setVisibility("visible") : locator).waitHandle({ signal: sig }),
		)) as ElementHandle;
	}
	#clearElementCache(): void {
		if (this.#elementCache.size === 0) {
			this.#elementCounter = 0;
			return;
		}
		const handles = Array.from(this.#elementCache.values());
		this.#elementCache.clear();
		this.#elementCounter = 0;
		for (const handle of handles) void releaseHandle(handle);
	}

	/** Best-effort `Page.stopLoading` so an abandoned navigation cannot stall later ops. */
	async #stopLoading(): Promise<void> {
		try {
			const session = await this.#requirePage().createCDPSession();
			try {
				await session.send("Page.stopLoading");
			} finally {
				await bestEffort(session.detach(), "the stop already happened, and the session goes with the target");
			}
		} catch (error) {
			this.#log("debug", "Page.stopLoading failed", {
				error: errorMessage(error),
			});
		}
	}

	async #close(): Promise<void> {
		this.#unsub();
		this.#clearElementCache();
		const page = this.#page;
		if (this.#dialogHandler && page && !page.isClosed()) page.off("dialog", this.#dialogHandler);
		// The worker is shutting down and reports `closed` below regardless: a page that will not close is either
		// already closing or belongs to a browser that is going away with it, and the disconnect follows. A named
		// context is the supervisor's, which closes it when its last tab goes.
		if (this.#mode === "headless" && page && !page.isClosed()) {
			await bestEffort(page.close(), "a page that will not close is already closing or going with its browser");
		}
		if (this.#browser?.connected) this.#browser.disconnect();
		this.#transport.send({ type: "closed" });
		this.#transport.close();
		this.#uninstallRejectionGuard();
	}

	async #storageState(file: string | undefined, signal: AbortSignal, session: SessionSnapshot): Promise<StorageState> {
		const context = this.#requirePage().browserContext();
		return await untilAborted(signal, async () => {
			const state = await captureStorageState(context);
			if (file !== undefined) await writeStorageStateFile(resolveToCwd(file, session.cwd), state);
			return state;
		});
	}

	async #loadStorageState(
		stateOrPath: string | StorageState,
		signal: AbortSignal,
		session: SessionSnapshot,
	): Promise<StorageStateLoaded> {
		// Reading a spawned or connected browser's session is how one is carried into a headless tab;
		// writing one would overwrite the cookies of a profile a person or an app signs in with.
		if (this.#mode !== "headless") {
			throw new ToolError(
				"tab.loadStorageState() needs the headless browser: this tab runs in a spawned or connected browser's own profile, and a load would write cookies and localStorage into that profile. Load the state into a tab opened without app.",
			);
		}
		const context = this.#requirePage().browserContext();
		return await untilAborted(signal, async () => {
			const state =
				typeof stateOrPath === "string"
					? await readStorageStateFile(resolveToCwd(stateOrPath, session.cwd))
					: parseStorageState(stateOrPath, "tab.loadStorageState()'s argument");
			return await applyStorageState(context, state);
		});
	}

	#requirePage(): Page {
		if (!this.#page) throw new ToolError("Tab worker is not initialized");
		return this.#page;
	}

	#requireBrowser(): Browser {
		if (!this.#browser) throw new ToolError("Tab worker is not initialized");
		return this.#browser;
	}

	#log(level: "debug" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void {
		this.#transport.send({ type: "log", level, msg, meta });
	}
}
