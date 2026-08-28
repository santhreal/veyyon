import * as AIError from "@veyyon/ai/error";
import { getMCPConfigPath, logger } from "@veyyon/utils";
import { connectToServer, disconnectServer, listPrompts, listResources, listTools } from "../../mcp/client";
import {
	addMCPServer,
	readDisabledServers,
	readMCPConfigFile,
	removeMCPServer,
	setServerDisabled,
	updateMCPServer,
} from "../../mcp/config-writer";
import { MCPManager } from "../../mcp/manager";
import { getSmitheryApiKey } from "../../mcp/smithery-auth";
import { searchSmitheryRegistry } from "../../mcp/smithery-registry";
import type { MCPServerConfig, MCPServerConnection } from "../../mcp/types";
import { parseCommandArgs } from "../../utils/command-args";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import {
	commandConsumed,
	errorMessage,
	MCP_SCOPE_REMOVED_REPLACEMENT,
	parseSubcommand,
	removedOptionMessage,
	usage,
} from "./parse";

interface ParsedMcpAddArgs {
	name?: string;
	url?: string;
	transport: "http" | "sse";
	authToken?: string;
	commandTokens?: string[];
	error?: string;
}

interface ParsedMcpSearchArgs {
	keyword: string;
	limit: number;
	semantic: boolean;
	error?: string;
}

interface ParsedMcpRemoveArgs {
	name?: string;
	error?: string;
}

const MCP_ADD_USAGE = "Usage: /mcp add <name> [http|sse] [url <url>] [token <token>] [run <command...>]";

const MCP_SEARCH_USAGE = "Usage: /mcp smithery-search <keyword...> [<limit 1-100>] [semantic]";

const MCP_REMOVE_USAGE = "Usage: /mcp remove <name>";

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

async function getMcpConfiguredServers(cwd: string): Promise<Array<{ name: string; config: MCPServerConfig }>> {
	const config = await readMCPConfigFile(getMCPConfigPath("user", cwd));
	return Object.entries(config.mcpServers ?? {})
		.filter(([, server]) => server.enabled !== false)
		.map(([name, server]) => ({ name, config: server }));
}

function validateParsedMcpAddArgs(parsed: ParsedMcpAddArgs): ParsedMcpAddArgs {
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

function parseMcpAddArgs(rest: string): ParsedMcpAddArgs {
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
		} else if (Object.hasOwn(MCP_ADD_REMOVED_OPTIONS, token.toLowerCase())) {
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

	return validateParsedMcpAddArgs(parsed);
}

function parseMcpSearchArgs(rest: string): ParsedMcpSearchArgs {
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

async function withPreparedMcpConnection<T>(
	runtime: SlashCommandRuntime,
	name: string,
	config: MCPServerConfig,
	fn: (connection: MCPServerConnection) => Promise<T>,
): Promise<T> {
	let connection: MCPServerConnection | undefined;
	try {
		const manager = new MCPManager(runtime.cwd);
		manager.setAuthStorage(runtime.session.modelRegistry.authStorage);
		const resolvedConfig = await manager.prepareConfig(config);
		connection = await connectToServer(name, resolvedConfig);
		return await fn(connection);
	} finally {
		if (connection) {
			try {
				await disconnectServer(connection);
			} catch (err) {
				logger.warn("MCP disconnect after temporary connection failed", { name, err });
			}
		}
	}
}

async function collectConnectedMcpLines(
	runtime: SlashCommandRuntime,
	collect: (serverName: string, connection: MCPServerConnection) => Promise<string[]>,
): Promise<string[] | undefined> {
	const servers = await getMcpConfiguredServers(runtime.cwd);
	if (servers.length === 0) return undefined;

	const lines: string[] = [];
	for (const { name, config } of servers) {
		try {
			const collected = await withPreparedMcpConnection(runtime, name, config, connection =>
				collect(name, connection),
			);
			for (let li = 0; li < collected.length; li++) lines.push(collected[li]!);
		} catch (error) {
			logger.warn("MCP server could not be queried; it is missing from this listing", {
				name,
				error: errorMessage(error),
			});
		}
	}
	return lines;
}

async function handleResourcesCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const lines = await collectConnectedMcpLines(runtime, async (name, connection) => {
		const resources = await listResources(connection);
		return resources.map(resource => `${name}/${resource.uri}`);
	});
	if (!lines) {
		await runtime.output("No MCP servers configured.");
		return commandConsumed();
	}
	await runtime.output(lines.length > 0 ? lines.join("\n") : "No resources available on connected servers.");
	return commandConsumed();
}

async function handlePromptsCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const lines = await collectConnectedMcpLines(runtime, async (name, connection) => {
		const prompts = await listPrompts(connection);
		return prompts.map(prompt => `${name}/${prompt.name}${prompt.description ? ` — ${prompt.description}` : ""}`);
	});
	if (!lines) {
		await runtime.output("No MCP servers configured.");
		return commandConsumed();
	}
	await runtime.output(lines.length > 0 ? lines.join("\n") : "No prompts available on connected servers.");
	return commandConsumed();
}

async function handleTestCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const name = rest.split(/\s+/)[0]?.trim() ?? "";
	if (!name) return usage("Usage: /mcp test <name>", runtime);
	const servers = await getMcpConfiguredServers(runtime.cwd);
	const server = servers.find(item => item.name === name);
	if (!server) return usage(`Server "${name}" not found. Run /mcp list to see configured servers.`, runtime);

	try {
		return await withPreparedMcpConnection(runtime, name, server.config, async connection => {
			const tools = await listTools(connection);
			const lines = [`Server "${name}" connected (${tools.length} tools).`];
			for (const tool of tools) lines.push(`  - ${tool.name}`);
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		});
	} catch (err) {
		return usage(`Connection to "${name}" failed: ${errorMessage(err)}`, runtime);
	}
}

function buildMcpServerConfig(parsed: ParsedMcpAddArgs): MCPServerConfig | undefined {
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

async function handleAddCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	if (!rest) return usage(MCP_ADD_USAGE, runtime);
	const parsed = parseMcpAddArgs(rest);
	if (parsed.error) return usage(parsed.error, runtime);
	if (!parsed.name) return usage(MCP_ADD_USAGE, runtime);
	const config = buildMcpServerConfig(parsed);
	if (!config) return usage(MCP_ADD_USAGE, runtime);
	try {
		const filePath = getMCPConfigPath("user", runtime.cwd);
		await addMCPServer(filePath, parsed.name, config);
		await runtime.output(`Added MCP server "${parsed.name}".`);
		return commandConsumed();
	} catch (err) {
		return usage(`Failed to add server: ${errorMessage(err)}`, runtime);
	}
}

async function handleSmitherySearchCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseMcpSearchArgs(rest);
	if (parsed.error) return usage(parsed.error, runtime);
	try {
		const apiKey = await getSmitheryApiKey();
		const results = await searchSmitheryRegistry(parsed.keyword, {
			limit: parsed.limit,
			apiKey: apiKey ?? undefined,
			includeSemantic: parsed.semantic,
			resolveProviderTextTransform: () => text => runtime.session.obfuscateProviderText(text),
		});
		if (results.length === 0) {
			await runtime.output(`No Smithery results found for "${parsed.keyword}".`);
			return commandConsumed();
		}
		await runtime.output(
			results
				.map(
					result =>
						`${result.display.displayName} (${result.name})${result.display.description ? ` — ${result.display.description}` : ""}`,
				)
				.join("\n"),
		);
		return commandConsumed();
	} catch (err) {
		const message = errorMessage(err);
		if (AIError.is(AIError.classify(err), AIError.Flag.AuthFailed)) {
			return usage(
				"Smithery authentication required. Run /mcp smithery-login in the TUI client or add an API key to smithery.json in the active profile's agent directory (~/.veyyon/profiles/<name>/agent/smithery.json).",
				runtime,
			);
		}
		return usage(`Smithery search failed: ${message}`, runtime);
	}
}

async function handleListCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	try {
		const userPath = getMCPConfigPath("user", runtime.cwd);
		const userConfig = await readMCPConfigFile(userPath);
		const disabledSet = new Set(await readDisabledServers(userPath));
		const entries: Array<{ name: string; config: MCPServerConfig }> = [];
		for (const [name, config] of Object.entries(userConfig.mcpServers ?? {})) {
			entries.push({ name, config });
		}
		if (entries.length === 0) {
			await runtime.output("No MCP servers configured.");
			return commandConsumed();
		}
		await runtime.output(
			entries
				.map(({ name, config }) => {
					const type = config.type ?? "stdio";
					const enabled = config.enabled !== false && !disabledSet.has(name) ? "enabled" : "disabled";
					let location: string | undefined;
					if (config.type === "http" || config.type === "sse") {
						const raw = (config as { url?: string }).url;
						if (raw) {
							try {
								const parsed = new URL(raw);
								const pathOnly = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
								location = `${parsed.origin}${pathOnly}`;
							} catch {
								location = "(hidden)";
							}
						}
					} else {
						location = (config as { command: string }).command;
					}
					return `${name} | ${type} | ${enabled} | ${location ?? "(unknown)"}`;
				})
				.join("\n"),
		);
		return commandConsumed();
	} catch (err) {
		return usage(`Failed to list MCP servers: ${errorMessage(err)}`, runtime);
	}
}

async function handleEnableDisableCommand(
	verb: "enable" | "disable",
	rest: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const name = rest.split(/\s+/)[0] ?? "";
	if (!name) return usage(`Usage: /mcp ${verb} <name>`, runtime);
	const enabled = verb === "enable";
	try {
		const userPath = getMCPConfigPath("user", runtime.cwd);
		const userConfig = await readMCPConfigFile(userPath);
		if (userConfig.mcpServers?.[name] !== undefined) {
			await updateMCPServer(userPath, name, { ...userConfig.mcpServers[name], enabled } as MCPServerConfig);
			await runtime.output(`Server "${name}" ${enabled ? "enabled" : "disabled"}.`);
			return commandConsumed();
		}
		const disabledList = await readDisabledServers(userPath);
		if (!enabled || disabledList.includes(name)) {
			await setServerDisabled(userPath, name, !enabled);
			await runtime.output(`Server "${name}" ${enabled ? "enabled" : "disabled"}.`);
			return commandConsumed();
		}
		return usage(`Server "${name}" not found.`, runtime);
	} catch (err) {
		return usage(`Failed to ${verb} MCP server: ${errorMessage(err)}`, runtime);
	}
}

export const MCP_REMOVE_REMOVED_OPTIONS: Record<string, string> = {
	scope: MCP_SCOPE_REMOVED_REPLACEMENT,
	project: MCP_SCOPE_REMOVED_REPLACEMENT,
	user: MCP_SCOPE_REMOVED_REPLACEMENT,
};

function parseMcpRemoveArgs(rest: string): ParsedMcpRemoveArgs {
	const tokens = parseCommandArgs(rest);
	if (tokens.length === 0) return {};
	const name = tokens[0]!;
	if (name.startsWith("-")) {
		return { error: removedOptionMessage(name, MCP_REMOVE_REMOVED_OPTIONS, MCP_REMOVE_USAGE) };
	}
	const extra = tokens[1];
	if (extra !== undefined) {
		if (extra.startsWith("-") || Object.hasOwn(MCP_REMOVE_REMOVED_OPTIONS, extra.toLowerCase())) {
			return { error: removedOptionMessage(extra, MCP_REMOVE_REMOVED_OPTIONS, MCP_REMOVE_USAGE) };
		}
		return { error: `Unknown argument: ${extra}\n${MCP_REMOVE_USAGE}` };
	}
	return { name };
}

async function handleRemoveCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseMcpRemoveArgs(rest);
	if (parsed.error) return usage(parsed.error, runtime);
	if (!parsed.name) return usage(MCP_REMOVE_USAGE, runtime);
	try {
		const filePath = getMCPConfigPath("user", runtime.cwd);
		await removeMCPServer(filePath, parsed.name);
		await runtime.output(`Removed server "${parsed.name}".`);
		return commandConsumed();
	} catch (err) {
		return usage(`Failed to remove MCP server: ${errorMessage(err)}`, runtime);
	}
}

const MCP_HELP_TEXT = [
	"MCP server management (ACP mode)",
	"  /mcp list                                               List configured servers",
	"  /mcp enable <name>                                      Enable a server",
	"  /mcp disable <name>                                     Disable a server",
	"  /mcp remove <name>                                      Remove a server",
	"  /mcp reload                                             Reload MCP runtime",
	"  /mcp resources                                          List resources from all servers",
	"  /mcp prompts                                            List prompts from all servers",
	"  /mcp test <name>                                        Test connection to a server",
	"  /mcp add <name> [url <url>]                             Add a server (non-interactive)",
	"  /mcp add <name> run <command...>                        Add a stdio server",
	"  /mcp smithery-search <keyword...> [<limit>] [semantic]  Search Smithery registry",
	"  /mcp help                                               Show this help",
].join("\n");

const TUI_ONLY_MCP_VERBS = new Set(["reauth", "unauth", "smithery-login", "smithery-logout", "reconnect"]);

export async function handleMcpAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	if (!verb || verb === "help") {
		await runtime.output(MCP_HELP_TEXT);
		return commandConsumed();
	}
	if (verb === "notifications") {
		return usage(
			"MCP notifications require the TUI client (live MCPManager). Use /mcp list to see server status.",
			runtime,
		);
	}
	if (TUI_ONLY_MCP_VERBS.has(verb)) {
		return usage(`/mcp ${verb} requires OAuth or browser flows only available in the TUI client.`, runtime);
	}
	switch (verb) {
		case "resources":
			return await handleResourcesCommand(runtime);
		case "prompts":
			return await handlePromptsCommand(runtime);
		case "test":
			return await handleTestCommand(rest, runtime);
		case "add":
			return await handleAddCommand(rest, runtime);
		case "smithery-search":
			return await handleSmitherySearchCommand(rest, runtime);
		case "reload":
			await runtime.refreshCommands();
			await runtime.output("MCP runtime reload requested.");
			return commandConsumed();
		case "list":
			return await handleListCommand(runtime);
		case "enable":
		case "disable":
			return await handleEnableDisableCommand(verb, rest, runtime);
		case "remove":
		case "rm":
			return await handleRemoveCommand(rest, runtime);
		default:
			return usage(`Unknown /mcp subcommand: ${verb}. Use /mcp help for available subcommands.`, runtime);
	}
}
