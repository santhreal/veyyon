import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { errorMessage, isTimeoutError, postmortem, Snowflake, untilAborted } from "@veyyon/utils";
import { bestEffort, optionalResult } from "@veyyon/utils/discarded-fault";
import type {
	Browser,
	CDPSession,
	Dialog,
	ElementHandle,
	ElementScreenshotOptions,
	HTTPResponse,
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
import { captureAriaSnapshot, parseAriaRefSelector, resolveAriaRefHandle } from "./aria/aria-snapshot";
import { releaseHandle } from "./handle-release";
import {
	applyStealthPatches,
	applyViewport,
	BROWSER_PROTOCOL_TIMEOUT_MS,
	DEFAULT_VIEWPORT,
	loadPuppeteer,
} from "./launch";
import { extractReadableFromHtml } from "./readable";
import { markHandled, resolvePredicateTimeout, type WaitPredicateOptions, waitForBrowserRun } from "./run-cancellation";
import { cloneSafe, RunOutput } from "./run-output";
import { guardTabApi } from "./tab-api-guard";
import type {
	Observation,
	ObservationEntry,
	ReadyInfo,
	ScreenshotResult,
	SessionSnapshot,
	TabWorkerInbound,
	TabWorkerTransport,
	ToolReply,
	WorkerInitPayload,
} from "./tab-protocol";
import {
	type ActiveRun,
	clickQueryHandlerText,
	collectObservationEntries,
	type DialogPolicy,
	type DragTarget,
	describeInflight,
	describeScreenshot,
	errorPayload,
	fillViaHandle,
	formatSelectorMatchHint,
	imageFormatForPath,
	normalizeSelector,
	type OpenDialogInfo,
	redactUrlCredentials,
	replyError,
	resolveOpTimeouts,
	resolveWaitTimeout,
	type ScreenshotOptions,
	type TabApi,
	toActionableHandle,
	ZERO_MATCH_FAIL_FAST_MS,
	ZERO_MATCH_POLL_MS,
} from "./tab-worker-helpers";
import { targetIdForPage, targetIdForTarget } from "./target-id";

export {
	type ActionableHandle,
	describeInflight,
	describeMissingClickTarget,
	describeScreenshot,
	formatSelectorMatchHint,
	type InflightOp,
	imageFormatForPath,
	normalizeSelector,
	type OpTimeouts,
	resolveOpTimeouts,
	resolveWaitTimeout,
	type TabApi,
	toActionableHandle,
} from "./tab-worker-helpers";

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
