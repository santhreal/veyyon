import { logger, postmortem } from "@veyyon/utils";
import type { RuntimeHooks } from "../../../eval/js/shared/runtime";
import { callSessionTool } from "../../../eval/js/tool-bridge";
import { scopedTimeoutSignal } from "../../../utils/fetch-timeout";
import { ToolAbortError, ToolError, throwIfAborted } from "../../tool-errors";
import {
	bindBrowserRunFacade,
	resolvePredicateTimeout,
	type WaitPredicateOptions,
	waitForBrowserRun,
} from "../run-cancellation";
import { cloneSafe, RunOutput } from "../run-output";
import { guardTabApi } from "../tab-api-guard";
import type { BrowserRunError, ReadyInfo, RunResultOk, ScreenshotResult } from "../tab-protocol";
import type {
	BoundingBox,
	CmuxResponseRecord,
	CmuxTab,
	RunCmuxCodeOptions,
	ScreenshotOptions,
	ViewportOptions,
	WaitUntil,
} from "./cmux-tab-helpers";

export {
	CmuxTab,
	type CmuxTabClient,
	RESPONSE_OBSERVER_SCRIPT,
	type RunCmuxCodeOptions,
} from "./cmux-tab-helpers";

export class CmuxResponse {
	readonly #record: CmuxResponseRecord;

	constructor(record: CmuxResponseRecord) {
		this.#record = record;
	}

	url(): string {
		return this.#record.url;
	}

	status(): number {
		return this.#record.status;
	}

	statusText(): string {
		return this.#record.statusText;
	}

	headers(): Record<string, string> {
		return { ...this.#record.headers };
	}

	async text(): Promise<string> {
		if (this.#record.bodyUnreadable) {
			throw new ToolError(
				`The body of ${this.#record.url} could not be read as text (it was consumed, or it is not text). ` +
					`Read it in the page instead, for example with tab.evaluate(), or match on the response status and headers.`,
			);
		}
		return this.#record.body;
	}

	async json(): Promise<unknown> {
		return JSON.parse(await this.text());
	}
}

export class CmuxElementHandle {
	readonly #tab: CmuxTab;
	readonly #selector: string;

	constructor(tab: CmuxTab, selector: string) {
		this.#tab = tab;
		this.#selector = selector;
	}

	async click(): Promise<void> {
		await this.#tab.click(this.#selector);
	}

	async type(text: string): Promise<void> {
		await this.#tab.type(this.#selector, text);
	}

	async fill(value: string): Promise<void> {
		await this.#tab.fill(this.#selector, value);
	}

	async press(key: string): Promise<void> {
		await this.#tab.press(key, { selector: this.#selector });
	}

	async focus(): Promise<void> {
		await this.#tab.focus(this.#selector);
	}

	async hover(): Promise<void> {
		await this.#tab.hover(this.#selector);
	}

	async evaluate<TResult, TArgs extends unknown[]>(
		fn: (element: unknown, ...args: TArgs) => TResult | Promise<TResult>,
		...args: TArgs
	): Promise<TResult> {
		return await this.#tab.evaluateOnSelector<TResult>(this.#selector, fn.toString(), args);
	}

	async boundingBox(): Promise<BoundingBox | null> {
		return await this.#tab.elementBox(this.#selector);
	}

	async uploadFile(...paths: string[]): Promise<void> {
		await this.#tab.uploadFile(this.#selector, ...paths);
	}

	async dispose(): Promise<void> {}
}

class CmuxLocator {
	readonly #tab: CmuxTab;
	readonly #selector: string;
	#timeoutMs: number | undefined;

	constructor(tab: CmuxTab, selector: string) {
		this.#tab = tab;
		this.#selector = selector;
	}

	setTimeout(timeoutMs: number): this {
		this.#timeoutMs = timeoutMs;
		return this;
	}

	async click(): Promise<void> {
		await this.#tab.waitFor(this.#selector, { timeout: this.#timeoutMs });
		await this.#tab.click(this.#selector);
	}

	async fill(value: string): Promise<void> {
		await this.#tab.waitFor(this.#selector, { timeout: this.#timeoutMs });
		await this.#tab.fill(this.#selector, value);
	}

	async waitHandle(): Promise<CmuxElementHandle> {
		return await this.#tab.waitFor(this.#selector, { timeout: this.#timeoutMs });
	}
}

export class CmuxPageFacade {
	readonly #tab: CmuxTab;
	readonly keyboard: { press: (key: string) => Promise<void> };
	readonly mouse: {
		wheel: (delta: { deltaX?: number; deltaY?: number }) => Promise<void>;
		move: (x: number, y: number) => Promise<void>;
		down: () => Promise<void>;
		up: () => Promise<void>;
	};

	constructor(tab: CmuxTab) {
		this.#tab = tab;
		this.keyboard = { press: key => this.#tab.press(key) };
		let lastPoint = { x: 0, y: 0 };
		let dragStart: { x: number; y: number } | undefined;
		this.mouse = {
			wheel: delta => this.#tab.scroll(delta.deltaX ?? 0, delta.deltaY ?? 0),
			move: (x, y) => {
				lastPoint = { x, y };
				return Promise.resolve();
			},
			down: () => {
				dragStart = lastPoint;
				return Promise.resolve();
			},
			up: async () => {
				if (dragStart) await this.#tab.drag(dragStart, lastPoint);
				dragStart = undefined;
			},
		};
	}

	url(): string {
		return this.#tab.url();
	}

	async title(): Promise<string> {
		return await this.#tab.title();
	}

	viewport(): ReadyInfo["viewport"] {
		return this.#tab.viewport();
	}

	async setViewport(viewport: ViewportOptions): Promise<void> {
		await this.#tab.setViewport(viewport);
	}

	async goto(url: string, opts?: { waitUntil?: WaitUntil; timeout?: number }): Promise<{ url: string }> {
		await this.#tab.goto(url, { waitUntil: opts?.waitUntil, timeoutMs: opts?.timeout });
		return { url: this.#tab.url() };
	}

	async evaluate<TResult, TArgs extends unknown[]>(
		fn: string | ((...args: TArgs) => TResult | Promise<TResult>),
		...args: TArgs
	): Promise<TResult> {
		return await this.#tab.evaluate(fn, ...args);
	}

	async content(): Promise<string> {
		return await this.#tab.pageContent();
	}

	locator(selector: string): CmuxLocator {
		return new CmuxLocator(this.#tab, selector);
	}

	async $(selector: string): Promise<CmuxElementHandle | null> {
		return (await this.#tab.elementExists(selector)) ? this.#tab.elementHandle(selector) : null;
	}

	async waitForSelector(selector: string, opts?: { timeout?: number }): Promise<CmuxElementHandle> {
		return await this.#tab.waitFor(selector, opts);
	}

	async waitForFunction(
		fn: string | ((...args: unknown[]) => unknown | Promise<unknown>),
		opts?: { timeout?: number; polling?: number },
		...args: unknown[]
	): Promise<unknown> {
		return await this.#tab.waitForFunction(fn, opts, ...args);
	}

	async waitForResponse(
		pattern: string | RegExp | ((response: CmuxResponse) => boolean | Promise<boolean>),
		opts?: { timeout?: number },
	): Promise<CmuxResponse> {
		return await this.#tab.waitForResponse(pattern, opts);
	}

	async screenshot(opts: ScreenshotOptions = {}): Promise<Buffer | string> {
		return await this.#tab.pageScreenshot(opts);
	}
}

export class CmuxBrowserFacade {
	readonly #tab: CmuxTab;
	connected = true;

	constructor(tab: CmuxTab) {
		this.#tab = tab;
	}

	async pages(): Promise<CmuxPageFacade[]> {
		return [this.#tab.page];
	}

	async version(): Promise<string> {
		return "cmux";
	}

	wsEndpoint(): string {
		return `cmux://${this.#tab.surfaceId}`;
	}

	disconnect(): void {
		this.connected = false;
	}

	async close(): Promise<void> {
		this.connected = false;
	}
}

export async function runCmuxCode(tab: CmuxTab, opts: RunCmuxCodeOptions): Promise<RunResultOk> {
	const runAc = new AbortController();
	const runTimeout = scopedTimeoutSignal(opts.timeoutMs);
	const signal = AbortSignal.any(
		opts.signal ? [runTimeout.signal, opts.signal, runAc.signal] : [runTimeout.signal, runAc.signal],
	);
	const output = new RunOutput();
	const screenshots: ScreenshotResult[] = [];
	const runId = crypto.randomUUID();
	tab.setRunContext({ session: opts.snapshot, output, screenshots, signal, timeoutMs: opts.timeoutMs });

	const { promise: cancelRejection, reject } = Promise.withResolvers<never>();
	cancelRejection.catch(() => {});
	const onAbort = (): void => {
		if (runTimeout.signal.aborted) {
			reject(new ToolError(`Browser code execution timed out after ${opts.timeoutMs}ms`));
		} else {
			reject(
				signal.reason instanceof ToolAbortError
					? signal.reason
					: new ToolAbortError(undefined, { cause: signal.reason }),
			);
		}
	};
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });

	try {
		const runtime = tab.ensureRuntime(opts.snapshot);
		runtime.setCwd(opts.snapshot.cwd);
		const runTab = guardTabApi(bindBrowserRunFacade(tab, signal));
		runtime.setRunScope({
			page: bindBrowserRunFacade(tab.page, signal),
			browser: bindBrowserRunFacade(tab.browser, signal),
			tab: runTab,
			assert: (cond: unknown, text?: string): void => {
				if (!cond) throw new ToolError(text ?? "Assertion failed");
			},
			wait: (msOrPredicate: number | (() => unknown), waitOpts?: WaitPredicateOptions): Promise<unknown> =>
				waitForBrowserRun(
					msOrPredicate,
					signal,
					typeof msOrPredicate === "number"
						? waitOpts
						: {
								timeout: resolvePredicateTimeout(opts.timeoutMs, waitOpts?.timeout),
								interval: waitOpts?.interval,
							},
				),
		});

		const hooks: RuntimeHooks = {
			onText: chunk => {
				throwIfAborted(signal);
				output.pushText(chunk);
				logger.debug(chunk.replace(/\n$/, ""));
			},
			onDisplay: displayed => {
				throwIfAborted(signal);
				output.pushDisplay(displayed);
			},
			callTool: (name, args) => {
				throwIfAborted(signal);
				return callSessionTool(name, args, { session: opts.session, signal });
			},
		};
		const returnValue = await Promise.race([
			runtime.run(opts.code, `cmux-run-${runId}.js`, hooks, { runId, cwd: opts.snapshot.cwd }),
			cancelRejection,
		]);
		return { displays: output.finish(), returnValue: cloneSafe(returnValue), screenshots };
	} catch (error) {
		if (error instanceof Error) {
			(error as BrowserRunError).partialRunOutput = { displays: output.finish(), screenshots };
		}
		throw error;
	} finally {
		runTimeout.cancel();
		signal.removeEventListener("abort", onAbort);
		runAc.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Browser run ended")));
		tab.clearRunContext();
	}
}

export function numberFrom(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
