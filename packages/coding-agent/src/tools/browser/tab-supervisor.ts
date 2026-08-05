import { errorMessage, isCancellation, logger, postmortem, Snowflake, workerHostEntry } from "@veyyon/utils";
import { callSessionTool } from "../../eval/js/tool-bridge";
import { registerOwnedResourceDisposer } from "../../session/owned-resources";
import { logWorkerMessage } from "../../subprocess/worker-log";
import { raceWithTimeout } from "../../utils/fetch-timeout";
import { webpExclusionForModel } from "../../utils/image-loading";
import { TAB_WORKER_ARG } from "../../worker-args";
import type { ToolSession } from "../index";
import { expandPath } from "../path-utils";
import { ToolAbortError, ToolError } from "../tool-errors";
import { pickElectronTarget } from "./attach";
import { CmuxTab, runCmuxCode } from "./cmux/cmux-tab";
import { mapWaitUntil } from "./cmux/rpc";
import { DEFAULT_VIEWPORT } from "./launch";
import {
	type BrowserHandle,
	type BrowserKindTag,
	type CmuxBrowserHandle,
	holdBrowser,
	type PuppeteerBrowserHandle,
	releaseBrowser,
} from "./registry";
import type {
	BrowserRunError,
	ReadyInfo,
	RunResultOk,
	SessionSnapshot,
	TabRunErrorPayload,
	TabWorkerInbound,
	TabWorkerOutbound,
	TabWorkerTransport,
	Transferable,
	WorkerInitPayload,
} from "./tab-protocol";
import { targetIdForPage, targetIdForTarget } from "./target-id";

// Coding-agent binary/bundle workers route through the CLI entrypoint with a
// hidden argv mode, so compiled/npm builds only need one JavaScript entry.

interface WorkerHandle {
	send(msg: TabWorkerInbound, transferList?: Transferable[]): void;
	onMessage(handler: (msg: TabWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
	readonly mode: "worker" | "inline";
}

/**
 * Terminate a tab worker, in one place.
 *
 * Every caller reaches this while tearing a tab down, either because the tab was released or because the
 * worker stopped answering and is being replaced. None of them can usefully throw: the release has already
 * removed the tab, and the recycle paths raise their own error describing why the recycle failed, which is
 * the error the operator needs rather than the terminate that came after it.
 *
 * The failure is still reported, because it is not free. A terminate fails either because the worker has
 * already exited, which is harmless, or because it is alive and refusing to stop, and in the second case
 * the tab is dropped from the registry while the process keeps running. That is a leaked worker for the
 * lifetime of the session, so it is logged with the reason and the site that was tearing down.
 */
async function terminateWorker(worker: WorkerHandle, context: string): Promise<void> {
	try {
		await worker.terminate();
	} catch (error) {
		logger.warn("browser tab worker did not terminate", { context, mode: worker.mode, error: errorMessage(error) });
	}
}

export type DialogPolicy = "accept" | "dismiss";

export interface PendingRun {
	resolve(result: RunResultOk): void;
	reject(error: unknown): void;
	session: ToolSession;
	signal?: AbortSignal;
	toolCalls: Map<string, AbortController>;
	/**
	 * Fires when `releaseTab` closes the tab out from under an in-flight run
	 * (sibling `browser close --all`, session-scoped reap, etc.). Composed
	 * into the cmux run's signal so `wait(...)`, cmux socket calls, and the
	 * facade proxies unwind promptly instead of blocking to the run's
	 * timeout. `pending.reject` still fires first so the awaiting caller
	 * sees the tab-close error immediately; `closeAc` propagates the
	 * cancellation into the still-running `runCmuxCode` body (issue #4499).
	 */
	closeAc?: AbortController;
}

interface TabSessionBase<TBrowser extends BrowserHandle = BrowserHandle> {
	name: string;
	browser: TBrowser;
	targetId: string;
	state: "alive" | "dead";
	info: ReadyInfo;
	pending: Map<string, PendingRun>;
	dialogPolicy?: DialogPolicy;
	kindTag: BrowserKindTag;
	/**
	 * Session id of the caller that CREATED the tab. Preserved across reuse so
	 * that dispose of the creating session can reap browser resources without
	 * yanking the tab out from under a subagent that only reused it.
	 * Undefined when the acquirer did not identify itself.
	 */
	ownerSessionId?: string;
}

export interface WorkerTabSession extends TabSessionBase<PuppeteerBrowserHandle> {
	backend: "worker";
	worker: WorkerHandle;
}

export interface CmuxTabSession extends TabSessionBase<CmuxBrowserHandle> {
	backend: "cmux";
	cmuxTab: CmuxTab;
	cmuxOwnsSurface: boolean;
	cmuxAttachedSurface?: string;
}

export type TabSession = WorkerTabSession | CmuxTabSession;

export interface AcquireTabOptions {
	url?: string;
	waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	target?: string;
	signal?: AbortSignal;
	timeoutMs: number;
	dialogs?: DialogPolicy;
	cmuxSurface?: string;
	/**
	 * Session id of the acquirer. Recorded on the tab when created (never on
	 * reuse) so `releaseTabsForOwner` can walk the shared tabs map on session
	 * dispose. Optional — omitting it opts the tab out of session-scoped reap.
	 */
	ownerSessionId?: string;
}

export interface AcquireTabResult {
	tab: TabSession;
	created: boolean;
}

export interface RunInTabOptions {
	code: string;
	timeoutMs: number;
	signal?: AbortSignal;
	session: ToolSession;
}

export interface ReleaseTabOptions {
	kill?: boolean;
}

const tabs = new Map<string, TabSession>();
// Per-name acquisition chain: serializes concurrent `acquireTab` calls for the
// same tab name so the existence check and `tabs.set` (separated by several
// awaits) cannot interleave and leak a worker + browser refCount.
const acquireChains = new Map<string, Promise<void>>();
const GRACE_MS = 750;
// Names of tabs the supervisor force-killed (timeout past grace, failed recycle),
// mapped to the kill reason. Lets the next `run` on that name explain WHY the tab
// vanished instead of a bare "not alive". Cleared when the name is opened again.
const killedTabs = new Map<string, string>();

export function getTab(name: string): TabSession | undefined {
	return tabs.get(name);
}

export function acquireTab(name: string, browser: BrowserHandle, opts: AcquireTabOptions): Promise<AcquireTabResult> {
	const prior = acquireChains.get(name) ?? Promise.resolve();
	const result = prior.then(() => acquireTabImpl(name, browser, opts));
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	acquireChains.set(name, tail);
	void tail.then(() => {
		if (acquireChains.get(name) === tail) acquireChains.delete(name);
	});
	return result;
}

async function acquireTabImpl(
	name: string,
	browser: BrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	// Serialized opens can sit behind a slow predecessor in the per-name
	// chain; honor an abort at dequeue instead of spawning a worker and
	// browser hold nobody is waiting for.
	if (opts.signal?.aborted) {
		// The caller acquired (and published) the browser handle before queueing this
		// open, so an abort at dequeue must drop it too — otherwise a live Chromium
		// sits in `browsers` at refCount 0 with no tab pointing at it.
		if (browser.refCount === 0) await releaseBrowser(browser, { kill: false }).catch(() => undefined);
		throw new ToolAbortError("Browser tab open aborted");
	}
	killedTabs.delete(name);
	// Temporary refCount hold so releasing an existing tab on the SAME browser
	// below cannot drop it to refCount 0 and dispose the instance we are about
	// to reuse (e.g. reopening the sole tab with a different dialogs policy).
	let tempHold = false;
	const existing = tabs.get(name);
	if (existing) {
		if (existing.browser === browser && existing.state === "alive") {
			const requestedCmuxSurface = "client" in browser ? (opts.cmuxSurface ?? browser.surface) : undefined;
			if (existing.backend === "cmux" && existing.cmuxAttachedSurface !== requestedCmuxSurface) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else if (opts.dialogs !== undefined && opts.dialogs !== existing.dialogPolicy) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else {
				const reuseSteps: string[] = [];
				if (opts.viewport && browser.kind.kind !== "cmux") {
					const dsf = opts.viewport.deviceScaleFactor;
					reuseSteps.push(
						`await page.setViewport({ width: ${opts.viewport.width}, height: ${opts.viewport.height}, deviceScaleFactor: ${dsf === undefined ? "undefined" : String(dsf)} });`,
					);
				}
				if (opts.url) {
					reuseSteps.push(
						`await tab.goto(${JSON.stringify(opts.url)}, { waitUntil: ${JSON.stringify(opts.waitUntil ?? "load")} });`,
					);
				}
				if (reuseSteps.length) {
					await runInTabWithSnapshot(
						name,
						{
							code: reuseSteps.join("\n"),
							timeoutMs: opts.timeoutMs,
							signal: opts.signal,
						},
						{ cwd: process.cwd() },
					);
				}
				// Re-fetch after the awaited reuse steps: the tab can be released
				// concurrently while the snapshot run is in flight.
				const reused = tabs.get(name);
				if (!reused) {
					throw new Error(`Browser tab "${name}" was released while being reused; retry the operation`);
				}
				return { tab: reused, created: false };
			}
		} else {
			if (existing.browser === browser) {
				holdBrowser(browser);
				tempHold = true;
			}
			await releaseTab(name, { kill: false });
		}
	}

	if ("client" in browser) {
		try {
			const result = await acquireCmuxTab(name, browser, opts);
			if (tempHold) await releaseBrowser(browser, { kill: false });
			return result;
		} catch (error) {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
	}
	let initPayload: WorkerInitPayload;
	let worker: WorkerHandle;
	try {
		initPayload = await buildInitPayload(browser, opts);
		worker = await spawnTabWorker();
	} catch (error) {
		// Failing before the worker took its own hold must release the
		// temporary one, or the browser's refCount never reaches 0 again.
		if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
		throw error;
	}
	let info: ReadyInfo;
	try {
		info = await initializeTabWorker(worker, initPayload, opts.timeoutMs + GRACE_MS);
	} catch (error) {
		// `BuildMessage`-class failures arrive asynchronously via the worker's `error` event,
		// after `spawnTabWorker`'s synchronous try/catch has already returned. Fall back to
		// the inline worker here so module-resolution failures don't poison every tab open.
		await terminateWorker(worker, "open-init-failed");
		if (worker.mode === "inline") {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
		logger.warn("Tab worker init failed; retrying with inline tab worker (no sync-loop guard)", {
			error: errorMessage(error),
		});
		worker = await spawnInlineWorker();
		try {
			info = await initializeTabWorker(worker, initPayload, opts.timeoutMs + GRACE_MS);
		} catch (inlineError) {
			await terminateWorker(worker, "open-inline-failed");
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			const finalError = new ToolError(
				`Failed to start browser tab worker (inline fallback also failed): ${errorMessage(inlineError)}`,
			);
			(finalError as { cause?: unknown }).cause = error;
			throw finalError;
		}
	}

	// If the caller aborted while we were spawning/initializing the worker,
	// tear the freshly-built worker down before publishing the tab so the
	// browser refCount (which `holdBrowser` below would take) never grows for
	// a tab nobody is waiting for.
	if (opts.signal?.aborted) {
		await terminateWorker(worker, "open-aborted");
		// The browser release runs while an abort is already being raised; its own failure must not
		// replace `ToolAbortError`, and the refCount it adjusts is dropped with the browser anyway.
		// `|| browser.refCount === 0` matches every sibling error path above (:257, :269,
		// :281, :292). Without it, an abort here strands the handle `acquireBrowser`
		// already published at refCount 0 — and nothing walks `browsers`, only `tabs`.
		if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false }).catch(() => undefined);
		throw new ToolAbortError("Browser tab open aborted");
	}

	holdBrowser(browser);
	if (tempHold) await releaseBrowser(browser, { kill: false });
	const tab: WorkerTabSession = {
		name,
		browser,
		targetId: info.targetId,
		backend: "worker",
		worker,
		state: "alive",
		info,
		pending: new Map(),
		dialogPolicy: opts.dialogs,
		kindTag: browser.kind.kind,
		ownerSessionId: opts.ownerSessionId,
	};
	worker.onMessage(msg => handleTabMessage(tab, msg));
	tabs.set(name, tab);
	return { tab, created: true };
}

async function acquireCmuxTab(
	name: string,
	browser: CmuxBrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	const attachedSurface = opts.cmuxSurface ?? browser.surface;
	if (attachedSurface?.startsWith("surface:")) {
		throw new ToolError(
			"app.surface must be a surface UUID (e.g. CMUX_SURFACE_ID), not a 'surface:N' ref; omit it to open a new split",
		);
	}

	let surfaceId = attachedSurface;
	let initialUrl = opts.url;
	let ownsSurface = false;
	try {
		if (!surfaceId) {
			const params: Record<string, unknown> = { url: opts.url ?? "about:blank", focus: false };
			if (process.env.CMUX_WORKSPACE_ID) params.workspace_id = process.env.CMUX_WORKSPACE_ID;
			if (process.env.CMUX_SURFACE_ID) params.surface_id = process.env.CMUX_SURFACE_ID;
			const result = await browser.client.request("browser.open_split", params, { timeoutMs: opts.timeoutMs });
			if (typeof result.surface_id !== "string" || result.surface_id.length === 0) {
				throw new ToolError("cmux browser.open_split did not return a surface_id");
			}
			surfaceId = result.surface_id;
			ownsSurface = true;
			if (typeof result.url === "string" && result.url.length > 0) initialUrl = result.url;
			if (opts.url) {
				await browser.client.request(
					"browser.wait",
					{
						surface_id: surfaceId,
						load_state: mapWaitUntil(opts.waitUntil ?? "load"),
						timeout_ms: opts.timeoutMs,
					},
					{ timeoutMs: opts.timeoutMs },
				);
			}
		}

		const cmuxTab = new CmuxTab({ client: browser.client, surfaceId, url: initialUrl });
		if (attachedSurface && opts.url) {
			await cmuxTab.goto(opts.url, { waitUntil: opts.waitUntil ?? "load", timeoutMs: opts.timeoutMs });
		}
		const info = await cmuxTab.readyInfo(opts.viewport ?? DEFAULT_VIEWPORT);
		// If the caller aborted while we were opening the cmux surface, close the
		// surface (if we own it) instead of taking a browser hold on it.
		if (opts.signal?.aborted) {
			throw new ToolAbortError("Browser tab open aborted");
		}
		holdBrowser(browser);
		const tab: CmuxTabSession = {
			name,
			browser,
			targetId: surfaceId,
			backend: "cmux",
			cmuxTab,
			cmuxOwnsSurface: ownsSurface,
			state: "alive",
			info,
			pending: new Map(),
			dialogPolicy: opts.dialogs,
			kindTag: browser.kind.kind,
			cmuxAttachedSurface: attachedSurface,
			ownerSessionId: opts.ownerSessionId,
		};
		tabs.set(name, tab);
		return { tab, created: true };
	} catch (error) {
		if (ownsSurface && surfaceId) {
			// Rolling back the surface we created while the open error is already propagating; that error is what
			// the caller needs, and a close that fails means the surface is already gone with the browser.
			await browser.client.request("surface.close", { surface_id: surfaceId }).catch(() => undefined);
		}
		throw error;
	}
}

export async function runInTab(name: string, opts: RunInTabOptions): Promise<RunResultOk> {
	return await runInTabWithSnapshot(
		name,
		{ code: opts.code, timeoutMs: opts.timeoutMs, signal: opts.signal, session: opts.session },
		{
			cwd: opts.session.cwd,
			browserScreenshotDir: expandBrowserScreenshotDir(opts.session),
			excludeWebP: webpExclusionForModel(opts.session.getActiveModel?.()),
		},
	);
}

async function runInTabWithSnapshot(
	name: string,
	opts: { code: string; timeoutMs: number; signal?: AbortSignal; session?: ToolSession },
	snapshot: SessionSnapshot,
): Promise<RunResultOk> {
	const tab = tabs.get(name);
	if (!tab || tab.state === "dead") {
		const killed = killedTabs.get(name);
		throw new ToolError(
			killed
				? `Tab ${JSON.stringify(name)} was killed: ${killed}. Reopen it.`
				: `Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".`,
		);
	}
	if (tab.pending.size > 0) throw new ToolError(`Tab ${JSON.stringify(name)} is busy`);
	const id = Snowflake.next();
	const { promise, resolve, reject } = Promise.withResolvers<RunResultOk>();
	// `releaseTab` calls `pending.reject(closeError)` when the tab dies
	// out from under an in-flight run (sibling `browser close --all`,
	// session-scoped reap, etc.). Both backends below MUST end up awaiting
	// this same `promise` so:
	//   1. The caller sees `Tab ... was closed` immediately instead of
	//      blocking to the run's timeout, and
	//   2. `reject(...)` always has an attached handler — a zero-consumer
	//      rejection would fire `unhandledRejection` and the CLI's
	//      top-level handler would tear the whole session down, killing
	//      every other tab and subagent sharing the process (issue #4499).
	// The cmux branch also composes `closeAc.signal` into the run's abort
	// signal so `wait(...)`, cmux socket calls, and the facade proxies
	// unwind promptly when the tab is closed — otherwise a `wait(60_000)`
	// with no in-flight socket request would keep `runCmuxCode` blocked
	// until timeout even after the tab is gone.
	const closeAc = new AbortController();
	const pending: PendingRun = {
		resolve,
		reject,
		session: opts.session ?? ({} as ToolSession),
		signal: opts.signal,
		toolCalls: new Map(),
		closeAc,
	};
	tab.pending.set(id, pending);
	if (tab.backend === "cmux") {
		const runSignal = opts.signal ? AbortSignal.any([opts.signal, closeAc.signal]) : closeAc.signal;
		try {
			// `runCmuxCode.then(resolve, reject)` publishes the run's real
			// outcome to `promise`, but `releaseTab` may have already
			// rejected it — `Promise.withResolvers` settles on the first
			// call and later resolve/reject are no-ops, so the tab-close
			// error still wins the race.
			runCmuxCode(tab.cmuxTab, {
				code: opts.code,
				timeoutMs: opts.timeoutMs,
				signal: runSignal,
				session: pending.session,
				snapshot,
			}).then(resolve, reject);
			return await promise;
		} finally {
			tab.pending.delete(id);
		}
	}
	const abort = (): void => {
		// `safeSend`, not `tab.worker.send`: this runs from an `abort` event listener, so a
		// throw from a worker terminated by a concurrent recycle/force-kill would escape
		// with nowhere to go. Every other post-init send in this file is already guarded.
		safeSend(tab, { type: "abort", id });
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(opts.signal?.reason);
	};
	opts.signal?.addEventListener("abort", abort, { once: true });
	try {
		// An already-aborted signal must NOT send `abort` and then `run`: the worker drops
		// the abort (`#active` is still null, so `case "abort"`'s id check fails), the run
		// then executes to completion, and the caller blocks the full timeout on a
		// cancellation it already requested. Throw instead of sending anything — and throw
		// INSIDE the try, because the `finally` below deletes the pending entry. Leaking it
		// would leave `tab.pending.size > 0` forever, making the tab permanently "busy".
		if (opts.signal?.aborted) throw new ToolAbortError("Browser run aborted");
		tab.worker.send({
			type: "run",
			id,
			name,
			code: opts.code,
			timeoutMs: opts.timeoutMs,
			session: snapshot,
		});
		try {
			return await raceWithTimeout(
				promise,
				opts.timeoutMs + GRACE_MS,
				() => new ToolError("Browser code execution hung past grace; tab killed"),
				{ onTimeout: async () => await forceKillTab(name, "Browser code execution hung past grace; tab killed") },
			);
		} catch (error) {
			if (error instanceof ToolError && error.message.startsWith("Browser code execution timed out after ")) {
				try {
					if (tab.worker.mode === "inline")
						await forceKillTab(name, "Browser code execution timed out; tab killed");
					else await recycleTimedOutWorkerTab(tab, opts.timeoutMs + GRACE_MS);
				} catch (recycleError) {
					logger.warn("Failed to recycle timed-out browser tab worker; killing tab", {
						error: errorMessage(recycleError),
					});
					await forceKillTab(name, "Browser code execution timed out; tab killed");
				}
			}
			throw error;
		}
	} finally {
		opts.signal?.removeEventListener("abort", abort);
		tab.pending.delete(id);
	}
}

export async function releaseTab(name: string, opts: ReleaseTabOptions = {}): Promise<boolean> {
	const tab = tabs.get(name);
	if (!tab) {
		logger.debug("releaseTab: unknown tab", { name });
		return false;
	}
	const wasAlive = tab.state === "alive";
	tab.state = "dead";
	const closeError = postmortem.markExpectedCleanupError(new ToolError(`Tab ${JSON.stringify(name)} was closed`));
	for (const [id, pending] of tab.pending) {
		if (tab.backend === "worker") {
			try {
				tab.worker.send({ type: "abort", id, expectedCleanup: true });
			} catch {
				// The tab is already marked dead: a worker that has exited cannot be
				// told to abort, and the abort below cancels the call regardless.
			}
		}
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(closeError);
		// Propagate the closure into the cmux run's abort signal so
		// `wait(...)`, in-flight cmux socket calls, and the facade proxies
		// unwind promptly. Firing this BEFORE `pending.reject` means
		// `runCmuxCode` finishes with `ToolAbortError` and its `.then(reject)`
		// is a no-op — `promise` still settles with the tab-close error via
		// the `reject` call below. Without it, a run that isn't currently
		// making a socket request (e.g. `await wait(60_000)`) would keep
		// `runCmuxCode` blocked until timeout even after `pending.reject`
		// unblocked the caller (issue #4499 review feedback).
		pending.closeAc?.abort(closeError);
		pending.reject(closeError);
	}
	tab.pending.clear();
	if (tab.backend === "cmux") {
		let nonLastCloseError: unknown;
		if (wasAlive && tab.cmuxOwnsSurface) {
			try {
				await tab.browser.client.request("surface.close", { surface_id: tab.targetId });
			} catch (err) {
				if (isLastSurfaceCloseError(err)) {
					logger.debug("Leaving cmux browser surface open because it is the last surface in the workspace", {
						error: errorMessage(err),
					});
				} else {
					nonLastCloseError = err;
				}
			}
		}
		await releaseBrowser(tab.browser, { kill: opts.kill ?? false });
		tabs.delete(name);
		if (nonLastCloseError) throw nonLastCloseError;
		return true;
	}
	let forced = false;
	if (wasAlive) {
		try {
			tab.worker.send({ type: "close" });
			await waitForClosed(tab);
		} catch {
			forced = true;
		}
	}
	await terminateWorker(tab.worker, "release-tab");
	if (forced && tab.kindTag === "headless") await closeOrphanTarget(tab);
	await releaseBrowser(tab.browser, { kill: opts.kill ?? false });
	tabs.delete(name);
	return true;
}

export async function releaseAllTabs(opts: ReleaseTabOptions = {}): Promise<number> {
	const names = [...tabs.keys()];
	let count = 0;
	for (const name of names) {
		if (await releaseTab(name, opts)) count++;
	}
	return count;
}

export async function dropHeadlessTabs(): Promise<void> {
	const names = [...tabs.values()].filter(tab => tab.kindTag === "headless").map(tab => tab.name);
	for (const name of names) await releaseTab(name);
}

/**
 * Release every tab created by the given session id. Invoked from
 * `AgentSession.dispose()` so headless/spawned Chromium and workers the
 * session opened do not leak into the long-lived process — the module-global
 * `tabs`/`browsers` maps that back this tool are not otherwise walked by
 * session teardown. (Issue #3963.)
 *
 * Ownership is recorded ONLY on tab creation (`acquireTab` with
 * `ownerSessionId`), never on reuse: a subagent re-driving a tab another
 * session opened will not yank teardown responsibility away from the
 * creator. Tabs opened with no owner (e.g. from an SDK caller that doesn't
 * identify a session) are skipped and must be released explicitly.
 */
export async function releaseTabsForOwner(ownerId: string, opts: ReleaseTabOptions = {}): Promise<number> {
	if (!ownerId) return 0;
	const names = [...tabs.values()].filter(tab => tab.ownerSessionId === ownerId).map(tab => tab.name);
	let count = 0;
	for (const name of names) {
		if (await releaseTab(name, opts)) count++;
	}
	return count;
}

/** Test-only accessor for the module-global tabs map. */
export function getTabsMapForTest(): ReadonlyMap<string, TabSession> {
	return tabs;
}

function isLastSurfaceCloseError(err: unknown): boolean {
	const message = errorMessage(err);
	return /last/i.test(message);
}

async function buildInitPayload(browser: PuppeteerBrowserHandle, opts: AcquireTabOptions): Promise<WorkerInitPayload> {
	const browserWSEndpoint = browser.browser.wsEndpoint();
	if (!browserWSEndpoint) throw new ToolError("Browser websocket endpoint is unavailable");
	if (browser.kind.kind === "headless") {
		return {
			mode: "headless",
			browserWSEndpoint,
			viewport: opts.viewport,
			dialogs: opts.dialogs,
			url: opts.url,
			waitUntil: opts.waitUntil,
			timeoutMs: opts.timeoutMs,
		};
	}
	const page = await pickElectronTarget(browser.browser, opts.target);
	const targetId = await targetIdForPage(page);
	return {
		mode: "attach",
		browserWSEndpoint,
		targetId,
		dialogs: opts.dialogs,
	};
}

function handleTabMessage(tab: WorkerTabSession, msg: TabWorkerOutbound): void {
	if (msg.type === "result") {
		const pending = tab.pending.get(msg.id);
		if (!pending) return;
		tab.pending.delete(msg.id);
		if (msg.ok) {
			pending.resolve(msg.payload);
			return;
		}
		const failure: BrowserRunError = errorFromPayload(msg.error);
		// Carried on the error rather than resolved separately: the run DID fail, so the caller must
		// still see a rejection, and the output it produced first is context for that rejection.
		if (msg.partial) failure.partialRunOutput = msg.partial;
		pending.reject(failure);
		return;
	}
	if (msg.type === "ready") {
		tab.info = msg.info;
		return;
	}
	if (msg.type === "tool-call") {
		void dispatchToolCall(tab, msg);
		return;
	}
	if (msg.type === "log") logWorkerMessage(msg);
}

async function dispatchToolCall(
	tab: WorkerTabSession,
	msg: Extract<TabWorkerOutbound, { type: "tool-call" }>,
): Promise<void> {
	const pending = tab.pending.get(msg.runId);
	if (!pending?.session.cwd) {
		safeSend(tab, {
			type: "tool-reply",
			id: msg.id,
			reply: {
				ok: false,
				error: { name: "ToolError", message: "No active run for tool call", isToolError: true, isAbort: false },
			},
		});
		return;
	}
	const ctrl = new AbortController();
	pending.toolCalls.set(msg.id, ctrl);
	const onParentAbort = (): void => ctrl.abort(pending.signal?.reason);
	if (pending.signal?.aborted) onParentAbort();
	else pending.signal?.addEventListener("abort", onParentAbort, { once: true });
	try {
		const value = await callSessionTool(msg.name, msg.args, {
			session: pending.session,
			signal: ctrl.signal,
			emitStatus: () => {
				// Status events from tool calls aren't piped back to user code yet; the worker
				// already pushes its own helper status via the display channel.
			},
		});
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: true, value } });
	} catch (error) {
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: false, error: toErrorPayload(error) } });
	} finally {
		pending.toolCalls.delete(msg.id);
		pending.signal?.removeEventListener("abort", onParentAbort);
	}
}

function safeSend(tab: WorkerTabSession, msg: TabWorkerInbound): void {
	if (tab.state !== "alive") return;
	try {
		tab.worker.send(msg);
	} catch (err) {
		logger.debug("tab worker send failed", { error: errorMessage(err) });
	}
}

function toErrorPayload(error: unknown): TabRunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			// Deadlines count as aborts for this classification: the caller uses the
			// flag to decide whether the tab stopped for a reason of its own, and a
			// timeout is one.
			isAbort: isCancellation(error),
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { name: "Error", message: String(error), isAbort: false, isToolError: false };
}

async function recycleTimedOutWorkerTab(tab: WorkerTabSession, timeoutMs: number): Promise<void> {
	const oldWorker = tab.worker;
	await terminateWorker(oldWorker, "recycle-timed-out");
	const browserWSEndpoint = tab.browser.browser.wsEndpoint();
	if (!browserWSEndpoint) throw new ToolError("Browser websocket endpoint is unavailable");
	const payload: WorkerInitPayload = {
		mode: "attach",
		browserWSEndpoint,
		targetId: tab.targetId,
		dialogs: tab.dialogPolicy,
		// Unblock a wedged page (open JS dialog, hung navigation) before adopting it —
		// otherwise init stalls, times out, and the tab gets force-killed.
		recover: true,
	};
	let worker = await spawnTabWorker();
	try {
		const info = await initializeTabWorker(worker, payload, timeoutMs);
		tab.worker = worker;
		tab.info = info;
		tab.state = "alive";
		worker.onMessage(msg => handleTabMessage(tab, msg));
	} catch (error) {
		await terminateWorker(worker, "recycle-spawn-failed");
		worker = await spawnInlineWorker();
		try {
			const info = await initializeTabWorker(worker, payload, timeoutMs);
			tab.worker = worker;
			tab.info = info;
			tab.state = "alive";
			worker.onMessage(msg => handleTabMessage(tab, msg));
		} catch (inlineError) {
			await terminateWorker(worker, "recycle-inline-failed");
			const finalError = new ToolError(
				`Failed to recycle timed-out browser tab worker (inline fallback also failed): ${errorMessage(inlineError)}`,
			);
			Object.defineProperty(finalError, "cause", { value: error, configurable: true });
			throw finalError;
		}
	}
}

async function forceKillTab(name: string, reason: string): Promise<void> {
	const tab = tabs.get(name);
	if (!tab) return;
	killedTabs.set(name, reason);
	tab.state = "dead";
	const error = postmortem.markExpectedCleanupError(new ToolError(reason));
	for (const pending of tab.pending.values()) pending.reject(error);
	tab.pending.clear();
	if (tab.backend === "cmux") {
		await releaseBrowser(tab.browser, { kill: false });
		tabs.delete(name);
		return;
	}
	await terminateWorker(tab.worker, "force-kill");
	if (tab.kindTag === "headless") await closeOrphanTarget(tab);
	await releaseBrowser(tab.browser, { kill: false });
	tabs.delete(name);
}

async function closeOrphanTarget(tab: WorkerTabSession): Promise<void> {
	for (const target of tab.browser.browser.targets()) {
		// Closing an orphaned target after its worker died. Each step tolerates the target already being gone,
		// which is the common case: an id that cannot be read cannot match, a target that will not hand over a
		// page has nothing to close, and a close that fails means it closed itself first. Nothing depends on the
		// outcome -- the tab is already out of the registry.
		if ((await targetIdForTarget(target).catch(() => "")) !== tab.targetId) continue;
		const page = await target.page().catch(() => null);
		await page?.close().catch(() => undefined);
		return;
	}
}

async function waitForClosed(tab: WorkerTabSession): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = tab.worker.onMessage(msg => {
		if (msg.type === "closed") resolve();
	});
	try {
		await raceWithTimeout(promise, GRACE_MS, () => new ToolError("Timed out closing browser tab worker"));
	} finally {
		unsubscribe();
	}
}

function expandBrowserScreenshotDir(session: ToolSession): string | undefined {
	const value = session.settings.get("browser.screenshotDir") as string | undefined;
	return value ? expandPath(value) : undefined;
}

function errorFromPayload(payload: TabRunErrorPayload): Error {
	const error = payload.isAbort
		? new ToolAbortError()
		: payload.isToolError
			? new ToolError(payload.message)
			: new Error(payload.message);
	error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

async function spawnTabWorker(): Promise<WorkerHandle> {
	try {
		const hostEntry = workerHostEntry();
		const worker = hostEntry
			? new Worker(hostEntry, { type: "module", argv: [TAB_WORKER_ARG] })
			: new Worker(new URL("./tab-worker-entry.ts", import.meta.url).href, { type: "module" });
		return wrapBunWorker(worker);
	} catch (err) {
		logger.warn("Bun Worker spawn failed; using inline tab worker (no sync-loop guard)", {
			error: errorMessage(err),
		});
		return spawnInlineWorker();
	}
}

function wrapBunWorker(worker: Worker): WorkerHandle {
	return {
		mode: "worker",
		send(msg, transferList) {
			worker.postMessage(msg, { transfer: transferList ?? [] });
		},
		onMessage(handler) {
			const wrap = (event: MessageEvent): void => handler(event.data as TabWorkerOutbound);
			worker.addEventListener("message", wrap);
			return () => worker.removeEventListener("message", wrap);
		},
		onError(handler) {
			const onError = (event: ErrorEvent): void => handler(errorFromWorkerEvent(event));
			const onMessageError = (event: MessageEvent): void =>
				handler(new ToolError(`Tab worker message error: ${String(event.data)}`));
			worker.addEventListener("error", onError);
			worker.addEventListener("messageerror", onMessageError);
			return () => {
				worker.removeEventListener("error", onError);
				worker.removeEventListener("messageerror", onMessageError);
			};
		},
		async terminate() {
			worker.terminate();
		},
	};
}

/**
 * Inline fallback for environments where Bun cannot compile or spawn the worker
 * entry. This preserves normal browser behavior but cannot interrupt synchronous
 * infinite loops because user code runs on the main thread.
 */
async function spawnInlineWorker(): Promise<WorkerHandle> {
	const hostListeners = new Set<(message: TabWorkerOutbound) => void>();
	const workerListeners = new Set<(message: TabWorkerInbound) => void>();
	const workerTransport: TabWorkerTransport = {
		send: msg =>
			queueMicrotask(() => {
				for (const listener of hostListeners) listener(msg as TabWorkerOutbound);
			}),
		onMessage: handler => {
			const typed = handler as (message: TabWorkerInbound) => void;
			workerListeners.add(typed);
			return () => workerListeners.delete(typed);
		},
		close: () => {},
	};
	const { WorkerCore } = await import("./tab-worker");
	new WorkerCore(workerTransport);
	return {
		mode: "inline",
		send: msg =>
			queueMicrotask(() => {
				for (const listener of workerListeners) listener(msg);
			}),
		onMessage: handler => {
			hostListeners.add(handler);
			return () => hostListeners.delete(handler);
		},
		onError: () => () => {},
		async terminate() {},
	};
}

async function initializeTabWorker(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
): Promise<ReadyInfo> {
	const { promise, resolve, reject } = Promise.withResolvers<ReadyInfo>();
	const unlisten = worker.onMessage(msg => {
		if (msg.type === "ready") resolve(msg.info);
		else if (msg.type === "init-failed") reject(errorFromPayload(msg.error));
		else if (msg.type === "log") logWorkerMessage(msg);
	});
	const unlistenError = worker.onError(error => {
		reject(new ToolError(`Tab worker failed during startup: ${error.message}`));
	});
	try {
		worker.send({ type: "init", payload });
		return await raceWithTimeout(
			promise,
			timeoutMs,
			() => new ToolError("Timed out initializing browser tab worker"),
		);
	} finally {
		unlisten();
		unlistenError();
	}
}

export function initializeTabWorkerForTest(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
): Promise<ReadyInfo> {
	return initializeTabWorker(worker, payload, timeoutMs);
}

function errorFromWorkerEvent(event: ErrorEvent): Error {
	if (event.error instanceof Error) return event.error;
	if (event.message) return new Error(event.message);
	return new Error("Unknown tab worker error");
}

/**
 * Wire tab release into the session's owner-scoped cleanup.
 *
 * Keyed by the SESSION id, not the eval-kernel owner id: `ownerSessionId` is stamped at
 * `acquireTab` creation and never on reuse, so a subagent re-driving a tab another session opened
 * does not take teardown responsibility from the creator. Bounded, because teardown talks to a
 * live CDP connection and a broken close must not stall `/exit` (issue #3963).
 */
registerOwnedResourceDisposer({
	name: "browser-tabs",
	scope: "session",
	timeoutMs: 3_000,
	dispose: ownerId => releaseTabsForOwner(ownerId, { kill: true }),
});
