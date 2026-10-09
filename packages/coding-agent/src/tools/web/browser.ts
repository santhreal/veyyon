import { setTimeout as sleep } from "node:timers/promises";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { type } from "@veyyon/ai/utils/schema/arktype";
import {
	errorMessage,
	isCancellation,
	lazy,
	logger,
	prompt,
	trimTrailingSlashes,
	untilAborted,
	withTimeout,
} from "@veyyon/utils";
import { toolsPrompts } from "../../prompts/tools/rows";
import type { ToolSession } from "../../sdk";
import { enforceInlineByteCap } from "../../session/streaming-output";
import { truncateForPrompt } from "../core/approval";
import { inlineOutputPricing, saveOutputArtifact } from "../core/output-artifact";
import type { OutputMeta } from "../core/output-meta";
import { resolveToCwd } from "../core/path-utils";
import { ToolAbortError, ToolError, throwIfAborted, toolAbort } from "../core/tool-errors";
import { prependResultNotice, toolResult } from "../core/tool-result";
import { clampTimeout, describeTimeoutParam, formatTimeoutClampNotice } from "../core/tool-timeouts";
import {
	type Challenge,
	classifyChallenge,
	type PageSignals,
	PROBE_READ_MS,
	PROBE_RUN_CODE,
	parsePageSignals,
} from "./browser/challenge";
import { resolveCmuxKind } from "./browser/cmux/rpc";
import { validateProfileName } from "./browser/profiles";
import {
	acquireBrowser,
	assertBrowserCanStart,
	type BrowserHandle,
	type BrowserKind,
	type BrowserKindTag,
} from "./browser/registry";
import { safeJsonStringify } from "./browser/run-output";
import { readStorageStateFile, type StorageState, type StorageStateLoaded } from "./browser/storage-state";
import type { BrowserRunError, Observation, RunResultOk, ScreenshotResult } from "./browser/tab-protocol";
import {
	type AcquireTabResult,
	acquireTab,
	captureTabState,
	dropHeadlessTabs,
	getTab,
	isolatedContextName,
	releaseAllTabs,
	releaseTab,
	runInTab,
	type TabSession,
	tabNamesOn,
} from "./browser/tab-supervisor";

export {
	type AriaSnapshotOptions,
	buildAriaSnapshotScript,
	parseAriaRefSelector,
} from "./browser/aria-snapshot";
export { cmuxSnapshotToObservation, mapWaitUntil, resolveCmuxKind, serializeEval } from "./browser/cmux/rpc";
export { CmuxSocketClient } from "./browser/cmux/socket-client";
export { extractReadableFromHtml, type ReadableFormat, type ReadableResult } from "./browser/readable";
export type { Observation, ObservationEntry } from "./browser/tab-protocol";

const DEFAULT_TAB_NAME = "main";

/**
 * The largest page snapshot an `open` sends unasked, about 1,500 tokens: a form, a login or an app
 * screen fits, and a long article or listing, which a model reads a part of, is left to a run.
 */
export const OPEN_SNAPSHOT_MAX_CHARS = 6_000;

/** The longest an interstitial check is waited out; a call with a shorter timeout waits that long instead. */
export const CHALLENGE_WAIT_MAX_MS = 20_000;

/** How often a page under an interstitial check is read again. */
const CHALLENGE_POLL_MS = 500;

/** A probe run's deadline. Its read of the page gives up at {@link PROBE_READ_MS}, so this is a backstop. */
const PROBE_RUN_TIMEOUT_MS = PROBE_READ_MS + 2_000;

/** The page each tab's last reported challenge was on, so a page's challenge is reported once. */
const reportedChallenges = new WeakMap<TabSession, string>();

const CMUX_REFUSAL =
	"profile and visible need the headless browser; the cmux browser pane is already visible and keeps cmux's own session. Turn the browser.cmux setting off, or set VEYYON_BROWSER_CMUX=0, to open tabs in the headless browser.";

const appSchema = lazy(() =>
	type({
		"path?": type("string").describe("binary path to spawn"),
		"cdp_url?": type("string").describe("existing cdp endpoint"),
		"args?": type("string[]").describe("extra cli args"),
		"target?": type("string").describe("substring to pick a window"),
	}),
);

const browserSchema = lazy(() =>
	type({
		action: type("'open' | 'close' | 'run' | 'save_state'").describe("operation"),
		"name?": type("string").describe("tab id (default 'main')"),
		"url?": type("string").describe("url to open"),
		"context?": type("string").describe("isolated context: tabs naming the same one share cookies and storage"),
		"storage_state?": type("string").describe(
			"state file of cookies and localStorage: open loads it, save_state writes it",
		),
		"profile?": type("string").describe("persistent profile: its cookies, storage and cache outlive the session"),
		"visible?": type("boolean").describe(
			"true moves the tab to a browser window, false back to headless; its session goes along",
		),
		"app?": appSchema.value,
		"viewport?": {
			width: "number",
			height: "number",
			"scale?": "number",
		},
		"wait_until?": type("'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'").describe(
			"navigation wait condition",
		),
		"dialogs?": type("'accept' | 'dismiss'").describe("auto-handle dialogs"),
		"code?": type("string").describe("js body to run in tab"),
		"timeout?": type("number").describe(describeTimeoutParam("browser")),
		"all?": type("boolean").describe("close every tab"),
		"kill?": type("boolean").describe("also kill spawned-app browsers"),
	}),
);

/** Input schema for the browser tool. */
export type BrowserParams = typeof browserSchema.value.infer;

/** Details describing a browser tool execution result (for renderers + transcript). */
export interface BrowserToolDetails {
	action: BrowserParams["action"];
	name?: string;
	url?: string;
	browser?: BrowserKindTag;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	observation?: Observation;
	screenshots?: ScreenshotResult[];
	/** The rows the card draws under the action's row; an open's text for the model also carries the page. */
	result?: string;
	/** The isolated context the tab is in, when it is in one. */
	context?: string;
	/** The persistent profile the tab's browser runs on, when it runs on one. */
	profile?: string;
	/** The state file `open` loaded or `save_state` wrote, resolved against the session's directory. */
	storageState?: string;
	/** The bot challenge the page showed, when the call reported one. */
	challenge?: Challenge;
	meta?: OutputMeta;
}

/**
 * The browser `params` open a tab on. A tab opened again keeps its window and profile unless the open
 * names others; a new one takes its window from the `browser.headless` setting.
 */
function resolveBrowserKind(
	params: BrowserParams,
	session: ToolSession,
	current: BrowserKind | undefined,
): BrowserKind {
	const app = params.app;
	if (app?.cdp_url) {
		return { kind: "connected", cdpUrl: trimTrailingSlashes(app.cdp_url) };
	}
	if (app?.path) {
		const exe = resolveToCwd(app.path, session.cwd);
		return { kind: "spawned", path: exe };
	}
	const cmuxKind = resolveCmuxKind({
		settingEnabled: session.settings.get("browser.cmux") as boolean | undefined,
	});
	if (cmuxKind) {
		return cmuxKind;
	}
	const kept = current?.kind === "headless" ? current : undefined;
	const headless =
		params.visible === undefined
			? (kept?.headless ?? (session.settings.get("browser.headless") as boolean))
			: !params.visible;
	const profile = params.profile === undefined ? kept?.profile : validateProfileName(params.profile);
	return { kind: "headless", headless, ...(profile === undefined ? {} : { profile }) };
}

/**
 * Browser tool: stateful, multi-tab. Four actions:
 * - `open`  → acquire/create a named tab on a browser kind (headless | spawned | connected) and optionally goto a url;
 *   a headless tab may name an isolated context and load a state file into it first.
 * - `close` → release a named tab (or all tabs); dispose browser when refcount hits 0.
 * - `run`   → execute JS code against an existing tab with `page`/`browser`/`tab` helpers in scope.
 * - `save_state` → write a tab's context cookies and localStorage to a state file.
 */
export class BrowserTool implements AgentTool<typeof browserSchema.value, BrowserToolDetails> {
	readonly name = "browser";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<BrowserParams>;
		const lines = [`Action: ${typeof params.action === "string" ? params.action : "(missing)"}`];
		const tabName = typeof params.name === "string" ? params.name : DEFAULT_TAB_NAME;
		lines.push(`Tab: ${truncateForPrompt(tabName)}`);
		if (typeof params.context === "string" && params.context.length > 0) {
			lines.push(`Context: ${truncateForPrompt(params.context)}`);
		}
		if (typeof params.storage_state === "string" && params.storage_state.length > 0) {
			lines.push(`Storage State: ${truncateForPrompt(params.storage_state)}`);
		}
		if (typeof params.profile === "string" && params.profile.length > 0) {
			lines.push(`Profile: ${truncateForPrompt(params.profile)}`);
		}
		if (typeof params.visible === "boolean") {
			lines.push(`Visible: ${params.visible ? "yes" : "no"}`);
		}
		if (typeof params.url === "string" && params.url.length > 0) {
			lines.push(`URL: ${truncateForPrompt(params.url)}`);
		}
		if (typeof params.code === "string" && params.code.length > 0) {
			lines.push(`Code:\n${truncateForPrompt(params.code)}`);
		}
		return lines;
	};
	readonly label = "Browser";
	readonly loadMode = "discoverable";
	readonly summary = "Control a headless browser to navigate and interact with web pages";
	get parameters(): typeof browserSchema.value {
		return browserSchema.value;
	}
	readonly strict = true;
	/**
	 * Every action reads or moves one shared tab table, and `run` writes to a
	 * page's single input stream. Batched as shared, `run` and `close` on the
	 * same tab started together and the run found its tab gone; exclusive runs
	 * a batch in the order it was written, which is the order it reads in.
	 */
	readonly concurrency = "exclusive";

	readonly examples: readonly ToolExample<typeof browserSchema.value.infer>[] = [
		{
			caption: "Open a tab",
			call: { action: "open", name: "docs", url: "https://example.com" },
		},
		{
			caption: "Read structured page data in the opened tab",
			call: {
				action: "run",
				name: "docs",
				code: "const obs = await tab.observe(); display(obs); return obs.elements.length;",
			},
		},
		{
			caption: "Click an observed element by id",
			call: {
				action: "run",
				name: "docs",
				code: "const obs = await tab.observe(); const link = obs.elements.find(e => e.role === 'link' && e.name === 'Sign in'); assert(link, 'Sign in link missing'); await (await tab.id(link.id)).click();",
			},
		},
		{
			caption: "Fill and submit a form via selectors",
			call: {
				action: "run",
				name: "docs",
				code: "await tab.fill('input[name=email]', 'me@example.com'); await tab.click('text/Continue');",
			},
		},
		{
			caption: "Screenshot to look at the page — no save path",
			call: {
				action: "run",
				name: "docs",
				code: "await tab.screenshot();",
			},
		},
		{
			caption: "Attach to an existing Electron app",
			call: {
				action: "open",
				name: "cursor",
				app: { path: "/Applications/Cursor.app/Contents/MacOS/Cursor" },
			},
		},
		{
			caption: "Open a tab signed in as a second user, in its own context, from a saved session",
			call: {
				action: "open",
				name: "admin",
				context: "admin",
				storage_state: ".auth/admin.json",
				url: "https://example.com/dashboard",
			},
		},
		{
			caption: "Close every tab and kill spawned-app processes",
			call: { action: "close", all: true, kill: true },
		},
	];

	constructor(private readonly session: ToolSession) {}
	#description?: string;
	get description(): string {
		this.#description ??= prompt.render(toolsPrompts["tools/browser"].text, {});
		return this.#description;
	}

	/** Restart browser to apply mode changes (e.g. headless toggle). Drops only headless browsers. */
	async restartForModeChange(): Promise<void> {
		await dropHeadlessTabs();
	}

	async execute(
		_toolCallId: string,
		params: BrowserParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BrowserToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		try {
			throwIfAborted(signal);
			const timeoutSeconds = clampTimeout("browser", params.timeout, this.session.settings.get("tools.maxTimeout"));
			const timeoutMs = timeoutSeconds * 1000;
			// A clamp changes the budget the agent asked for; surface it on the
			// result rather than applying it silently (Law 10). Each action builds
			// its own result, so prepend the notice once around the dispatch.
			const clampNotice = formatTimeoutClampNotice("browser", params.timeout, timeoutSeconds);
			const name = params.name ?? DEFAULT_TAB_NAME;
			const details: BrowserToolDetails = { action: params.action, name };
			// Ignored silently, either would read as done: a context on a run, or a state file on a close.
			if (typeof params.context === "string" && params.action !== "open") {
				throw new ToolError(`context applies to open, which puts a tab in it; ${params.action} takes none.`);
			}
			if (typeof params.storage_state === "string" && params.action !== "open" && params.action !== "save_state") {
				throw new ToolError(
					`storage_state applies to open, which loads it, and save_state, which writes it; ${params.action} takes none.`,
				);
			}
			if ((params.profile !== undefined || params.visible !== undefined) && params.action !== "open") {
				throw new ToolError(
					`profile and visible apply to open, which picks the browser a tab runs in; ${params.action} takes neither.`,
				);
			}

			let result: AgentToolResult<BrowserToolDetails>;
			switch (params.action) {
				case "open":
					result = await this.#open(name, params, details, timeoutMs, signal);
					break;
				case "close":
					result = await close(name, params, details, signal);
					break;
				case "run":
					result = await this.#run(name, params, details, timeoutMs, signal);
					break;
				case "save_state":
					result = await this.#saveState(name, params, details, timeoutMs, signal);
					break;
				default:
					throw new ToolError(`Unsupported action: ${(params as BrowserParams).action}`);
			}
			return clampNotice ? prependResultNotice(result, clampNotice) : result;
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			// `isCancellation`, not `isAbortError`: a deadline now reaches here
			// wearing its own `TimeoutError` name, and it stops the browser action
			// just as surely as an interrupt does. `toolAbort` keeps the reason so
			// the operator learns which of the two happened.
			if (isCancellation(error)) throw toolAbort(error, "browser");
			throw error;
		}
	}

	async #open(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const existing = getTab(name);
		const kind = resolveBrowserKind(params, this.session, existing?.browser.kind);
		details.browser = kind.kind;
		if ((params.profile !== undefined || params.visible !== undefined) && kind.kind !== "headless") {
			throw new ToolError(
				kind.kind === "cmux"
					? CMUX_REFUSAL
					: `profile and visible need the headless browser; ${describeKind(kind)} runs in the app's own session and window.`,
			);
		}
		if (kind.kind === "headless" && !kind.headless && params.viewport?.scale !== undefined) {
			throw new ToolError(
				"viewport.scale needs a hidden tab: a browser window renders at its display's scale, and viewport sizes the window's content area. Omit scale, or open with visible: false.",
			);
		}
		const contextName = isolatedContextName(params.context);
		if ((contextName !== undefined || params.storage_state !== undefined) && kind.kind !== "headless") {
			throw new ToolError(
				`context and storage_state need the headless browser; ${describeKind(kind)} runs in the app's own session.`,
			);
		}
		// Read before any browser starts, so a missing or malformed file fails the open with its path and nothing to undo.
		const statePath =
			params.storage_state === undefined ? undefined : resolveToCwd(params.storage_state, this.session.cwd);
		const fileState = statePath === undefined ? undefined : await readStorageStateFile(statePath);

		// A tab on another browser is refused, unless `visible` moves it between a window and headless:
		// its page and session then go along.
		let moved: MovedTab | undefined;
		if (existing && !sameBrowserKind(existing.browser.kind, kind)) {
			if (!movesWindow(existing, kind, params.visible)) {
				throw new ToolError(
					`Tab ${JSON.stringify(name)} is bound to a different browser (${describeKind(existing.browser.kind)}). Close it first.`,
				);
			}
			if (fileState !== undefined) {
				throw new ToolError(
					"storage_state cannot load while visible moves a tab: the move carries the tab's own session. Load the file with a second open.",
				);
			}
			assertBrowserCanStart(kind);
			moved = await this.#leaveBrowser(name, existing, timeoutMs, signal);
		}
		const url = params.url ?? moved?.url;

		let browser: BrowserHandle;
		let result: AcquireTabResult;
		try {
			browser = await untilAborted(signal, () =>
				acquireBrowser(kind, {
					cwd: this.session.cwd,
					viewport: params.viewport
						? {
								width: params.viewport.width,
								height: params.viewport.height,
								deviceScaleFactor: params.viewport.scale,
							}
						: undefined,
					appArgs: params.app?.args,
					signal,
				}),
			);

			result = await untilAborted(signal, () =>
				acquireTab(name, browser, {
					url,
					waitUntil: params.wait_until,
					viewport: params.viewport
						? {
								width: params.viewport.width,
								height: params.viewport.height,
								deviceScaleFactor: params.viewport.scale,
							}
						: undefined,
					target: params.app?.target,
					timeoutMs,
					dialogs: params.dialogs ?? moved?.dialogs,
					signal,
					ownerSessionId: this.session.getSessionId?.() ?? undefined,
					context: params.context ?? moved?.context,
					storageState: moved?.state ?? fileState,
				}),
			);
		} catch (error) {
			if (moved) await this.#returnTab(name, moved, timeoutMs, error);
			throw error;
		}
		// An interstitial check is waited out before the page is described, so the rows below show where it led.
		const challenge = url === undefined ? undefined : await this.#challengeNotice(name, timeoutMs, signal);
		const tab = getTab(name) ?? result.tab;
		const title = tab.info.title ?? "";
		details.url = tab.info.url;
		details.viewport = tab.info.viewport;
		const inContext = tab.backend === "worker" ? tab.contextName : undefined;
		if (inContext !== undefined) details.context = inContext;
		if (kind.kind === "headless" && kind.profile !== undefined) details.profile = kind.profile;
		if (statePath !== undefined) details.storageState = statePath;
		if (challenge) details.challenge = challenge.challenge;
		const verb = moved ? "Moved" : result.created ? "Opened" : "Reused";
		const lines = [
			`${verb} tab ${JSON.stringify(name)} ${moved ? `from ${describeKind(moved.from)} to` : "on"} ${describeBrowser(browser)}${inContext === undefined ? "" : ` in context ${JSON.stringify(inContext)}`}`,
			`URL: ${tab.info.url}`,
			title ? `Title: ${title}` : null,
			moved
				? `Carried ${describeStateCounts(
						moved.state.cookies.length,
						moved.state.origins.map(o => o.origin),
					)}`
				: null,
			result.stateLoaded && statePath !== undefined ? describeStateLoaded(result.stateLoaded, statePath) : null,
			challenge?.text ?? null,
		].filter((l): l is string => typeof l === "string");
		details.result = lines.join("\n");
		if (url === undefined) return toolResult(details).text(details.result).done();
		// Nearly every open that loads a page is followed by a call that reads it, and each call re-sends
		// the whole conversation: a page small enough is sent with the open instead. The page is the
		// model's to read, so the rows the card draws stay without it.
		const page = await this.#pageSnapshot(name, timeoutMs, signal);
		return toolResult(details).text(`${details.result}\n${page}`).done();
	}

	/**
	 * Take tab `name` off its browser for a move between a window and headless: its URL, dialog policy,
	 * context, cookies and localStorage, then the tab itself. A profile runs in one browser at a time,
	 * so a profile tab moves only when no other tab holds its browser.
	 */
	async #leaveBrowser(name: string, existing: TabSession, timeoutMs: number, signal?: AbortSignal): Promise<MovedTab> {
		const from = existing.browser.kind;
		if (from.kind === "headless" && from.profile !== undefined) {
			const others = tabNamesOn(existing.browser).filter(other => other !== name);
			if (others.length > 0) {
				throw new ToolError(
					`Browser profile ${JSON.stringify(from.profile)} runs in one browser at a time, and tab${others.length === 1 ? "" : "s"} ${others.map(other => JSON.stringify(other)).join(", ")} ${others.length === 1 ? "is" : "are"} open on it. Close ${others.length === 1 ? "it" : "them"} first, then move this tab.`,
				);
			}
		}
		const run = await runInTab(name, { code: "return page.url();", timeoutMs, signal, session: this.session });
		const url =
			typeof run.returnValue === "string" && /^(?:https?|file):/i.test(run.returnValue)
				? run.returnValue
				: undefined;
		// Every page of the tab's context is read, and one with an open dialog or a busy main thread answers
		// nothing until the protocol gives up a minute later; the tab has not left yet, so it stays.
		const state = await withTimeout(
			captureTabState(name),
			timeoutMs,
			`Reading the cookies and localStorage of tab ${JSON.stringify(name)} took longer than ${Math.round(timeoutMs / 1000)} s: a page in its context is not answering, such as one with a dialog open. The tab stays where it is; close the dialog or the page, then move it again.`,
			signal,
		);
		const moved: MovedTab = {
			from,
			state,
			...(url === undefined ? {} : { url }),
			...(existing.backend === "worker" && existing.contextName !== undefined
				? { context: existing.contextName }
				: {}),
			...(existing.dialogPolicy === undefined ? {} : { dialogs: existing.dialogPolicy }),
		};
		await releaseTab(name, { kill: false });
		return moved;
	}

	/**
	 * Put tab `name` back on the browser a move took it from, with the page, session, context and dialog
	 * policy it took along, when the move failed or was cancelled after the tab left: otherwise the tab,
	 * and every cookie it carried, is gone. The move's own error states the outcome; a cancelled move
	 * still waits for the tab to return.
	 */
	async #returnTab(name: string, moved: MovedTab, timeoutMs: number, error: unknown): Promise<void> {
		const stated = error instanceof Error && !isCancellation(error);
		try {
			const browser = await acquireBrowser(moved.from, { cwd: this.session.cwd });
			await acquireTab(name, browser, {
				url: moved.url,
				timeoutMs,
				dialogs: moved.dialogs,
				context: moved.context,
				storageState: moved.state,
				ownerSessionId: this.session.getSessionId?.() ?? undefined,
			});
			if (stated) {
				error.message += `\nTab ${JSON.stringify(name)} is back on ${describeKind(moved.from)} with its session.`;
			}
		} catch (returnError) {
			logger.warn("A browser tab whose move failed could not return to its browser", {
				tab: name,
				error: errorMessage(returnError),
			});
			if (stated) {
				error.message += `\nTab ${JSON.stringify(name)} could not be put back on ${describeKind(moved.from)}: ${errorMessage(returnError)}`;
			}
		}
	}

	/** The tab's page as the challenge probe reads it, or undefined when it gives nothing to read. */
	async #readPage(name: string, signal?: AbortSignal): Promise<PageSignals | undefined> {
		try {
			const run = await runInTab(name, {
				code: PROBE_RUN_CODE,
				timeoutMs: PROBE_RUN_TIMEOUT_MS,
				signal,
				session: this.session,
			});
			return parsePageSignals(run.returnValue);
		} catch (error) {
			if (error instanceof ToolAbortError || isCancellation(error)) throw error;
			logger.debug("browser challenge probe failed", { tab: name, error: errorMessage(error) });
			return undefined;
		}
	}

	/**
	 * The notice for a bot challenge on tab `name`'s page, once per page. An interstitial check is
	 * waited out first, for at most {@link CHALLENGE_WAIT_MAX_MS} and the call's timeout: the notice then
	 * states where it led, or that it did not clear. A challenge that needs a person, or blocks the
	 * browser, is stated with the hand-off to a person.
	 */
	async #challengeNotice(
		name: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<{ challenge: Challenge; text: string } | undefined> {
		const tab = getTab(name);
		const first = tab ? await this.#readPage(name, signal) : undefined;
		const found = first ? classifyChallenge(first) : undefined;
		if (!tab || !first || !found) return undefined;
		if (reportedChallenges.get(tab) === pageKey(first, found)) return undefined;
		if (found.kind !== "interstitial") {
			reportedChallenges.set(tab, pageKey(first, found));
			return { challenge: found, text: describeChallenge(found, tab) };
		}
		const bound = Math.min(CHALLENGE_WAIT_MAX_MS, timeoutMs);
		const started = performance.now();
		let last = first;
		let lastFound = found;
		while (getTab(name) === tab && tab.state === "alive") {
			const left = bound - (performance.now() - started);
			if (left <= 0) break;
			await sleep(Math.min(CHALLENGE_POLL_MS, left), undefined, { signal });
			const read = await this.#readPage(name, signal);
			// Between two documents the page answers nothing; the next read sees the one that loaded.
			if (!read) continue;
			const now = classifyChallenge(read);
			if (now?.kind === "interstitial") {
				last = read;
				lastFound = now;
				continue;
			}
			const seconds = ((performance.now() - started) / 1000).toFixed(1);
			const cleared = `Challenge: ${found.label} cleared after ${seconds} s; the tab is now at ${read.url} ${JSON.stringify(read.title)}.`;
			if (!now) return { challenge: found, text: cleared };
			reportedChallenges.set(tab, pageKey(read, now));
			return { challenge: now, text: `${cleared}\n${describeChallenge(now, tab)}` };
		}
		reportedChallenges.set(tab, pageKey(last, lastFound));
		return {
			challenge: lastFound,
			text: `Challenge: ${lastFound.label} did not clear within ${Math.round(bound / 1000)} s; the tab is at ${last.url} ${JSON.stringify(last.title)} (evidence: ${lastFound.evidence.join("; ")}). ${handOff(tab, "interactive")}`,
		};
	}

	/**
	 * The loaded page as `tab.ariaSnapshot()` reads it, whose refs a later run uses as `aria-ref=eN`,
	 * when it is at most {@link OPEN_SNAPSHOT_MAX_CHARS}; for a larger page, its size and how to read a
	 * part of it. A snapshot that fails leaves the open standing and says why.
	 */
	async #pageSnapshot(name: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
		let snapshot: unknown;
		try {
			const run = await runInTab(name, {
				code: "return await tab.ariaSnapshot();",
				timeoutMs,
				signal,
				session: this.session,
			});
			snapshot = run.returnValue;
		} catch (error) {
			if (error instanceof ToolAbortError || isCancellation(error)) throw error;
			return `Page snapshot unavailable: ${errorMessage(error)}`;
		}
		if (typeof snapshot !== "string") return "Page snapshot unavailable: the page returned no snapshot.";
		if (snapshot.length > OPEN_SNAPSHOT_MAX_CHARS) {
			return `Page snapshot not sent: ${snapshot.length} chars. Read what you need with tab.observe() or tab.ariaSnapshot(selector).`;
		}
		return `Page:\n${snapshot}`;
	}

	async #saveState(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		if (params.storage_state === undefined) {
			throw new ToolError(
				"save_state needs storage_state, the file to write the tab's cookies and localStorage to. The file holds live session credentials: keep it out of version control.",
			);
		}
		const tab = getTab(name);
		if (!tab) {
			throw new ToolError(`No tab named ${JSON.stringify(name)} to save storage state from. Open the tab first.`);
		}
		const file = resolveToCwd(params.storage_state, this.session.cwd);
		details.browser = tab.browser.kind.kind;
		details.url = tab.info.url;
		details.storageState = file;
		if (tab.backend === "worker" && tab.contextName !== undefined) details.context = tab.contextName;

		const run = await runInTab(name, {
			code: `const state = await tab.storageState({ path: ${JSON.stringify(file)} });\nreturn { cookies: state.cookies.length, origins: state.origins.map(entry => entry.origin) };`,
			timeoutMs,
			signal,
			session: this.session,
		});
		const saved = savedStateSchema.value(run.returnValue);
		if (saved instanceof type.errors) {
			throw new ToolError(`save_state wrote ${file} but could not count what it wrote: ${saved.summary}`);
		}
		details.result = `Saved ${describeStateCounts(saved.cookies, saved.origins)} to ${file}`;
		return toolResult(details).text(details.result).done();
	}

	async #run(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		if (!params.code?.trim()) {
			throw new ToolError("Missing required parameter 'code' for action 'run'.");
		}
		const tab = getTab(name);
		if (tab) {
			details.browser = tab.browser.kind.kind;
			details.url = tab.info.url;
		}

		let run: RunResultOk;
		try {
			run = await runInTab(name, {
				code: params.code,
				timeoutMs,
				signal,
				session: this.session,
			});
		} catch (error) {
			// An abort is left alone: the operator cancelled, so there is no failure to explain.
			if (error instanceof ToolAbortError || !(error instanceof Error)) throw error;
			// A failed run still reports what it managed to produce. The displayed lines are folded
			// into the error text because that is the only channel a thrown tool error has, and the
			// screenshots go onto `details` so they still render.
			let text = error.message;
			const partial = (error as BrowserRunError).partialRunOutput;
			if (partial !== undefined) {
				if (partial.screenshots.length) details.screenshots = partial.screenshots;
				const produced = partial.displays
					.filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
					.map(entry => entry.text)
					.join("\n");
				if (produced) text = `${produced}\n\n${text}`;
			}
			// Capped as a result's text is: an `execSync`'s stderr or a dumped page runs to hundreds of
			// KB, and every later turn sends it again. The head and the tail, where the reason is, stay.
			const capped = await enforceInlineByteCap(text, {
				...inlineOutputPricing(this.session),
				saveArtifact: full => saveBrowserOutputArtifact(this.session, full),
			});
			if (capped !== error.message) error.message = capped;
			// A run that failed on a challenge page (a click that found no element, a wait that timed out)
			// is told what stood in its way.
			const challenge = await this.#challengeNotice(name, timeoutMs, signal);
			if (challenge) error.message = `${error.message}\n\n${challenge.text}`;
			throw error;
		}
		const { displays, returnValue, screenshots } = run;

		if (screenshots.length) details.screenshots = screenshots;

		const content = displays.slice();
		if (returnValue !== undefined) {
			// `display(x); return x;` is a common shape, and every copy is re-sent on each later turn:
			// a return value the run already displayed is not sent twice.
			const returned = stringifyReturnValue(returnValue);
			const shown = displays.some(entry => entry.type === "text" && entry.text.trimEnd() === returned.trimEnd());
			if (!shown) content.push({ type: "text", text: returned });
		}
		if (!content.length) {
			content.push({ type: "text", text: `Ran code on tab ${JSON.stringify(name)}` });
		}
		const textOnly = content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");
		// Final defense at the tool-result boundary: a single run can display
		// tens of KB (large JSON returns, dumped observations). Cap the combined
		// text inline; the full text stays recoverable via the artifact footer
		// when allocation succeeds.
		const cappedText = await enforceInlineByteCap(textOnly, {
			...inlineOutputPricing(this.session),
			saveArtifact: full => saveBrowserOutputArtifact(this.session, full),
		});
		// After the cap, so a long output never pushes it out of what the model reads.
		const challenge = await this.#challengeNotice(name, timeoutMs, signal);
		if (challenge) details.challenge = challenge.challenge;
		const notice = challenge ? [{ type: "text" as const, text: challenge.text }] : [];
		details.result = challenge ? `${cappedText}\n${challenge.text}` : cappedText;
		if (cappedText !== textOnly) {
			const nonText = content.filter(c => c.type !== "text");
			return toolResult(details)
				.content([...nonText, { type: "text", text: cappedText }, ...notice])
				.done();
		}
		return toolResult(details)
			.content([...content, ...notice])
			.done();
	}
}

async function close(
	name: string,
	params: BrowserParams,
	details: BrowserToolDetails,
	signal?: AbortSignal,
): Promise<AgentToolResult<BrowserToolDetails>> {
	const kill = !!params.kill;
	if (params.all) {
		const count = await untilAborted(signal, () => releaseAllTabs({ kill }));
		details.result = `Closed ${count} tab(s)`;
		return toolResult(details).text(details.result).done();
	}
	const closed = await untilAborted(signal, () => releaseTab(name, { kill }));
	details.result = closed ? `Closed tab ${JSON.stringify(name)}` : `No tab named ${JSON.stringify(name)}`;
	return toolResult(details).text(details.result).done();
}

/** Persist over-cap browser run output as a session artifact; mirrors the bash minimizer's save path. */
function saveBrowserOutputArtifact(session: ToolSession, fullText: string): Promise<string | undefined> {
	return saveOutputArtifact(session, "browser-original", fullText);
}

/** What the `save_state` run returns: counts, never the cookies themselves, which stay out of the transcript. */
const savedStateSchema = lazy(() => type({ cookies: "number", origins: "string[]" }));

function describeStateCounts(cookies: number, origins: readonly string[]): string {
	const counted = `${cookies} cookie${cookies === 1 ? "" : "s"}`;
	return origins.length === 0
		? `${counted} and no localStorage`
		: `${counted} and localStorage for ${origins.join(", ")}`;
}

function describeStateLoaded(loaded: StorageStateLoaded, file: string): string {
	return `Loaded ${describeStateCounts(loaded.cookies, loaded.origins)} from ${file}`;
}

function describeBrowser(handle: BrowserHandle): string {
	if (!("browser" in handle)) {
		return `cmux browser (${handle.kind.surface ?? "split"})`;
	}
	switch (handle.kind.kind) {
		case "headless":
			return `headless browser (${handle.kind.headless ? "hidden" : "visible"}${handle.kind.profile === undefined ? "" : `, profile ${JSON.stringify(handle.kind.profile)}`})`;
		case "spawned":
			return `spawned ${handle.kind.path} (pid ${handle.pid ?? "?"})`;
		case "connected":
			return `connected ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
	}
}

function describeKind(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless ${kind.headless ? "hidden" : "visible"}${kind.profile === undefined ? "" : ` profile ${JSON.stringify(kind.profile)}`}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.surface ?? "split"}`;
	}
}

function sameBrowserKind(a: BrowserKind, b: BrowserKind): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "headless" && b.kind === "headless") return a.headless === b.headless && a.profile === b.profile;
	if (a.kind === "spawned" && b.kind === "spawned") return a.path === b.path;
	if (a.kind === "connected" && b.kind === "connected") return a.cdpUrl === b.cdpUrl;
	if (a.kind === "cmux" && b.kind === "cmux") return a.socketPath === b.socketPath;
	return false;
}

/** What a tab takes along when `visible` moves it to another browser. */
interface MovedTab {
	readonly from: BrowserKind;
	readonly state: StorageState;
	/** The page it was on, when that page can be loaded again. */
	readonly url?: string;
	readonly context?: string;
	readonly dialogs?: "accept" | "dismiss";
}

/** Whether `visible` asks tab `existing` to move between a window and headless, on the same profile. */
function movesWindow(existing: TabSession, to: BrowserKind, visible: boolean | undefined): boolean {
	const from = existing.browser.kind;
	return (
		visible !== undefined &&
		existing.backend === "worker" &&
		from.kind === "headless" &&
		to.kind === "headless" &&
		from.profile === to.profile &&
		from.headless !== to.headless
	);
}

/** A page's challenge, as once-per-page reporting remembers it: the document and the rule it matched. */
function pageKey(signals: PageSignals, challenge: Challenge): string {
	return `${signals.documentId} ${challenge.rule}`;
}

/** What a person can do about a challenge on `tab`, which this tool does not solve. */
function handOff(tab: TabSession, kind: "interactive" | "block"): string {
	const browser = tab.browser.kind;
	const hidden = browser.kind === "headless" && browser.headless;
	const headless = browser.kind === "headless";
	if (kind === "block") {
		return hidden
			? "A person may get past it in a browser window (open this tab with visible: true, then ask); otherwise use another source."
			: "A person may get past it in this tab's window (ask); otherwise use another source.";
	}
	if (hidden) {
		return "This tool does not solve CAPTCHAs: open this tab with visible: true, which moves its page, cookies and localStorage to a browser window, ask a person with the ask tool to solve it there, then open it with visible: false to continue headless.";
	}
	return headless
		? "This tool does not solve CAPTCHAs: ask a person with the ask tool to solve it in this tab's window, then open it with visible: false to continue headless."
		: "This tool does not solve CAPTCHAs: ask a person with the ask tool to solve it in this browser's window, then continue.";
}

/** The notice for a challenge that needs a person or blocks the browser. */
function describeChallenge(challenge: Challenge, tab: TabSession): string {
	const evidence = `evidence: ${challenge.evidence.join("; ")}`;
	return challenge.kind === "block"
		? `Challenge: ${challenge.label}; the site blocks this browser (${evidence}). ${handOff(tab, "block")}`
		: `Challenge: ${challenge.label} on the page, which needs a person (${evidence}). ${handOff(tab, "interactive")}`;
}

function stringifyReturnValue(value: unknown): string {
	if (typeof value === "string") return value;
	return safeJsonStringify(value);
}
