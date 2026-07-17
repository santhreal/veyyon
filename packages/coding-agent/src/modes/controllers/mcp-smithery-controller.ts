/**
 * Smithery registry lane for the /mcp command controller: login/logout,
 * auth-retry wrapping for registry operations, result picking, and deploying
 * a registry result into a named server config.
 */
import { getMCPConfigPath, getProjectDir } from "@veyyon/pi-utils";
import { readMCPConfigFile } from "../../mcp/config-writer";
import {
	clearSmitheryApiKey,
	createSmitheryCliAuthSession,
	getSmitheryApiKey,
	getSmitheryLoginUrl,
	pollSmitheryCliAuthSession,
	saveSmitheryApiKey,
} from "../../mcp/smithery-auth";
import { SmitheryConnectError } from "../../mcp/smithery-connect";
import {
	SmitheryRegistryError,
	type SmitherySearchResult,
	searchSmitheryRegistry,
	toConfigName,
} from "../../mcp/smithery-registry";
import type { MCPServerConfig } from "../../mcp/types";
import { openPath } from "../../utils/open";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { type ScopeValue, showCommandMessage } from "./command-controller-shared";

async function validateSmitheryApiKey(apiKey: string): Promise<void> {
	await searchSmitheryRegistry("mcp", { limit: 1, apiKey });
}

async function promptSmitheryApiKey(ctx: InteractiveModeContext, promptLabel: string): Promise<string | null> {
	for (;;) {
		const input = await ctx.showHookInput(promptLabel);
		if (input === undefined) return null;
		const apiKey = input.trim();
		if (!apiKey) {
			ctx.showError("Smithery API key cannot be empty.");
			continue;
		}
		try {
			await validateSmitheryApiKey(apiKey);
			return apiKey;
		} catch (error) {
			ctx.showError(`Smithery API key validation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

async function handleSmitheryLoginWithApiKey(ctx: InteractiveModeContext): Promise<boolean> {
	const apiKey = await promptSmitheryApiKey(ctx, "Smithery API key (Esc to cancel)");
	if (!apiKey) return false;
	await saveSmitheryApiKey(apiKey);
	ctx.showStatus("Smithery API key saved.");
	return true;
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

async function handleSmitheryBrowserLogin(ctx: InteractiveModeContext): Promise<boolean> {
	const session = await createSmitheryCliAuthSession();
	const fallbackLoginUrl = getSmitheryLoginUrl();
	showCommandMessage(
		ctx,
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
	await validateSmitheryApiKey(apiKey);
	await saveSmitheryApiKey(apiKey);
	ctx.showStatus("Smithery API key saved.");
	return true;
}

async function promptSmitheryLogin(ctx: InteractiveModeContext, reason: string): Promise<boolean> {
	showCommandMessage(
		ctx,
		[
			"",
			theme.fg("muted", `Smithery authentication required (${reason}).`),
			theme.fg("muted", "If browser auth fails, you can paste an API key."),
			"",
		].join("\n"),
	);
	try {
		return await handleSmitheryBrowserLogin(ctx);
	} catch (error) {
		ctx.showWarning(
			`Browser authorization failed: ${error instanceof Error ? error.message : String(error)}. Falling back to API key.`,
		);
		return await handleSmitheryLoginWithApiKey(ctx);
	}
}

function getSmitheryErrorStatus(error: unknown): number | undefined {
	if (error instanceof SmitheryRegistryError || error instanceof SmitheryConnectError) {
		return error.status;
	}
	return undefined;
}

function toSmitheryAuthReason(status: number): string {
	return status === 429 ? "rate limited by Smithery" : "forbidden/unauthorized with Smithery";
}

async function requireSmitheryApiKey(ctx: InteractiveModeContext, reason: string): Promise<string> {
	let apiKey = await getSmitheryApiKey();
	if (apiKey) return apiKey;

	const loggedIn = await promptSmitheryLogin(ctx, reason);
	if (!loggedIn) {
		throw new Error("Smithery login cancelled. Run /mcp smithery-login, then retry /mcp smithery-search.");
	}

	apiKey = await getSmitheryApiKey();
	if (!apiKey) {
		throw new Error("Smithery API key not found after login.");
	}
	return apiKey;
}

export async function runSmitheryOperationWithAuthRetry<T>(
	ctx: InteractiveModeContext,
	operation: (apiKey: string) => Promise<T>,
	reason: string,
): Promise<T> {
	const apiKey = await requireSmitheryApiKey(ctx, reason);
	try {
		return await operation(apiKey);
	} catch (error) {
		const status = getSmitheryErrorStatus(error);
		if (status === undefined || ![401, 403, 429].includes(status)) {
			throw error;
		}
		const loggedIn = await promptSmitheryLogin(ctx, toSmitheryAuthReason(status));
		if (!loggedIn) {
			throw error;
		}
		const retryApiKey = await requireSmitheryApiKey(ctx, reason);
		return await operation(retryApiKey);
	}
}

export async function handleSmitheryLogin(ctx: InteractiveModeContext): Promise<void> {
	const ok = await promptSmitheryLogin(ctx, "login");
	if (!ok) {
		ctx.showStatus("Smithery login cancelled.");
	}
}

export async function handleSmitheryLogout(ctx: InteractiveModeContext): Promise<void> {
	const removed = await clearSmitheryApiKey();
	ctx.showStatus(removed ? "Smithery API key removed." : "No cached Smithery API key found.");
}

async function nextAvailableServerName(scope: ScopeValue, baseName: string): Promise<string> {
	const filePath = getMCPConfigPath(scope, getProjectDir());
	const config = await readMCPConfigFile(filePath);
	const existingNames = new Set(Object.keys(config.mcpServers ?? {}));
	if (!existingNames.has(baseName)) return baseName;
	for (let i = 2; i <= 999; i++) {
		const candidate = `${baseName}-${i}`;
		if (!existingNames.has(candidate)) return candidate;
	}
	return `${baseName}-${Date.now()}`;
}

async function promptDeploymentServerName(
	ctx: InteractiveModeContext,
	scope: ScopeValue,
	defaultName: string,
): Promise<string | null> {
	for (;;) {
		const input = await ctx.showHookInput(`Server name for deploy (default: ${defaultName})`, defaultName);
		if (input === undefined) return null;
		const proposed = input.trim() || defaultName;
		if (!proposed) {
			ctx.showError("Server name cannot be empty.");
			continue;
		}
		const filePath = getMCPConfigPath(scope, getProjectDir());
		const config = await readMCPConfigFile(filePath);
		if (config.mcpServers?.[proposed]) {
			ctx.showError(`Server "${proposed}" already exists in ${scope} config.`);
			continue;
		}
		return proposed;
	}
}

async function promptRequiredRegistryInputs(
	ctx: InteractiveModeContext,
	result: SmitherySearchResult,
): Promise<Record<string, string> | null> {
	const values: Record<string, string> = {};
	for (const input of result.requiredInputs) {
		const label = input.required ? `${input.key} (required)` : `${input.key} (optional)`;
		const prompt = `${label}${input.description ? ` - ${input.description}` : ""}`;
		const userInput = await ctx.showHookInput(prompt, input.defaultValue);
		if (userInput === undefined) {
			if (input.required) return null;
			continue;
		}
		const value = userInput.trim();
		if (!value) {
			if (input.required) {
				ctx.showError(`Missing required value for "${input.key}".`);
				return null;
			}
			continue;
		}
		values[input.key] = value;
	}
	return values;
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

export async function pickRegistryResult(
	ctx: InteractiveModeContext,
	results: SmitherySearchResult[],
	keyword: string,
): Promise<SmitherySearchResult | null> {
	const options = results.map((result, index) => {
		const label = `${index + 1}. ${result.display.displayName} (${result.display.transport}, uses ${result.display.useCount})`;
		return label.length > 120 ? `${label.slice(0, 117)}...` : label;
	});
	const selected = await ctx.showHookSelector(`Registry results for "${keyword}"`, options);
	if (!selected) return null;
	const prefix = selected.split(".", 1)[0];
	const index = Number(prefix) - 1;
	if (!Number.isInteger(index) || index < 0 || index >= results.length) return null;
	return results[index] ?? null;
}

/**
 * Deploy a picked registry result: prompt for a server name and any required
 * inputs, then hand the finalized config to `completeAdd` — the caller's
 * wizard-completion path, which owns persistence and connection.
 */
export async function deployRegistryResult(
	ctx: InteractiveModeContext,
	result: SmitherySearchResult,
	scope: ScopeValue,
	completeAdd: (name: string, config: MCPServerConfig, scope: ScopeValue) => Promise<void>,
): Promise<void> {
	const baseName = toConfigName(result.name);
	const defaultName = await nextAvailableServerName(scope, baseName);
	const serverName = await promptDeploymentServerName(ctx, scope, defaultName);
	if (!serverName) {
		ctx.showStatus("MCP deploy cancelled.");
		return;
	}
	const inputValues = await promptRequiredRegistryInputs(ctx, result);
	if (inputValues === null) {
		ctx.showStatus("MCP deploy cancelled.");
		return;
	}
	const config = applyRegistryInputOverrides(result.config, inputValues);
	await completeAdd(serverName, config, scope);
}
