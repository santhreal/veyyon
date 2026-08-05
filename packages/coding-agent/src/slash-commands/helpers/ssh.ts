import { getSSHConfigPath } from "@veyyon/utils";
import { addSSHHost, readSSHConfigFile, removeSSHHost, type SSHHostConfig } from "../../ssh/config-writer";
import { parseCommandArgs } from "../../utils/command-args";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./parse";

interface ParsedSshAddArgs {
	name?: string;
	host?: string;
	username?: string;
	port?: number;
	keyPath?: string;
	error?: string;
}

type SshAddOptionParser = (parsed: ParsedSshAddArgs, value: string | undefined) => string | undefined;

const SSH_ADD_USAGE = "Usage: /ssh add <name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>]";

const SSH_ADD_OPTION_PARSERS = new Map<string, SshAddOptionParser>([
	[
		"--host",
		(parsed, value) => {
			if (!value) return "Missing value for --host.";
			parsed.host = value;
			return undefined;
		},
	],
	[
		"--user",
		(parsed, value) => {
			if (!value) return "Missing value for --user.";
			parsed.username = value;
			return undefined;
		},
	],
	[
		"--port",
		(parsed, value) => {
			if (!value) return "Missing value for --port.";
			// Reject any non-integer token. `Number.parseInt` accepts trailing
			// garbage (parseInt("22oops") === 22) which silently coerces typos
			// to valid-looking ports.
			if (!/^\d+$/.test(value)) {
				return "Invalid --port value. Must be an integer between 1 and 65535.";
			}
			const port = Number.parseInt(value, 10);
			if (port < 1 || port > 65535) {
				return "Invalid --port value. Must be an integer between 1 and 65535.";
			}
			parsed.port = port;
			return undefined;
		},
	],
	[
		"--key",
		(parsed, value) => {
			if (!value) return "Missing value for --key.";
			parsed.keyPath = value;
			return undefined;
		},
	],
]);

function parseSshAddArgs(rest: string): ParsedSshAddArgs {
	const tokens = parseCommandArgs(rest);
	const parsed: ParsedSshAddArgs = {};
	let index = 0;
	if (tokens.length > 0 && !tokens[0]!.startsWith("-")) {
		parsed.name = tokens[0];
		index = 1;
	}
	while (index < tokens.length) {
		const arg = tokens[index]!;
		const parser = SSH_ADD_OPTION_PARSERS.get(arg);
		if (!parser) return { ...parsed, error: `Unknown option: ${arg}\n${SSH_ADD_USAGE}` };
		const error = parser(parsed, tokens[index + 1]);
		if (error) return { ...parsed, error };
		index += 2;
	}
	return parsed;
}

const SSH_HELP_TEXT = [
	"SSH host management (ACP mode)",
	"  /ssh add <name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>]",
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
	const name = parseCommandArgs(rest)[0];
	if (!name || name.startsWith("-")) return usage("Usage: /ssh remove <name>", runtime);
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
	if (!parsed.host) return usage(`--host is required.\n${SSH_ADD_USAGE}`, runtime);
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

/** ACP/text-mode `/ssh` handler. Shared by both dispatchers via the spec. */
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
