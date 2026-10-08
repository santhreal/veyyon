/**
 * MCP Command Controller
 *
 * Handles /mcp subcommands for managing MCP servers.
 */
import type { OverlayHandle } from "@veyyon/tui";
import { errorMessage, getMCPConfigPath, getProjectDir, isAbortError, withTimeout } from "@veyyon/utils";
import { expandEnvVarsDeep, unresolvedRefusedDownstream } from "../../../discovery/env-expansion";
import { analyzeAuthError, loadAllMCPConfigs, MCPManager, type OAuthEndpoints } from "../../../mcp";
import { connectToServer, disconnectServer, listTools } from "../../../mcp/client";
import {
	addMCPServer,
	readDisabledServers,
	readMCPConfigFile,
	removeMCPServer,
	setServerDisabled,
	updateMCPServer,
} from "../../../mcp/config-writer";
import {
	lookupMcpOAuthCredentialForServer,
	mcpOAuthCredentialIdsForServerUrl,
	removeManagedMcpOAuthCredential,
	removeManagedMcpOAuthCredentials,
} from "../../../mcp/oauth-credentials";
import { mcpOAuthCredentialId } from "../../../mcp/oauth-flow";
import type { MCPHttpServerConfig, MCPServerConfig, MCPServerConnection, MCPSseServerConfig } from "../../../mcp/types";
import { MCP_REMOVE_USAGE, parseMcpAddCommand, parseMcpRemoveArgs } from "../../../slash-commands/helpers/mcp-args";
import { withIcon } from "../../../theme/icon-label";
import { theme } from "../../../theme/theme";
import { shortenPath } from "../../../tools/core/render-utils";
import { MCPAddWizard } from "../components/dialogs/mcp-add-wizard";
import type { InteractiveModeContext } from "../types";
import { dispatchSubcommand, showCommandMessage } from "./command-controller-shared";
import {
	addCancelledMessage,
	addedServerMessage,
	addFailureTip,
	alreadySetMessage,
	connectionErrorsMessage,
	enabledMessage,
	McpConnectingBlock,
	type McpConnectionState,
	mcpHelpText,
	reauthorizedMessage,
	testedServerMessage,
	testFailureTip,
} from "./mcp-command-output";
import {
	loginWithMcpOAuth,
	MCPOAuthCancelledError,
	oauthEndpointsForAuthFailure,
	oauthRedirectOptions,
	persistOAuthResult,
	reauthClient,
	stdioOAuthRefusal,
} from "./mcp-oauth-login";
import { notificationsReport, promptsReport, resourcesReport, serverListReport } from "./mcp-server-reports";
import { McpSmitheryCommands } from "./mcp-smithery-commands";

/**
 * The slice of the interactive context this controller uses: 12 members of the
 * 215 `InteractiveModeContext` requires. Naming the slice keeps the dependency
 * legible and lets a test build one without the `as unknown as
 * InteractiveModeContext` cast the full interface forces (see
 * `CollabHostContext`).
 */
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

/** A server entry in the profile's own `mcp.json`. */
interface ConfiguredServer {
	filePath: string;
	scope: "user";
	config: MCPServerConfig;
}

/**
 * A server an auth or test subcommand acts on. `discovered` marks a server
 * another tool's config declares; a change to it is written into the
 * profile's `mcp.json` under the same name.
 */
interface ResolvedServer extends ConfiguredServer {
	discovered: boolean;
}

export class MCPCommandController {
	readonly #smithery: McpSmitheryCommands;

	constructor(private ctx: McpCommandControllerContext) {
		this.#smithery = new McpSmitheryCommands(ctx, (name, config) => this.#handleWizardComplete(name, config));
	}

	/**
	 * Handle /mcp command and route to subcommands
	 */
	async handle(text: string): Promise<void> {
		await dispatchSubcommand(
			text,
			"mcp",
			[
				{ name: "add", handler: () => this.#handleAdd(text) },
				{ name: "list", handler: () => this.#handleList() },
				{ name: "remove", aliases: ["rm"], handler: () => this.#handleRemove(text) },
				{ name: "test", handler: (_args, _full, parts) => this.#handleTest(parts[2]) },
				{ name: "reauth", handler: (_args, _full, parts) => this.#handleReauth(parts[2]) },
				{ name: "unauth", handler: (_args, _full, parts) => this.#handleUnauth(parts[2]) },
				{ name: "enable", handler: (_args, _full, parts) => this.#handleSetEnabled(parts[2], true) },
				{ name: "disable", handler: (_args, _full, parts) => this.#handleSetEnabled(parts[2], false) },
				{ name: "resources", handler: () => this.#showReport(resourcesReport) },
				{ name: "prompts", handler: () => this.#showReport(promptsReport) },
				{ name: "notifications", handler: () => this.#showReport(notificationsReport) },
				{ name: "smithery-search", handler: () => this.#smithery.search(text) },
				{ name: "smithery-login", handler: () => this.#smithery.login() },
				{ name: "smithery-logout", handler: () => this.#smithery.logout() },
				{ name: "reconnect", handler: (_args, _full, parts) => this.#handleReconnect(parts[2]) },
				{ name: "reload", handler: () => this.#handleReload() },
			],
			{
				onHelp: () => this.#showMessage(mcpHelpText()),
				showError: msg => this.ctx.showError(msg),
			},
		);
	}

	/**
	 * Handle /mcp add - Launch interactive wizard or quick-add from args
	 */
	async #handleAdd(text: string): Promise<void> {
		const match = text.match(/^\/mcp\s+add\b\s*(.*)$/i);
		const parsed = parseMcpAddCommand(match?.[1]?.trim() ?? "");
		if (parsed.error) {
			this.ctx.showError(parsed.error);
			return;
		}
		const { quickConfig, initialName } = parsed;
		if (!quickConfig || !initialName) {
			this.#openAddWizard(initialName);
			return;
		}
		// A URL quick add detects auth and runs the OAuth login the way the
		// wizard does. A command quick add skips both.
		const config =
			!parsed.isCommandQuickAdd && (quickConfig.type === "http" || quickConfig.type === "sse")
				? await this.#authorizeQuickAdd(initialName, quickConfig, parsed.hasAuthToken)
				: quickConfig;
		if (config) await this.#handleWizardComplete(initialName, config);
	}

	/**
	 * The config a URL quick add saves: `config` itself, unless its test
	 * connection fails with an authentication challenge, in which case the
	 * OAuth login runs and its credential is folded in. Undefined when the add
	 * stopped and reported why.
	 */
	async #authorizeQuickAdd(
		name: string,
		config: MCPHttpServerConfig | MCPSseServerConfig,
		hasAuthToken: boolean | undefined,
	): Promise<MCPServerConfig | undefined> {
		const failure = await this.#connectionFailure(config);
		if (!failure) return config;
		if (hasAuthToken) {
			this.ctx.showError(`Authentication failed for "${name}": ${errorMessage(failure.error)}`);
			return undefined;
		}
		const authResult = analyzeAuthError(failure.error, config.url);
		if (!authResult.requiresAuth) return config;
		const oauth = await oauthEndpointsForAuthFailure(authResult, config.url, { ignoreDiscoveryFailure: true });
		if (!oauth) {
			this.ctx.showError(
				`Authentication required for "${name}", but OAuth endpoints could not be discovered. ` +
					`Use /mcp add ${name} (wizard) or configure auth manually.`,
			);
			return undefined;
		}
		try {
			return await this.#loginForQuickAdd(config, oauth);
		} catch (error) {
			if (error instanceof MCPOAuthCancelledError) this.ctx.showStatus(`Add cancelled for "${name}"`);
			else this.ctx.showError(`OAuth flow failed for "${name}": ${errorMessage(error)}`);
			return undefined;
		}
	}

	/** Log in to the server a quick add names and fold the credential into its config. */
	async #loginForQuickAdd(
		config: MCPHttpServerConfig | MCPSseServerConfig,
		oauth: OAuthEndpoints,
	): Promise<MCPServerConfig> {
		const resource = oauth.resource ?? config.url;
		const resourceIsFallback = !oauth.resource;
		const result = await loginWithMcpOAuth(
			this.ctx,
			oauth.authorizationUrl,
			oauth.tokenUrl,
			oauth.clientId ?? config.oauth?.clientId ?? "",
			config.oauth?.clientSecret ?? "",
			oauth.scopes ?? "",
			{
				...oauthRedirectOptions(config.oauth),
				registrationUrl: oauth.registrationUrl,
				serverUrl: config.url,
				resource,
				stripSameOriginResource: resourceIsFallback,
			},
		);
		return persistOAuthResult(config, result, {
			tokenUrl: oauth.tokenUrl,
			resource,
			stripSameOriginResource: resourceIsFallback,
			clientId: oauth.clientId,
			userClientSecret: config.oauth?.clientSecret,
		});
	}

	/** Open the `/mcp add` wizard card, prefilled with `initialName`. */
	#openAddWizard(initialName: string | undefined): void {
		// The wizard is a floating card on the alternate screen, so its close
		// glyph and chips have somewhere to live and the transcript stays put.
		let overlayHandle: OverlayHandle | undefined;
		// The wizard holds a pointer band on the shared motion clock, and hiding an overlay only
		// stops painting it. The show site created the card, so the show site hands it back.
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
				this.#showMessage(addCancelledMessage());
			},
			(authUrl, tokenUrl, clientId, clientSecret, scopes, options) =>
				loginWithMcpOAuth(this.ctx, authUrl, tokenUrl, clientId, clientSecret, scopes, options),
			config => this.#handleTestConnection(config),
			() => {
				this.ctx.ui.requestRender();
			},
			initialName,
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

	/**
	 * Test connection to an MCP server.
	 * Throws an error if connection fails (used for auto-detection).
	 */
	async #handleTestConnection(config: MCPServerConfig, options?: { oauth?: boolean }): Promise<void> {
		// Create temporary connection using a test name
		const testName = `test_${Date.now()}`;
		const resolvedConfig = await this.#prepareConfig(config, options);
		const connection = await connectToServer(testName, resolvedConfig);
		await disconnectServer(connection);
	}

	/** The error a test connection to `config` fails with; undefined when it connects. */
	async #connectionFailure(
		config: MCPServerConfig,
		options?: { oauth?: boolean },
	): Promise<{ error: Error } | undefined> {
		try {
			await this.#handleTestConnection(config, options);
			return undefined;
		} catch (error) {
			return { error: error as Error };
		}
	}

	/** `config` with its auth resolved, by the session's MCP manager or by a temporary one when there is none. */
	async #prepareConfig(config: MCPServerConfig, options?: { oauth?: boolean }): Promise<MCPServerConfig> {
		if (this.ctx.mcpManager) return this.ctx.mcpManager.prepareConfig(config, options);
		const tempManager = new MCPManager(getProjectDir());
		tempManager.setAuthStorage(this.ctx.session.modelRegistry.authStorage);
		return tempManager.prepareConfig(config, options);
	}

	/**
	 * Resolve a server for an auth/test operation.
	 *
	 * Unlike {@link findConfiguredServer} (which only reads writable Veyyon config
	 * files), this also recognizes runtime-discovered servers that `/mcp list`
	 * surfaces but that live in no writable config — e.g. servers from a Claude
	 * Code marketplace plugin (`cloudflare:cloudflare-api`), `.cursor/mcp.json`,
	 * etc. Without this, `/mcp reauth|test|unauth` reports "not found" for a
	 * server the list just showed.
	 *
	 * For a discovered server, any persisted change is written into the *user*
	 * config under the same (namespaced) name; the native provider (priority 100)
	 * shadows the discovered entry on the next reload, so an OAuth `auth` block
	 * persisted by `/mcp reauth` takes effect. `discovered` lets callers tailor
	 * messaging and skip pointless writes when there is nothing to persist.
	 */
	async #resolveServerForAuth(name: string): Promise<ResolvedServer | null> {
		const found = await findConfiguredServer(name);
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

	/**
	 * The OAuth endpoints a reauthorization logs in against, read from the
	 * challenge the server answers an unauthenticated test connection with.
	 * Fails when the server connects without OAuth.
	 */
	async #resolveOAuthEndpointsFromServer(config: MCPHttpServerConfig | MCPSseServerConfig): Promise<OAuthEndpoints> {
		const failure = await this.#connectionFailure(stripOAuthAuth(config), { oauth: false });
		if (!failure) throw new Error("Server connection succeeded without OAuth; reauthorization is not required.");
		const authResult = analyzeAuthError(failure.error, config.url);
		const oauth = await oauthEndpointsForAuthFailure(authResult, config.url, { ignoreDiscoveryFailure: false });
		if (!oauth) throw new Error("Could not discover OAuth endpoints from server response.");
		return oauth;
	}

	async #waitForServerConnectionWithAnimation(
		name: string,
		options?: { suppressDisconnectedWarning?: boolean },
	): Promise<McpConnectionState> {
		if (!this.ctx.mcpManager) return "disconnected";

		const block = new McpConnectingBlock(name);
		this.ctx.present(block);

		try {
			try {
				await withTimeout(this.ctx.mcpManager.waitForConnection(name), 10_000, "Connection still pending");
			} catch {
				// Ignore timeout/errors here and use status check below.
			}
			const state = this.ctx.mcpManager.getConnectionStatus(name);
			if (state === "connected") {
				// Connection may complete after initial reload; rebind runtime MCP tools now.
				await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());
			}
			block.settle(state, options?.suppressDisconnectedWarning);
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
			const state = await this.#addedServerState(name, config);
			if (state === "connected") await this.#activateServerTools(name);
			this.#showMessage(addedServerMessage(name, filePath, state));
		} catch (error) {
			const errorMsg = errorMessage(error);
			this.ctx.showError(`Failed to add server: ${errorMsg}${addFailureTip(errorMsg)}`);
		}
	}

	/**
	 * The connection state `/mcp add` reports for a server it saved. A server
	 * the manager has not connected yet still counts as connected when a
	 * direct test connection succeeds, which avoids a false "not connected"
	 * and connects the manager to it.
	 */
	async #addedServerState(name: string, config: MCPServerConfig): Promise<McpConnectionState> {
		if (config.enabled === false) return "disconnected";
		const state = await this.#waitForServerConnectionWithAnimation(name, { suppressDisconnectedWarning: true });
		if (state !== "disconnected") return state;
		try {
			await this.#handleTestConnection(config);
		} catch {
			return "disconnected";
		}
		// The server answered the direct test, so it is reported connected
		// whether or not the manager connects to it now.
		await this.#syncManagerConnection(name, config).catch(() => {});
		return "connected";
	}

	/**
	 * Activate the tools of a server `/mcp add` connected. `refreshMCPTools`
	 * keeps the prior MCP tool selection, so a new server's tools are
	 * registered but stay inactive until this runs.
	 */
	async #activateServerTools(name: string): Promise<void> {
		if (!this.ctx.mcpManager) return;
		const serverTools = this.ctx.mcpManager.getTools().filter(t => t.mcpServerName === name);
		if (serverTools.length === 0) return;
		const currentActive = this.ctx.session.getActiveToolNames();
		const toActivate = serverTools.map(t => t.name).filter(n => this.ctx.session.getToolByName(n));
		if (toActivate.length === 0) return;
		await this.ctx.session.setActiveToolsByName(Array.from(new Set(currentActive.concat(toActivate))));
	}

	/**
	 * Handle /mcp list - Show all configured servers
	 */
	async #handleList(): Promise<void> {
		try {
			// The profile's own `<agentDir>/mcp.json` is the only writable config.
			// A second read of `<cwd>/.veyyon/mcp.json` used to render a "Project
			// level" section here; nothing loads that file, so the section listed
			// servers no session would ever connect to.
			const userPath = getMCPConfigPath("user", getProjectDir());
			const userServers = (await readMCPConfigFile(userPath)).mcpServers ?? {};
			const disabled = new Set(await readDisabledServers(userPath));
			this.#showMessage(serverListReport(this.ctx.mcpManager, userPath, userServers, disabled));
		} catch (error) {
			this.ctx.showError(`Failed to list servers: ${errorMessage(error)}`);
		}
	}

	/**
	 * Handle /mcp remove <name> - Remove a server
	 */
	async #handleRemove(text: string): Promise<void> {
		const match = text.match(/^\/mcp\s+(?:remove|rm)\b\s*(.*)$/i);
		const parsed = parseMcpRemoveArgs(match?.[1]?.trim() ?? "", "terminal");
		if (parsed.error) {
			this.ctx.showError(parsed.error);
			return;
		}
		if (!parsed.name) {
			this.ctx.showError(`Server name required.\n${MCP_REMOVE_USAGE}`);
			return;
		}
		const name = parsed.name;

		try {
			const filePath = getMCPConfigPath("user", getProjectDir());
			const config = await readMCPConfigFile(filePath);
			if (!config.mcpServers?.[name]) {
				this.ctx.showError(`Server "${name}" not found in ${shortenPath(filePath)}.`);
				return;
			}

			// Disconnect if connected
			if (this.ctx.mcpManager?.getConnection(name)) {
				await this.ctx.mcpManager.disconnectServer(name);
			}

			// Remove from config
			await removeMCPServer(filePath, name);

			// Reload MCP manager
			await this.#reloadMCP();

			this.#showMessage(
				["", theme.fg("success", `- Removed server "${name}" from ${shortenPath(filePath)}`), ""].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(`Failed to remove server: ${errorMessage(error)}`);
		}
	}

	/**
	 * Handle /mcp test <name> - Test connection to a server
	 */
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
			const config = await this.#testableConfig(name);
			if (!config) return;
			this.#showMessage(
				["", theme.fg("muted", `Testing connection to "${name}"... (esc to cancel)`), ""].join("\n"),
			);
			const resolvedConfig = await this.#prepareConfig(config);
			connection = await connectToServer(name, resolvedConfig, { signal: abortController.signal });
			// Listing tools proves the connection answers requests.
			const tools = await listTools(connection, { signal: abortController.signal });
			await this.#syncManagerConnection(name, config);
			this.#showMessage(testedServerMessage(name, connection, tools));
		} catch (error) {
			if (abortController.signal.aborted || isAbortError(error)) {
				this.ctx.showStatus(`Cancelled MCP test for "${name}"`);
				return;
			}
			const errorMsg = errorMessage(error);
			this.ctx.showError(`Failed to connect to "${name}": ${errorMsg}${testFailureTip(errorMsg)}`);
		} finally {
			this.ctx.editor.onEscape = originalOnEscape;
			// Best-effort: don't block UI on cleanup.
			if (connection) void disconnectServer(connection);
		}
	}

	/** The config `/mcp test` connects with; undefined after reporting why the server cannot be tested. */
	async #testableConfig(name: string): Promise<MCPServerConfig | undefined> {
		const found = await this.#resolveServerForAuth(name);
		if (!found) {
			this.ctx.showError(
				`Server "${name}" not found.\n\nTip: Run ${theme.fg("accent", "/mcp list")} to see available servers.`,
			);
			return undefined;
		}
		if (found.config.enabled === false) {
			this.ctx.showError(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
			return undefined;
		}
		return found.config;
	}

	async #handleSetEnabled(name: string | undefined, enabled: boolean): Promise<void> {
		if (!name) {
			this.ctx.showError(`Server name required. Usage: /mcp ${enabled ? "enable" : "disable"} <name>`);
			return;
		}

		try {
			const found = await findConfiguredServer(name);
			if (found) await this.#setConfiguredServerEnabled(name, found, enabled);
			else await this.#setDiscoveredServerEnabled(name, enabled);
		} catch (error) {
			this.ctx.showError(`Failed to ${enabled ? "enable" : "disable"} server: ${errorMessage(error)}`);
		}
	}

	/** Write `enabled` into the profile's entry for `name`, then connect or disconnect it. */
	async #setConfiguredServerEnabled(name: string, found: ConfiguredServer, enabled: boolean): Promise<void> {
		if ((found.config.enabled ?? true) === enabled) {
			this.#showMessage(alreadySetMessage(name, enabled));
			return;
		}
		await updateMCPServer(found.filePath, name, { ...found.config, enabled });
		await this.#applyEnabled(name, enabled, `"${name}" (${found.scope} config)`);
	}

	/**
	 * Enable or disable a server a third-party config declares, through the
	 * profile's disabled-server list, then connect or disconnect it.
	 */
	async #setDiscoveredServerEnabled(name: string, enabled: boolean): Promise<void> {
		const userConfigPath = getMCPConfigPath("user", getProjectDir());
		const isCurrentlyDisabled = (await readDisabledServers(userConfigPath)).includes(name);
		if (!this.ctx.mcpManager?.getSource(name) && !isCurrentlyDisabled) {
			// Naming the file is the whole point: the operator who typed this
			// is usually looking at a `mcp.json` in the repository they are
			// standing in, and nothing reads that. Silently reporting "not
			// found" left them re-editing a file no session ever loads.
			this.ctx.showError(
				`MCP server "${name}" is not configured, so there is nothing to ${enabled ? "enable" : "disable"}. ` +
					`Veyyon reads MCP servers from ${shortenPath(userConfigPath)} and from the editor configs ` +
					`${theme.fg("accent", "/mcp list")} names; a repository's own mcp.json, .mcp.json or .veyyon/mcp.json is never loaded. ` +
					`Fix: run ${theme.fg("accent", `/mcp add ${name} run <command...>`)} to configure it for this profile.`,
			);
			return;
		}
		if (isCurrentlyDisabled === !enabled) {
			this.#showMessage(alreadySetMessage(name, enabled));
			return;
		}
		await setServerDisabled(userConfigPath, name, !enabled);
		await this.#applyEnabled(name, enabled, `"${name}"`);
	}

	/** Connect or disconnect `name` after its enabled flag changed, and report the change. */
	async #applyEnabled(name: string, enabled: boolean, label: string): Promise<void> {
		if (!enabled) {
			await this.ctx.mcpManager?.disconnectServer(name);
			await this.ctx.session.refreshMCPTools(this.ctx.mcpManager?.getTools() ?? []);
			this.#showMessage(["", theme.fg("muted", `${theme.status.disabled} Disabled ${label}`), ""].join("\n"));
			return;
		}
		await this.#connectEnabledMCPServer(name);
		const state = await this.#waitForServerConnectionWithAnimation(name);
		this.#showMessage(enabledMessage(label, state));
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

			const removedUrlKeyedCredential = await this.#removeStoredOAuth(found.config);
			if (!found.discovered || found.config.auth?.type === "oauth") {
				await updateMCPServer(found.filePath, name, stripOAuthAuth(found.config));
			} else if (!removedUrlKeyedCredential) {
				this.#showMessage(["", theme.fg("muted", `No stored OAuth auth to remove for "${name}".`), ""].join("\n"));
				return;
			}
			await this.#reloadMCP();
			this.#showMessage(
				["", theme.fg("success", `- Cleared auth for "${name}" (${found.scope} config)`), ""].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(`Failed to clear auth: ${errorMessage(error)}`);
		}
	}

	/**
	 * Delete this profile's stored OAuth credentials for `config`: the row its
	 * auth block points at, and the url-keyed rows, so the server is signed out
	 * even when the config carries no auth block. Runtime discovery expands
	 * `${...}` URL values before MCPManager looks up the deterministic
	 * credential row, so the rows for both the expanded and the literal URL are
	 * deleted. True when a url-keyed row was deleted.
	 */
	async #removeStoredOAuth(config: MCPServerConfig): Promise<boolean> {
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		if (config.auth?.type === "oauth") await removeManagedMcpOAuthCredential(authStorage, config.auth.credentialId);
		if ((config.type !== "http" && config.type !== "sse") || !config.url) return false;
		return removeManagedMcpOAuthCredentials(authStorage, mcpOAuthCredentialIdsForServerUrl(config.url));
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
			await this.#reauthorize(name, found);
		} catch (error) {
			if (error instanceof MCPOAuthCancelledError) {
				this.ctx.showStatus(`Reauthorization cancelled for "${name}"`);
				return;
			}
			this.ctx.showError(`Failed to reauthorize server: ${errorMessage(error)}`);
		}
	}

	/** Run a fresh OAuth login for `found`, point its config at the new credential, and reconnect it. */
	async #reauthorize(name: string, found: ResolvedServer): Promise<void> {
		const currentAuth = found.config.auth;
		const baseConfig = stripOAuthAuth(found.config);
		// The connect guard is the enforcement point and names the field and the variable in the
		// refusal the operator sees, so reporting here would say it twice.
		const refusedAtConnect = unresolvedRefusedDownstream(
			"the MCP connect guard refuses an unresolved structural field before a transport exists",
		);
		// Runtime discovery passes MCPManager this env-expanded shape; the raw
		// file value may contain `${...}` placeholders.
		const runtimeConfig = expandEnvVarsDeep(baseConfig, refusedAtConnect);
		// Stdio servers manage credentials inside the child process; Veyyon's
		// OAuth flow applies to http/sse transports only. Probing one would
		// spawn the child, which reuses its own cached tokens (e.g. mcp-remote's
		// machine-wide ~/.mcp-auth) and reports that reauthorization is not
		// required.
		if (runtimeConfig.type !== "http" && runtimeConfig.type !== "sse") throw stdioOAuthRefusal(runtimeConfig);
		// Endpoints first: the probe connects without OAuth, so nothing
		// destructive has happened yet if the server turns out not to need (or
		// support) OAuth.
		const oauth = await this.#resolveOAuthEndpointsFromServer(runtimeConfig);
		const serverUrl = runtimeConfig.url;
		const authStorage = this.ctx.session.modelRegistry.authStorage;
		const client = reauthClient(
			found.config,
			oauth,
			lookupMcpOAuthCredentialForServer(authStorage, currentAuth, serverUrl)?.credential,
		);

		this.#showMessage(["", theme.fg("muted", `Reauthorizing "${name}"...`), ""].join("\n"));

		const currentResource = currentAuth?.resource
			? expandEnvVarsDeep(currentAuth.resource, refusedAtConnect)
			: undefined;
		const resource = oauth.resource ?? currentResource ?? serverUrl;
		const resourceIsFallback = !oauth.resource && !currentResource;
		const result = await loginWithMcpOAuth(
			this.ctx,
			oauth.authorizationUrl,
			oauth.tokenUrl,
			client.clientId,
			client.clientSecret,
			oauth.scopes ?? "",
			{
				...oauthRedirectOptions(found.config.oauth),
				registrationUrl: oauth.registrationUrl,
				serverUrl,
				resource,
				stripSameOriginResource: resourceIsFallback,
			},
		);

		// The login overwrote (or minted) this profile's row; a superseded
		// pointer row from the legacy random-id era is now orphaned. It is
		// deleted only after success, so cancelling the browser step leaves the
		// previous session signed in.
		if (currentAuth?.type === "oauth" && currentAuth.credentialId !== result.credentialId) {
			await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
		}
		// Definition-only entries resolve through the url-keyed binding alone;
		// skipping the write-back keeps a committed project mcp.json clean.
		const urlKeyedId = serverUrl ? mcpOAuthCredentialId(serverUrl) : undefined;
		if (currentAuth || result.credentialId !== urlKeyedId) {
			const updated = persistOAuthResult(baseConfig, result, {
				tokenUrl: oauth.tokenUrl,
				clientId: oauth.clientId,
				userClientSecret: client.userClientSecret,
				resource,
				stripSameOriginResource: resourceIsFallback,
			});
			await updateMCPServer(found.filePath, name, updated);
		}
		await this.#reloadMCP();
		const state = await this.#waitForServerConnectionWithAnimation(name);
		this.#showMessage(reauthorizedMessage(name, found.scope, state));
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

	/**
	 * Handle /mcp reconnect <name> - Reconnect to a specific server.
	 */
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
				// refreshMCPTools re-registers tools and preserves the user's prior
				// MCP tool selection. No need to call activateDiscoveredMCPTools —
				// that would broaden the selection to all server tools.
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
		if (errors.size > 0) this.#showMessage(connectionErrorsMessage(errors));
	}

	/**
	 * Reload MCP manager with new configs
	 */
	async #reloadMCP(): Promise<void> {
		if (!this.ctx.mcpManager) {
			return;
		}

		// A reload re-reads the config files, so the credentials a `!command` in them mints or
		// reads are re-read too. Nothing else can notice that kind of secret rotated: the cache is
		// keyed by the command text, which is identical before and after. Scoped to MCP configs,
		// so a command that resolves a provider key elsewhere keeps its value.
		this.ctx.mcpManager.invalidateCommandCredentials();

		// Disconnect all existing servers
		await this.ctx.mcpManager.disconnectAll();

		// Rediscover and connect
		const result = await this.ctx.mcpManager.discoverAndConnect();
		await this.ctx.session.refreshMCPTools(this.ctx.mcpManager.getTools());

		this.#showMCPConnectionErrors(result.errors);
	}

	/** Show a read-only `/mcp` report built from the session's MCP manager. */
	#showReport(report: (manager: MCPManager) => string): void {
		if (!this.ctx.mcpManager) {
			this.ctx.showError("No MCP manager available.");
			return;
		}
		this.#showMessage(report(this.ctx.mcpManager));
	}

	/**
	 * Show a message in the chat
	 */
	#showMessage(text: string): void {
		showCommandMessage(this.ctx, text);
	}
}

/**
 * Find `name` in the one MCP config file `/mcp` owns: the active profile's
 * `<agentDir>/mcp.json`.
 *
 * Three working-tree candidates used to sit behind that file —
 * `<cwd>/.veyyon/mcp.json`, `<cwd>/mcp.json` and `<cwd>/.mcp.json`, matching
 * the since-deleted project-scope discovery providers. Nothing loads them at
 * boot any more, but this function still resolved them, so `/mcp test` and
 * `/mcp reauth` would have CONNECTED to a server a repository declared and
 * `/mcp enable` would have written `enabled: true` into a repository file.
 * Operator-initiated is not consent: typing `/mcp test` is not agreement to
 * reach a server the operator never configured.
 */
async function findConfiguredServer(name: string): Promise<ConfiguredServer | null> {
	const userPath = getMCPConfigPath("user", getProjectDir());
	const userConfig = await readMCPConfigFile(userPath);
	const config = userConfig.mcpServers?.[name];
	if (!config) return null;
	return { filePath: userPath, scope: "user", config };
}

function stripOAuthAuth(config: MCPServerConfig): MCPServerConfig {
	const next = { ...config };
	delete next.auth;
	return next;
}
