import { getSSHConfigPath } from "@veyyon/utils";
import { addSSHHost, readSSHConfigFile, removeSSHHost, type SSHHostConfig } from "../../ssh/config-writer";
import { parseCommandArgs } from "../../utils/command-args";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, errorMessage, parseSubcommand, removedOptionMessage, usage } from "./parse";

interface ParsedSshAddArgs {
	name?: string;
	host?: string;
	username?: string;
	port?: number;
	keyPath?: string;
	error?: string;
}

const SSH_ADD_USAGE = "Usage: /ssh add <name> <host> [user <user>] [<port>] [key <keyPath>]";

const SSH_REMOVE_USAGE = "Usage: /ssh remove <name>";

export const SSH_ADD_REMOVED_OPTIONS: Record<string, string> = {
	host: "write the host as the second word, after the name",
	user: "write `user <user>`",
	port: "write the port as a plain integer",
	key: "write `key <keyPath>`",
};

export const SSH_REMOVE_REMOVED_OPTIONS: Record<string, string> = {
	scope: "drop it — SSH hosts live in one config file, so there is no scope to choose",
};

function parseSshAddArgs(rest: string): ParsedSshAddArgs {
	const tokens = parseCommandArgs(rest);
	if (tokens.length === 0) return {};

	const name = tokens[0]!;
	if (name.startsWith("-")) return { error: removedOptionMessage(name, SSH_ADD_REMOVED_OPTIONS, SSH_ADD_USAGE) };
	const parsed: ParsedSshAddArgs = { name };
	if (tokens.length === 1) return parsed;

	const host = tokens[1]!;
	if (host.startsWith("-")) {
		return { ...parsed, error: removedOptionMessage(host, SSH_ADD_REMOVED_OPTIONS, SSH_ADD_USAGE) };
	}
	parsed.host = host;

	const seen = new Set<string>();
	let index = 2;
	while (index < tokens.length) {
		const token = tokens[index]!;
		if (token.startsWith("-")) {
			return { ...parsed, error: removedOptionMessage(token, SSH_ADD_REMOVED_OPTIONS, SSH_ADD_USAGE) };
		}
		let word: string;
		if (token === "user" || token === "key") {
			const value = tokens[index + 1];
			if (!value) return { ...parsed, error: `Missing value after \`${token}\`.\n${SSH_ADD_USAGE}` };
			if (token === "user") parsed.username = value;
			else parsed.keyPath = value;
			word = token;
			index += 2;
		} else if (/^\d+$/.test(token)) {
			const port = Number(token);
			if (port < 1 || port > 65535) {
				return {
					...parsed,
					error: `Invalid port: ${token}. Use an integer between 1 and 65535.\n${SSH_ADD_USAGE}`,
				};
			}
			parsed.port = port;
			word = "port";
			index += 1;
		} else {
			if (Object.hasOwn(SSH_ADD_REMOVED_OPTIONS, token.toLowerCase())) {
				return { ...parsed, error: removedOptionMessage(token, SSH_ADD_REMOVED_OPTIONS, SSH_ADD_USAGE) };
			}
			return { ...parsed, error: `Unknown argument: ${token}\n${SSH_ADD_USAGE}` };
		}
		if (seen.has(word)) return { ...parsed, error: `\`${word}\` given twice.\n${SSH_ADD_USAGE}` };
		seen.add(word);
	}

	return parsed;
}

const SSH_HELP_TEXT = [
	"SSH host management (ACP mode)",
	"  /ssh add <name> <host> [user <user>] [<port>] [key <keyPath>]",
	"  /ssh list                     List configured SSH hosts",
	"  /ssh remove <name>            Remove an SSH host",
	"  /ssh help                     Show this help",
].join("\n");

async function handleListCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	try {
		const config = await readSSHConfigFile(getSSHConfigPath());
		const entries = Object.entries(config.hosts ?? {});
		if (entries.length === 0) {
			await runtime.output("No SSH hosts configured.");
			return commandConsumed();
		}
		await runtime.output(
			entries
				.map(([name, host]) => `${name} | ${host.host} | ${host.username ?? "-"} | ${host.port ?? 22}`)
				.join("\n"),
		);
		return commandConsumed();
	} catch (err) {
		return usage(`Failed to list SSH hosts: ${errorMessage(err)}`, runtime);
	}
}

async function handleRemoveCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const tokens = parseCommandArgs(rest);
	const name = tokens[0];
	if (!name) return usage(SSH_REMOVE_USAGE, runtime);
	if (name.startsWith("-")) {
		return usage(removedOptionMessage(name, SSH_REMOVE_REMOVED_OPTIONS, SSH_REMOVE_USAGE), runtime);
	}
	if (tokens.length > 1) {
		const extra = tokens[1]!;
		const message =
			extra.startsWith("-") || Object.hasOwn(SSH_REMOVE_REMOVED_OPTIONS, extra.toLowerCase())
				? removedOptionMessage(extra, SSH_REMOVE_REMOVED_OPTIONS, SSH_REMOVE_USAGE)
				: `Unknown argument: ${extra}\n${SSH_REMOVE_USAGE}`;
		return usage(message, runtime);
	}
	try {
		await removeSSHHost(getSSHConfigPath(), name);
		await runtime.session.refreshSshTool();
		await runtime.output(`Removed SSH host "${name}".`);
		return commandConsumed();
	} catch (err) {
		return usage(`Failed to remove SSH host: ${errorMessage(err)}`, runtime);
	}
}

async function handleAddCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	if (!rest) return usage(SSH_ADD_USAGE, runtime);
	const parsed = parseSshAddArgs(rest);
	if (parsed.error) return usage(parsed.error, runtime);
	if (!parsed.name) return usage(`Host name required.\n${SSH_ADD_USAGE}`, runtime);
	if (!parsed.host) return usage(`Host address required as the second word.\n${SSH_ADD_USAGE}`, runtime);
	const hostConfig: SSHHostConfig = { host: parsed.host };
	if (parsed.username) hostConfig.username = parsed.username;
	if (parsed.port) hostConfig.port = parsed.port;
	if (parsed.keyPath) hostConfig.keyPath = parsed.keyPath;
	try {
		await addSSHHost(getSSHConfigPath(), parsed.name, hostConfig);
		await runtime.session.refreshSshTool({ activateIfAvailable: true });
		await runtime.output(`Added SSH host "${parsed.name}".`);
		return commandConsumed();
	} catch (err) {
		return usage(`Failed to add SSH host: ${errorMessage(err)}`, runtime);
	}
}

export async function handleSshAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	if (!verb || verb === "help") {
		await runtime.output(SSH_HELP_TEXT);
		return commandConsumed();
	}
	switch (verb) {
		case "list":
			return await handleListCommand(runtime);
		case "remove":
		case "rm":
			return await handleRemoveCommand(rest, runtime);
		case "add":
			return await handleAddCommand(rest, runtime);
		default:
			return usage(`Unknown /ssh subcommand: ${verb}. Use /ssh help for available subcommands.`, runtime);
	}
}
