/**
 * SSH Command Controller
 *
 * Handles /ssh subcommands for managing SSH host configurations.
 */
import { errorMessage, getProjectDir, getSSHConfigPath, logger } from "@veyyon/utils";
import { type SSHHost, sshCapability } from "../../capability/ssh";
import { loadCapability } from "../../discovery";
import { removedOptionMessage } from "../../slash-commands/helpers/parse";
import { addSSHHost, readSSHConfigFile, removeSSHHost, type SSHHostConfig } from "../../ssh/config-writer";
import { parseCommandArgs } from "../shared";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { groupBySource, showCommandMessage } from "./command-controller-shared";

const SSH_ADD_USAGE =
	"Usage: /ssh add <name> <host> [user <user>] [<port>] [key <keyPath>] [desc <description>] [compat]";

const SSH_REMOVE_USAGE = "Usage: /ssh remove <name>";

/** The option spellings `/ssh add` no longer has, keyed by bare name. */
const SSH_ADD_REMOVED_OPTIONS: Record<string, string> = {
	host: "write the host as the second word, after the name",
	user: "write `user <user>`",
	port: "write the port as a plain integer",
	key: "write `key <keyPath>`",
	desc: "write `desc <description>`",
	compat: "write `compat` as a plain word",
};

/**
 * `/ssh remove` never had an option worth converting. It used to read a scope and
 * then throw it away: SSH hosts live in ONE file, so nothing was there to select.
 */
const SSH_REMOVE_REMOVED_OPTIONS: Record<string, string> = {
	scope: "drop it — SSH hosts live in one config file, so there is no scope to choose",
};

type SshAddParsed = {
	name?: string;
	host?: string;
	username?: string;
	port?: number;
	keyPath?: string;
	description?: string;
	compat?: boolean;
	error?: string;
};

/**
 * The slice of the interactive context this controller uses: 2 members of the
 * 215 `InteractiveModeContext` requires. Naming the slice keeps the dependency
 * legible and lets a test build one without the `as unknown as
 * InteractiveModeContext` cast the full interface forces (see
 * `CollabHostContext`).
 */
export type SshCommandControllerContext = Pick<InteractiveModeContext, "present" | "session" | "showError">;

export class SSHCommandController {
	constructor(private ctx: SshCommandControllerContext) {}

	/**
	 * Handle /ssh command and route to subcommands
	 */
	async handle(text: string): Promise<void> {
		const parts = text.trim().split(/\s+/);
		const subcommand = parts[1]?.toLowerCase();

		if (!subcommand || subcommand === "help") {
			this.#showHelp();
			return;
		}

		switch (subcommand) {
			case "add":
				await this.#handleAdd(text);
				break;
			case "list":
				await this.#handleList();
				break;
			case "remove":
			case "rm":
				await this.#handleRemove(text);
				break;
			default:
				this.ctx.showError(`Unknown subcommand: ${subcommand}. Type /ssh help for usage.`);
		}
	}

	/**
	 * Show help text
	 */
	#showHelp(): void {
		const helpText = [
			"",
			theme.bold("SSH Host Management"),
			"",
			"Manage SSH host configurations for remote command execution.",
			"",
			theme.fg("accent", "Commands:"),
			`  ${SSH_ADD_USAGE.replace("Usage: ", "")}`,
			"  /ssh list             List all configured SSH hosts",
			"  /ssh remove <name>    Remove an SSH host",
			"  /ssh help             Show this help message",
			"",
		].join("\n");

		this.#showMessage(helpText);
	}

	/**
	 * Parse the argument tail of `/ssh add`.
	 *
	 * Both required values are POSITION: token 1 is the name and token 2 is the
	 * address, so a host literally called `user` or `key` needs no escaping. The
	 * optional values follow, `user`, `key` and `desc` as leading keywords because
	 * their values are arbitrary text, `compat` as a bare literal, and the port by
	 * PATTERN as a bare integer.
	 *
	 * Reading the port by its shape is sound rather than lucky. Past position 2
	 * this grammar reads exactly four literal words — `user`, `key`, `desc`,
	 * `compat` — and none is a run of digits, so no integer can be mistaken for a
	 * word and no word for a port. A keyword's value is consumed by position and
	 * never examined, so a user named `2222` is still a user.
	 */
	#parseAddCommand(text: string): SshAddParsed {
		const prefixMatch = text.match(/^\/ssh\s+add\b\s*(.*)$/i);
		const tokens = parseCommandArgs(prefixMatch?.[1]?.trim() ?? "");
		if (tokens.length === 0) return {};

		const name = tokens[0];
		if (name.startsWith("-")) return { error: removedOptionMessage(name, SSH_ADD_REMOVED_OPTIONS, SSH_ADD_USAGE) };
		const parsed: SshAddParsed = { name };
		if (tokens.length === 1) return parsed;

		const host = tokens[1];
		if (host.startsWith("-")) {
			return { ...parsed, error: removedOptionMessage(host, SSH_ADD_REMOVED_OPTIONS, SSH_ADD_USAGE) };
		}
		parsed.host = host;

		const seen = new Set<string>();
		let index = 2;
		while (index < tokens.length) {
			const token = tokens[index];
			if (token.startsWith("-")) {
				return { ...parsed, error: removedOptionMessage(token, SSH_ADD_REMOVED_OPTIONS, SSH_ADD_USAGE) };
			}
			let word: string;
			if (token === "user" || token === "key" || token === "desc") {
				const value = tokens[index + 1];
				if (!value) return { ...parsed, error: `Missing value after \`${token}\`.\n${SSH_ADD_USAGE}` };
				if (token === "user") parsed.username = value;
				else if (token === "key") parsed.keyPath = value;
				else parsed.description = value;
				word = token;
				index += 2;
			} else if (token === "compat") {
				parsed.compat = true;
				word = "compat";
				index += 1;
			} else if (/^\d+$/.test(token)) {
				// `Number.parseInt` accepts trailing garbage (parseInt("22oops") === 22),
				// so the digit test above is what keeps a typo from becoming a port.
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
				return { ...parsed, error: `Unknown argument: ${token}\n${SSH_ADD_USAGE}` };
			}
			if (seen.has(word)) return { ...parsed, error: `\`${word}\` given twice.\n${SSH_ADD_USAGE}` };
			seen.add(word);
		}

		return parsed;
	}

	/**
	 * Handle /ssh add - read the plain-word arguments and add the host to config
	 */
	async #handleAdd(text: string): Promise<void> {
		const parsed = this.#parseAddCommand(text);
		if (parsed.error) {
			this.ctx.showError(parsed.error);
			return;
		}
		if (!parsed.name) {
			this.ctx.showError(`Host name required.\n${SSH_ADD_USAGE}`);
			return;
		}
		if (!parsed.host) {
			this.ctx.showError(`Host address required as the second word.\n${SSH_ADD_USAGE}`);
			return;
		}

		const { name, host, username, port, keyPath, description, compat } = parsed;
		try {
			const filePath = getSSHConfigPath();

			const hostConfig: SSHHostConfig = { host };
			if (username) hostConfig.username = username;
			if (port) hostConfig.port = port;
			if (keyPath) hostConfig.keyPath = keyPath;
			if (description) hostConfig.description = description;
			if (compat) hostConfig.compat = true;

			await addSSHHost(filePath, name, hostConfig);
			await this.ctx.session.refreshSshTool({ activateIfAvailable: true });

			const lines = ["", theme.fg("success", `+ Added SSH host "${name}"`), "", `  Host: ${host}`];
			if (username) lines.push(`  User: ${username}`);
			if (port) lines.push(`  Port: ${port}`);
			if (keyPath) lines.push(`  Key:  ${keyPath}`);
			if (description) lines.push(`  Desc: ${description}`);
			if (compat) lines.push(`  Compat: true`);
			lines.push("");
			lines.push(theme.fg("muted", `Run ${theme.fg("accent", "/ssh list")} to see all configured hosts.`));
			lines.push("");

			this.#showMessage(lines.join("\n"));
		} catch (error) {
			const errorMsg = errorMessage(error);

			let helpText = "";
			if (errorMsg.includes("already exists")) {
				helpText = `\n\nTip: Use ${theme.fg("accent", "/ssh remove")} first, or choose a different name.`;
			}

			this.ctx.showError(`Failed to add host: ${errorMsg}${helpText}`);
		}
	}

	/**
	 * Handle /ssh list - show all configured SSH hosts
	 */
	async #handleList(): Promise<void> {
		try {
			const cwd = getProjectDir();
			const userConfig = await readSSHConfigFile(getSSHConfigPath());
			const userHosts = Object.keys(userConfig.hosts ?? {});

			// Load discovered hosts via capability system
			const configHostNames = new Set(userHosts);
			let discoveredHosts: SSHHost[] = [];
			try {
				const result = await loadCapability<SSHHost>(sshCapability.id, { cwd });
				discoveredHosts = result.items.filter(h => !configHostNames.has(h.name));
			} catch (error) {
				// Configured hosts still list, but the user should know why
				// discovered hosts are missing instead of seeing a short list.
				logger.warn("SSH host discovery failed; listing configured hosts only", {
					error: errorMessage(error),
				});
			}

			if (userHosts.length === 0 && discoveredHosts.length === 0) {
				this.#showMessage(
					[
						"",
						theme.fg("muted", "No SSH hosts configured."),
						"",
						`Use ${theme.fg("accent", "/ssh add")} to add a host.`,
						"",
					].join("\n"),
				);
				return;
			}

			const lines: string[] = ["", theme.bold("Configured SSH Hosts"), ""];

			// Hosts configured in the active profile
			if (userHosts.length > 0) {
				lines.push(theme.fg("accent", "Profile level") + theme.fg("muted", " (ssh.json):"));
				for (const name of userHosts) {
					const config = userConfig.hosts![name];
					const details = this.#formatHostDetails(config);
					lines.push(`  ${theme.fg("accent", name)} ${details}`);
				}
				lines.push("");
			}

			// Read-only hosts contributed by a discovery provider
			if (discoveredHosts.length > 0) {
				for (const { providerName, shortPath, items: hosts } of groupBySource(discoveredHosts, h => h._source)) {
					lines.push(
						theme.fg("accent", "Discovered") +
							theme.fg("muted", ` (${providerName}: ${shortPath}):`) +
							theme.fg("dim", " read-only"),
					);
					for (const host of hosts) {
						const details = this.#formatHostDetails({
							host: host.host,
							username: host.username,
							port: host.port,
						});
						lines.push(`  ${theme.fg("accent", host.name)} ${details}`);
					}
					lines.push("");
				}
			}

			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.ctx.showError(`Failed to list hosts: ${errorMessage(error)}`);
		}
	}

	/**
	 * Format host details (host, user, port) for display
	 */
	#formatHostDetails(config: { host?: string; username?: string; port?: number }): string {
		const parts: string[] = [];
		if (config.host) parts.push(config.host);
		if (config.username) parts.push(`user=${config.username}`);
		if (config.port && config.port !== 22) parts.push(`port=${config.port}`);
		return theme.fg("dim", parts.length > 0 ? `[${parts.join(", ")}]` : "");
	}

	/**
	 * Handle /ssh remove <name> - remove a host from config
	 */
	async #handleRemove(text: string): Promise<void> {
		const match = text.match(/^\/ssh\s+(?:remove|rm)\b\s*(.*)$/i);
		const tokens = parseCommandArgs(match?.[1]?.trim() ?? "");
		const name = tokens[0];
		if (!name) {
			this.ctx.showError(`Host name required.\n${SSH_REMOVE_USAGE}`);
			return;
		}
		if (name.startsWith("-")) {
			this.ctx.showError(removedOptionMessage(name, SSH_REMOVE_REMOVED_OPTIONS, SSH_REMOVE_USAGE));
			return;
		}
		if (tokens.length > 1) {
			const extra = tokens[1];
			this.ctx.showError(
				extra.startsWith("-")
					? removedOptionMessage(extra, SSH_REMOVE_REMOVED_OPTIONS, SSH_REMOVE_USAGE)
					: `Unknown argument: ${extra}\n${SSH_REMOVE_USAGE}`,
			);
			return;
		}

		try {
			const filePath = getSSHConfigPath();
			const config = await readSSHConfigFile(filePath);
			if (!config.hosts?.[name]) {
				this.ctx.showError(`Host "${name}" not found.`);
				return;
			}

			await removeSSHHost(filePath, name);
			await this.ctx.session.refreshSshTool();

			this.#showMessage(["", theme.fg("success", `- Removed SSH host "${name}"`), ""].join("\n"));
		} catch (error) {
			this.ctx.showError(`Failed to remove host: ${errorMessage(error)}`);
		}
	}

	/**
	 * Show a message in the chat
	 */
	#showMessage(text: string): void {
		showCommandMessage(this.ctx, text);
	}
}
