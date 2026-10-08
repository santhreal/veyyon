/**
 * The Smithery `/mcp` subcommands: `smithery-search` (search the registry and
 * add the chosen server), `smithery-login` and `smithery-logout`.
 */
import { errorMessage, getMCPConfigPath, getProjectDir } from "@veyyon/utils";
import { readMCPConfigFile } from "../../../mcp/config-writer";
import {
	clearSmitheryApiKey,
	createSmitheryCliAuthSession,
	getSmitheryApiKey,
	getSmitheryLoginUrl,
	pollSmitheryCliAuthSession,
	saveSmitheryApiKey,
} from "../../../mcp/smithery-auth";
import {
	SmitheryRegistryError,
	type SmitherySearchResult,
	searchSmitheryRegistry,
	toConfigName,
} from "../../../mcp/smithery-registry";
import type { MCPServerConfig } from "../../../mcp/types";
import { parseMcpSearchArgs } from "../../../slash-commands/helpers/mcp-args";
import { theme } from "../../../theme/theme";
import { shortenPath } from "../../../tools/core/render-utils";
import { openPath } from "../../../utils/open";
import type { InteractiveModeContext } from "../types";
import { showCommandMessage } from "./command-controller-shared";

/** The slice of the interactive context the Smithery subcommands use. */
export type McpSmitheryContext = Pick<
	InteractiveModeContext,
	"present" | "session" | "showError" | "showHookInput" | "showHookSelector" | "showStatus" | "showWarning"
>;

/** Registry status codes that mean the cached API key is missing, rejected or throttled. */
const SMITHERY_AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);

export class McpSmitheryCommands {
	/** `addServer` saves a chosen registry server the way `/mcp add` does. */
	constructor(
		private readonly ctx: McpSmitheryContext,
		private readonly addServer: (name: string, config: MCPServerConfig) => Promise<void>,
	) {}

	/** `/mcp smithery-search <keyword>`: search the registry, pick a result, and add it. */
	async search(text: string): Promise<void> {
		const match = text.match(/^\/mcp\s+smithery-search\b\s*(.*)$/i);
		const parsed = parseMcpSearchArgs(match?.[1]?.trim() ?? "", "terminal");
		if (parsed.error) {
			this.ctx.showError(parsed.error);
			return;
		}

		try {
			this.#showMessage(
				["", theme.fg("muted", `Searching Smithery registry for "${parsed.keyword}"...`), ""].join("\n"),
			);
			const results = await this.#withAuthRetry(
				apiKey =>
					searchSmitheryRegistry(parsed.keyword, {
						limit: parsed.limit,
						apiKey,
						includeSemantic: parsed.semantic,
						resolveProviderTextTransform: () => text => this.ctx.session.obfuscateProviderText(text),
					}),
				"required for smithery-search",
			);
			if (results.length === 0) {
				this.#showMessage(
					["", theme.fg("warning", `No Smithery results found for "${parsed.keyword}".`), ""].join("\n"),
				);
				return;
			}

			const selected = await this.#pickResult(results, parsed.keyword);
			if (!selected) {
				this.ctx.showStatus("MCP Smithery selection cancelled.");
				return;
			}

			await this.#deploy(selected);
		} catch (error) {
			const message = errorMessage(error);
			if (/authentication was cancelled|login cancelled/i.test(message)) {
				this.ctx.showError(`${message} Run /mcp smithery-login to authenticate first.`);
				return;
			}
			this.ctx.showError(`Smithery search failed: ${message}`);
		}
	}

	/** `/mcp smithery-login`: authorize in the browser, or paste an API key when that fails. */
	async login(): Promise<void> {
		const ok = await this.#promptLogin("login");
		if (!ok) {
			this.ctx.showStatus("Smithery login cancelled.");
		}
	}

	/** `/mcp smithery-logout`: delete the cached API key. */
	async logout(): Promise<void> {
		const removed = await clearSmitheryApiKey();
		this.ctx.showStatus(removed ? "Smithery API key removed." : "No cached Smithery API key found.");
	}

	async #validateApiKey(apiKey: string): Promise<void> {
		await searchSmitheryRegistry("mcp", {
			limit: 1,
			apiKey,
			resolveProviderTextTransform: () => text => this.ctx.session.obfuscateProviderText(text),
		});
	}

	async #promptApiKey(promptLabel: string): Promise<string | null> {
		for (;;) {
			const input = await this.ctx.showHookInput(promptLabel);
			if (input === undefined) return null;
			const apiKey = input.trim();
			if (!apiKey) {
				this.ctx.showError("Smithery API key cannot be empty.");
				continue;
			}
			try {
				await this.#validateApiKey(apiKey);
				return apiKey;
			} catch (error) {
				this.ctx.showError(`Smithery API key validation failed: ${errorMessage(error)}`);
			}
		}
	}

	async #loginWithApiKey(): Promise<boolean> {
		const apiKey = await this.#promptApiKey("Smithery API key (Esc to cancel)");
		if (!apiKey) return false;
		await saveSmitheryApiKey(apiKey);
		this.ctx.showStatus("Smithery API key saved.");
		return true;
	}

	async #browserLogin(): Promise<boolean> {
		const session = await createSmitheryCliAuthSession();
		const fallbackLoginUrl = getSmitheryLoginUrl();
		this.#showMessage(
			[
				"",
				theme.bold("Smithery Login"),
				theme.fg("muted", "Browser authorization started. Complete auth in your browser."),
				theme.fg("dim", "Authorize URL:"),
				theme.fg("accent", session.authUrl),
				theme.fg("dim", `Fallback: ${fallbackLoginUrl}`),
				"",
			].join("\n"),
		);
		try {
			openPath(session.authUrl);
		} catch {
			// URL is already shown above.
		}

		const apiKey = await waitForSmitheryCliApiKey(session.sessionId, new AbortController().signal);
		await this.#validateApiKey(apiKey);
		await saveSmitheryApiKey(apiKey);
		this.ctx.showStatus("Smithery API key saved.");
		return true;
	}

	async #promptLogin(reason: string): Promise<boolean> {
		this.#showMessage(
			[
				"",
				theme.fg("muted", `Smithery authentication required (${reason}).`),
				theme.fg("muted", "If browser auth fails, you can paste an API key."),
				"",
			].join("\n"),
		);
		try {
			return await this.#browserLogin();
		} catch (error) {
			this.ctx.showWarning(`Browser authorization failed: ${errorMessage(error)}. Falling back to API key.`);
			return await this.#loginWithApiKey();
		}
	}

	async #requireApiKey(reason: string): Promise<string> {
		let apiKey = await getSmitheryApiKey();
		if (apiKey) return apiKey;

		const loggedIn = await this.#promptLogin(reason);
		if (!loggedIn) {
			throw new Error("Smithery login cancelled. Run /mcp smithery-login, then retry /mcp smithery-search.");
		}

		apiKey = await getSmitheryApiKey();
		if (!apiKey) {
			throw new Error("Smithery API key not found after login.");
		}
		return apiKey;
	}

	/** Run `operation` with the cached API key, logging in again once when the registry rejects it. */
	async #withAuthRetry<T>(operation: (apiKey: string) => Promise<T>, reason: string): Promise<T> {
		const apiKey = await this.#requireApiKey(reason);
		try {
			return await operation(apiKey);
		} catch (error) {
			if (!(error instanceof SmitheryRegistryError) || !SMITHERY_AUTH_STATUSES.has(error.status)) throw error;
			const authReason = error.status === 429 ? "rate limited by Smithery" : "forbidden/unauthorized with Smithery";
			if (!(await this.#promptLogin(authReason))) throw error;
			return await operation(await this.#requireApiKey(reason));
		}
	}

	async #promptServerName(defaultName: string): Promise<string | null> {
		for (;;) {
			const input = await this.ctx.showHookInput(`Server name for deploy (default: ${defaultName})`, defaultName);
			if (input === undefined) return null;
			const proposed = input.trim() || defaultName;
			if (!proposed) {
				this.ctx.showError("Server name cannot be empty.");
				continue;
			}
			const filePath = getMCPConfigPath("user", getProjectDir());
			const config = await readMCPConfigFile(filePath);
			if (config.mcpServers?.[proposed]) {
				this.ctx.showError(`Server "${proposed}" already exists in ${shortenPath(filePath)}.`);
				continue;
			}
			return proposed;
		}
	}

	async #promptRequiredInputs(result: SmitherySearchResult): Promise<Record<string, string> | null> {
		const values: Record<string, string> = {};
		for (const input of result.requiredInputs) {
			const label = input.required ? `${input.key} (required)` : `${input.key} (optional)`;
			const prompt = `${label}${input.description ? ` - ${input.description}` : ""}`;
			const userInput = await this.ctx.showHookInput(prompt, input.defaultValue);
			if (userInput === undefined) {
				if (input.required) return null;
				continue;
			}
			const value = userInput.trim();
			if (!value) {
				if (input.required) {
					this.ctx.showError(`Missing required value for "${input.key}".`);
					return null;
				}
				continue;
			}
			values[input.key] = value;
		}
		return values;
	}

	async #pickResult(results: SmitherySearchResult[], keyword: string): Promise<SmitherySearchResult | null> {
		const options = results.map((result, index) => {
			const label = `${index + 1}. ${result.display.displayName} (${result.display.transport}, uses ${result.display.useCount})`;
			return label.length > 120 ? `${label.slice(0, 117)}...` : label;
		});
		const selected = await this.ctx.showHookSelector(`Registry results for "${keyword}"`, options);
		if (!selected) return null;
		const prefix = selected.split(".", 1)[0];
		const index = Number(prefix) - 1;
		if (!Number.isInteger(index) || index < 0 || index >= results.length) return null;
		return results[index] ?? null;
	}

	async #deploy(result: SmitherySearchResult): Promise<void> {
		const baseName = toConfigName(result.name);
		const defaultName = await nextAvailableServerName(baseName);
		const serverName = await this.#promptServerName(defaultName);
		if (!serverName) {
			this.ctx.showStatus("MCP deploy cancelled.");
			return;
		}
		const inputValues = await this.#promptRequiredInputs(result);
		if (inputValues === null) {
			this.ctx.showStatus("MCP deploy cancelled.");
			return;
		}
		const config = applyRegistryInputOverrides(result.config, inputValues);
		await this.addServer(serverName, config);
	}

	#showMessage(text: string): void {
		showCommandMessage(this.ctx, text);
	}
}

async function waitForSmitheryCliApiKey(sessionId: string, signal: AbortSignal): Promise<string> {
	const pollIntervalMs = 2_000;
	const timeoutMs = 300_000;
	const startedAt = Date.now();

	while (!signal.aborted) {
		if (Date.now() - startedAt >= timeoutMs) {
			throw new Error("Smithery authorization timed out after 5 minutes.");
		}
		const response = await pollSmitheryCliAuthSession(sessionId, signal);
		if (response.status === "success" && response.apiKey) {
			return response.apiKey;
		}
		if (response.status === "error") {
			throw new Error(response.message ?? "Smithery authorization failed.");
		}
		await Bun.sleep(pollIntervalMs);
	}

	throw new Error("Smithery authorization cancelled.");
}

async function nextAvailableServerName(baseName: string): Promise<string> {
	const filePath = getMCPConfigPath("user", getProjectDir());
	const config = await readMCPConfigFile(filePath);
	const existingNames = new Set(Object.keys(config.mcpServers ?? {}));
	if (!existingNames.has(baseName)) return baseName;
	for (let i = 2; i <= 999; i++) {
		const candidate = `${baseName}-${i}`;
		if (!existingNames.has(candidate)) return candidate;
	}
	return `${baseName}-${Date.now()}`;
}

function applyRegistryInputOverrides(config: MCPServerConfig, values: Record<string, string>): MCPServerConfig {
	if (Object.keys(values).length === 0) return config;
	if (config.type !== "stdio") {
		return config;
	}
	const args = [...(config.args ?? [])];
	const configJson = JSON.stringify(values);
	const index = args.indexOf("--config");
	if (index >= 0) {
		if (index + 1 < args.length) {
			args[index + 1] = configJson;
		} else {
			args.push(configJson);
		}
	} else {
		args.push("--config", configJson);
	}
	return { ...config, args };
}
