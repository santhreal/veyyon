import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { errorMessage, isCancellation, prompt, trimTrailingSlashes, untilAborted } from "@veyyon/utils";
import { type } from "arktype";
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
import { resolveCmuxKind } from "./browser/cmux/rpc";
import { acquireBrowser, type BrowserHandle, type BrowserKind, type BrowserKindTag } from "./browser/registry";
import { safeJsonStringify } from "./browser/run-output";
import { readStorageStateFile, type StorageStateLoaded } from "./browser/storage-state";
import type { BrowserRunError, Observation, RunResultOk, ScreenshotResult } from "./browser/tab-protocol";
import {
	acquireTab,
	dropHeadlessTabs,
	getTab,
	isolatedContextName,
	releaseAllTabs,
	releaseTab,
	runInTab,
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

const appSchema = type({
	"path?": type("string").describe("binary path to spawn"),
	"cdp_url?": type("string").describe("existing cdp endpoint"),
	"args?": type("string[]").describe("extra cli args"),
	"target?": type("string").describe("substring to pick a window"),
});

const browserSchema = type({
	action: type("'open' | 'close' | 'run' | 'save_state'").describe("operation"),
	"name?": type("string").describe("tab id (default 'main')"),
	"url?": type("string").describe("url to open"),
	"context?": type("string").describe("isolated context: tabs naming the same one share cookies and storage"),
	"storage_state?": type("string").describe(
		"state file of cookies and localStorage: open loads it, save_state writes it",
	),
	"app?": appSchema,
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
});

/** Input schema for the browser tool. */
export type BrowserParams = typeof browserSchema.infer;

/** Details describing a browser tool execution result (for renderers + transcript). */
export interface BrowserToolDetails {
	action: BrowserParams["action"];
	name?: string;
	url?: string;
	browser?: BrowserKindTag;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	observation?: Observation;
	screenshots?: ScreenshotResult[];
	result?: string;
	/** The isolated context the tab is in, when it is in one. */
	context?: string;
	/** The state file `open` loaded or `save_state` wrote, resolved against the session's directory. */
	storageState?: string;
	meta?: OutputMeta;
}

function resolveBrowserKind(params: BrowserParams, session: ToolSession): BrowserKind {
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
	const headless = session.settings.get("browser.headless") as boolean;
	return { kind: "headless", headless };
}

/**
 * Browser tool: stateful, multi-tab. Four actions:
 * - `open`  → acquire/create a named tab on a browser kind (headless | spawned | connected) and optionally goto a url;
 *   a headless tab may name an isolated context and load a state file into it first.
 * - `close` → release a named tab (or all tabs); dispose browser when refcount hits 0.
 * - `run`   → execute JS code against an existing tab with `page`/`browser`/`tab` helpers in scope.
 * - `save_state` → write a tab's context cookies and localStorage to a state file.
 */
export class BrowserTool implements AgentTool<typeof browserSchema, BrowserToolDetails> {
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
	readonly parameters = browserSchema;
	readonly strict = true;
	/**
	 * Every action reads or moves one shared tab table, and `run` writes to a
	 * page's single input stream. Batched as shared, `run` and `close` on the
	 * same tab started together and the run found its tab gone; exclusive runs
	 * a batch in the order it was written, which is the order it reads in.
	 */
	readonly concurrency = "exclusive";

	readonly examples: readonly ToolExample<typeof browserSchema.infer>[] = [
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

			let result: AgentToolResult<BrowserToolDetails>;
			switch (params.action) {
				case "open":
					result = await this.#open(name, params, details, timeoutMs, signal);
					break;
				case "close":
					result = await this.#close(name, params, details, signal);
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
		const kind = resolveBrowserKind(params, this.session);
		details.browser = kind.kind;
		const contextName = isolatedContextName(params.context);
		if ((contextName !== undefined || params.storage_state !== undefined) && kind.kind !== "headless") {
			throw new ToolError(
				`context and storage_state need the headless browser; ${describeKind(kind)} runs in the app's own session.`,
			);
		}
		// Read before any browser starts, so a missing or malformed file fails the open with its path and nothing to undo.
		const statePath =
			params.storage_state === undefined ? undefined : resolveToCwd(params.storage_state, this.session.cwd);
		const storageState = statePath === undefined ? undefined : await readStorageStateFile(statePath);

		// If a tab with this name already exists on a different browser kind, fail fast — caller must close first.
		const existing = getTab(name);
		if (existing && !sameBrowserKind(existing.browser.kind, kind)) {
			throw new ToolError(
				`Tab ${JSON.stringify(name)} is bound to a different browser (${describeKind(existing.browser.kind)}). Close it first.`,
			);
		}

		const browser = await untilAborted(signal, () =>
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

		const result = await untilAborted(signal, () =>
			acquireTab(name, browser, {
				url: params.url,
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
				dialogs: params.dialogs,
				signal,
				ownerSessionId: this.session.getSessionId?.() ?? undefined,
				context: params.context,
				storageState,
			}),
		);
		const tab = result.tab;
		const url = tab.info.url;
		const title = tab.info.title ?? "";
		details.url = url;
		details.viewport = tab.info.viewport;
		const inContext = tab.backend === "worker" ? tab.contextName : undefined;
		if (inContext !== undefined) details.context = inContext;
		if (statePath !== undefined) details.storageState = statePath;
		const verb = result.created ? "Opened" : "Reused";
		const lines = [
			`${verb} tab ${JSON.stringify(name)} on ${describeBrowser(browser)}${inContext === undefined ? "" : ` in context ${JSON.stringify(inContext)}`}`,
			`URL: ${url}`,
			title ? `Title: ${title}` : null,
			result.stateLoaded && statePath !== undefined ? describeStateLoaded(result.stateLoaded, statePath) : null,
			// Nearly every open that loads a page is followed by a call that reads it, and each call re-sends
			// the whole conversation: a page small enough is sent with the open instead.
			params.url === undefined ? null : await this.#pageSnapshot(name, timeoutMs, signal),
		].filter((l): l is string => typeof l === "string");
		details.result = lines.join("\n");
		return toolResult(details).text(details.result).done();
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

	async #close(
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
		const saved = savedStateSchema(run.returnValue);
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
			// A failed run still reports what it managed to produce. The displayed lines are folded
			// into the error text because that is the only channel a thrown tool error has, and the
			// screenshots go onto `details` so they still render. An abort is left alone: the
			// operator cancelled, so there is no failure to explain.
			const partial = error instanceof ToolAbortError ? undefined : (error as BrowserRunError).partialRunOutput;
			if (partial !== undefined && error instanceof Error) {
				if (partial.screenshots.length) details.screenshots = partial.screenshots;
				const produced = partial.displays
					.filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
					.map(entry => entry.text)
					.join("\n");
				if (produced) error.message = `${produced}\n\n${error.message}`;
			}
			throw error;
		}
		const { displays, returnValue, screenshots } = run;

		if (screenshots.length) details.screenshots = screenshots;

		const content = displays.slice();
		if (returnValue !== undefined) {
			content.push({ type: "text", text: stringifyReturnValue(returnValue) });
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
		details.result = cappedText;
		if (cappedText !== textOnly) {
			const nonText = content.filter(c => c.type !== "text");
			return toolResult(details)
				.content([...nonText, { type: "text", text: cappedText }])
				.done();
		}
		return toolResult(details).content(content).done();
	}
}

/** Persist over-cap browser run output as a session artifact; mirrors the bash minimizer's save path. */
function saveBrowserOutputArtifact(session: ToolSession, fullText: string): Promise<string | undefined> {
	return saveOutputArtifact(session, "browser-original", fullText);
}

/** What the `save_state` run returns: counts, never the cookies themselves, which stay out of the transcript. */
const savedStateSchema = type({ cookies: "number", origins: "string[]" });

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
			return `headless browser (${handle.kind.headless ? "hidden" : "visible"})`;
		case "spawned":
			return `spawned ${handle.kind.path} (pid ${handle.pid ?? "?"})`;
		case "connected":
			return `connected ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
	}
}

function describeKind(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless ${kind.headless ? "hidden" : "visible"}`;
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
	if (a.kind === "headless" && b.kind === "headless") return a.headless === b.headless;
	if (a.kind === "spawned" && b.kind === "spawned") return a.path === b.path;
	if (a.kind === "connected" && b.kind === "connected") return a.cdpUrl === b.cdpUrl;
	if (a.kind === "cmux" && b.kind === "cmux") return a.socketPath === b.socketPath;
	return false;
}

function stringifyReturnValue(value: unknown): string {
	if (typeof value === "string") return value;
	return safeJsonStringify(value);
}
