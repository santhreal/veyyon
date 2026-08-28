import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { errorMessage, isTimeoutError, postmortem, Snowflake, untilAborted } from "@veyyon/utils";
import { bestEffort, optionalResult } from "@veyyon/utils/discarded-fault";
import type { HTMLElement } from "linkedom";
import type {
	Browser,
	CDPSession,
	Dialog,
	ElementHandle,
	ElementScreenshotOptions,
	HTTPResponse,
	ImageFormat,
	KeyInput,
	Page,
	SerializedAXNode,
	Target,
} from "puppeteer-core";
import { JsRuntime, type RuntimeHooks } from "../../eval/js/shared/runtime";
import { scopedTimeoutSignal } from "../../utils/fetch-timeout";
import { resizeImage } from "../../utils/image-resize";
import { resolveToCwd } from "../path-utils";
import { formatScreenshot } from "../render-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "../tool-errors";
import {
	type AriaSnapshotOptions,
	captureAriaSnapshot,
	parseAriaRefSelector,
	resolveAriaRefHandle,
} from "./aria/aria-snapshot";
import { releaseHandle, releaseHandles } from "./handle-release";
import {
	applyStealthPatches,
	applyViewport,
	BROWSER_PROTOCOL_TIMEOUT_MS,
	DEFAULT_VIEWPORT,
	loadPuppeteer,
} from "./launch";
import { extractReadableFromHtml, type ReadableFormat } from "./readable";
import {
	CELL_BUDGET_SLACK_MS,
	markHandled,
	resolvePredicateTimeout,
	type WaitPredicateOptions,
	waitForBrowserRun,
} from "./run-cancellation";
import { cloneSafe, RunOutput } from "./run-output";
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

const PLAYWRIGHT_ONLY_SELECTOR_RE =
	/:has-text\(|:text\(|:text-is\(|:text-matches\(|:visible\b|:hidden\b|:nth-match\(|:near\(|:above\(|:below\(|:right-of\(|:left-of\(/;

type DialogPolicy = "accept" | "dismiss";
type DragTarget = string | { readonly x: number; readonly y: number };
type ActionabilityResult = { ok: true; x: number; y: number } | { ok: false; reason: string };
interface OpenDialogInfo {
	type: string;
	message: string;
}

const QUICK_OP_TIMEOUT_MS = 20_000;
const ACTION_OP_TIMEOUT_MS = 8_000;
const OP_DEADLINE_SLACK_MS = CELL_BUDGET_SLACK_MS;
const ZERO_MATCH_FAIL_FAST_MS = 2_000;
const ZERO_MATCH_POLL_MS = 250;

export interface OpTimeouts {
	budgetBound: number;
	quickOpMs: number;
	actionOpMs: number;
}

export function resolveOpTimeouts(cellTimeoutMs: number): OpTimeouts {
	const budgetBound = Math.max(1, cellTimeoutMs - OP_DEADLINE_SLACK_MS);
	return {
		budgetBound,
		quickOpMs: Math.min(budgetBound, QUICK_OP_TIMEOUT_MS),
		actionOpMs: Math.min(budgetBound, ACTION_OP_TIMEOUT_MS),
	};
}

export function resolveWaitTimeout(cellTimeoutMs: number, explicit?: number): number {
	const { budgetBound, actionOpMs } = resolveOpTimeouts(cellTimeoutMs);
	if (explicit === undefined) return actionOpMs;
	if (explicit === 0 || explicit === Number.POSITIVE_INFINITY) return budgetBound;
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
	id(n: number): Promise<ActionableHandle>;
	ref(id: string): Promise<ActionableHandle>;
}

export function normalizeSelector(selector: string): string {
	if (!selector) return selector;
	if (
		!SELECTOR_HANDLER_PREFIXES.some(prefix => selector.startsWith(prefix)) &&
		PLAYWRIGHT_ONLY_SELECTOR_RE.test(selector)
	) {
		throw new ToolError(
			`Playwright-only selector ${JSON.stringify(selector)} is not supported by the browser tool. ` +
				`Use a puppeteer text selector ("text/Allow all"), an aria selector ("aria/Name"), CSS, or "xpath/...".`,
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

export type ActionableHandle = ElementHandle & { fill(value: string): Promise<void> };

export function toActionableHandle(handle: ElementHandle): ActionableHandle {
	const enriched = handle as ActionableHandle;
	enriched.fill = value => fillViaHandle(enriched, value);
	return enriched;
}

async function fillViaHandle(handle: ElementHandle, value: string, signal?: AbortSignal): Promise<void> {
	await untilAborted(signal, () =>
		handle.evaluate(el => {
			const node = el as unknown as { value?: string; focus?: () => void };
			node.focus?.();
			if ("value" in node) node.value = "";
		}),
	);
	await untilAborted(signal, () => handle.type(value, { delay: 0 }));
}

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
		const handle = await node.elementHandle();
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

interface ClickTargetResolution {
	target: ElementHandle | null;
	probed: number;
	probeFailures: number;
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
		} catch {}
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

async function clickQueryHandlerText(
	page: Page,
	selector: string,
	timeoutMs: number,
	signal?: AbortSignal,
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
				await untilAborted(clickSignal, () => target.click());
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
	inflight: Map<number, InflightOp>;
	opCounter: number;
}

export function describeScreenshot(opts?: ScreenshotOptions): string {
	if (opts?.selector) return `tab.screenshot({ selector: ${JSON.stringify(opts.selector)} })`;
	if (opts?.fullPage) return "tab.screenshot({ fullPage: true })";
	return "tab.screenshot()";
}

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
	#dialogPolicy?: DialogPolicy;
	#dialogHandler?: (dialog: Dialog) => void;
	#openDialog?: OpenDialogInfo;

	constructor(transport: TabWorkerTransport) {
		this.#transport = transport;
		this.#unsub = this.#transport.onMessage(msg => {
			void this.#handleMessage(msg as TabWorkerInbound);
		});
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
				await this.#init(msg.payload);
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

	async #init(payload: WorkerInitPayload): Promise<void> {
		try {
			this.#mode = payload.mode;
			const puppeteer = await loadPuppeteer();
			this.#browser = await puppeteer.connect({
				browserWSEndpoint: payload.browserWSEndpoint,
				defaultViewport: null,
				protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
			});
			if (payload.mode === "headless") {
				this.#page = await this.#browser.newPage();
				this.#observeDialogs();
				await applyStealthPatches(this.#browser, this.#page, { browserSession: null, override: null });
				await applyViewport(this.#page, payload.viewport);
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);
				if (payload.url) {
					await this.#page.goto(payload.url, {
						waitUntil: payload.waitUntil ?? "load",
						timeout: payload.timeoutMs,
					});
				}
			} else {
				const target = await this.#findAttachedTarget(payload.targetId);
				if (payload.recover) await this.#recoverAttachedTarget(target);
				const page = await target.page();
				if (!page) throw new ToolError(`Target ${payload.targetId} is no longer available on the attached browser`);
				this.#page = page;
				this.#observeDialogs();
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);
			}
			this.#targetId = await targetIdForPage(this.#page);
			this.#transport.send({ type: "ready", info: await this.#currentReadyInfo() });
		} catch (error) {
			this.#transport.send({ type: "init-failed", error: errorPayload(error) });
		}
	}

	async #findAttachedTarget(targetId: string): Promise<Target> {
		if (!this.#browser) throw new ToolError("Browser is not connected");
		for (const target of this.#browser.targets()) {
			if ((await targetIdForTarget(target).catch(() => "")) !== targetId) continue;
			return target;
		}
		throw new ToolError(`Target ${targetId} is no longer available on the attached browser`);
	}

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

	#observeDialogs(): void {
		const page = this.#requirePage();
		page.on("dialog", dialog => {
			this.#openDialog = { type: dialog.type(), message: dialog.message() };
		});
		page.on("framenavigated", frame => {
			if (frame === page.mainFrame()) this.#openDialog = undefined;
		});
	}

	async #currentReadyInfo(): Promise<ReadyInfo> {
		const page = this.#requirePage();
		const targetId = this.#targetId ?? (await targetIdForPage(page));
		this.#targetId = targetId;
		return {
			url: redactUrlCredentials(page.url()),
			title: await optionalResult(page.title(), "a page mid-navigation has no title yet"),
			viewport: page.viewport() ?? DEFAULT_VIEWPORT,
			targetId,
		};
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
		};
		this.#active = active;
		try {
			throwIfAborted(signal);
			const page = this.#requirePage();
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
					runtime.run(msg.code, `browser-run-${msg.id}.js`, hooks, { runId: msg.id, cwd: msg.session.cwd }),
					cancelRejection,
				]);
				await this.#postReadyInfo();
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
			this.#transport.send({
				type: "result",
				id: msg.id,
				ok: false,
				error: errorPayload(error),
				partial: { displays: output.finish(), screenshots },
			});
		} finally {
			cellTimeout.cancel();
			if (this.#active?.id === msg.id) this.#active = null;
			runAc.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Browser run ended")));
		}
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

	async #runOp<T>(
		active: ActiveRun,
		label: string,
		cellSignal: AbortSignal,
		perOpTimeoutMs: number,
		fn: (signal: AbortSignal) => Promise<T>,
		opts?: { selector?: string; zeroMatchAfterMs?: number },
	): Promise<T> {
		const opId = active.opCounter++;
		active.inflight.set(opId, { label, startedAt: Date.now() });
		const capped = Number.isFinite(perOpTimeoutMs) && perOpTimeoutMs > 0;
		const opTimeout = capped ? scopedTimeoutSignal(perOpTimeoutMs) : undefined;
		const opSignal = opTimeout ? AbortSignal.any([cellSignal, opTimeout.signal]) : cellSignal;
		const selector = opts?.selector;
		const watchdog =
			selector !== undefined && opts?.zeroMatchAfterMs !== undefined && parseAriaRefSelector(selector) === null
				? { selector, afterMs: opts.zeroMatchAfterMs }
				: undefined;
		const earlyAc = new AbortController();
		try {
			if (!watchdog) return await fn(opSignal);
			const racedSignal = AbortSignal.any([opSignal, earlyAc.signal]);
			return await Promise.race([
				fn(racedSignal),
				this.#zeroMatchWatchdog(watchdog.selector, label, watchdog.afterMs, racedSignal),
			]);
		} catch (err) {
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
			} catch {}
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
		const op = <T>(
			label: string,
			perOpMs: number,
			fn: (sig: AbortSignal) => Promise<T>,
			selectorOpts?: { selector?: string; zeroMatchAfterMs?: number },
		): Promise<T> => markHandled(this.#runOp(active, label, signal, perOpMs, fn, selectorOpts));
		return {
			name,
			page,
			signal,
			url: () => page.url(),
			title: () => op("tab.title()", INF, sig => untilAborted(sig, () => page.title())),
			goto: (url, opts) =>
				op(`tab.goto(${JSON.stringify(url)})`, INF, async sig => {
					this.#clearElementCache();
					try {
						await untilAborted(sig, () =>
							page.goto(url, { waitUntil: opts?.waitUntil ?? "load", timeout: budgetBound }),
						);
					} catch (err) {
						if (isTimeoutError(err)) {
							await this.#stopLoading();
							throw new ToolError(
								`tab.goto(${JSON.stringify(url)}) timed out after ${budgetBound}ms; pending navigation stopped — retry with a longer tool timeout or waitUntil:"domcontentloaded"`,
							);
						}
						throw err;
					}
				}),
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
							return await untilAborted(sig, () => captureAriaSnapshot(page, root, opts));
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
					async sig => {
						if (parseAriaRefSelector(selector) !== null) {
							const handle = await this.#resolveAriaRef(selector);
							try {
								await untilAborted(sig, () => handle.click());
							} finally {
								await releaseHandle(handle);
							}
							return;
						}
						const resolved = normalizeSelector(selector);
						if (resolved.startsWith("text/")) await clickQueryHandlerText(page, resolved, actionOpMs, sig);
						else
							await untilAborted(sig, () =>
								page.locator(resolved).setTimeout(actionOpMs).click({ signal: sig }),
							);
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			type: (selector, text) =>
				op(
					`tab.type(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, actionOpMs, sig);
						try {
							await untilAborted(sig, () => handle.type(text, { delay: 0 }));
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
					async sig => {
						if (parseAriaRefSelector(selector) !== null) {
							const handle = await this.#resolveAriaRef(selector);
							try {
								await fillViaHandle(handle, value, sig);
							} finally {
								await releaseHandle(handle);
							}
							return;
						}
						await untilAborted(sig, () =>
							page.locator(normalizeSelector(selector)).setTimeout(actionOpMs).fill(value, { signal: sig }),
						);
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			press: (key, opts) =>
				op(`tab.press(${JSON.stringify(key)})`, actionOpMs, async sig => {
					const selector = opts?.selector;
					if (selector) await untilAborted(sig, () => page.focus(normalizeSelector(selector)));
					await untilAborted(sig, () => page.keyboard.press(key));
				}),
			scroll: (deltaX, deltaY) =>
				op("tab.scroll()", actionOpMs, sig => untilAborted(sig, () => page.mouse.wheel({ deltaX, deltaY }))),
			drag: (from, to) => op("tab.drag()", actionOpMs, sig => this.#drag(from, to, sig)),
			waitFor: (selector, opts) => {
				const w = waitMs(opts?.timeout);
				return op(
					`tab.waitFor(${JSON.stringify(selector)})`,
					w,
					async sig => toActionableHandle(await this.#resolveActionHandle(selector, w, sig)),
					{ selector, zeroMatchAfterMs: opts?.timeout === undefined ? ZERO_MATCH_FAIL_FAST_MS : undefined },
				);
			},
			waitForSelector: (selector, opts) => {
				const w = waitMs(opts?.timeout);
				return op(
					`tab.waitForSelector(${JSON.stringify(selector)})`,
					w,
					async sig => {
						if (parseAriaRefSelector(selector) !== null)
							return toActionableHandle(await this.#resolveAriaRef(selector));
						const handle = (await untilAborted(sig, () =>
							page.waitForSelector(normalizeSelector(selector), {
								timeout: w,
								visible: opts?.visible,
								hidden: opts?.hidden,
								signal: sig,
							}),
						)) as ElementHandle | null;
						return handle ? toActionableHandle(handle) : null;
					},
					{
						selector,
						zeroMatchAfterMs: opts?.timeout === undefined && !opts?.hidden ? ZERO_MATCH_FAIL_FAST_MS : undefined,
					},
				);
			},
			waitForNavigation: opts => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForNavigation()", w, sig =>
					untilAborted(sig, () =>
						page.waitForNavigation({ waitUntil: opts?.waitUntil ?? "load", timeout: w, signal: sig }),
					),
				);
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
					async sig => {
						const handle = await this.#resolveActionHandle(selector, actionOpMs, sig);
						try {
							await untilAborted(sig, () =>
								handle.evaluate(el => {
									const target = el as unknown as {
										scrollIntoView: (opts: { behavior: string; block: string; inline: string }) => void;
									};
									target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
								}),
							);
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
					sig => this.#select(selector, values, actionOpMs, sig),
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			uploadFile: (selector, ...filePaths) =>
				op(
					`tab.uploadFile(${JSON.stringify(selector)})`,
					actionOpMs,
					sig => this.#uploadFile(selector, filePaths, actionOpMs, sig, session),
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
			id: async id => toActionableHandle(await this.#resolveCachedHandle(id)),
			ref: async id => toActionableHandle(await this.#resolveAriaRef(id)),
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
		const scroll = (await untilAborted(options.signal, () =>
			page.evaluate(() => {
				const win = globalThis as unknown as {
					scrollX: number;
					scrollY: number;
					innerWidth: number;
					innerHeight: number;
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
				};
			}),
		)) as Observation["scroll"];
		return {
			url: page.url(),
			title: (await untilAborted(options.signal, () => page.title())) as string,
			viewport: page.viewport() ?? DEFAULT_VIEWPORT,
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
		await bestEffort(
			untilAborted(signal, () => page.bringToFront()),
			"an already-active or freshly-closed target never fails the capture",
		);
		const fullPage = opts.selector ? false : (opts.fullPage ?? false);
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

	async #drag(from: DragTarget, to: DragTarget, signal: AbortSignal): Promise<void> {
		const page = this.#requirePage();
		const resolveDragPoint = async (
			target: DragTarget,
			role: "from" | "to",
		): Promise<{ x: number; y: number; handle?: ElementHandle }> => {
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
				return { x: box.x + box.width / 2, y: box.y + box.height / 2, handle };
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
		let end: { x: number; y: number; handle?: ElementHandle } | undefined;
		try {
			end = await resolveDragPoint(to, "to");
			await untilAborted(signal, () => page.mouse.move(start.x, start.y));
			await untilAborted(signal, () => page.mouse.down());
			await untilAborted(signal, () => page.mouse.move(end!.x, end!.y, { steps: 12 }));
			await untilAborted(signal, () => page.mouse.up());
		} finally {
			await releaseHandle(start.handle);
			await releaseHandle(end?.handle);
		}
	}

	async #select(selector: string, values: string[], timeoutMs: number, signal: AbortSignal): Promise<string[]> {
		const page = this.#requirePage();
		const handle = (await untilAborted(signal, () =>
			page.locator(normalizeSelector(selector)).setTimeout(timeoutMs).waitHandle({ signal }),
		)) as ElementHandle;
		try {
			return (await untilAborted(signal, () =>
				handle.evaluate((el, vals) => {
					interface SelectOption {
						value: string;
						selected: boolean;
					}
					interface SelectLike {
						tagName: string;
						options: ArrayLike<SelectOption>;
						dispatchEvent: (event: unknown) => boolean;
					}
					const select = el as unknown as SelectLike;
					if (select?.tagName !== "SELECT") throw new Error("tab.select() requires a <select> element");
					const EventCtor = (
						globalThis as unknown as { Event: new (type: string, init?: { bubbles: boolean }) => unknown }
					).Event;
					const wanted = new Set(vals as string[]);
					const selected: string[] = [];
					for (let i = 0; i < select.options.length; i++) {
						const opt = select.options[i] as SelectOption;
						opt.selected = wanted.has(opt.value);
						if (opt.selected) selected.push(opt.value);
					}
					select.dispatchEvent(new EventCtor("input", { bubbles: true }));
					select.dispatchEvent(new EventCtor("change", { bubbles: true }));
					return selected;
				}, values),
			)) as string[];
		} finally {
			await releaseHandle(handle);
		}
	}

	async #uploadFile(
		selector: string,
		filePaths: string[],
		timeoutMs: number,
		signal: AbortSignal,
		session: SessionSnapshot,
	): Promise<void> {
		if (!filePaths.length) throw new ToolError("tab.uploadFile() requires at least one file path");
		const page = this.#requirePage();
		const handle = (await untilAborted(signal, () =>
			page.locator(normalizeSelector(selector)).setTimeout(timeoutMs).waitHandle({ signal }),
		)) as ElementHandle;
		try {
			const absolute = filePaths.map(filePath => resolveToCwd(filePath, session.cwd));
			const upload = handle as unknown as { uploadFile: (...paths: string[]) => Promise<void> };
			const tagName = (await untilAborted(signal, () =>
				handle.evaluate(el => (el as unknown as { tagName: string }).tagName),
			)) as string;
			if (tagName !== "INPUT")
				throw new ToolError(
					`tab.uploadFile() requires an <input type="file"> element (got <${tagName.toLowerCase()}>)`,
				);
			await untilAborted(signal, () => upload.uploadFile(...absolute));
		} finally {
			await releaseHandle(handle);
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
		const handle = await resolveAriaRefHandle(this.#requirePage(), ref);
		if (!handle) {
			throw new ToolError(
				`Unknown ARIA ref ${JSON.stringify(ref)}. Run tab.ariaSnapshot() to refresh refs (they renumber each snapshot).`,
			);
		}
		return handle;
	}

	async #resolveActionHandle(selector: string, timeoutMs: number, sig: AbortSignal): Promise<ElementHandle> {
		if (parseAriaRefSelector(selector) !== null) return this.#resolveAriaRef(selector);
		return (await untilAborted(sig, () =>
			this.#requirePage().locator(normalizeSelector(selector)).setTimeout(timeoutMs).waitHandle({ signal: sig }),
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
		if (this.#mode === "headless" && page && !page.isClosed()) {
			await bestEffort(page.close(), "a page that will not close is already closing or going with its browser");
		}
		if (this.#browser?.connected) this.#browser.disconnect();
		this.#transport.send({ type: "closed" });
		this.#transport.close();
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
