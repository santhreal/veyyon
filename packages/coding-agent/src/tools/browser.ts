import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { isCancellation, prompt, stringifyJsonSafe, untilAborted } from "@veyyon/utils";
import { toolsPrompts } from "../prompts/tools/rows";
import type { ToolSession } from "../sdk";
import { enforceInlineByteCap } from "../session/streaming-output";
import { truncateForPrompt } from "./approval";
import { acquireBrowser, type BrowserHandle, type BrowserKind } from "./browser/registry";
import type { BrowserRunError, RunResultOk } from "./browser/tab-protocol";
import { acquireTab, dropHeadlessTabs, getTab, releaseAllTabs, releaseTab, runInTab } from "./browser/tab-supervisor";
import type { BrowserParams, BrowserToolDetails } from "./browser-helpers";

export * from "./browser-helpers";

import { browserSchema, DEFAULT_TAB_NAME, resolveBrowserKind } from "./browser-helpers";
import { inlineOutputPricing, saveOutputArtifact } from "./output-artifact";
import { ToolAbortError, ToolError, throwIfAborted, toolAbort } from "./tool-errors";
import { prependResultNotice, toolResult } from "./tool-result";
import { clampTimeout, formatTimeoutClampNotice } from "./tool-timeouts";

export type { BrowserParams, BrowserToolDetails };

export class BrowserTool implements AgentTool<typeof browserSchema, BrowserToolDetails> {
	readonly name = "browser";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<BrowserParams>;
		const lines = [`Action: ${typeof params.action === "string" ? params.action : "(missing)"}`];
		const tabName = typeof params.name === "string" ? params.name : DEFAULT_TAB_NAME;
		lines.push(`Tab: ${truncateForPrompt(tabName)}`);
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
			const clampNotice = formatTimeoutClampNotice("browser", params.timeout, timeoutSeconds);
			const name = params.name ?? DEFAULT_TAB_NAME;
			const details: BrowserToolDetails = { action: params.action, name };

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
				default:
					throw new ToolError(`Unsupported action: ${(params as BrowserParams).action}`);
			}
			return clampNotice ? prependResultNotice(result, clampNotice) : result;
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
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
			}),
		);
		const tab = result.tab;
		const url = tab.info.url;
		const title = tab.info.title ?? "";
		details.url = url;
		details.viewport = tab.info.viewport;
		const verb = result.created ? "Opened" : "Reused";
		const lines = [
			`${verb} tab ${JSON.stringify(name)} on ${describeBrowser(browser)}`,
			`URL: ${url}`,
			title ? `Title: ${title}` : null,
		].filter((l): l is string => typeof l === "string");
		details.result = lines.join("\n");
		return toolResult(details).text(lines.join("\n")).done();
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
		const textParts: string[] = [];
		for (let ci = 0; ci < content.length; ci++) {
			const c = content[ci]!;
			if (c.type === "text") textParts.push(c.text);
		}
		const textOnly = textParts.join("\n");
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

function saveBrowserOutputArtifact(session: ToolSession, fullText: string): Promise<string | undefined> {
	return saveOutputArtifact(session, "browser-original", fullText);
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
	return stringifyJsonSafe(value, 2);
}
