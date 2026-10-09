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
	FileChooser,
	Frame,
	HTTPRequest,
	HTTPResponse,
	ImageFormat,
	JSHandle,
	KeyboardTypeOptions,
	KeyInput,
	Page,
	PuppeteerLifeCycleEvent,
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
	type AriaSnapshotCapture,
	type AriaSnapshotOptions,
	captureAriaSnapshot,
	parseAriaRefSelector,
	resolveAriaRefHandle,
} from "./aria-snapshot";
import { type ChainedHandle, chainHandle } from "./chained-handle";
import { PortTransport } from "./connection-relay";
import {
	type ElementIdentity,
	focusConnected,
	type HandleRelocation,
	pointerPoint,
	relocateElement,
	scrollConnected,
	selectConnected,
	withRelocation,
} from "./element-identity";
import { fillViaHandle } from "./fill";
import { releaseHandle, releaseHandles } from "./handle-release";
import { hasTextSelector } from "./has-text";
import {
	applyStealthPatches,
	applyViewport,
	BROWSER_PROTOCOL_TIMEOUT_MS,
	DEFAULT_VIEWPORT,
	loadPuppeteer,
} from "./launch";
import { type Extent, NaturalInput } from "./natural-input";
import { DetachedPressTarget, type Gesture, PRESS_REPORT_MARGIN_MS, pressUncovered } from "./press";
import { extractReadableFromHtml, type ReadableFormat } from "./readable";
import {
	CELL_BUDGET_SLACK_MS,
	markHandled,
	resolvePredicateTimeout,
	type WaitPredicateOptions,
	waitForBrowserRun,
} from "./run-cancellation";
import { cloneSafe, RunOutput } from "./run-output";
import {
	CAPTURE_HEDGE_MS,
	CAPTURE_MAX_ATTEMPTS,
	type CaptureParams,
	elementClip,
	hedgeCapture,
	startCapture,
} from "./screenshot-capture";
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

/** How long an aborted `tab.goto` waits for the request of the navigation that aborted it. */
const NAVIGATION_INTERRUPT_GRACE_MS = 250;

/**
 * A URL as puppeteer reports a navigation request's: parsed, so equivalent spellings compare equal,
 * and with its fragment, which `HTTPRequest.url()` appends.
 */
function navigationKey(url: string): string {
	return URL.canParse(url) ? new URL(url).href : url;
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

/** A handle's own pointer and key actions, read before it is enriched, so a wrapper acts through puppeteer and not through another wrapper. */
interface OwnActions {
	click(options?: Readonly<ClickOptions>): Promise<void>;
	hover(): Promise<void>;
	tap(): Promise<void>;
	type(text: string, options?: Readonly<KeyboardTypeOptions>): Promise<void>;
}

const ownActions = new WeakMap<ElementHandle, OwnActions>();

/** `handle`'s own actions, kept at the first read so a later enrichment wraps puppeteer's, not a wrapper. */
function ownOf(handle: ElementHandle): OwnActions {
	let own = ownActions.get(handle);
	if (!own) {
		own = {
			click: handle.click.bind(handle),
			hover: handle.hover.bind(handle),
			tap: handle.tap.bind(handle),
			type: handle.type.bind(handle),
		};
		ownActions.set(handle, own);
	}
	return own;
}

/**
 * How each `tab.id()` and ARIA ref handle finds the element that replaced its node when the page
 * re-rendered it (see `element-identity.ts`). A handle a CSS selector resolved has none.
 */
const relocations = new WeakMap<ElementHandle, HandleRelocation>();

/** Run `act` on `handle`, or on the element that replaced its node when `handle` has a relocation ({@link withRelocation}). */
function onElement<T>(handle: ElementHandle, act: (target: ElementHandle) => Promise<T>): Promise<T> {
	const relocation = relocations.get(handle);
	return relocation ? withRelocation(handle, relocation, act) : act(handle);
}

/**
 * Attach `fill()` to a puppeteer ElementHandle before handing it to user code, route its `click()` and
 * `hover()` through {@link pressUncovered}, and pace its `type()` when natural input is on, each as an
 * action `actions` runs. Puppeteer handles expose `type()` but no `fill()`; the semantics are the
 * selector-based `tab.fill()`'s.
 *
 * An id or ARIA ref handle carries a relocation: every action that fails because the page re-rendered
 * the node runs again on the element that replaced it. Scrolling, focusing or selecting a detached
 * node succeeds and changes nothing the page shows, so those actions check the node and act on it in
 * one evaluation (see {@link scrollConnected}). Puppeteer's `type()` and `press()` focus through
 * `this.focus()`, the wrapped focus.
 */
function toActionableHandle(handle: ElementHandle, actions: HandleActions): ActionableHandle {
	const own = ownOf(handle);
	const relocation = relocations.get(handle);
	const enriched = handle as ActionableHandle;
	enriched.fill = value =>
		actions.run("handle.fill()", (signal, timeoutMs) => {
			const input = actions.input();
			return onElement(handle, target =>
				fillViaHandle(target, value, signal, input && { input, withinMs: timeoutMs / 2 }),
			);
		});
	// The press gives up before its op's deadline, so the reason it waited (a cover, a disabled control) is reported.
	enriched.click = options =>
		actions.run("handle.click()", (signal, timeoutMs) => {
			const gesture: Gesture = {
				kind: "click",
				button: options?.button,
				count: options?.count,
				holdMs: options?.delay,
			};
			return pressUncovered(
				handle,
				"handle.click()",
				puppeteerPress("click", relocation !== undefined, options),
				Math.max(1, timeoutMs - PRESS_REPORT_MARGIN_MS),
				{
					signal,
					gesture,
					// A fixed offset or a highlighted press is puppeteer's own; a natural press aims for itself.
					input: options?.offset === undefined && !options?.debugHighlight ? actions.input() : null,
					relocation,
				},
			);
		});
	enriched.hover = () =>
		actions.run("handle.hover()", (signal, timeoutMs) =>
			pressUncovered(
				handle,
				"handle.hover()",
				puppeteerPress("hover", relocation !== undefined),
				Math.max(1, timeoutMs - PRESS_REPORT_MARGIN_MS),
				{ signal, gesture: { kind: "hover" }, input: actions.input(), relocation },
			),
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
	if (!relocation) return enriched;
	// A tap aims in one evaluation, so a node the page redraws between puppeteer's round trips still
	// receives it (see pointerPoint). A node in a child frame keeps puppeteer's path, which adds the frame offsets.
	enriched.tap = () =>
		withRelocation(handle, relocation, async target => {
			if (target.frame.parentFrame()) return ownOf(target).tap();
			const { x, y } = await pointerPoint(target);
			await target.frame.page().touchscreen.tap(x, y);
		});
	enriched.select = (...values) => withRelocation(handle, relocation, target => selectConnected(target, values));
	enriched.scrollIntoView = () => withRelocation(handle, relocation, scrollConnected);
	enriched.focus = () => withRelocation(handle, relocation, focusConnected);
	return enriched;
}

/**
 * Puppeteer's press for `kind` on the element a {@link pressUncovered} check passed. A relocating
 * handle's press aims in one evaluation, so a node the page redraws between puppeteer's round trips
 * still receives it (see pointerPoint); a node in a child frame keeps puppeteer's path, which adds
 * the frame offsets.
 */
function puppeteerPress(
	kind: "click" | "hover",
	relocating: boolean,
	options?: Readonly<ClickOptions>,
): (target: ElementHandle) => Promise<void> {
	return async target => {
		if (!relocating || target.frame.parentFrame()) {
			const own = ownOf(target);
			return kind === "click" ? own.click(options) : own.hover();
		}
		const { x, y } = await pointerPoint(target, kind === "click" ? options?.offset : undefined);
		const mouse = target.frame.page().mouse;
		if (kind === "click") await mouse.click(x, y, options);
		else await mouse.move(x, y);
	};
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

/** How many nodes an observation considers carry each role and name, keyed `role\nname`. */
function countIdentities(
	node: SerializedAXNode,
	includeAll: boolean,
	counts: Map<string, number>,
): Map<string, number> {
	if (includeAll || isInteractiveNode(node)) {
		const key = `${node.role}\n${node.name ?? ""}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	for (const child of node.children ?? []) countIdentities(child, includeAll, counts);
	return counts;
}

async function collectObservationEntries(
	core: WorkerCore,
	node: SerializedAXNode,
	entries: ObservationEntry[],
	options: { viewportOnly: boolean; includeAll: boolean; identities: Map<string, number> },
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
				const name = node.name ?? "";
				// Only a role and name the page held once can name this element's replacement.
				const unique = options.identities.get(`${node.role}\n${name}`) === 1;
				core.cacheElement(id, handle as ElementHandle, unique ? { role: node.role, name } : null);
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

/** How long a `<select>` joins typed keys into one type-ahead search (`kTypeAheadTimeout`), and a margin. */
const TYPE_AHEAD_SESSION_MS = 1_100;

/** How long `tab.uploadFile` waits, after pressing a control, for the file chooser it opens. */
const CHOOSER_WAIT_MS = 2_000;

/** The target a natural drag's travel time takes a bare `{ x, y }` point to be. */
const DRAG_POINT_TARGET: Extent = { width: 20, height: 20 };

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
							element => element.click(),
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
	#elementCache = new Map<number, { handle: ElementHandle; identity: ElementIdentity | null }>();
	/** Handles an id held before a re-render replaced its node; released with the cache. */
	#retiredHandles: ElementHandle[] = [];
	/** Role and name of each ref the latest whole-page ARIA snapshot held once; null when it held it more often. */
	#ariaRefIdentities = new Map<string, ElementIdentity | null>();
	/** The document the latest whole-page ARIA snapshot read; a ref relocates only while it is the page's. */
	#ariaSnapshotDocument?: JSHandle;
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

	cacheElement(id: number, handle: ElementHandle, identity: ElementIdentity | null): void {
		this.#elementCache.set(id, { handle, identity });
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
					await this.#navigate(label, page, url, waitUntil ?? "load", budgetBound, sig);
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
							await this.#recordAriaRefs(page, capture, root === null);
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
							// Focused in the evaluation that checks the node, so a ref's re-rendered element takes the keys.
							await untilAborted(sig, () => onElement(handle, focusConnected));
							if (input === null) await untilAborted(sig, () => page.keyboard.type(text));
							else await input.type(text, typingWithin(started), sig);
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
							await onElement(handle, element =>
								fillViaHandle(element, value, sig, input && { input, withinMs: typingWithin(started) }),
							);
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
								await untilAborted(sig, () => onElement(handle, focusConnected));
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
							const relocation = relocations.get(handle);
							await onElement(handle, async element => {
								if (input && (await input.scrollIntoView(element, sig, relocation?.relocate))) return;
								await untilAborted(sig, () => scrollConnected(element));
							});
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
		const identities = countIdentities(snapshot, includeAll, new Map());
		await collectObservationEntries(this, snapshot, entries, { includeAll, viewportOnly, identities });
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
		let params: CaptureParams;
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
				// captureBeyondViewport renders the clipped region even where it leaves the viewport.
				params = {
					format: captureType,
					captureBeyondViewport: true,
					clip: await untilAborted(signal, () => elementClip(page, handle)),
				};
			} finally {
				await releaseHandle(handle);
			}
		} else {
			params = { format: captureType, captureBeyondViewport: fullPage };
		}
		const data = await hedgeCapture(() => startCapture(page, params), {
			hedgeAfterMs: CAPTURE_HEDGE_MS,
			maxAttempts: CAPTURE_MAX_ATTEMPTS,
			signal,
		});
		const buffer = Buffer.from(data, "base64");
		const resized = await resizeImage(
			{ type: "image", data, mimeType: captureMime },
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
	 * framework replaces it; an `aria-ref` press goes on at the single element holding the role and name
	 * the ref had ({@link HandleRelocation}).
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
				const relocation = relocations.get(handle);
				await pressUncovered(handle, label, puppeteerPress("click", relocation !== undefined), pressMs, {
					signal,
					gesture: { kind: "click" },
					input,
					relocation,
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
				await pressUncovered(handle, label, element => element.click(), remaining, {
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
						element => element.click(),
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
			await pressUncovered(handle, label, element => element.click(), remaining, {
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

	/**
	 * `page.goto(url)`, sent again once when another main-frame navigation aborted it. Chromium
	 * cancels a pending navigation when a newer one starts in the same frame, as one the page starts
	 * from a click handler (a script redirect, a meta refresh, a reload, a form submission) does, and
	 * `page.goto` reports that as `net::ERR_ABORTED`, the same error as a URL that answers with a
	 * download or with no content. A main-frame navigation request to another URL separates the two:
	 * a download sends none, so it is never sent twice. That request is reported after the abort, so
	 * an abort waits up to {@link NAVIGATION_INTERRUPT_GRACE_MS} for it.
	 */
	async #navigate(
		label: string,
		page: Page,
		url: string,
		waitUntil: PuppeteerLifeCycleEvent,
		timeout: number,
		signal: AbortSignal,
	): Promise<void> {
		const own = navigationKey(url);
		let interrupter: string | undefined;
		let noticed: (() => void) | undefined;
		const onRequest = (request: HTTPRequest): void => {
			if (interrupter !== undefined || !request.isNavigationRequest() || request.frame() !== page.mainFrame())
				return;
			if (request.redirectChain().length !== 0 || navigationKey(request.url()) === own) return;
			interrupter = request.url();
			noticed?.();
		};
		page.on("request", onRequest);
		try {
			for (let attempt = 1; ; attempt++) {
				interrupter = undefined;
				try {
					await untilAborted(signal, () => page.goto(url, { waitUntil, timeout }));
					return;
				} catch (err) {
					if (!errorMessage(err).includes("net::ERR_ABORTED")) throw err;
					if (interrupter === undefined) {
						const { promise, resolve } = Promise.withResolvers<void>();
						noticed = resolve;
						const grace = setTimeout(resolve, NAVIGATION_INTERRUPT_GRACE_MS);
						try {
							await untilAborted(signal, () => promise);
						} finally {
							clearTimeout(grace);
							noticed = undefined;
						}
						if (interrupter === undefined) throw err;
					}
					if (attempt === 2) {
						throw new ToolError(
							`${label} was aborted twice by other navigations, the last to ${interrupter}; wait for the page to settle (tab.waitForNavigation()) and retry`,
						);
					}
				}
			}
		} finally {
			page.off("request", onRequest);
		}
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

	/**
	 * The element behind an observe id. A node the page re-rendered out of the document is replaced
	 * by the single element holding its role and name (see `element-identity.ts`); a node whose
	 * document a navigation replaced, or one with no single replacement, makes every id stale. The
	 * handle's relocation is registered for the actions that act on it.
	 */
	async #resolveCachedHandle(id: number): Promise<ElementHandle> {
		const entry = this.#elementCache.get(id);
		if (!entry) throw new ToolError(`Unknown element id ${id}. Run tab.observe() to refresh the element list.`);
		const page = this.#requirePage();
		const { identity } = entry;
		const relocation: HandleRelocation = {
			relocate: () => (identity ? relocateElement(page, identity) : Promise.resolve(null)),
			stale: cause =>
				new ToolError(
					`Element id ${id} is stale (${cause})${identity ? `, and no single element with role ${JSON.stringify(identity.role)} and name ${JSON.stringify(identity.name)} replaced it` : ""}. Run tab.observe() again.`,
				),
		};
		const connected = await optionalResult(
			entry.handle.evaluate(el => el.isConnected),
			"a node whose document was replaced cannot be evaluated, and that makes it stale",
		);
		if (connected === undefined) {
			this.#clearElementCache();
			throw new ToolError(`Element id ${id} is stale (the page navigated). Run tab.observe() again.`);
		}
		if (!connected) {
			const fresh = await relocation.relocate();
			if (!fresh) {
				this.#clearElementCache();
				throw relocation.stale("the page re-rendered it");
			}
			// A handle an earlier tab.id() returned stays usable: its actions relocate on their own.
			this.#retiredHandles.push(entry.handle);
			entry.handle = fresh;
		}
		relocations.set(entry.handle, relocation);
		return entry.handle;
	}

	/**
	 * The element behind an ARIA ref of the latest snapshot. A ref whose element the page re-rendered
	 * resolves to the single element holding the role and name the ref had, as long as the document
	 * the snapshot read is still the page's. The handle's relocation is registered for the actions
	 * that act on it.
	 */
	async #resolveAriaRef(id: string): Promise<ElementHandle> {
		const ref = parseAriaRefSelector(id) ?? id.trim();
		const page = this.#requirePage();
		const identity = this.#ariaRefIdentities.get(ref) ?? null;
		const snapshotDocument = this.#ariaSnapshotDocument;
		const relocation: HandleRelocation = {
			relocate: async () => {
				if (!identity || !snapshotDocument) return null;
				const sameDocument = await optionalResult(
					snapshotDocument.evaluate(() => true),
					"a document a navigation replaced cannot be evaluated, and its refs name nothing on the next page",
				);
				return sameDocument === true ? relocateElement(page, identity) : null;
			},
			stale: cause =>
				new ToolError(
					`ARIA ref ${JSON.stringify(ref)} is stale (${cause})${identity ? `, and no single element with role ${JSON.stringify(identity.role)} and name ${JSON.stringify(identity.name)} replaced it` : ""}. Run tab.ariaSnapshot() to refresh refs.`,
				),
		};
		const handle = (await resolveAriaRefHandle(page, ref, this.#snapshotFrames)) ?? (await relocation.relocate());
		if (!handle) {
			throw new ToolError(
				`Unknown ARIA ref ${JSON.stringify(ref)}. Run tab.ariaSnapshot() to refresh refs (they renumber each snapshot).`,
			);
		}
		relocations.set(handle, relocation);
		return handle;
	}

	/**
	 * Keep the ref identities of a snapshot: each ref's role and name when the snapshot held that
	 * pair once, and the document it read. A snapshot of a subtree keeps none, since a pair unique
	 * in the subtree can belong to another element elsewhere in the page.
	 */
	async #recordAriaRefs(page: Page, capture: AriaSnapshotCapture, wholePage: boolean): Promise<void> {
		const identities = new Map<string, ElementIdentity | null>();
		if (wholePage) {
			const counts = new Map<string, number>();
			for (const [, role, name] of capture.refs) {
				const key = `${role}\n${name}`;
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
			for (const [ref, role, name] of capture.refs) {
				identities.set(ref, counts.get(`${role}\n${name}`) === 1 ? { role, name } : null);
			}
		}
		this.#ariaRefIdentities = identities;
		const previous = this.#ariaSnapshotDocument;
		this.#ariaSnapshotDocument = wholePage ? await page.evaluateHandle("document") : undefined;
		void releaseHandle(previous);
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
		this.#elementCounter = 0;
		if (this.#elementCache.size === 0 && this.#retiredHandles.length === 0) return;
		const released = [...Array.from(this.#elementCache.values(), entry => entry.handle), ...this.#retiredHandles];
		this.#elementCache.clear();
		this.#retiredHandles = [];
		void releaseHandles(released);
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
		void releaseHandle(this.#ariaSnapshotDocument);
		this.#ariaSnapshotDocument = undefined;
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
