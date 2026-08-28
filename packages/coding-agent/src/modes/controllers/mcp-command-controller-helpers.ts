import { type Component, replaceTabs, Spacer, Text } from "@veyyon/tui";
import type { MCPServerConfig } from "../../mcp/types";
import { MCP_SCOPE_REMOVED_REPLACEMENT } from "../../slash-commands/helpers/parse";
import { urlHyperlinkAlways } from "../../tui";
import { ChatBlock } from "../components/chat-block";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";

export type McpCommandControllerContext = Pick<
	InteractiveModeContext,
	| "editor"
	| "editorContainer"
	| "mcpManager"
	| "oauthManualInput"
	| "present"
	| "session"
	| "showError"
	| "showHookInput"
	| "showHookSelector"
	| "showStatus"
	| "showWarning"
	| "ui"
>;

export const MCP_MANUAL_INPUT_PROVIDER_ID = "mcp";
export const MCP_MANUAL_LOGIN_TIP = "Headless? Paste the redirect URL or code with /login <value>.";
export function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
	onTimeout?: () => void,
): Promise<T> {
	const { promise: timeoutPromise, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => {
		onTimeout?.();
		reject(new Error(message));
	}, timeoutMs);
	return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}
export function raceAbortSignal<T>(promise: Promise<T>, signal: AbortSignal, createError: () => Error): Promise<T> {
	if (signal.aborted) return Promise.reject(createError());

	const aborted = Promise.withResolvers<never>();
	const onAbort = (): void => aborted.reject(createError());
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, aborted.promise]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}

export const MCP_AUTH_MIN_WRAP_WIDTH = 16;

export function wrapUrlRows(label: string, url: string, width: number): string[] {
	const indent = " ";
	const sanitized = replaceTabs(url);
	const effective = Math.max(MCP_AUTH_MIN_WRAP_WIDTH, Math.trunc(width));
	const inlineWidth = indent.length + label.length + 1 + sanitized.length;
	if (inlineWidth <= effective) {
		return [`${indent}${theme.fg("muted", `${label} ${sanitized}`)}`];
	}
	const rows: string[] = [`${indent}${theme.fg("muted", label)}`];
	for (let i = 0; i < sanitized.length; i += effective) {
		rows.push(theme.fg("muted", sanitized.slice(i, i + effective)));
	}
	return rows;
}

export class MCPAuthorizationLinkPrompt implements Component {
	readonly #fullUrl: string;
	readonly #launchUrl: string | undefined;

	constructor(url: string, launchUrl?: string) {
		this.#fullUrl = url;
		this.#launchUrl = launchUrl && launchUrl !== url ? launchUrl : undefined;
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const link = urlHyperlinkAlways(this.#fullUrl, "Click here to authorize");
		const lines: string[] = [
			` ${theme.fg("success", "Open authorization URL:")}`,
			` ${theme.fg("accent", link)}`,
			...wrapUrlRows("Copy URL:", this.#fullUrl, width),
		];
		if (this.#launchUrl) {
			const wu = wrapUrlRows("Local shortcut (this machine only):", this.#launchUrl, width);
			for (let li = 0; li < wu.length; li++) lines.push(wu[li]!);
		}
		return lines;
	}
}

export class McpConnectingBlock extends ChatBlock {
	readonly #text: Text;

	constructor(private readonly serverName: string) {
		super();
		this.addChild(new Spacer(1));
		const frame = theme.spinnerFrames[0] ?? "|";
		this.#text = new Text(theme.fg("muted", `${frame} Connecting to "${serverName}"...`), 1, 0);
		this.addChild(this.#text);
	}

	override onMount(): void {
		const frames = theme.spinnerFrames;
		let frame = 0;
		const interval = setInterval(() => {
			frame++;
			this.#text.setText(
				theme.fg("muted", `${frames[frame % frames.length] ?? "|"} Connecting to "${this.serverName}"...`),
			);
			this.requestRender();
		}, 80);
		this.onCleanup(() => clearInterval(interval));
	}

	setStatus(text: string): void {
		this.#text.setText(text);
		this.requestRender();
	}
}

export interface OAuthFlowResult {
	credentialId: string;
	clientId?: string;
	resource?: string;
}

export class MCPOAuthCancelledError extends Error {
	constructor(message = "OAuth flow cancelled") {
		super(message);
		this.name = "MCPOAuthCancelledError";
	}
}

export const MCP_OAUTH_USER_CANCEL_REASON = "MCP OAuth flow cancelled by user";

export type MCPAddTransport = "http" | "sse";

export const MCP_ADD_USAGE = "Usage: /mcp add <name> [http|sse] [url <url>] [token <token>] [run <command...>]";

export const MCP_SEARCH_USAGE = "Usage: /mcp smithery-search <keyword...> [<limit 1-100>] [semantic]";

export const MCP_REMOVE_USAGE = "Usage: /mcp remove <name>";

export const MCP_ADD_REMOVED_OPTIONS: Record<string, string> = {
	"": "write `run <command...>`, which takes the whole rest of the line",
	scope: MCP_SCOPE_REMOVED_REPLACEMENT,
	project: MCP_SCOPE_REMOVED_REPLACEMENT,
	user: MCP_SCOPE_REMOVED_REPLACEMENT,
	url: "write `url <url>`",
	transport: "write `http` or `sse` as a plain word",
	token: "write `token <token>`",
};

export const MCP_SEARCH_REMOVED_OPTIONS: Record<string, string> = {
	scope: MCP_SCOPE_REMOVED_REPLACEMENT,
	project: MCP_SCOPE_REMOVED_REPLACEMENT,
	user: MCP_SCOPE_REMOVED_REPLACEMENT,
	limit: "write the limit as a plain integer",
	semantic: "write `semantic` as a plain word",
};

export const MCP_REMOVE_REMOVED_OPTIONS: Record<string, string> = {
	scope: MCP_SCOPE_REMOVED_REPLACEMENT,
	project: MCP_SCOPE_REMOVED_REPLACEMENT,
	user: MCP_SCOPE_REMOVED_REPLACEMENT,
};

export type MCPAddParsed = {
	initialName?: string;
	quickConfig?: MCPServerConfig;
	isCommandQuickAdd?: boolean;
	hasAuthToken?: boolean;
	error?: string;
};

export type MCPSearchParsed = {
	keyword: string;
	limit: number;
	semantic: boolean;
	error?: string;
};
