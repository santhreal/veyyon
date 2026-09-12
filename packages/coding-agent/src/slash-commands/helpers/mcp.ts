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
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import {
	buildMcpServerConfig,
	MCP_ADD_REMOVED_OPTIONS,
	MCP_ADD_USAGE,
	MCP_REMOVE_REMOVED_OPTIONS,
	MCP_REMOVE_USAGE,
	MCP_SEARCH_REMOVED_OPTIONS,
	parseMcpAddArgs,
	parseMcpRemoveArgs,
	parseMcpSearchArgs,
	validateParsedMcpAddArgs,
} from "./mcp-args";

export { MCP_ADD_REMOVED_OPTIONS, MCP_REMOVE_REMOVED_OPTIONS, MCP_SEARCH_REMOVED_OPTIONS };

import { commandConsumed, errorMessage, parseSubcommand, usage } from "./parse";

async function getMcpConfiguredServers(cwd: string): Promise<Array<{ name: string; config: MCPServerConfig }>> {
	const config = await readMCPConfigFile(getMCPConfigPath("user", cwd));
	return Object.entries(config.mcpServers ?? {})
		.filter(([, server]) => server.enabled !== false)
		.map(([name, server]) => ({ name, config: server }));
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
		// Auth storage must be wired in before prepareConfig so OAuth-backed
		// servers can refresh credentials and inject Authorization headers.
		// Without this, `/mcp test|resources|prompts` silently fails for any
		// server saved by the TUI/reauth path.
		manager.setAuthStorage(runtime.session.modelRegistry.authStorage);
		const resolvedConfig = await manager.prepareConfig(config);
		connection = await connectToServer(name, resolvedConfig);
		return await fn(connection);
	} finally {
		if (connection) {
			// Await cleanup so the stdio subprocess / HTTP DELETE has actually
			// released the resource before this helper returns. Fire-and-forget
			// here races with subsequent connect attempts and turns close
			// failures into unhandled rejections.
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
			// The server is simply absent from the listing, which reads exactly like a
			// server that is up and has nothing to list. Name it so an operator whose
			// MCP server stopped answering can tell the two apart.
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

async function handleAddCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	if (!rest) return usage(MCP_ADD_USAGE, runtime);
	const raw = parseMcpAddArgs(rest);
	if (raw.error) return usage(raw.error, runtime);
	const parsed = validateParsedMcpAddArgs(raw);
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
						// Strip query string and userinfo from URLs to avoid leaking
						// API keys carried in the query (e.g. `?apiKey=…`). Skip the
						// redaction entirely for missing/empty URLs so the row falls
						// back to `(unknown)` rather than the misleading `(hidden)`
						// label reserved for unparseable values.
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

/** ACP/text-mode `/mcp` handler. Shared by both dispatchers via the spec. */
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
