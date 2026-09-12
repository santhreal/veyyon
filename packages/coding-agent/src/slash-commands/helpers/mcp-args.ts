/**
 * Shared MCP command argument grammar.
 *
 * Consolidates argument parsing for /mcp add, /mcp smithery-search, and /mcp remove
 * across the terminal controller and CLI/ACP handlers while preserving surface-specific
 * policies (such as trailing scope words in search).
 */
import type { MCPServerConfig } from "../../mcp/types";
import { parseCommandArgs } from "../../utils/command-args";
import { MCP_SCOPE_REMOVED_REPLACEMENT, removedOptionMessage } from "./parse";

export const MCP_ADD_USAGE = "Usage: /mcp add <name> [http|sse] [url <url>] [token <token>] [run <command...>]";

export const MCP_SEARCH_USAGE = "Usage: /mcp smithery-search <keyword...> [<limit 1-100>] [semantic]";

export const MCP_REMOVE_USAGE = "Usage: /mcp remove <name>";

/**
 * The option spellings `/mcp add` no longer has, keyed by bare name. The empty
 * key is the separator that used to mean "everything after this is a command to
 * run", which is exactly what the `run` keyword means now.
 *
 * The scope words are keys too, on every `/mcp` map here. This surface used to
 * have a scope and it wrote `<cwd>/.veyyon/mcp.json` through
 * `getMCPConfigPath("project", …)`; no MCP provider emits a project-level
 * source, so nothing ever loaded that file and `/mcp add x project url …`
 * reported `Added MCP server "x" (project).` while configuring nothing. The TUI
 * controller had already dropped the word, so the reason is shared with it
 * verbatim through {@link MCP_SCOPE_REMOVED_REPLACEMENT} rather than reworded
 * here, and a plain `project` is refused with it instead of being read as
 * something else or quietly dropped.
 */
export const MCP_ADD_REMOVED_OPTIONS: Record<string, string> = {
	"": "write `run <command...>`, which takes the whole rest of the line",
	scope: MCP_SCOPE_REMOVED_REPLACEMENT,
	project: MCP_SCOPE_REMOVED_REPLACEMENT,
	user: MCP_SCOPE_REMOVED_REPLACEMENT,
	url: "write `url <url>`",
	transport: "write `http` or `sse` as a plain word",
	token: "write `token <token>`",
};

/** The option spellings `/mcp smithery-search` no longer has, keyed by bare name. */
export const MCP_SEARCH_REMOVED_OPTIONS: Record<string, string> = {
	scope: MCP_SCOPE_REMOVED_REPLACEMENT,
	project: MCP_SCOPE_REMOVED_REPLACEMENT,
	user: MCP_SCOPE_REMOVED_REPLACEMENT,
	limit: "write the limit as a plain integer",
	semantic: "write `semantic` as a plain word",
};

/** The option spellings `/mcp remove` no longer has, keyed by bare name. */
export const MCP_REMOVE_REMOVED_OPTIONS: Record<string, string> = {
	scope: MCP_SCOPE_REMOVED_REPLACEMENT,
	project: MCP_SCOPE_REMOVED_REPLACEMENT,
	user: MCP_SCOPE_REMOVED_REPLACEMENT,
};

export type MCPAddTransport = "http" | "sse";

export interface ParsedMcpAddArgs {
	name?: string;
	url?: string;
	transport: MCPAddTransport;
	authToken?: string;
	commandTokens?: string[];
	error?: string;
}

export interface MCPAddParsed {
	initialName?: string;
	quickConfig?: MCPServerConfig;
	isCommandQuickAdd?: boolean;
	hasAuthToken?: boolean;
	error?: string;
}

export type McpArgumentSurface = "terminal" | "cli";

export interface ParsedMcpSearchArgs {
	keyword: string;
	limit: number;
	semantic: boolean;
	error?: string;
}

export interface ParsedMcpRemoveArgs {
	name?: string;
	error?: string;
}

function isRemovedMcpWord(token: string, options: Record<string, string>, surface: McpArgumentSurface): boolean {
	return surface === "terminal"
		? token === "project" || token === "user"
		: Object.hasOwn(options, token.toLowerCase());
}

/**
 * Builds an MCPServerConfig object from parsed add arguments.
 */
export function buildMcpServerConfig(parsed: ParsedMcpAddArgs): MCPServerConfig | undefined {
	if (parsed.commandTokens && parsed.commandTokens.length > 0) {
		const [command, ...args] = parsed.commandTokens;
		return { type: "stdio", command: command!, args: args.length > 0 ? args : undefined } as MCPServerConfig;
	}
	if (!parsed.url) return undefined;
	const normalizedUrl = /^https?:\/\//i.test(parsed.url) ? parsed.url : `https://${parsed.url}`;
	return {
		type: parsed.transport === "sse" ? "sse" : "http",
		url: normalizedUrl,
		headers: parsed.authToken ? { Authorization: `Bearer ${parsed.authToken}` } : undefined,
	} as MCPServerConfig;
}

/**
 * Validates parsed arguments for non-interactive CLI add.
 */
export function validateParsedMcpAddArgs(parsed: ParsedMcpAddArgs): ParsedMcpAddArgs {
	const hasCommand = (parsed.commandTokens?.length ?? 0) > 0;
	const hasUrl = Boolean(parsed.url);
	if (!hasCommand && !hasUrl) {
		return {
			...parsed,
			error: `Provide \`url <url>\` or \`run <command...>\` for non-interactive add.\n${MCP_ADD_USAGE}`,
		};
	}
	if (!parsed.name) return { ...parsed, error: `Server name required.\n${MCP_ADD_USAGE}` };
	if (hasCommand && hasUrl) return { ...parsed, error: "Use either `url <url>` or `run <command...>`, not both." };
	if (parsed.authToken && !hasUrl) return { ...parsed, error: "`token` requires `url` (HTTP/SSE transport)." };
	return parsed;
}

/**
 * Parse the argument tail of `/mcp add`.
 *
 * Every argument is a plain word, disambiguated two ways and no others. The name
 * is POSITION: token 1 is the name whatever it spells, so a server called
 * `token` or `url` is named without ceremony. Everything after it is either a
 * CLOSED SET word that is its own value (`http|sse` for the transport) or a
 * leading keyword introducing text no set could describe (`url <url>`,
 * `token <token>`, `run <command...>`).
 *
 * Those token sets cannot overlap, which is what makes reading a word by its own
 * shape sound here: the closed set and the three keywords are five literal
 * spellings, all distinct, and a keyword's value is consumed by position rather
 * than examined. `run` takes the whole remainder, so a command's own arguments —
 * flags included — are never read as this grammar's words.
 *
 * `project` and `user` after the name are REFUSED rather than ignored: they used
 * to redirect the write, and a scope word that is quietly dropped stores the
 * server in a config the operator did not name.
 */
export function parseMcpAddArgs(rest: string, surface: McpArgumentSurface = "cli"): ParsedMcpAddArgs {
	const tokens = parseCommandArgs(rest);
	const parsed: ParsedMcpAddArgs = { transport: "http" };
	if (tokens.length === 0) return parsed;

	const name = tokens[0]!;
	if (name.startsWith("-")) {
		return { ...parsed, error: removedOptionMessage(name, MCP_ADD_REMOVED_OPTIONS, MCP_ADD_USAGE) };
	}
	parsed.name = name;

	const seen = new Set<string>();
	let index = 1;
	while (index < tokens.length) {
		const token = tokens[index]!;
		if (token.startsWith("-")) {
			return { ...parsed, error: removedOptionMessage(token, MCP_ADD_REMOVED_OPTIONS, MCP_ADD_USAGE) };
		}
		let word: string;
		if (token === "run") {
			parsed.commandTokens = tokens.slice(index + 1);
			word = "run";
			index = tokens.length;
		} else if (token === "url" || token === "token") {
			const value = tokens[index + 1];
			if (!value) return { ...parsed, error: `Missing value after \`${token}\`.\n${MCP_ADD_USAGE}` };
			if (token === "url") parsed.url = value;
			else parsed.authToken = value;
			word = token;
			index += 2;
		} else if (isRemovedMcpWord(token, MCP_ADD_REMOVED_OPTIONS, surface)) {
			return { ...parsed, error: removedOptionMessage(token, MCP_ADD_REMOVED_OPTIONS, MCP_ADD_USAGE) };
		} else if (token === "http" || token === "sse") {
			parsed.transport = token;
			word = "transport";
			index += 1;
		} else {
			return { ...parsed, error: `Unknown argument: ${token}\n${MCP_ADD_USAGE}` };
		}
		if (seen.has(word)) return { ...parsed, error: `\`${word}\` given twice.\n${MCP_ADD_USAGE}` };
		seen.add(word);
	}

	return parsed;
}

/**
 * Parse the argument tail of `/mcp add` for the terminal interactive controller,
 * supporting interactive wizard fallback when neither url nor run is supplied.
 */
export function parseMcpAddCommand(rest: string): MCPAddParsed {
	const raw = parseMcpAddArgs(rest, "terminal");
	if (raw.error) return { error: raw.error };
	if (raw.name === undefined) return {};

	const hasCommand = Boolean(raw.commandTokens && raw.commandTokens.length > 0);
	if (!raw.url && !hasCommand) {
		return { initialName: raw.name };
	}
	if (raw.url && hasCommand) {
		return { error: "Use either `url <url>` or `run <command...>`, not both." };
	}
	if (raw.authToken && !raw.url) {
		return { error: "`token` requires `url` (HTTP/SSE transport)." };
	}

	const quickConfig = buildMcpServerConfig(raw);
	return {
		initialName: raw.name,
		quickConfig,
		isCommandQuickAdd: hasCommand,
		hasAuthToken: Boolean(raw.authToken),
	};
}

/**
 * Parse the argument tail of `/mcp smithery-search`.
 *
 * The keyword is arbitrary text and the two options are words, so the keyword is
 * required FIRST and the options are read from the END. Token 1 is always part of
 * the keyword, which is what keeps a one-word search for `semantic` or for a
 * number searching for it; scanning backwards then stops at the first word that
 * belongs to no option, and everything up to there is the keyword.
 *
 * The options cannot be confused with each other: `semantic` is one literal word
 * and the limit is the only integer the command reads.
 *
 * In terminal mode, trailing scope words
 * (`project`, `user`) are refused with a removed-option message.
 * In CLI / ACP mode, trailing scope words
 * are treated as search keywords.
 */
export function parseMcpSearchArgs(rest: string, surface: McpArgumentSurface = "cli"): ParsedMcpSearchArgs {
	const tokens = parseCommandArgs(rest);
	const base: ParsedMcpSearchArgs = { keyword: "", limit: 20, semantic: false };
	if (tokens.length === 0) return { ...base, error: `Keyword required.\n${MCP_SEARCH_USAGE}` };
	for (const token of tokens) {
		if (token.startsWith("-")) {
			return { ...base, error: removedOptionMessage(token, MCP_SEARCH_REMOVED_OPTIONS, MCP_SEARCH_USAGE) };
		}
	}

	let limit = 20;
	let semantic = false;
	const seen = new Set<string>();
	let end = tokens.length;
	while (end > 1) {
		const token = tokens[end - 1]!;
		if (surface === "terminal" && isRemovedMcpWord(token, MCP_SEARCH_REMOVED_OPTIONS, surface)) {
			return { ...base, error: removedOptionMessage(token, MCP_SEARCH_REMOVED_OPTIONS, MCP_SEARCH_USAGE) };
		}
		let word: string;
		if (token === "semantic") {
			semantic = true;
			word = "semantic";
		} else if (/^\d+$/.test(token)) {
			const value = Number(token);
			if (value < 1 || value > 100) {
				return {
					...base,
					error: `Invalid limit: ${token}. Use an integer between 1 and 100.\n${MCP_SEARCH_USAGE}`,
				};
			}
			limit = value;
			word = "limit";
		} else {
			break;
		}
		if (seen.has(word)) return { ...base, error: `\`${word}\` given twice.\n${MCP_SEARCH_USAGE}` };
		seen.add(word);
		end -= 1;
	}

	return { keyword: tokens.slice(0, end).join(" "), limit, semantic };
}

/**
 * Parse the argument tail of `/mcp remove`.
 *
 * One word, read by POSITION: token 1 is the name whatever it spells, so a
 * server literally named `project` is removed by name. A second word is refused
 * rather than dropped, and a word the grammar used to read as an option gets the
 * sentence naming what replaced it.
 */
export function parseMcpRemoveArgs(rest: string, surface: McpArgumentSurface = "cli"): ParsedMcpRemoveArgs {
	const tokens = parseCommandArgs(rest);
	if (tokens.length === 0) return {};
	const name = tokens[0]!;
	if (name.startsWith("-")) {
		return { error: removedOptionMessage(name, MCP_REMOVE_REMOVED_OPTIONS, MCP_REMOVE_USAGE) };
	}
	const extra = tokens[1];
	if (extra !== undefined) {
		if (extra.startsWith("-") || isRemovedMcpWord(extra, MCP_REMOVE_REMOVED_OPTIONS, surface)) {
			return { error: removedOptionMessage(extra, MCP_REMOVE_REMOVED_OPTIONS, MCP_REMOVE_USAGE) };
		}
		return { error: `Unknown argument: ${extra}\n${MCP_REMOVE_USAGE}` };
	}
	return { name };
}
