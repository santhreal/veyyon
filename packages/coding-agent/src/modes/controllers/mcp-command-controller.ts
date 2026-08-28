import { type OverlayHandle, Spacer, Text } from "@veyyon/tui";
import { errorMessage, getMCPConfigPath, getProjectDir, isAbortError } from "@veyyon/utils";
import type { SourceMeta } from "../../capability/types";
import { expandEnvVarsDeep, unresolvedRefusedDownstream } from "../../discovery/env-expansion";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	fetchResourceMetadataScopes,
	loadAllMCPConfigs,
	MCPManager,
	type OAuthEndpoints,
} from "../../mcp";
import { connectToServer, disconnectServer, listTools } from "../../mcp/client";
import {
	addMCPServer,
	readDisabledServers,
	readMCPConfigFile,
	removeMCPServer,
	setServerDisabled,
	updateMCPServer,
} from "../../mcp/config-writer";
import {
	lookupMcpOAuthCredentialForServer,
	mcpOAuthCredentialIdsForServerUrl,
	removeManagedMcpOAuthCredential,
	removeManagedMcpOAuthCredentials,
} from "../../mcp/oauth-credentials";
import { MCPOAuthFlow, type MCPStoredOAuthCredential, mcpOAuthCredentialId } from "../../mcp/oauth-flow";
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
import { sanitizeMcpStatusError } from "../../mcp/startup-events";
import type { MCPAuthConfig, MCPServerConfig, MCPServerConnection } from "../../mcp/types";
import { removedOptionMessage } from "../../slash-commands/helpers/parse";
import { shortenPath } from "../../tools/render-utils";
import { copyToClipboard } from "../../utils/clipboard";
import { openPath } from "../../utils/open";
import { MCPAddWizard } from "../components/mcp-add-wizard";
import { TranscriptBlock } from "../components/transcript-container";
import { parseCommandArgs } from "../shared";
import { withIcon } from "../theme/icon-label";
import { theme } from "../theme/theme";
import { groupBySource, showCommandMessage } from "./command-controller-shared";

import {
	MCP_ADD_REMOVED_OPTIONS,
	MCP_ADD_USAGE,
	MCP_MANUAL_INPUT_PROVIDER_ID,
	MCP_MANUAL_LOGIN_TIP,
	MCP_OAUTH_USER_CANCEL_REASON,
	MCP_REMOVE_REMOVED_OPTIONS,
	MCP_REMOVE_USAGE,
	MCP_SEARCH_REMOVED_OPTIONS,
	MCP_SEARCH_USAGE,
	type MCPAddParsed,
	type MCPAddTransport,
	MCPAuthorizationLinkPrompt,
	MCPOAuthCancelledError,
	type MCPSearchParsed,
	type McpCommandControllerContext,
	McpConnectingBlock,
	type OAuthFlowResult,
	raceAbortSignal,
	withTimeout,
} from "./mcp-command-controller-helpers";

export {
	MCPAuthorizationLinkPrompt,
	MCPOAuthCancelledError,
	type McpCommandControllerContext,
} from "./mcp-command-controller-helpers";

export class MCPCommandController {
	constructor(private ctx: McpCommandControllerContext) {}

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
			case "test":
				await this.#handleTest(parts[2]);
				break;
			case "reauth":
				await this.#handleReauth(parts[2]);
				break;
			case "unauth":
				await this.#handleUnauth(parts[2]);
				break;
			case "enable":
				await this.#handleSetEnabled(parts[2], true);
				break;
			case "disable":
				await this.#handleSetEnabled(parts[2], false);
				break;
			case "resources":
				await this.#handleResources();
				break;
			case "prompts":
				await this.#handlePrompts();
				break;
			case "notifications":
				await this.#handleNotifications();
				break;
			case "smithery-search":
				await this.#handleSearch(text);
				break;
			case "smithery-login":
				await this.#handleSmitheryLogin();
				break;
			case "smithery-logout":
				await this.#handleSmitheryLogout();
				break;
			case "reconnect":
				await this.#handleReconnect(parts[2]);
				break;
			case "reload":
				await this.#handleReload();
				break;
			default:
				this.ctx.showError(`Unknown subcommand: ${subcommand}. Type /mcp help for usage.`);
		}
	}

	#showHelp(): void {
		const helpText = [
			"",
			theme.bold("MCP Server Management"),
			"",
			"Manage Model Context Protocol (MCP) servers for external tool integrations.",
			"",
			theme.fg("accent", "Commands:"),
			"  /mcp add              Add a new MCP server (interactive wizard)",
			`  ${MCP_ADD_USAGE.replace("Usage: ", "")}`,
			"  /mcp list             List all configured MCP servers",
			"  /mcp remove <name>    Remove an MCP server",
			"  /mcp test <name>      Test connection to an MCP server",
			"  /mcp reauth <name>    Reauthorize OAuth for an MCP server",
			"  /mcp unauth <name>    Remove OAuth auth from an MCP server",
			"  /mcp enable <name>    Enable an MCP server",
			"  /mcp disable <name>   Disable an MCP server",
			`  ${MCP_SEARCH_USAGE.replace("Usage: ", "")}`,
			"                        Search Smithery registry and deploy from picker",
			"  /mcp smithery-login   Login to Smithery and cache API key",
			"  /mcp smithery-logout  Remove cached Smithery API key",
			"  /mcp reconnect <name> Reconnect to a specific MCP server",
			"  /mcp reload           Force reload and rediscover MCP runtime tools",
			"  /mcp resources        List available resources from connected servers",
			"  /mcp prompts          List available prompts from connected servers",
			"  /mcp notifications    Show notification capabilities and subscription state",
			"  /mcp help             Show this help message",
			"",
		].join("\n");

		this.#showMessage(helpText);
	}

	#parseAddCommand(text: string): MCPAddParsed {
		const prefixMatch = text.match(/^\/mcp\s+add\b\s*(.*)$/i);
		const tokens = parseCommandArgs(prefixMatch?.[1]?.trim() ?? "");
		if (tokens.length === 0) return {};

		const name = tokens[0];
		if (name.startsWith("-")) return { error: removedOptionMessage(name, MCP_ADD_REMOVED_OPTIONS, MCP_ADD_USAGE) };

		let url: string | undefined;
		let transport: MCPAddTransport = "http";
		let authToken: string | undefined;
		let commandTokens: string[] | undefined;

		const seen = new Set<string>();
		let index = 1;
		while (index < tokens.length) {
			const token = tokens[index];
			if (token.startsWith("-") || token === "project" || token === "user") {
				return { error: removedOptionMessage(token, MCP_ADD_REMOVED_OPTIONS, MCP_ADD_USAGE) };
			}
			let word: string;
			if (token === "run") {
				commandTokens = tokens.slice(index + 1);
				word = "run";
				index = tokens.length;
			} else if (token === "url" || token === "token") {
				const value = tokens[index + 1];
				if (!value) return { error: `Missing value after \`${token}\`.\n${MCP_ADD_USAGE}` };
				if (token === "url") url = value;
				else authToken = value;
				word = token;
				index += 2;
			} else if (token === "http" || token === "sse") {
				transport = token;
				word = "transport";
				index += 1;
			} else {
				return { error: `Unknown argument: ${token}\n${MCP_ADD_USAGE}` };
			}
			if (seen.has(word)) return { error: `\`${word}\` given twice.\n${MCP_ADD_USAGE}` };
			seen.add(word);
		}

		const hasCommand = Boolean(commandTokens && commandTokens.length > 0);
		if (!url && !hasCommand) {
			return { initialName: name };
		}
		if (url && hasCommand) {
			return { error: "Use either `url <url>` or `run <command...>`, not both." };
		}
		if (authToken && !url) {
			return { error: "`token` requires `url` (HTTP/SSE transport)." };
		}

		if (commandTokens && commandTokens.length > 0) {
			const [command, ...args] = commandTokens;
			const config: MCPServerConfig = {
				type: "stdio",
				command,
				args: args.length > 0 ? args : undefined,
			};
			return { initialName: name, quickConfig: config, isCommandQuickAdd: true };
		}

		const useHttpTransport = transport === "http";
		let normalizedUrl = url!;
		if (!/^https?:\/\//i.test(normalizedUrl)) {
			normalizedUrl = `https://${normalizedUrl}`;
		}
		const config: MCPServerConfig = {
			type: useHttpTransport ? "http" : "sse",
			url: normalizedUrl,
			headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
		};
		return {
			initialName: name,
			quickConfig: config,
			isCommandQuickAdd: false,
			hasAuthToken: Boolean(authToken),
		};
	}

	#parseSearchCommand(text: string): MCPSearchParsed {
		const prefixMatch = text.match(/^\/mcp\s+smithery-search\b\s*(.*)$/i);
		const tokens = parseCommandArgs(prefixMatch?.[1]?.trim() ?? "");
		const base: MCPSearchParsed = { keyword: "", limit: 20, semantic: false };
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
			const token = tokens[end - 1];
			if (token === "project" || token === "user") {
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

	async #handleAdd(text: string): Promise<void> {
		const parsed = this.#parseAddCommand(text);
		if (parsed.error) {
			this.ctx.showError(parsed.error);
			return;
		}
		if (parsed.quickConfig && parsed.initialName) {
			let finalConfig = parsed.quickConfig;

			if (!parsed.isCommandQuickAdd && (finalConfig.type === "http" || finalConfig.type === "sse")) {
				try {
					await this.#handleTestConnection(finalConfig);
				} catch (error) {
					if (parsed.hasAuthToken) {
						this.ctx.showError(`Authentication failed for "${parsed.initialName}": ${errorMessage(error)}`);
						return;
					}
					const authResult = analyzeAuthError(error as Error, finalConfig.url);
					if (authResult.requiresAuth) {
						let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
						if (!oauth && finalConfig.url) {
							try {
								oauth = await discoverOAuthEndpoints(
									finalConfig.url,
									authResult.authServerUrl,
									authResult.resourceMetadataUrl,
									{ protectedScopes: authResult.scopes },
								);
							} catch {}
						}
						if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
							const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
							if (scopes) oauth = { ...oauth, scopes };
						}

						if (!oauth) {
							this.ctx.showError(
								`Authentication required for "${parsed.initialName}", but OAuth endpoints could not be discovered. ` +
									`Use /mcp add ${parsed.initialName} (wizard) or configure auth manually.`,
							);
							return;
						}

						try {
							const oauthResource = oauth.resource ?? finalConfig.url;
							const oauthResourceIsFallback = !oauth.resource;
							const oauthResult = await this.#handleOAuthFlow(
								oauth.authorizationUrl,
								oauth.tokenUrl,
								oauth.clientId ?? finalConfig.oauth?.clientId ?? "",
								finalConfig.oauth?.clientSecret ?? "",
								oauth.scopes ?? "",
								{
									callbackPort: finalConfig.oauth?.callbackPort,
									callbackPath: finalConfig.oauth?.callbackPath,
									redirectUri: finalConfig.oauth?.redirectUri,
									prompt: finalConfig.oauth?.prompt,
									registrationUrl: oauth.registrationUrl,
									serverUrl: finalConfig.url,
									resource: oauthResource,
									stripSameOriginResource: oauthResourceIsFallback,
								},
							);
							finalConfig = this.#persistOAuthResult(finalConfig, oauthResult, {
								tokenUrl: oauth.tokenUrl,
								resource: oauthResource,
								stripSameOriginResource: oauthResourceIsFallback,
								clientId: oauth.clientId,
								userClientSecret: finalConfig.oauth?.clientSecret,
							});
						} catch (oauthError) {
							if (oauthError instanceof MCPOAuthCancelledError) {
								this.ctx.showStatus(`Add cancelled for "${parsed.initialName}"`);
								return;
							}
							this.ctx.showError(`OAuth flow failed for "${parsed.initialName}": ${errorMessage(oauthError)}`);
							return;
						}
					}
				}
			}

			await this.#handleWizardComplete(parsed.initialName, finalConfig);
			return;
		}

		let overlayHandle: OverlayHandle | undefined;
		let card: MCPAddWizard | undefined;
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			card?.dispose();
			overlayHandle?.hide();
			this.ctx.ui.setFocus(this.ctx.editorContainer.children[0] ?? this.ctx.editor);
			this.ctx.ui.requestRender();
		};

		const wizard = new MCPAddWizard(
			async (name: string, config: MCPServerConfig) => {
				done();
				await this.#handleWizardComplete(name, config);
			},
			() => {
				done();
				this.#handleWizardCancel();
			},
			async (authUrl: string, tokenUrl: string, clientId: string, clientSecret: string, scopes: string, options) => {
				return await this.#handleOAuthFlow(authUrl, tokenUrl, clientId, clientSecret, scopes, options);
			},
			async (config: MCPServerConfig) => {
				return await this.#handleTestConnection(config);
			},
			() => {
				this.ctx.ui.requestRender();
			},
			parsed.initialName,
		);

		card = wizard;
		wizard.setOnRequestRender(() => this.ctx.ui.requestRender());
		overlayHandle = this.ctx.ui.showOverlay(wizard, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ctx.ui.setFocus(wizard);
		this.ctx.ui.requestRender();
	}

	async #handleOAuthFlow(
		authUrl: string,
		tokenUrl: string,
		clientId: string,
		clientSecret: string,
		scopes: string,
		opts?: {
			callbackPort?: number;
			callbackPath?: string;
			redirectUri?: string;
			prompt?: string;
			serverUrl?: string;
			registrationUrl?: string;
			resource?: string;
			stripSameOriginResource?: boolean;
			abortSignal?: AbortSignal;
		},
	): Promise<OAuthFlowResult> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		let parsedAuthUrl: URL;

		try {
			parsedAuthUrl = new URL(authUrl);
			new URL(tokenUrl);
		} catch (_error) {
			throw new Error(
				`Invalid OAuth URLs. Please check:\n  Authorization URL: ${authUrl}\n  Token URL: ${tokenUrl}`,
			);
		}

		const resolvedClientId = clientId.trim() || parsedAuthUrl.searchParams.get("client_id") || undefined;
		const resolvedClientSecret = clientSecret.trim() || undefined;

		const manualInput = this.ctx.oauthManualInput;
		if (manualInput.hasPending()) {
			const pendingProvider = manualInput.pendingProviderId ?? "another provider";
			throw new Error(
				`OAuth login already in progress for ${pendingProvider}. Complete or cancel it before starting MCP OAuth.`,
			);
		}
		let manualInputClaim: { promise: Promise<string>; clear: (reason?: string) => void } | undefined;
		const oauthTimeout = new AbortController();

		let userCancelled = false;
		const requestUserCancel = (reason: string): void => {
			userCancelled = true;
			if (!oauthTimeout.signal.aborted) oauthTimeout.abort(reason);
		};
		const originalOnEscape = this.ctx.editor.onEscape;
		this.ctx.editor.onEscape = () => requestUserCancel(MCP_OAUTH_USER_CANCEL_REASON);
		const externalSignal = opts?.abortSignal;
		const onExternalAbort = (): void => {
			const reason = externalSignal?.reason;
			requestUserCancel(typeof reason === "string" ? reason : MCP_OAUTH_USER_CANCEL_REASON);
		};
		if (externalSignal?.aborted) {
			onExternalAbort();
		} else {
			externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
		}
		try {
			const flow = new MCPOAuthFlow(
				{
					authorizationUrl: authUrl,
					tokenUrl: tokenUrl,
					registrationUrl: opts?.registrationUrl,
					clientId: resolvedClientId,
					clientSecret: resolvedClientSecret,
					scopes: scopes || undefined,
					prompt: opts?.prompt,
					redirectUri: opts?.redirectUri,
					callbackPort: opts?.callbackPort,
					callbackPath: opts?.callbackPath,
					resource: opts?.resource,
					stripSameOriginResource: opts?.stripSameOriginResource,
				},
				{
					onAuth: (info: { url: string; launchUrl?: string; instructions?: string }) => {
						const block = new TranscriptBlock();
						this.ctx.present(block);
						block.addChild(new Text(theme.fg("accent", "━━━ OAuth Authorization Required ━━━"), 1, 0));
						block.addChild(new Spacer(1));
						block.addChild(new Text(theme.fg("muted", "Preparing browser authorization..."), 1, 0));
						block.addChild(new Spacer(1));
						block.addChild(
							new Text(
								theme.fg("muted", "Waiting for authorization... (Press Esc to cancel, 5 minute timeout)"),
								1,
								0,
							),
						);
						block.addChild(new Text(theme.fg("muted", MCP_MANUAL_LOGIN_TIP), 1, 0));
						block.addChild(new Spacer(1));
						block.addChild(new Text(theme.fg("accent", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"), 1, 0));

						openPath(info.url);
						void copyToClipboard(info.url).catch(() => {});
						block.addChild(new Spacer(1));
						block.addChild(new Text(theme.fg("success", "→ Attempting to open browser..."), 1, 0));
						block.addChild(new Spacer(1));
						block.addChild(new Text(theme.fg("muted", "Alternative if browser did not open:"), 1, 0));
						block.addChild(new MCPAuthorizationLinkPrompt(info.url, info.launchUrl));
						this.ctx.ui.requestRender();
					},
					onProgress: (message: string) => {
						this.ctx.present([new Spacer(1), new Text(theme.fg("muted", message), 1, 0)]);
					},
					onManualCodeInput: () => {
						if (manualInputClaim) return manualInputClaim.promise;
						const pendingInput = manualInput.tryClaimInput(MCP_MANUAL_INPUT_PROVIDER_ID);
						if (!pendingInput) {
							const pendingProvider = manualInput.pendingProviderId ?? "another provider";
							throw new Error(
								`OAuth login already in progress for ${pendingProvider}. Complete or cancel it before starting MCP OAuth.`,
							);
						}
						manualInputClaim = pendingInput;
						return pendingInput.promise;
					},
					signal: oauthTimeout.signal,
				},
			);

			const createAbortError = (): Error => {
				const reason = String(oauthTimeout.signal.reason ?? "MCP OAuth flow aborted");
				return userCancelled ? new MCPOAuthCancelledError() : new Error(reason);
			};
			if (oauthTimeout.signal.aborted) throw createAbortError();

			const credentials = await withTimeout(
				raceAbortSignal(flow.login(), oauthTimeout.signal, createAbortError),
				5 * 60 * 1000,
				"OAuth flow timed out after 5 minutes",
				() => oauthTimeout.abort("MCP OAuth flow timed out"),
			);

			this.ctx.present([
				new Spacer(1),
				new Text(theme.fg("success", "ok Authorization completed in browser."), 1, 0),
			]);

			const credentialId = opts?.serverUrl
				? mcpOAuthCredentialId(opts.serverUrl)
				: `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

			// refresh must work for configs that carry no auth block at all.
			const oauthCredential: MCPStoredOAuthCredential = {
				type: "oauth",
				...credentials,
				tokenUrl,
				clientId: flow.resolvedClientId ?? resolvedClientId,
				clientSecret: flow.registeredClientSecret ?? resolvedClientSecret,
				resource: flow.resource,
				authorizationUrl: flow.authorizationUrl,
			};

			await authStorage.set(credentialId, oauthCredential);

			return {
				credentialId,
				clientId: flow.resolvedClientId,
				resource: flow.resource,
			};
		} catch (error) {
			if (userCancelled) {
				throw new MCPOAuthCancelledError();
			}

			const errorMsg = errorMessage(error);

			if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
				throw new Error("OAuth flow timed out. Please try again.");
			} else if (errorMsg.includes("403") || errorMsg.includes("unauthorized")) {
				throw new Error("OAuth authorization failed. Please check your client credentials.");
			} else if (errorMsg.includes("invalid_grant")) {
				throw new Error("OAuth authorization code is invalid or expired. Please try again.");
			} else if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("fetch failed")) {
				throw new Error("Could not connect to OAuth server. Please check the URLs and your network connection.");
			} else {
				throw new Error(`OAuth authentication failed: ${errorMsg}`);
			}
		} finally {
			this.ctx.editor.onEscape = originalOnEscape;
			externalSignal?.removeEventListener("abort", onExternalAbort);
			manualInputClaim?.clear("Manual MCP OAuth input cleared");
		}
	}

	#persistOAuthResult(
		config: MCPServerConfig,
		result: OAuthFlowResult,
		opts: {
			tokenUrl: string;
			resource?: string;
			stripSameOriginResource?: boolean;
			clientId?: string;
			userClientSecret?: string;
		},
	): MCPServerConfig {
		const clientId = result.clientId ?? opts.clientId ?? config.oauth?.clientId;
		const resource =
			result.resource ?? (opts.stripSameOriginResource ? undefined : opts.resource) ?? config.auth?.resource;
		return {
			...config,
			auth: {
				type: "oauth",
				credentialId: result.credentialId,
				tokenUrl: opts.tokenUrl,
				clientId,
				clientSecret: opts.userClientSecret,
				resource,
			},
			oauth: {
				...config.oauth,
				clientId,
			},
		};
	}

	async #handleTestConnection(config: MCPServerConfig, options?: { oauth?: boolean }): Promise<void> {
		const testName = `test_${Date.now()}`;
		let resolvedConfig: MCPServerConfig;
		if (this.ctx.mcpManager) {
			resolvedConfig = await this.ctx.mcpManager.prepareConfig(config, options);
		} else {
			const tempManager = new MCPManager(getProjectDir());
			tempManager.setAuthStorage(this.ctx.session.modelRegistry.authStorage);
			resolvedConfig = await tempManager.prepareConfig(config, options);
		}

		const connection = await connectToServer(testName, resolvedConfig);
		await disconnectServer(connection);
	}

	async #findConfiguredServer(
		name: string,
	): Promise<{ filePath: string; scope: "user"; config: MCPServerConfig } | null> {
		const userPath = getMCPConfigPath("user", getProjectDir());
		const userConfig = await readMCPConfigFile(userPath);
		const config = userConfig.mcpServers?.[name];
		if (!config) return null;
		return { filePath: userPath, scope: "user", config };
	}

	async #resolveServerForAuth(name: string): Promise<{
		filePath: string;
		scope: "user";
		config: MCPServerConfig;
		discovered: boolean;
	} | null> {
		const found = await this.#findConfiguredServer(name);
		if (found) return { ...found, discovered: false };

		const config = this.ctx.mcpManager?.getServerConfig(name);
		const source = this.ctx.mcpManager?.getSource(name);
		if (!config || !source) return null;

		return {
			filePath: getMCPConfigPath("user", getProjectDir()),
			scope: "user",
			config,
			discovered: true,
		};
	}

	#stripOAuthAuth(config: MCPServerConfig): MCPServerConfig {
		const next = { ...config } as MCPServerConfig & { auth?: MCPAuthConfig };
		delete next.auth;
		return next;
	}

	async #resolveOAuthEndpointsFromServer(config: MCPServerConfig): Promise<OAuthEndpoints> {
		if (config.type !== "http" && config.type !== "sse") {
			const remoteUrl = config.args?.find(arg => /^https?:\/\//.test(arg));
			const httpHint = `{ "type": "http", "url": ${JSON.stringify(remoteUrl ?? "<remote url>")} }`;
			const usesMcpRemote = [config.command, ...(config.args ?? [])].some(part => part?.includes("mcp-remote"));
			throw new Error(
				usesMcpRemote
					? `this server proxies OAuth through mcp-remote, which caches tokens machine-wide in ~/.mcp-auth (shared across every Veyyon profile). Clear ~/.mcp-auth to force a fresh login, or replace the proxy with ${httpHint} so Veyyon manages OAuth per profile.`
					: `stdio servers manage their own credentials, so Veyyon has no OAuth to reauthorize. If the service supports OAuth over HTTP, configure it as ${httpHint} instead.`,
			);
		}
		let connectionSucceeded = false;
		let connectionError: Error | undefined;
		try {
			await this.#handleTestConnection(this.#stripOAuthAuth(config), { oauth: false });
			connectionSucceeded = true;
		} catch (error) {
			connectionError = error as Error;
		}

		if (connectionSucceeded) {
			throw new Error("Server connection succeeded without OAuth; reauthorization is not required.");
		}

		const authResult = analyzeAuthError(connectionError!, "url" in config ? config.url : undefined);
		let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;

		if (!oauth && (config.type === "http" || config.type === "sse") && config.url) {
			oauth = await discoverOAuthEndpoints(config.url, authResult.authServerUrl, authResult.resourceMetadataUrl, {
				protectedScopes: authResult.scopes,
			});
		}
		if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
			const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
			if (scopes) oauth = { ...oauth, scopes };
		}

		if (!oauth) {
			throw new Error("Could not discover OAuth endpoints from server response.");
		}

		return oauth;
	}

	async #waitForServerConnectionWithAnimation(
		name: string,
		options?: { suppressDisconnectedWarning?: boolean },
	): Promise<"connected" | "connecting" | "disconnected"> {
		if (!this.ctx.mcpManager) return "disconnected";

		const block = new McpConnectingBlock(name);
		this.ctx.present(block);

		try {
			try {
				await withTimeout(this.ctx.mcpManager.waitForConnection(name), 10_000, "Connection still pending");
			} catch {}
			const state = this.ctx.mcpManager.getConnectionStatus(name);
			if (state === "connected") {
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
			}
			if (state === "connected") {
				block.setStatus(theme.fg("success", `${theme.status.enabled} Connected to "${name}"`));
			} else if (state === "connecting") {
				block.setStatus(theme.fg("muted", `${theme.status.connecting} "${name}" is still connecting...`));
			} else {
				block.setStatus(
					options?.suppressDisconnectedWarning
						? theme.fg("muted", `${theme.status.connecting} Connection check complete for "${name}"`)
						: theme.fg("warning", `warn Could not connect to "${name}" yet`),
				);
			}
			return state;
		} finally {
			block.finish();
		}
	}

	async #syncManagerConnection(name: string, config: MCPServerConfig): Promise<void> {
		if (!this.ctx.mcpManager) return;
		if (this.ctx.mcpManager.getConnectionStatus(name) !== "disconnected") return;
		await this.ctx.mcpManager.connectServers({ [name]: config }, {});
		if (this.ctx.mcpManager.getConnectionStatus(name) === "connected") {
			await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
		}
	}

	async #handleWizardComplete(name: string, config: MCPServerConfig): Promise<void> {
		try {
			const filePath = getMCPConfigPath("user", getProjectDir());

			await addMCPServer(filePath, name, config);

			await this.#reloadMCP();
			const state =
				config.enabled === false
					? "disconnected"
					: await this.#waitForServerConnectionWithAnimation(name, { suppressDisconnectedWarning: true });
			let isConnected = state === "connected";
			const isConnecting = state === "connecting";

			if (!isConnected && !isConnecting && config.enabled !== false) {
				try {
					await this.#handleTestConnection(config);
					isConnected = true;
					await this.#syncManagerConnection(name, config);
				} catch {}
			}

			if (isConnected && this.ctx.mcpManager) {
				const serverTools = this.ctx.mcpManager.getTools().filter(t => t.mcpServerName === name);
				if (serverTools.length > 0) {
					const currentActive = this.ctx.session.getActiveToolNames();
					const toActivate = serverTools.map(t => t.name).filter(n => this.ctx.session.getToolByName(n));
					if (toActivate.length > 0) {
						await this.ctx.session.setActiveToolsByName(Array.from(new Set(currentActive.concat(toActivate))));
					}
				}
			}

			const lines = ["", theme.fg("success", `+ Added server "${name}" to ${shortenPath(filePath)}`), ""];

			if (isConnected) {
				lines.push(theme.fg("success", `${theme.status.enabled} Successfully connected to server`));
				lines.push("");
			} else if (isConnecting) {
				lines.push(theme.fg("muted", `${theme.status.connecting} Server is connecting in background...`));
				lines.push(theme.fg("muted", `  Run ${theme.fg("accent", `/mcp test ${name}`)} in a few seconds.`));
				lines.push("");
			} else {
				lines.push(theme.fg("warning", `warn Server added but not yet connected`));
				lines.push(theme.fg("muted", `  Run ${theme.fg("accent", `/mcp test ${name}`)} to test the connection.`));
				lines.push("");
			}

			lines.push(theme.fg("muted", `Run ${theme.fg("accent", "/mcp list")} to see all configured servers.`));
			lines.push("");

			this.#showMessage(lines.join("\n"));
		} catch (error) {
			const errorMsg = errorMessage(error);

			let helpText = "";
			if (errorMsg.includes("EACCES") || errorMsg.includes("permission denied")) {
				helpText = "\n\nTip: Check file permissions for the config directory.";
			} else if (errorMsg.includes("ENOSPC")) {
				helpText = "\n\nTip: Insufficient disk space.";
			} else if (errorMsg.includes("already exists")) {
				helpText = `\n\nTip: Use ${theme.fg("accent", "/mcp list")} to see existing servers.`;
			}

			this.ctx.showError(`Failed to add server: ${errorMsg}${helpText}`);
		}
	}

	#handleWizardCancel(): void {
		this.#showMessage(
			[
				"",
				theme.fg("muted", "Server creation cancelled."),
				"",
				theme.fg("dim", "Tip: Press Ctrl+C or Esc anytime to cancel"),
				"",
			].join("\n"),
		);
	}

	#serverStatusRows(name: string, state: string, type?: string): string[] {
		const status =
			state === "inactive"
				? theme.fg("warning", ` ${theme.status.connecting} inactive`)
				: state === "connected"
					? theme.fg("success", ` ${theme.status.active} connected`)
					: state === "connecting"
						? theme.fg("muted", ` ${theme.status.connecting} connecting`)
						: theme.fg("muted", ` ${theme.status.shadowed} not connected`);
		const typeTag = type ? ` ${theme.fg("dim", `[${type}]`)}` : "";
		const rows = [`  ${theme.fg("accent", name)}${status}${typeTag}`];
		if (state === "disconnected" || state === "not connected") {
			const err = this.ctx.mcpManager?.getLastError(name);
			if (err) rows.push(`      ${theme.fg("dim", sanitizeMcpStatusError(err))}`);
		}
		return rows;
	}

	async #handleList(): Promise<void> {
		try {
			const userPath = getMCPConfigPath("user", getProjectDir());
			const userPathLabel = shortenPath(userPath);
			const userConfig = await readMCPConfigFile(userPath);

			const userServers = Object.keys(userConfig.mcpServers ?? {});

			const configServerNames = new Set(userServers);
			const disabledServerNames = new Set(await readDisabledServers(userPath));
			const discoveredServers: { name: string; source: SourceMeta }[] = [];
			if (this.ctx.mcpManager) {
				for (const name of this.ctx.mcpManager.getAllServerNames()) {
					if (configServerNames.has(name)) continue;
					if (disabledServerNames.has(name)) continue;
					const source = this.ctx.mcpManager.getSource(name);
					if (source) {
						discoveredServers.push({ name, source });
					}
				}
			}

			if (userServers.length === 0 && discoveredServers.length === 0 && disabledServerNames.size === 0) {
				this.#showMessage(
					[
						"",
						theme.fg("muted", "No MCP servers configured."),
						"",
						`Use ${theme.fg("accent", "/mcp add")} to add a server.`,
						"",
					].join("\n"),
				);
				return;
			}

			const lines: string[] = ["", theme.bold("Configured MCP Servers"), ""];

			if (userServers.length > 0) {
				lines.push(theme.fg("accent", "User level") + theme.fg("muted", ` (${userPathLabel}):`));
				for (const name of userServers) {
					const config = userConfig.mcpServers![name];
					const type = config.type ?? "stdio";
					const state =
						config.enabled === false
							? "inactive"
							: (this.ctx.mcpManager?.getConnectionStatus(name) ?? "disconnected");
					const ss = this.#serverStatusRows(name, state, type);
					for (let li = 0; li < ss.length; li++) lines.push(ss[li]!);
				}
				lines.push("");
			}

			if (discoveredServers.length > 0) {
				for (const { providerName, shortPath, items: entries } of groupBySource(discoveredServers, e => e.source)) {
					lines.push(theme.fg("accent", providerName) + theme.fg("muted", ` (${shortPath}):`));
					for (const { name } of entries) {
						const state = this.ctx.mcpManager!.getConnectionStatus(name);
						const ss = this.#serverStatusRows(name, state);
						for (let li = 0; li < ss.length; li++) lines.push(ss[li]!);
					}
					lines.push("");
				}
			}

			const relevantDisabled = Array.from(disabledServerNames).filter(n => !configServerNames.has(n));
			if (relevantDisabled.length > 0) {
				lines.push(theme.fg("accent", "Disabled") + theme.fg("muted", " (discovered servers):"));
				for (const name of relevantDisabled) {
					lines.push(
						`  ${theme.fg("accent", name)}${theme.fg("warning", ` ${theme.status.connecting} disabled`)}`,
					);
				}
				lines.push("");
			}
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.ctx.showError(`Failed to list servers: ${errorMessage(error)}`);
		}
	}

	async #handleRemove(text: string): Promise<void> {
		const match = text.match(/^\/mcp\s+(?:remove|rm)\b\s*(.*)$/i);
		const rest = match?.[1]?.trim() ?? "";
		let name: string | undefined;
		for (const token of parseCommandArgs(rest)) {
			if (token.startsWith("-") || (name !== undefined && (token === "project" || token === "user"))) {
				this.ctx.showError(removedOptionMessage(token, MCP_REMOVE_REMOVED_OPTIONS, MCP_REMOVE_USAGE));
				return;
			}
			if (name !== undefined) {
				this.ctx.showError(`Unknown argument: ${token}\n${MCP_REMOVE_USAGE}`);
				return;
			}
			name = token;
		}

		if (!name) {
			this.ctx.showError(`Server name required.\n${MCP_REMOVE_USAGE}`);
			return;
		}

		try {
			const filePath = getMCPConfigPath("user", getProjectDir());
			const config = await readMCPConfigFile(filePath);
			if (!config.mcpServers?.[name]) {
				this.ctx.showError(`Server "${name}" not found in ${shortenPath(filePath)}.`);
				return;
			}

			if (this.ctx.mcpManager?.getConnection(name)) {
				await this.ctx.mcpManager.disconnectServer(name);
			}

			await removeMCPServer(filePath, name);

			await this.#reloadMCP();

			this.#showMessage(
				["", theme.fg("success", `- Removed server "${name}" from ${shortenPath(filePath)}`), ""].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(`Failed to remove server: ${errorMessage(error)}`);
		}
	}

	async #handleTest(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp test <name>");
			return;
		}

		const originalOnEscape = this.ctx.editor.onEscape;
		const abortController = new AbortController();
		this.ctx.editor.onEscape = () => {
			abortController.abort();
		};

		let connection: MCPServerConnection | undefined;
		try {
			const found = await this.#resolveServerForAuth(name);

			if (!found) {
				this.ctx.showError(
					`Server "${name}" not found.\n\nTip: Run ${theme.fg("accent", "/mcp list")} to see available servers.`,
				);
				return;
			}

			const { config } = found;
			if (config.enabled === false) {
				this.ctx.showError(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
				return;
			}

			this.#showMessage(
				["", theme.fg("muted", `Testing connection to "${name}"... (esc to cancel)`), ""].join("\n"),
			);

			let resolvedConfig: MCPServerConfig;
			if (this.ctx.mcpManager) {
				resolvedConfig = await this.ctx.mcpManager.prepareConfig(config);
			} else {
				const tempManager = new MCPManager(getProjectDir());
				tempManager.setAuthStorage(this.ctx.session.modelRegistry.authStorage);
				resolvedConfig = await tempManager.prepareConfig(config);
			}

			connection = await connectToServer(name, resolvedConfig, { signal: abortController.signal });

			const tools = await listTools(connection, { signal: abortController.signal });

			const lines = [
				"",
				theme.fg("success", `${theme.status.enabled} Successfully connected to "${name}"`),
				"",
				`  Server: ${connection.serverInfo.name} v${connection.serverInfo.version}`,
				`  Tools: ${tools.length}`,
			];

			if (tools.length > 0 && tools.length <= 10) {
				lines.push("");
				lines.push("  Available tools:");
				for (const tool of tools) {
					lines.push(`    • ${tool.name}`);
				}
			}

			lines.push("");
			await this.#syncManagerConnection(name, config);
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			if (abortController.signal.aborted || isAbortError(error)) {
				this.ctx.showStatus(`Cancelled MCP test for "${name}"`);
				return;
			}

			const errorMsg = errorMessage(error);

			let helpText = "";
			if (errorMsg.includes("ENOENT") || errorMsg.includes("not found")) {
				helpText = "\n\nTip: Check that the command or URL is correct.";
			} else if (errorMsg.includes("EACCES")) {
				helpText = "\n\nTip: Check file/command permissions.";
			} else if (errorMsg.includes("ECONNREFUSED")) {
				helpText = "\n\nTip: Check that the server is running and the URL/port is correct.";
			} else if (errorMsg.includes("timeout")) {
				helpText = "\n\nTip: The server may be slow or unresponsive. Try increasing the timeout.";
			} else if (errorMsg.includes("401") || errorMsg.includes("403")) {
				helpText = "\n\nTip: Check your authentication credentials.";
			}

			this.ctx.showError(`Failed to connect to "${name}": ${errorMsg}${helpText}`);
		} finally {
			this.ctx.editor.onEscape = originalOnEscape;
			if (connection) {
				void disconnectServer(connection);
			}
		}
	}

	async #handleSetEnabled(name: string | undefined, enabled: boolean): Promise<void> {
		if (!name) {
			this.ctx.showError(`Server name required. Usage: /mcp ${enabled ? "enable" : "disable"} <name>`);
			return;
		}

		try {
			const found = await this.#findConfiguredServer(name);
			if (!found) {
				const userConfigPath = getMCPConfigPath("user", getProjectDir());
				const disabledServers = new Set(await readDisabledServers(userConfigPath));
				const isDiscovered = this.ctx.mcpManager?.getSource(name);
				const isCurrentlyDisabled = disabledServers.has(name);
				if (!isDiscovered && !isCurrentlyDisabled) {
					this.ctx.showError(
						`MCP server "${name}" is not configured, so there is nothing to ${enabled ? "enable" : "disable"}. ` +
							`Veyyon reads MCP servers from ${shortenPath(userConfigPath)} and from the editor configs ` +
							`${theme.fg("accent", "/mcp list")} names; a repository's own mcp.json, .mcp.json or .veyyon/mcp.json is never loaded. ` +
							`Fix: run ${theme.fg("accent", `/mcp add ${name} run <command...>`)} to configure it for this profile.`,
					);
					return;
				}
				if (isCurrentlyDisabled === !enabled) {
					this.#showMessage(
						["", theme.fg("muted", `Server "${name}" is already ${enabled ? "enabled" : "disabled"}.`), ""].join(
							"\n",
						),
					);
					return;
				}
				await setServerDisabled(userConfigPath, name, !enabled);
				if (enabled) {
					await this.#connectEnabledMCPServer(name);
					const state = await this.#waitForServerConnectionWithAnimation(name);
					const status =
						state === "connected"
							? theme.fg("success", "Connected")
							: state === "connecting"
								? theme.fg("muted", "Connecting")
								: theme.fg("warning", "Not connected yet");
					this.#showMessage(
						[
							"",
							theme.fg("success", `${theme.status.enabled} Enabled "${name}"`),
							"",
							`  Status: ${status}`,
							"",
						].join("\n"),
					);
				} else {
					await this.ctx.mcpManager?.disconnectServer(name);
					await this.ctx.session.refreshMCPTools(this.ctx.mcpManager?.getTools() ?? []);
					this.#showMessage(["", theme.fg("muted", `${theme.status.disabled} Disabled "${name}"`), ""].join("\n"));
				}
				return;
			}

			if ((found.config.enabled ?? true) === enabled) {
				this.#showMessage(
					["", theme.fg("muted", `Server "${name}" is already ${enabled ? "enabled" : "disabled"}.`), ""].join(
						"\n",
					),
				);
				return;
			}

			const updated: MCPServerConfig = { ...found.config, enabled };
			await updateMCPServer(found.filePath, name, updated);
			if (enabled) {
				await this.#connectEnabledMCPServer(name);
			} else {
				await this.ctx.mcpManager?.disconnectServer(name);
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager?.getTools() ?? []);
			}

			let status = "";
			if (enabled) {
				const state = await this.#waitForServerConnectionWithAnimation(name);
				status =
					state === "connected"
						? theme.fg("success", "Connected")
						: state === "connecting"
							? theme.fg("muted", "Connecting")
							: theme.fg("warning", "Not connected yet");
			}

			const lines = [
				"",
				enabled
					? theme.fg("success", `${theme.status.enabled} Enabled "${name}" (${found.scope} config)`)
					: theme.fg("muted", `${theme.status.disabled} Disabled "${name}" (${found.scope} config)`),
			];
			if (status) {
				lines.push("");
				lines.push(`  Status: ${status}`);
			}
			lines.push("");
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.ctx.showError(`Failed to ${enabled ? "enable" : "disable"} server: ${errorMessage(error)}`);
		}
	}

	async #handleUnauth(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp unauth <name>");
			return;
		}

		try {
			const found = await this.#resolveServerForAuth(name);
			if (!found) {
				this.ctx.showError(`Server "${name}" not found.`);
				return;
			}

			const currentAuth = (found.config as MCPServerConfig & { auth?: MCPAuthConfig }).auth;
			const authStorage = this.ctx.session.modelRegistry.authStorage;
			if (currentAuth?.type === "oauth") {
				await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
			}

			let removedUrlKeyedCredential = false;
			if ((found.config.type === "http" || found.config.type === "sse") && found.config.url) {
				removedUrlKeyedCredential = await removeManagedMcpOAuthCredentials(
					authStorage,
					mcpOAuthCredentialIdsForServerUrl(found.config.url),
				);
			}

			if (found.discovered && currentAuth?.type !== "oauth") {
				if (!removedUrlKeyedCredential) {
					this.#showMessage(
						["", theme.fg("muted", `No stored OAuth auth to remove for "${name}".`), ""].join("\n"),
					);
					return;
				}
				await this.#reloadMCP();
				this.#showMessage(
					["", theme.fg("success", `- Cleared auth for "${name}" (${found.scope} config)`), ""].join("\n"),
				);
				return;
			}

			const updated = this.#stripOAuthAuth(found.config);
			await updateMCPServer(found.filePath, name, updated);
			await this.#reloadMCP();

			this.#showMessage(
				["", theme.fg("success", `- Cleared auth for "${name}" (${found.scope} config)`), ""].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(`Failed to clear auth: ${errorMessage(error)}`);
		}
	}

	async #handleReauth(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp reauth <name>");
			return;
		}

		try {
			const found = await this.#resolveServerForAuth(name);
			if (!found) {
				this.ctx.showError(`Server "${name}" not found.`);
				return;
			}

			if (found.config.enabled === false) {
				this.ctx.showError(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
				return;
			}

			const currentAuth = (found.config as MCPServerConfig & { auth?: MCPAuthConfig }).auth;
			const authStorage = this.ctx.session.modelRegistry.authStorage;
			const baseConfig = this.#stripOAuthAuth(found.config);
			const refusedAtConnect = unresolvedRefusedDownstream(
				"the MCP connect guard refuses an unresolved structural field before a transport exists",
			);
			const runtimeBaseConfig = expandEnvVarsDeep(baseConfig, refusedAtConnect);
			const oauth = await this.#resolveOAuthEndpointsFromServer(runtimeBaseConfig);
			const serverUrl =
				runtimeBaseConfig.type === "http" || runtimeBaseConfig.type === "sse" ? runtimeBaseConfig.url : undefined;

			const configuredClientId = found.config.oauth?.clientId ?? currentAuth?.clientId;
			const existingCredential = lookupMcpOAuthCredentialForServer(authStorage, currentAuth, serverUrl)?.credential;
			const flowClientId = oauth.clientId ?? configuredClientId ?? existingCredential?.clientId ?? "";
			const storedClientSecret =
				existingCredential?.clientId === flowClientId ? existingCredential.clientSecret : undefined;
			const userClientSecret = found.config.oauth?.clientSecret ?? currentAuth?.clientSecret;
			const flowClientSecret = userClientSecret ?? storedClientSecret ?? "";

			this.#showMessage(["", theme.fg("muted", `Reauthorizing "${name}"...`), ""].join("\n"));

			const currentAuthResource = currentAuth?.resource
				? expandEnvVarsDeep(currentAuth.resource, refusedAtConnect)
				: undefined;
			const oauthResource =
				oauth.resource ?? currentAuthResource ?? ("url" in runtimeBaseConfig ? runtimeBaseConfig.url : undefined);
			const oauthResourceIsFallback = !oauth.resource && !currentAuthResource;

			const oauthResult = await this.#handleOAuthFlow(
				oauth.authorizationUrl,
				oauth.tokenUrl,
				flowClientId,
				flowClientSecret,
				oauth.scopes ?? "",
				{
					callbackPort: found.config.oauth?.callbackPort,
					callbackPath: found.config.oauth?.callbackPath,
					redirectUri: found.config.oauth?.redirectUri,
					prompt: found.config.oauth?.prompt,
					registrationUrl: oauth.registrationUrl,
					serverUrl,
					resource: oauthResource,
					stripSameOriginResource: oauthResourceIsFallback,
				},
			);

			if (currentAuth?.type === "oauth" && currentAuth.credentialId !== oauthResult.credentialId) {
				await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
			}

			const urlKeyedId = serverUrl ? mcpOAuthCredentialId(serverUrl) : undefined;
			if (currentAuth || oauthResult.credentialId !== urlKeyedId) {
				const updated = this.#persistOAuthResult(baseConfig, oauthResult, {
					tokenUrl: oauth.tokenUrl,
					clientId: oauth.clientId,
					userClientSecret,
					resource: oauthResource,
					stripSameOriginResource: oauthResourceIsFallback,
				});
				await updateMCPServer(found.filePath, name, updated);
			}
			await this.#reloadMCP();
			const state = await this.#waitForServerConnectionWithAnimation(name);

			const lines = [
				"",
				theme.fg("success", `ok Reauthorized "${name}" (${found.scope} config)`),
				"",
				`  Status: ${
					state === "connected"
						? theme.fg("success", "connected")
						: state === "connecting"
							? theme.fg("muted", "connecting")
							: theme.fg("warning", "not connected")
				}`,
				"",
			];
			this.#showMessage(lines.join("\n"));
		} catch (error) {
			if (error instanceof MCPOAuthCancelledError) {
				this.ctx.showStatus(`Reauthorization cancelled for "${name}"`);
				return;
			}
			this.ctx.showError(`Failed to reauthorize server: ${errorMessage(error)}`);
		}
	}

	async #handleReload(): Promise<void> {
		try {
			this.#showMessage(["", theme.fg("muted", "Reloading MCP servers and runtime tools..."), ""].join("\n"));
			await this.#reloadMCP();
			const connectedCount = this.ctx.mcpManager?.getConnectedServers().length ?? 0;
			this.#showMessage(
				[
					"",
					theme.fg("success", withIcon(theme.icon.loop, "MCP reload complete")),
					`  Connected servers: ${connectedCount}`,
					"",
				].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(`Failed to reload MCP: ${errorMessage(error)}`);
		}
	}

	async #handleReconnect(name: string | undefined): Promise<void> {
		if (!name) {
			this.ctx.showError("Server name required. Usage: /mcp reconnect <name>");
			return;
		}
		if (!this.ctx.mcpManager) {
			this.ctx.showError("MCP manager not available.");
			return;
		}

		this.#showMessage(["", theme.fg("muted", `Reconnecting to "${name}"...`), ""].join("\n"));

		try {
			const connection = await this.ctx.mcpManager.reconnectServer(name, { manual: true });
			if (connection) {
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
				const serverTools = this.ctx.mcpManager.getTools().filter(t => t.mcpServerName === name);
				this.#showMessage(
					[
						"\n",
						theme.fg("success", `${theme.status.enabled} Reconnected to "${name}"`),
						`  Tools: ${serverTools.length}`,
						"\n",
					].join("\n"),
				);
			} else {
				this.ctx.showError(`Failed to reconnect to "${name}". Check server status and logs.`);
			}
		} catch (error) {
			this.ctx.showError(`Failed to reconnect to "${name}": ${errorMessage(error)}`);
		}
	}

	async #connectEnabledMCPServer(name: string): Promise<void> {
		if (!this.ctx.mcpManager) {
			return;
		}

		const { configs, sources } = await loadAllMCPConfigs(getProjectDir());
		const config = configs[name];
		if (!config) {
			await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
			return;
		}

		const source = sources[name];
		const result = await this.ctx.mcpManager.connectServers({ [name]: config }, source ? { [name]: source } : {});
		await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
		this.#showMCPConnectionErrors(result.errors);
	}

	#showMCPConnectionErrors(errors: Map<string, string>): void {
		if (errors.size === 0) {
			return;
		}

		const errorLines = ["", theme.fg("warning", "Some servers failed to connect:"), ""];
		for (const [serverName, error] of errors.entries()) {
			errorLines.push(`  ${serverName}: ${error}`);
		}
		errorLines.push("");
		this.#showMessage(errorLines.join("\n"));
	}

	async #reloadMCP(): Promise<void> {
		if (!this.ctx.mcpManager) {
			return;
		}

		this.ctx.mcpManager.invalidateCommandCredentials();

		await this.ctx.mcpManager.disconnectAll();

		const result = await this.ctx.mcpManager.discoverAndConnect();
		await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());

		this.#showMCPConnectionErrors(result.errors);
	}

	async #handleResources(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("No MCP manager available.");
			return;
		}

		const servers = this.ctx.mcpManager.getConnectedServers();
		const lines: string[] = ["", theme.bold("MCP Resources"), ""];
		let hasAny = false;

		for (const name of servers) {
			const data = this.ctx.mcpManager.getServerResources(name);
			if (!data) continue;
			const { resources, templates } = data;
			if (resources.length === 0 && templates.length === 0) continue;
			hasAny = true;

			lines.push(`${theme.fg("accent", name)}:`);
			for (const r of resources) {
				const desc = r.description ? ` ${theme.fg("dim", r.description)}` : "";
				const mime = r.mimeType ? ` ${theme.fg("dim", `[${r.mimeType}]`)}` : "";
				lines.push(`  ${theme.fg("success", r.uri)}${mime}${desc}`);
			}
			if (templates.length > 0) {
				lines.push(`  ${theme.fg("muted", "Templates:")}`);
				for (const t of templates) {
					const desc = t.description ? ` ${theme.fg("dim", t.description)}` : "";
					lines.push(`    ${theme.fg("accent", t.uriTemplate)}${desc}`);
				}
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(theme.fg("muted", "No resources available on connected servers."));
			lines.push("");
		}
		this.#showMessage(lines.join("\n"));
	}

	async #handlePrompts(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("No MCP manager available.");
			return;
		}

		const servers = this.ctx.mcpManager.getConnectedServers();
		const lines: string[] = ["", theme.bold("MCP Prompts"), ""];
		let hasAny = false;

		for (const name of servers) {
			const prompts = this.ctx.mcpManager.getServerPrompts(name);
			if (!prompts?.length) continue;
			hasAny = true;

			lines.push(`${theme.fg("accent", name)}:`);
			for (const p of prompts) {
				const commandName = `${name}:${p.name}`;
				const desc = p.description ? ` ${theme.fg("dim", p.description)}` : "";
				lines.push(`  ${theme.fg("success", `/${commandName}`)}${desc}`);
				if (p.arguments?.length) {
					for (const arg of p.arguments) {
						const required = arg.required ? theme.fg("warning", " *") : "";
						const argDesc = arg.description ? ` - ${arg.description}` : "";
						lines.push(`    ${arg.name}=${required}${theme.fg("dim", argDesc)}`);
					}
				}
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(theme.fg("muted", "No prompts available on connected servers."));
			lines.push("");
		}
		this.#showMessage(lines.join("\n"));
	}

	async #handleNotifications(): Promise<void> {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("No MCP manager available.");
			return;
		}

		const { enabled, subscriptions } = this.ctx.mcpManager.getNotificationState();
		const servers = this.ctx.mcpManager.getConnectedServers();
		const statusIcon = enabled ? theme.fg("success", "enabled") : theme.fg("warning", "disabled");
		const lines: string[] = ["", theme.bold("MCP Notifications"), ""];
		lines.push(`  Status: ${statusIcon}  ${theme.fg("dim", "(mcp.notifications setting)")}`);
		lines.push("");

		let hasAny = false;
		for (const name of servers) {
			const connection = this.ctx.mcpManager.getConnection(name);
			if (!connection) continue;
			const caps = connection.capabilities;
			const supportsResources = caps.resources !== undefined;
			const supportsSubscribe = caps.resources?.subscribe === true;
			const supportsToolsChanged = caps.tools?.listChanged === true;
			const supportsPromptsChanged = caps.prompts?.listChanged === true;
			const supportsResourcesChanged = caps.resources?.listChanged === true;

			const hasNotifications =
				supportsToolsChanged || supportsPromptsChanged || supportsResourcesChanged || supportsSubscribe;
			if (!hasNotifications) continue;
			hasAny = true;

			lines.push(`${theme.fg("accent", name)}:`);
			const check = theme.fg("success", "ok");
			const cross = theme.fg("dim", "x");
			if (supportsToolsChanged) lines.push(`  ${check} tools/list_changed`);
			if (supportsResourcesChanged) lines.push(`  ${check} resources/list_changed`);
			if (supportsPromptsChanged) lines.push(`  ${check} prompts/list_changed`);

			if (supportsSubscribe) {
				const subscribedUris = subscriptions.get(name);
				const subCount = subscribedUris?.size ?? 0;
				const subStatus =
					enabled && subCount > 0
						? theme.fg("success", `subscribed (${subCount} URI${subCount !== 1 ? "s" : ""})`)
						: enabled
							? theme.fg("muted", "no active subscriptions")
							: theme.fg("dim", "inactive (notifications disabled)");
				lines.push(`  ${check} resources/subscribe  ${subStatus}`);
				if (enabled && subscribedUris && subscribedUris.size > 0) {
					for (const uri of subscribedUris) {
						lines.push(`    ${theme.fg("success", "ok")} ${theme.fg("dim", uri)}`);
					}
				}
			} else if (supportsResources) {
				lines.push(`  ${cross} resources/subscribe  ${theme.fg("dim", "not supported")}`);
			}
			lines.push("");
		}

		if (!hasAny) {
			lines.push(theme.fg("muted", "No servers support notifications."));
			lines.push("");
		}
		this.#showMessage(lines.join("\n"));
	}

	async #validateSmitheryApiKey(apiKey: string): Promise<void> {
		await searchSmitheryRegistry("mcp", {
			limit: 1,
			apiKey,
			resolveProviderTextTransform: () => text => this.ctx.session.obfuscateProviderText(text),
		});
	}

	async #promptSmitheryApiKey(promptLabel: string): Promise<string | null> {
		for (;;) {
			const input = await this.ctx.showHookInput(promptLabel);
			if (input === undefined) return null;
			const apiKey = input.trim();
			if (!apiKey) {
				this.ctx.showError("Smithery API key cannot be empty.");
				continue;
			}
			try {
				await this.#validateSmitheryApiKey(apiKey);
				return apiKey;
			} catch (error) {
				this.ctx.showError(`Smithery API key validation failed: ${errorMessage(error)}`);
			}
		}
	}

	async #handleSmitheryLoginWithApiKey(): Promise<boolean> {
		const apiKey = await this.#promptSmitheryApiKey("Smithery API key (Esc to cancel)");
		if (!apiKey) return false;
		await saveSmitheryApiKey(apiKey);
		this.ctx.showStatus("Smithery API key saved.");
		return true;
	}

	async #waitForSmitheryCliApiKey(sessionId: string, signal: AbortSignal): Promise<string> {
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

	async #handleSmitheryBrowserLogin(): Promise<boolean> {
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
		} catch {}

		const apiKey = await this.#waitForSmitheryCliApiKey(session.sessionId, new AbortController().signal);
		await this.#validateSmitheryApiKey(apiKey);
		await saveSmitheryApiKey(apiKey);
		this.ctx.showStatus("Smithery API key saved.");
		return true;
	}

	async #promptSmitheryLogin(reason: string): Promise<boolean> {
		this.#showMessage(
			[
				"",
				theme.fg("muted", `Smithery authentication required (${reason}).`),
				theme.fg("muted", "If browser auth fails, you can paste an API key."),
				"",
			].join("\n"),
		);
		try {
			return await this.#handleSmitheryBrowserLogin();
		} catch (error) {
			this.ctx.showWarning(`Browser authorization failed: ${errorMessage(error)}. Falling back to API key.`);
			return await this.#handleSmitheryLoginWithApiKey();
		}
	}

	#getSmitheryErrorStatus(error: unknown): number | undefined {
		if (error instanceof SmitheryRegistryError || error instanceof SmitheryConnectError) {
			return error.status;
		}
		return undefined;
	}

	#toSmitheryAuthReason(status: number): string {
		return status === 429 ? "rate limited by Smithery" : "forbidden/unauthorized with Smithery";
	}

	async #requireSmitheryApiKey(reason: string): Promise<string> {
		let apiKey = await getSmitheryApiKey();
		if (apiKey) return apiKey;

		const loggedIn = await this.#promptSmitheryLogin(reason);
		if (!loggedIn) {
			throw new Error("Smithery login cancelled. Run /mcp smithery-login, then retry /mcp smithery-search.");
		}

		apiKey = await getSmitheryApiKey();
		if (!apiKey) {
			throw new Error("Smithery API key not found after login.");
		}
		return apiKey;
	}

	async #runSmitheryOperationWithAuthRetry<T>(operation: (apiKey: string) => Promise<T>, reason: string): Promise<T> {
		const apiKey = await this.#requireSmitheryApiKey(reason);
		try {
			return await operation(apiKey);
		} catch (error) {
			const status = this.#getSmitheryErrorStatus(error);
			if (status === undefined || ![401, 403, 429].includes(status)) {
				throw error;
			}
			const loggedIn = await this.#promptSmitheryLogin(this.#toSmitheryAuthReason(status));
			if (!loggedIn) {
				throw error;
			}
			const retryApiKey = await this.#requireSmitheryApiKey(reason);
			return await operation(retryApiKey);
		}
	}

	async #handleSmitheryLogin(): Promise<void> {
		const ok = await this.#promptSmitheryLogin("login");
		if (!ok) {
			this.ctx.showStatus("Smithery login cancelled.");
		}
	}

	async #handleSmitheryLogout(): Promise<void> {
		const removed = await clearSmitheryApiKey();
		this.ctx.showStatus(removed ? "Smithery API key removed." : "No cached Smithery API key found.");
	}

	async #nextAvailableServerName(baseName: string): Promise<string> {
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

	async #promptDeploymentServerName(defaultName: string): Promise<string | null> {
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

	async #promptRequiredRegistryInputs(result: SmitherySearchResult): Promise<Record<string, string> | null> {
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

	#applyRegistryInputOverrides(config: MCPServerConfig, values: Record<string, string>): MCPServerConfig {
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

	async #pickRegistryResult(results: SmitherySearchResult[], keyword: string): Promise<SmitherySearchResult | null> {
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

	async #deployRegistryResult(result: SmitherySearchResult): Promise<void> {
		const baseName = toConfigName(result.name);
		const defaultName = await this.#nextAvailableServerName(baseName);
		const serverName = await this.#promptDeploymentServerName(defaultName);
		if (!serverName) {
			this.ctx.showStatus("MCP deploy cancelled.");
			return;
		}
		const inputValues = await this.#promptRequiredRegistryInputs(result);
		if (inputValues === null) {
			this.ctx.showStatus("MCP deploy cancelled.");
			return;
		}
		const config = this.#applyRegistryInputOverrides(result.config, inputValues);
		await this.#handleWizardComplete(serverName, config);
	}

	async #handleSearch(text: string): Promise<void> {
		const parsed = this.#parseSearchCommand(text);
		if (parsed.error) {
			this.ctx.showError(parsed.error);
			return;
		}

		try {
			this.#showMessage(
				["", theme.fg("muted", `Searching Smithery registry for "${parsed.keyword}"...`), ""].join("\n"),
			);
			const results = await this.#runSmitheryOperationWithAuthRetry(
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

			const selected = await this.#pickRegistryResult(results, parsed.keyword);
			if (!selected) {
				this.ctx.showStatus("MCP Smithery selection cancelled.");
				return;
			}

			await this.#deployRegistryResult(selected);
		} catch (error) {
			const message = errorMessage(error);
			if (/authentication was cancelled|login cancelled/i.test(message)) {
				this.ctx.showError(`${message} Run /mcp smithery-login to authenticate first.`);
				return;
			}
			this.ctx.showError(`Smithery search failed: ${message}`);
		}
	}

	#showMessage(text: string): void {
		showCommandMessage(this.ctx, text);
	}
}
