/** MCP Server Manager. Discovers, connects to, and manages MCP servers. */
import * as path from "node:path";
import * as url from "node:url";
import type { TSchema } from "@veyyon/ai";
// The owner, not the barrel: classifying an OAuth failure is a string test that
// belongs to the flag it decides, and `error/flags.ts` is where that flag lives.
import { isDefinitiveOAuthFailure } from "@veyyon/ai/error/flags";
import { errorMessage, logger } from "@veyyon/utils";
import { FOREIGN_PROVIDER_IDS } from "../capability/index";
import type { SourceMeta } from "../capability/types";
import { describeConfigEnvReference } from "../config/config-value-resolution";
import { invalidateConfigValue, resolveConfigValue } from "../config/resolve-config-value";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { type AuthStorage, REMOTE_REFRESH_SENTINEL } from "../session/auth-storage";
import {
	classifyMcpAuthFailure,
	MCPAuthRequiredError,
	type MCPAuthResolution,
	MCPBrokerRedactedRefreshError,
	MCPUnresolvedEnvReferenceError,
} from "./auth-failure";
import {
	closeTransportDetached,
	connectToServer,
	disconnectServer,
	getPrompt,
	listPrompts,
	listResources,
	listResourceTemplates,
	listTools,
	readResource,
	serverSupportsPrompts,
	serverSupportsResources,
	subscribeToResources,
	unsubscribeFromResources,
} from "./client";
import { type LoadMCPConfigsResult, loadAllMCPConfigs, validateServerConfig } from "./config";
import { hasMcpConfigCommands, mcpConfigCommandValues } from "./config-commands";
import { mcpManagerInstance, setMcpManagerInstance } from "./manager-instance";
import {
	lookupMcpOAuthCredential,
	type MCPOAuthCredentialLookup,
	selectMcpOAuthRefreshMaterial,
} from "./oauth-credentials";
import { type MCPStoredOAuthCredential, refreshMCPOAuthToken } from "./oauth-flow";
import { MCP_CONFIG_STATUS_LABEL, type McpConnectionStatusEvent } from "./startup-events";
import type { MCPToolDetails } from "./tool-bridge";
import { DeferredMCPTool, MCPTool, mcpToolNamePrefix } from "./tool-bridge";
import type { MCPToolCache } from "./tool-cache";
import { describeMCPServerTarget } from "./transports/transport-failure";
import type {
	MCPGetPromptResult,
	MCPPrompt,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadResult,
	MCPResourceTemplate,
	MCPServerConfig,
	MCPServerConnection,
	MCPToolDefinition,
	MCPTransport,
} from "./types";
import { MCPNotificationMethods } from "./types";

type ToolLoadResult = {
	connection: MCPServerConnection;
	serverTools: MCPToolDefinition[];
};

interface AuthRefreshableMCPTransport extends MCPTransport {
	onAuthError?: () => Promise<Record<string, string> | null>;
}

function isAuthRefreshableMCPTransport(transport: MCPTransport): transport is AuthRefreshableMCPTransport {
	return "onAuthError" in transport;
}
type TrackedPromise<T> = {
	promise: Promise<T>;
	status: "pending" | "fulfilled" | "rejected";
	value?: T;
	reason?: unknown;
};

/** How long startup waits for MCP connections before serving cached tools. This is a grace window, NOT a timeout: connections that have not settled by */
const STARTUP_TOOL_WAIT_MS = 250;

/** Per-server reconnect-storm circuit breaker. `transport.onClose` (wired in {@link MCPManager.connectServers} and */
const RECONNECT_BURST_WINDOW_MS = 30_000;
const RECONNECT_BURST_LIMIT = 5;

function trackPromise<T>(promise: Promise<T>): TrackedPromise<T> {
	const tracked: TrackedPromise<T> = { promise, status: "pending" };
	promise.then(
		value => {
			tracked.status = "fulfilled";
			tracked.value = value;
		},
		reason => {
			tracked.status = "rejected";
			tracked.reason = reason;
		},
	);
	return tracked;
}

/** Stable, total ordering on MCP tools by name. Anthropic prompt caching keys on byte-identical tool definitions: any reorder */
export function sortMCPToolsByName<T extends { name: string }>(tools: T[]): T[] {
	tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return tools;
}

export function resolveSubscriptionPostAction(
	notificationsEnabled: boolean,
	currentEpoch: number,
	subscriptionEpoch: number,
): "rollback" | "ignore" | "apply" {
	if (!notificationsEnabled) return "rollback";
	if (currentEpoch !== subscriptionEpoch) return "ignore";
	return "apply";
}
/** Result of loading MCP tools */
export interface MCPLoadResult {
	/** Loaded tools as CustomTool instances */
	tools: CustomTool<TSchema, MCPToolDetails>[];
	/** Connection errors by server name */
	errors: Map<string, string>;
	/** Connected server names */
	connectedServers: string[];
	/** Extracted Exa API keys from filtered MCP servers */
	exaApiKeys: string[];
}

/** Options for discovering and connecting to MCP servers */
export interface MCPDiscoverOptions {
	/** Whether to filter out Exa MCP servers (default: true) */
	filterExa?: boolean;
	/** Whether to filter out browser MCP servers when builtin browser tool is enabled (default: false) */
	filterBrowser?: boolean;
	/** WHICH profile owns the user-scope `mcp.json`. Default: the process-active profile. A session rooted in another agent dir passes that dir so its MCP */
	agentDir?: string;
	/** Called when MCP server connection state changes. */
	onStatus?: (event: McpConnectionStatusEvent) => void;
}

/** MCP Server Manager. Manages connections to MCP servers and provides tools to the agent. */
export class MCPManager {
	/** Process-global instance shared by internal URL protocol handlers and tools. The slot itself lives in `./manager-instance`, which imports nothing, so a reader that only needs */
	static instance(): MCPManager | undefined {
		return mcpManagerInstance();
	}

	/** Install or clear the process-global instance. */
	static setInstance(value: MCPManager | undefined): void {
		setMcpManagerInstance(value);
	}

	/** Reset the process-global instance. Test-only. */
	static resetForTests(): void {
		setMcpManagerInstance(undefined);
	}

	#connections = new Map<string, MCPServerConnection>();
	/** Session CPU budget hook, set by the owning session: spawned stdio server pids join the session's budget group. */
	#adoptSpawnedPid: ((pid: number) => void) | undefined;
	/** Session CPU budget gate: refuse a new stdio server while the group is saturated or uncreated. */
	#gateSpawn: ((what: string) => Promise<void>) | undefined;

	/** Wire the session CPU budget hook for stdio server spawns. */
	setSpawnAdoption(adopt: ((pid: number) => void) | undefined): void {
		this.#adoptSpawnedPid = adopt;
	}

	/** Wire the session CPU budget gate for stdio server spawns. */
	setSpawnGate(gate: ((what: string) => Promise<void>) | undefined): void {
		this.#gateSpawn = gate;
	}

	/** Read both hooks once. A connection attempt outlives the read, and `setSpawnGate(undefined)` between the two would leave a closure calling a */
	#stdioSpawnHooks(): {
		onSpawnPid?: (pid: number) => void;
		beforeSpawn?: () => Promise<void>;
	} {
		const adopt = this.#adoptSpawnedPid;
		const gate = this.#gateSpawn;
		return {
			...(adopt ? { onSpawnPid: adopt } : {}),
			...(gate ? { beforeSpawn: () => gate("an MCP stdio server") } : {}),
		};
	}

	#tools: CustomTool<TSchema, MCPToolDetails>[] = [];
	#pendingConnections = new Map<string, Promise<MCPServerConnection>>();
	#pendingToolLoads = new Map<string, Promise<ToolLoadResult>>();
	#sources = new Map<string, SourceMeta>();
	// Last connection failure per server, retained so `/mcp list` can show *why* a server is not connected instead of a bare "not connected". Cleared when
	#lastErrors = new Map<string, string>();
	#authStorage: AuthStorage | null = null;
	#onNotification?: (serverName: string, method: string, params: unknown) => void;
	#onToolsChanged?: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void;
	#onResourcesChanged?: (serverName: string, uri: string) => void;
	#onPromptsChanged?: (serverName: string) => void;
	#notificationsEnabled = false;
	#notificationsEpoch = 0;
	#subscribedResources = new Map<string, Set<string>>();
	#pendingResourceRefresh = new Map<string, { connection: MCPServerConnection; promise: Promise<void> }>();
	#pendingReconnections = new Map<string, Promise<MCPServerConnection | null>>();
	/** Preserved configs for reconnection after connection loss. */
	#serverConfigs = new Map<string, MCPServerConfig>();
	/** Timestamps of recent `reconnectServer` invocations per server, used by the crash-storm circuit breaker (see {@link RECONNECT_BURST_LIMIT}). */
	#reconnectHistory = new Map<string, number[]>();
	/** Monotonic epoch incremented on disconnectAll to invalidate stale reconnections. */
	#epoch = 0;

	constructor(
		private cwd: string,
		private toolCache: MCPToolCache | null = null,
	) {}

	/**
	 * Set a callback to receive all server notifications.
	 */
	setOnNotification(handler: (serverName: string, method: string, params: unknown) => void): void {
		this.#onNotification = handler;
	}

	/**
	 * Set a callback to fire when any server's tools change.
	 */
	setOnToolsChanged(handler: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void): void {
		this.#onToolsChanged = handler;
	}

	/**
	 * Set a callback to fire when any server's resources change.
	 */
	setOnResourcesChanged(handler: (serverName: string, uri: string) => void): void {
		this.#onResourcesChanged = handler;
	}

	/**
	 * Set a callback to fire when any server's prompts change.
	 */
	setOnPromptsChanged(handler: (serverName: string) => void): void {
		this.#onPromptsChanged = handler;
		// Fire immediately for servers that already have prompts loaded
		for (const [name, connection] of this.#connections) {
			if (connection.prompts?.length) {
				handler(name);
			}
		}
	}

	#subscribeAndTrack(name: string, connection: MCPServerConnection, uris: string[], notificationEpoch: number): void {
		void subscribeToResources(connection, uris)
			.then(() => {
				const action = resolveSubscriptionPostAction(
					this.#notificationsEnabled,
					this.#notificationsEpoch,
					notificationEpoch,
				);
				if (action === "rollback") {
					void unsubscribeFromResources(connection, uris).catch(error => {
						logger.debug("Failed to rollback stale MCP resource subscription", {
							path: `mcp:${name}`,
							error,
						});
					});
					return;
				}
				if (action === "ignore") {
					return;
				}
				this.#subscribedResources.set(name, new Set(uris));
			})
			.catch(error => {
				logger.debug("Failed to subscribe to MCP resources", { path: `mcp:${name}`, error });
			});
	}

	setNotificationsEnabled(enabled: boolean): void {
		const wasEnabled = this.#notificationsEnabled;
		this.#notificationsEnabled = enabled;
		if (enabled === wasEnabled) return;

		this.#notificationsEpoch += 1;
		const notificationEpoch = this.#notificationsEpoch;

		if (enabled) {
			// Subscribe to all connected servers that support it
			for (const [name, connection] of this.#connections) {
				if (connection.capabilities.resources?.subscribe && connection.resources) {
					const uris = connection.resources.map(r => r.uri);
					this.#subscribeAndTrack(name, connection, uris, notificationEpoch);
				}
			}
			return;
		}

		// Unsubscribe from all servers
		for (const [name, connection] of this.#connections) {
			const uris = this.#subscribedResources.get(name);
			if (uris && uris.size > 0) {
				void unsubscribeFromResources(connection, Array.from(uris)).catch(error => {
					logger.debug("Failed to unsubscribe MCP resources", { path: `mcp:${name}`, error });
				});
			}
		}
		this.#subscribedResources.clear();
	}

	/**
	 * Set the auth storage for resolving OAuth credentials.
	 */
	setAuthStorage(authStorage: AuthStorage): void {
		this.#authStorage = authStorage;
	}

	/** Discover and connect to every MCP server the capability system reports. Returns tools and any connection errors. */
	async discoverAndConnect(options?: MCPDiscoverOptions): Promise<MCPLoadResult> {
		let loadedConfigs: LoadMCPConfigsResult;
		try {
			loadedConfigs = await loadAllMCPConfigs(this.cwd, {
				filterExa: options?.filterExa,
				filterBrowser: options?.filterBrowser,
				agentDir: options?.agentDir,
			});
		} catch (error) {
			const message = errorMessage(error);
			options?.onStatus?.({ type: "failed", serverName: MCP_CONFIG_STATUS_LABEL, error: message });
			throw error;
		}
		const { configs, exaApiKeys, sources, warnings } = loadedConfigs;
		const result = await this.connectServers(configs, sources, options?.onStatus);
		result.exaApiKeys = exaApiKeys;
		// AFTER `connectServers`, not before: its `connecting` event resets the subscriber's failed-server map, so a warning emitted first is wiped
		for (const warning of warnings) {
			this.#lastErrors.set(MCP_CONFIG_STATUS_LABEL, warning);
			options?.onStatus?.({ type: "failed", serverName: MCP_CONFIG_STATUS_LABEL, error: warning });
		}
		return result;
	}

	/** Connect to specific MCP servers. Connections are made in parallel for faster startup. */
	async connectServers(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
		onStatus?: (event: McpConnectionStatusEvent) => void,
	): Promise<MCPLoadResult> {
		type ConnectionTask = {
			name: string;
			config: MCPServerConfig;
			tracked: TrackedPromise<ToolLoadResult>;
			toolsPromise: Promise<ToolLoadResult>;
		};

		const errors = new Map<string, string>();
		const connectedServers = new Set<string>();
		const allTools: CustomTool<TSchema, MCPToolDetails>[] = [];
		const reportedErrors = new Set<string>();
		let allowBackgroundLogging = false;
		const statusServerNames: string[] = [];
		const validationFailures: Array<{ name: string; message: string }> = [];

		// Prepare connection tasks
		const connectionTasks: ConnectionTask[] = [];

		for (const [name, config] of Object.entries(configs)) {
			if (sources[name]) {
				this.#sources.set(name, sources[name]);
				const existing = this.#connections.get(name);
				if (existing) {
					existing._source = sources[name];
				}
			}

			// Skip if already connected
			if (this.#connections.has(name)) {
				connectedServers.add(name);
				continue;
			}

			if (
				this.#pendingConnections.has(name) ||
				this.#pendingToolLoads.has(name) ||
				this.#pendingReconnections.has(name)
			) {
				continue;
			}

			statusServerNames.push(name);

			// Validate config
			const validationErrors = validateServerConfig(name, config);
			if (validationErrors.length > 0) {
				const message = validationErrors.join("; ");
				errors.set(name, message);
				validationFailures.push({ name, message });
				reportedErrors.add(name);
				continue;
			}

			// Save config early so reconnection works even if the initial connect times out
			// and falls back to cached/deferred tools.
			this.#serverConfigs.set(name, config);

			// Resolve auth config before connecting, but do so per-server in parallel.
			const connectionPromise = (async () => {
				const resolvedConfig = await this.#resolveAuthConfig(config);
				return connectToServer(name, resolvedConfig, {
					onNotification: (method, params) => {
						this.#handleServerNotification(name, method, params);
					},
					onRequest: (method, params) => {
						return this.#handleServerRequest(method, params);
					},
					...this.#stdioSpawnHooks(),
				});
			})().then(
				connection => {
					// Store original config (without resolved tokens) to keep
					// cache keys stable and avoid leaking rotating credentials.
					connection.config = config;
					this.#serverConfigs.set(name, config);
					if (sources[name]) {
						connection._source = sources[name];
					}
					if (this.#pendingConnections.get(name) === connectionPromise) {
						this.#pendingConnections.delete(name);
						this.#connections.set(name, connection);
					}

					// Wire auth refresh for HTTP-like transports so 401s trigger a fresh credential. Two kinds qualify, and the second used to be missed entirely: a resolvable
					if (
						isAuthRefreshableMCPTransport(connection.transport) &&
						(lookupMcpOAuthCredential(this.#authStorage, config) || hasMcpConfigCommands(config))
					) {
						connection.transport.onAuthError = async () => {
							const refreshed = await this.#resolveAuthConfig(config, {
								forceRefresh: true,
								refreshCommands: true,
							});
							if (refreshed.type === "http" || refreshed.type === "sse") {
								return refreshed.headers ?? null;
							}
							return null;
						};
					}

					// Re-establish connection if the transport closes (server restart,
					// network interruption).
					connection.transport.onClose = () => {
						logger.debug("MCP transport lost, triggering reconnect", { path: `mcp:${name}` });
						void this.reconnectServer(name);
					};

					return connection;
				},
				error => {
					if (this.#pendingConnections.get(name) === connectionPromise) {
						this.#pendingConnections.delete(name);
					}
					throw error;
				},
			);
			this.#pendingConnections.set(name, connectionPromise);

			const toolsPromise = connectionPromise.then(async connection => {
				const serverTools = await listTools(connection);
				return { connection, serverTools };
			});
			this.#pendingToolLoads.set(name, toolsPromise);

			const tracked = trackPromise(toolsPromise);
			connectionTasks.push({ name, config, tracked, toolsPromise });

			void toolsPromise
				.then(async ({ connection, serverTools }) => {
					if (this.#pendingToolLoads.get(name) !== toolsPromise) return;
					this.#pendingToolLoads.delete(name);
					const reconnect = () => this.reconnectServer(name);
					const customTools = MCPTool.fromTools(connection, serverTools, reconnect);
					this.#replaceServerTools(name, customTools);
					this.#onToolsChanged?.(this.#tools);
					void this.toolCache?.set(name, config, serverTools);

					this.#lastErrors.delete(name);
					onStatus?.({ type: "connected", serverName: name });
					await this.#loadServerResourcesAndPrompts(name, connection);
				})
				.catch(error => {
					if (this.#pendingToolLoads.get(name) !== toolsPromise) return;
					this.#pendingToolLoads.delete(name);
					const message = errorMessage(error);
					this.#lastErrors.set(name, message);
					onStatus?.({ type: "failed", serverName: name, error: message, foreign: this.#isForeignServer(name) });
					if (!allowBackgroundLogging || reportedErrors.has(name)) return;
					logger.error("MCP tool load failed", { path: `mcp:${name}`, error: message });
				});
		}

		// Notify about servers we're connecting to, including configs that fail fast.
		if (statusServerNames.length > 0 && onStatus) {
			onStatus({ type: "connecting", serverNames: statusServerNames });
			for (const { name, message } of validationFailures) {
				this.#lastErrors.set(name, message);
				onStatus({ type: "failed", serverName: name, error: message, foreign: this.#isForeignServer(name) });
			}
		}

		if (connectionTasks.length > 0) {
			await Promise.race([
				Promise.allSettled(connectionTasks.map(task => task.tracked.promise)),
				Bun.sleep(STARTUP_TOOL_WAIT_MS),
			]);

			const cachedTools = new Map<string, MCPToolDefinition[]>();
			const pendingTasks = connectionTasks.filter(task => task.tracked.status === "pending");

			if (pendingTasks.length > 0 && this.toolCache) {
				await Promise.all(
					pendingTasks.map(async task => {
						const cached = await this.toolCache?.get(task.name, task.config);
						if (cached) {
							cachedTools.set(task.name, cached);
						}
					}),
				);
			}

			// Pending tasks without cached tools used to be awaited synchronously here, which gated the entire UI on the slowest server's per-request timeout

			for (const task of connectionTasks) {
				const { name } = task;
				if (task.tracked.status === "fulfilled") {
					const value = task.tracked.value;
					if (!value) continue;
					const { connection, serverTools } = value;
					connectedServers.add(name);
					const reconnect = () => this.reconnectServer(name);
					const mcpTools = MCPTool.fromTools(connection, serverTools, reconnect);
					for (let ti = 0; ti < mcpTools.length; ti++) allTools.push(mcpTools[ti]!);
				} else if (task.tracked.status === "rejected") {
					const message = errorMessage(task.tracked.reason);
					errors.set(name, message);
					reportedErrors.add(name);
				} else {
					const cached = cachedTools.get(name);
					if (cached) {
						const source = this.#sources.get(name);
						const reconnect = () => this.reconnectServer(name);
						const deferred = DeferredMCPTool.fromTools(
							name,
							cached,
							() => this.waitForConnection(name),
							source,
							reconnect,
						);
						for (let ti = 0; ti < deferred.length; ti++) allTools.push(deferred[ti]!);
					}
				}
			}
		}

		// Stable sort by name so the order is independent of connection completion.
		// See `sortMCPToolsByName` for the cache-stability rationale.
		sortMCPToolsByName(allTools);

		// Update cached tools
		this.#tools = allTools;
		allowBackgroundLogging = true;

		return {
			tools: allTools,
			errors,
			connectedServers: Array.from(connectedServers),
			exaApiKeys: [], // Will be populated by discoverAndConnect
		};
	}

	#replaceServerTools(name: string, tools: CustomTool<TSchema, MCPToolDetails>[]): void {
		// The prefix must be derived the same way the tool names were, or a server
		// whose name needed sanitizing keeps its stale tools AND gains a second
		// copy on every reconnect. See `mcpToolNamePrefix`.
		const prefix = mcpToolNamePrefix(name);
		this.#tools = this.#tools.filter(t => !t.name.startsWith(prefix));
		for (let ti = 0; ti < tools.length; ti++) this.#tools.push(tools[ti]!);
		// Stable sort by name so reconnect order does not perturb the array.
		// See `sortMCPToolsByName` for the cache-stability rationale.
		sortMCPToolsByName(this.#tools);
	}

	#triggerNotificationRefresh(serverName: string, kind: "tools" | "resources" | "prompts"): void {
		const refresh = (() => {
			switch (kind) {
				case "tools":
					return this.refreshServerTools(serverName);
				case "resources":
					return this.refreshServerResources(serverName);
				case "prompts":
					return this.refreshServerPrompts(serverName);
			}
		})();
		void refresh.catch(error => {
			logger.debug("Failed MCP notification refresh", { path: `mcp:${serverName}`, kind, error });
		});
	}
	#handleServerNotification(serverName: string, method: string, params: unknown): void {
		logger.debug("MCP notification received", { path: `mcp:${serverName}`, method });

		switch (method) {
			case MCPNotificationMethods.TOOLS_LIST_CHANGED:
				this.#triggerNotificationRefresh(serverName, "tools");
				break;
			case MCPNotificationMethods.RESOURCES_LIST_CHANGED:
				this.#triggerNotificationRefresh(serverName, "resources");
				break;
			case MCPNotificationMethods.RESOURCES_UPDATED: {
				const uri = (params as { uri?: string })?.uri;
				const subscribed = this.#subscribedResources.get(serverName);
				if (uri && subscribed?.has(uri)) {
					this.#onResourcesChanged?.(serverName, uri);
				}
				break;
			}
			case MCPNotificationMethods.PROMPTS_LIST_CHANGED:
				this.#triggerNotificationRefresh(serverName, "prompts");
				break;
			default:
				break;
		}

		this.#onNotification?.(serverName, method, params);
	}

	/** Handle server-to-client JSON-RPC requests (e.g. ping, roots/list). */
	async #handleServerRequest(method: string, _params: unknown): Promise<unknown> {
		switch (method) {
			case "ping":
				return {};
			case "roots/list":
				return this.#getRoots();
			default:
				throw Object.assign(
					new Error(
						`This MCP client does not implement the server-to-client request "${method}". It answers "ping" and "roots/list" only. Fix: nothing for the operator to do; the server should treat -32601 as "unsupported" and continue. If it does not, report the method name to the server's maintainer.`,
					),
					{ code: -32601 },
				);
		}
	}

	#getRoots(): { roots: Array<{ uri: string; name: string }> } {
		return {
			roots: [
				{
					uri: url.pathToFileURL(this.cwd).href,
					name: path.basename(this.cwd),
				},
			],
		};
	}

	/**
	 * Get all loaded tools.
	 */
	getTools(): CustomTool<TSchema, MCPToolDetails>[] {
		return this.#tools;
	}

	/**
	 * Get a specific connection.
	 */
	getConnection(name: string): MCPServerConnection | undefined {
		return this.#connections.get(name);
	}

	/**
	 * Get current connection status for a server.
	 */
	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected" {
		if (this.#connections.has(name)) return "connected";
		if (
			this.#pendingConnections.has(name) ||
			this.#pendingToolLoads.has(name) ||
			this.#pendingReconnections.has(name)
		)
			return "connecting";
		return "disconnected";
	}

	/** The last connection failure for a server, if it failed and has not since reconnected. Lets `/mcp list` explain a "not connected" server instead of */
	getLastError(name: string): string | undefined {
		if (this.#connections.has(name)) return undefined;
		return this.#lastErrors.get(name);
	}

	/**
	 * Get the source metadata for a server.
	 */
	getSource(name: string): SourceMeta | undefined {
		return this.#sources.get(name) ?? this.#connections.get(name)?._source;
	}

	/** True when the server was imported from another tool's config (Claude Code, Codex, …). */
	#isForeignServer(name: string): boolean {
		const provider = this.getSource(name)?.provider;
		return provider !== undefined && FOREIGN_PROVIDER_IDS.has(provider);
	}

	/** Get the preserved (pre-auth) config for a known server — whether currently connected or merely discovered (a connect was attempted but may have failed, */
	getServerConfig(name: string): MCPServerConfig | undefined {
		return this.#connections.get(name)?.config ?? this.#serverConfigs.get(name);
	}

	/**
	 * Wait for a connection to complete (or fail).
	 */
	async waitForConnection(name: string): Promise<MCPServerConnection> {
		const connection = this.#connections.get(name);
		if (connection) return connection;
		const pending = this.#pendingConnections.get(name);
		if (pending) return pending;
		// If a reconnection is in flight, wait for it to complete
		const reconnecting = this.#pendingReconnections.get(name);
		if (reconnecting) {
			const result = await reconnecting;
			if (result) return result;
		}
		throw new Error(
			`MCP server "${name}" is not connected, and no connection or reconnection to it is in flight. Fix: run \`/mcp list\` to check the name and whether the server is enabled, then \`/mcp reconnect ${name}\`. \`/mcp test ${name}\` reports why the connection fails.`,
		);
	}

	/** Resolve auth and shell-command substitutions in config before connecting. Pass `oauth: false` to skip OAuth credential injection (used by reauth's */
	async prepareConfig(config: MCPServerConfig, options?: { oauth?: boolean }): Promise<MCPServerConfig> {
		return this.#resolveAuthConfig(config, options);
	}

	/**
	 * Get all connected server names.
	 */
	getConnectedServers(): string[] {
		return Array.from(this.#connections.keys());
	}

	/**
	 * Get all known server names (connected, connecting, or discovered).
	 */
	getAllServerNames(): string[] {
		const names = new Set<string>(this.#sources.keys());
		for (const name of this.#connections.keys()) names.add(name);
		for (const name of this.#pendingConnections.keys()) names.add(name);
		return Array.from(names);
	}

	/**
	 * Disconnect from a specific server.
	 */
	async disconnectServer(name: string): Promise<void> {
		this.#pendingConnections.delete(name);
		this.#pendingToolLoads.delete(name);
		this.#pendingReconnections.delete(name);
		this.#sources.delete(name);
		this.#serverConfigs.delete(name);
		this.#pendingResourceRefresh.delete(name);
		this.#reconnectHistory.delete(name);

		const connection = this.#connections.get(name);

		const subscribedUris = this.#subscribedResources.get(name);
		if (subscribedUris && subscribedUris.size > 0 && connection) {
			// The connection is disconnected a few lines below, which drops every subscription with it, so an
			// unsubscribe that fails costs nothing: it is a courtesy to the server, not state we still need.
			void unsubscribeFromResources(connection, Array.from(subscribedUris)).catch(() => {});
		}
		this.#subscribedResources.delete(name);

		if (connection) {
			// Detach onClose to prevent spurious reconnect from close()
			connection.transport.onClose = undefined;
			await disconnectServer(connection);
			this.#connections.delete(name);
		}

		// Remove tools from this server and notify consumers
		const hadTools = this.#tools.some(t => t.name.startsWith(`mcp__${name}_`));
		// The prefix must be derived the same way the tool names were, or a server
		// whose name needed sanitizing keeps its stale tools AND gains a second
		// copy on every reconnect. See `mcpToolNamePrefix`.
		const prefix = mcpToolNamePrefix(name);
		this.#tools = this.#tools.filter(t => !t.name.startsWith(prefix));
		if (hadTools) this.#onToolsChanged?.(this.#tools);

		// Notify prompt consumers so stale commands are cleared
		if (connection?.prompts?.length) this.#onPromptsChanged?.(name);
	}

	/**
	 * Disconnect from all servers.
	 */
	async disconnectAll(): Promise<void> {
		// Invalidate any in-flight reconnection attempts that outlive this call.
		// They captured the old epoch; after increment they'll detect staleness.
		this.#epoch++;
		// Detach onClose before closing to prevent spurious reconnect attempts
		for (const conn of this.#connections.values()) {
			conn.transport.onClose = undefined;
		}
		const promises = Array.from(this.#connections.values()).map(conn => disconnectServer(conn));
		await Promise.allSettled(promises);

		this.#pendingConnections.clear();
		this.#pendingToolLoads.clear();
		this.#pendingReconnections.clear();
		this.#pendingResourceRefresh.clear();
		this.#sources.clear();
		this.#serverConfigs.clear();
		this.#connections.clear();
		this.#tools = [];
		this.#subscribedResources.clear();
		this.#reconnectHistory.clear();
	}

	/** Reconnect to a server after a connection failure. Tears down the stale connection, re-resolves auth, establishes a new */
	async reconnectServer(name: string, options?: { manual?: boolean }): Promise<MCPServerConnection | null> {
		if (options?.manual) {
			this.#reconnectHistory.delete(name);
			// An operator-driven reconnect is the recovery step after rotating a secret, so this server's `!command` credentials are re-read rather than re-sent. An automatic
			this.invalidateCommandCredentials(name);
		}

		const pending = this.#pendingReconnections.get(name);
		if (pending) return pending;

		if (this.#tripReconnectBreaker(name)) {
			return null;
		}

		const attempt = this.#doReconnect(name);
		this.#pendingReconnections.set(name, attempt);
		return attempt.finally(() => this.#pendingReconnections.delete(name));
	}

	/** Drop the cached output of the `!command` credentials of one server, or of every configured server when no name is given, and report how many commands were dropped. */
	invalidateCommandCredentials(name?: string): number {
		const configs =
			name === undefined
				? Array.from(this.#serverConfigs.values())
				: [this.#connections.get(name)?.config ?? this.#serverConfigs.get(name)].filter(
						(config): config is MCPServerConfig => config !== undefined,
					);
		const commands = new Set<string>();
		for (const config of configs) {
			for (const value of mcpConfigCommandValues(config)) commands.add(value);
		}
		for (const command of commands) invalidateConfigValue(command);
		return commands.size;
	}

	/** Record a reconnect attempt against the per-server crash window and report whether the circuit breaker is now open. Sliding window: entries older */
	#tripReconnectBreaker(name: string): boolean {
		const now = Date.now();
		const previous = this.#reconnectHistory.get(name) ?? [];
		const recent = previous.filter(ts => now - ts < RECONNECT_BURST_WINDOW_MS);
		recent.push(now);
		this.#reconnectHistory.set(name, recent);

		if (recent.length > RECONNECT_BURST_LIMIT) {
			logger.error("MCP server crashed too many times; suspending automatic reconnects", {
				path: `mcp:${name}`,
				crashes: recent.length,
				windowMs: RECONNECT_BURST_WINDOW_MS,
			});
			// Tear down the stale connection so `getConnectionStatus()` no longer reports it as "connected" and `waitForConnection()` does
			const stale = this.#connections.get(name);
			if (stale) {
				stale.transport.onClose = undefined;
				void stale.transport.close().catch(() => {});
				this.#connections.delete(name);
			}
			this.#pendingConnections.delete(name);
			this.#pendingToolLoads.delete(name);
			return true;
		}
		return false;
	}

	async #doReconnect(name: string): Promise<MCPServerConnection | null> {
		const oldConnection = this.#connections.get(name);
		const config = oldConnection?.config ?? this.#serverConfigs.get(name);
		const source = this.#sources.get(name) ?? oldConnection?._source;
		if (!config) return null;

		logger.debug("MCP reconnecting", { path: `mcp:${name}` });

		// Close the old transport without removing tools or notifying consumers. Tools stay available (stale) while we establish the new connection.
		const reconnectEpoch = this.#epoch;
		if (oldConnection) {
			// Detach onClose to prevent re-entrant reconnect from the close itself
			oldConnection.transport.onClose = undefined;
			closeTransportDetached(oldConnection.transport, name, "reconnect-replaced");
			this.#connections.delete(name);
		}
		this.#pendingConnections.delete(name);
		this.#pendingToolLoads.delete(name);

		// Retry with backoff — the server may still be starting up.
		const delays = [500, 1000, 2000, 4000];
		for (let attempt = 0; attempt <= delays.length; attempt++) {
			if (this.#epoch !== reconnectEpoch) {
				logger.debug("MCP reconnect aborted before attempt after configuration changed", {
					path: `mcp:${name}`,
					storedEpoch: reconnectEpoch,
					currentEpoch: this.#epoch,
				});
				return null;
			}
			try {
				const connection = await this.#connectAndWireServer(name, config, source, reconnectEpoch);
				logger.debug("MCP reconnected", { path: `mcp:${name}`, tools: connection.tools?.length ?? 0 });
				return connection;
			} catch (error) {
				if (this.#epoch !== reconnectEpoch) {
					logger.debug("MCP reconnect aborted after configuration changed", {
						path: `mcp:${name}`,
						storedEpoch: reconnectEpoch,
						currentEpoch: this.#epoch,
					});
					return null;
				}

				const msg = errorMessage(error);
				if (attempt < delays.length) {
					logger.debug("MCP reconnect attempt failed, retrying", {
						path: `mcp:${name}`,
						attempt: attempt + 1,
						error: msg,
					});
					await Bun.sleep(delays[attempt]);
				} else {
					logger.error("MCP reconnect failed after retries", { path: `mcp:${name}`, error: msg });
					// Don't remove stale tools — keep them in the registry so they remain selected. Calls will fail with MCP errors, which
				}
			}
		}
		return null;
	}

	/** Establish a new connection to a server, wire handlers, load tools. */
	async #connectAndWireServer(
		name: string,
		config: MCPServerConfig,
		source: SourceMeta | undefined,
		reconnectEpoch: number,
	): Promise<MCPServerConnection> {
		const resolvedConfig = await this.#resolveAuthConfig(config);
		const connection = await connectToServer(name, resolvedConfig, {
			onNotification: (method, params) => {
				this.#handleServerNotification(name, method, params);
			},
			onRequest: (method, params) => {
				return this.#handleServerRequest(method, params);
			},
			...this.#stdioSpawnHooks(),
		});

		connection.config = config;
		if (source) connection._source = source;

		// Bail out if the server was disconnected or the manager was reset
		// while we were connecting (e.g. /mcp reload called disconnectAll).
		if (!this.#serverConfigs.has(name) || this.#epoch !== reconnectEpoch) {
			closeTransportDetached(connection.transport, name, "reconnect-superseded");
			throw new Error(
				`MCP server "${name}" was removed or disabled while it was reconnecting, so the new connection was dropped rather than left orphaned. Fix: if you did not intend that, run \`/mcp enable ${name}\` and then \`/mcp reconnect ${name}\`; \`/mcp list\` shows the current state.`,
			);
		}

		this.#connections.set(name, connection);

		// Wire auth refresh for HTTP-like transports, and reconnect for any transport.
		// Same gate as connectServers: a resolvable managed credential, or a `!command` this
		// path can re-run.
		if (
			isAuthRefreshableMCPTransport(connection.transport) &&
			(lookupMcpOAuthCredential(this.#authStorage, config) || hasMcpConfigCommands(config))
		) {
			connection.transport.onAuthError = async () => {
				const refreshed = await this.#resolveAuthConfig(config, { forceRefresh: true, refreshCommands: true });
				if (refreshed.type === "http" || refreshed.type === "sse") {
					return refreshed.headers ?? null;
				}
				return null;
			};
		}
		connection.transport.onClose = () => {
			logger.debug("MCP transport lost, triggering reconnect", { path: `mcp:${name}` });
			void this.reconnectServer(name);
		};
		try {
			const serverTools = await listTools(connection);
			const reconnect = () => this.reconnectServer(name);
			const customTools = MCPTool.fromTools(connection, serverTools, reconnect);
			void this.toolCache?.set(name, config, serverTools);
			this.#replaceServerTools(name, customTools);
			this.#onToolsChanged?.(this.#tools);
			void this.#loadServerResourcesAndPrompts(name, connection);
			return connection;
		} catch (error) {
			// Clean up the connection to avoid zombie transports
			connection.transport.onClose = undefined;
			closeTransportDetached(connection.transport, name, "reconnect-tool-list-failed");
			this.#connections.delete(name);
			throw error;
		}
	}

	/** Best-effort loading of resources, resource subscriptions, and prompts. Shared between initial connection and reconnection. */
	async #loadServerResourcesAndPrompts(name: string, connection: MCPServerConnection): Promise<void> {
		if (serverSupportsResources(connection.capabilities)) {
			try {
				const [resources] = await Promise.all([listResources(connection), listResourceTemplates(connection)]);

				if (this.#notificationsEnabled && connection.capabilities.resources?.subscribe) {
					const uris = resources.map(r => r.uri);
					const notificationEpoch = this.#notificationsEpoch;
					this.#subscribeAndTrack(name, connection, uris, notificationEpoch);
				}
			} catch (error) {
				logger.debug("Failed to load MCP resources", { path: `mcp:${name}`, error });
			}
		}

		if (serverSupportsPrompts(connection.capabilities)) {
			try {
				await listPrompts(connection);
				this.#onPromptsChanged?.(name);
			} catch (error) {
				logger.debug("Failed to load MCP prompts", { path: `mcp:${name}`, error });
			}
		}
	}

	/**
	 * Refresh tools from a specific server.
	 */
	async refreshServerTools(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection) return;

		// Clear cached tools
		connection.tools = undefined;

		// Reload tools
		const serverTools = await listTools(connection);
		const reconnect = () => this.reconnectServer(name);
		const customTools = MCPTool.fromTools(connection, serverTools, reconnect);
		void this.toolCache?.set(name, connection.config, serverTools);

		// Replace tools from this server
		this.#replaceServerTools(name, customTools);
		this.#onToolsChanged?.(this.#tools);
	}

	/**
	 * Refresh tools from all servers.
	 */
	async refreshAllTools(): Promise<void> {
		const promises = Array.from(this.#connections.keys()).map(name => this.refreshServerTools(name));
		await Promise.allSettled(promises);
	}

	/**
	 * Refresh resources from a specific server.
	 */
	async refreshServerResources(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsResources(connection.capabilities)) return;

		const existing = this.#pendingResourceRefresh.get(name);
		if (existing && existing.connection === connection) return existing.promise;

		const doRefresh = async (): Promise<void> => {
			// Clear cached resources
			connection.resources = undefined;
			connection.resourceTemplates = undefined;

			// Reload
			const [resources] = await Promise.all([listResources(connection), listResourceTemplates(connection)]);
			if (this.#notificationsEnabled && connection.capabilities.resources?.subscribe) {
				const newUris = new Set(resources.map(r => r.uri));
				const oldUris = this.#subscribedResources.get(name);
				const notificationEpoch = this.#notificationsEpoch;

				// Unsubscribe URIs that were removed
				if (oldUris) {
					const removed = Array.from(oldUris).filter(uri => !newUris.has(uri));
					if (removed.length > 0) {
						try {
							await unsubscribeFromResources(connection, removed);
						} catch (error) {
							logger.debug("Failed to unsubscribe stale MCP resources", { path: `mcp:${name}`, error });
						}
					}
				}

				// Subscribe to the current set and update tracking atomically
				try {
					const allUris = Array.from(newUris);
					await subscribeToResources(connection, allUris);
					const action = resolveSubscriptionPostAction(
						this.#notificationsEnabled,
						this.#notificationsEpoch,
						notificationEpoch,
					);
					if (action === "rollback") {
						await unsubscribeFromResources(connection, allUris).catch(error => {
							logger.debug("Failed to rollback stale MCP resource subscription", { path: `mcp:${name}`, error });
						});
						return;
					}
					if (action === "ignore") {
						return;
					}
					this.#subscribedResources.set(name, newUris);
				} catch (error) {
					logger.debug("Failed to re-subscribe to MCP resources", { path: `mcp:${name}`, error });
				}
			}
		};

		const promise = doRefresh().finally(() => {
			const pending = this.#pendingResourceRefresh.get(name);
			if (pending?.promise === promise) {
				this.#pendingResourceRefresh.delete(name);
			}
		});
		this.#pendingResourceRefresh.set(name, { connection, promise });
		return promise;
	}

	/**
	 * Refresh prompts from a specific server.
	 */
	async refreshServerPrompts(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsPrompts(connection.capabilities)) return;

		connection.prompts = undefined;
		await listPrompts(connection);

		this.#onPromptsChanged?.(name);
	}

	/**
	 * Get resources and templates for a specific server.
	 */
	getServerResources(name: string): { resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return {
			resources: connection.resources ?? [],
			templates: connection.resourceTemplates ?? [],
		};
	}

	/**
	 * Read a specific resource from a server.
	 */
	async readServerResource(
		name: string,
		uri: string,
		options?: MCPRequestOptions,
	): Promise<MCPResourceReadResult | undefined> {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return readResource(connection, uri, options);
	}

	/**
	 * Get prompts for a specific server.
	 */
	getServerPrompts(name: string): MCPPrompt[] | undefined {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return connection.prompts ?? [];
	}

	/**
	 * Get a specific prompt from a server.
	 */
	async executePrompt(
		name: string,
		promptName: string,
		args?: Record<string, string>,
		options?: MCPRequestOptions,
	): Promise<MCPGetPromptResult | undefined> {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return getPrompt(connection, promptName, args, options);
	}

	/**
	 * Get all server instructions (for system prompt injection).
	 */
	getServerInstructions(): Map<string, string> {
		const instructions = new Map<string, string>();
		for (const [name, connection] of this.#connections) {
			if (connection.instructions) {
				instructions.set(name, connection.instructions);
			}
		}
		return instructions;
	}

	/**
	 * Get notification state for display.
	 */
	getNotificationState(): { enabled: boolean; subscriptions: Map<string, ReadonlySet<string>> } {
		return {
			enabled: this.#notificationsEnabled,
			subscriptions: this.#subscribedResources as Map<string, ReadonlySet<string>>,
		};
	}

	/** Resolve OAuth credentials and shell commands in config. `oauth: false` skips credential injection (reauth's unauthenticated probe); */
	async #resolveAuthConfig(
		config: MCPServerConfig,
		opts?: { forceRefresh?: boolean; oauth?: boolean; refreshCommands?: boolean },
	): Promise<MCPServerConfig> {
		if (opts?.refreshCommands) {
			for (const value of mcpConfigCommandValues(config)) invalidateConfigValue(value);
		}
		let resolved: MCPServerConfig = { ...config };

		const auth = config.auth;
		const lookup: MCPOAuthCredentialLookup | undefined =
			opts?.oauth !== false ? lookupMcpOAuthCredential(this.#authStorage, config) : undefined;
		if (lookup && this.#authStorage) {
			const { credentialId } = lookup;
			const observed: MCPStoredOAuthCredential = lookup.credential;
			// A credential that cannot be presented is not a reason to send an anonymous
			// request. `outcome` carries either the credential to inject or the reason the
			// connection is refused; see `auth-failure.ts` for why each reason differs.
			let outcome: MCPAuthResolution;
			try {
				const REFRESH_BUFFER_MS = 5 * 60_000;
				const refreshResult = await this.#authStorage.refreshStoredOAuthCredential<MCPStoredOAuthCredential>(
					credentialId,
					{
						observedCredential: observed,
						credentialFromRow: row => row,
						forceRefresh: opts?.forceRefresh,
						refreshSkewMs: REFRESH_BUFFER_MS,
						canRefresh: current => {
							const material = selectMcpOAuthRefreshMaterial(current, auth);
							return Boolean(current.refresh && material?.tokenUrl);
						},
						refresh: (current, signal) => {
							if (current.refresh === REMOTE_REFRESH_SENTINEL) {
								throw new MCPBrokerRedactedRefreshError(describeMCPServerTarget(config));
							}
							const material = selectMcpOAuthRefreshMaterial(current, auth);
							const tokenUrl = material?.tokenUrl;
							if (!current.refresh || !tokenUrl) {
								throw new Error(
									`The stored OAuth credential for ${describeMCPServerTarget(config)} has no refresh token or no token endpoint, so it cannot be refreshed and will stay expired. Fix: run \`/mcp reauth <name>\` to authorize again; \`/mcp list\` gives the server's name.`,
								);
							}
							const clientId = material?.clientId;
							const clientSecret = material?.clientSecret;
							const authorizationUrl =
								material && "authorizationUrl" in material ? material.authorizationUrl : undefined;
							const resourceIsFallback =
								!material?.resource && (config.type === "http" || config.type === "sse") && Boolean(config.url);
							const resource = material?.resource ?? (resourceIsFallback ? config.url : undefined);
							return refreshMCPOAuthToken(tokenUrl, current.refresh, clientId, clientSecret, resource, {
								authorizationUrl,
								stripSameOriginResource: resourceIsFallback,
								signal,
							});
						},
						mergeRefreshedCredential: (current, refreshed) => {
							const material = selectMcpOAuthRefreshMaterial(current, auth);
							const tokenUrl = material?.tokenUrl;
							const clientId = material?.clientId;
							const clientSecret = material?.clientSecret;
							const authorizationUrl =
								material && "authorizationUrl" in material ? material.authorizationUrl : undefined;
							const resourceIsFallback =
								!material?.resource && (config.type === "http" || config.type === "sse") && Boolean(config.url);
							const resource = material?.resource ?? (resourceIsFallback ? config.url : undefined);
							return {
								...current,
								...refreshed,
								tokenUrl,
								clientId,
								clientSecret,
								resource: resourceIsFallback ? undefined : resource,
								authorizationUrl,
							};
						},
						isDefinitiveFailure: error => isDefinitiveOAuthFailure(errorMessage(error)),
						disabledCause: error => `oauth refresh failed: ${errorMessage(error)}`,
						keepCredentialOnRefreshFailure: error => !(error instanceof MCPBrokerRedactedRefreshError),
						onRefreshFailure: refreshError => {
							if (refreshError instanceof MCPBrokerRedactedRefreshError) return;
							logger.warn("MCP OAuth refresh failed, using existing token", {
								credentialId,
								error: refreshError,
							});
						},
					},
				);
				if (refreshResult.removed) {
					logger.warn("MCP OAuth refresh failed definitively; cleared credential", { credentialId });
				}
				outcome = refreshResult.credential
					? { kind: "credential", credential: refreshResult.credential, brokerRedacted: false }
					: { kind: "failure", reason: "revoked" };
			} catch (error) {
				logger.warn("Failed to resolve OAuth credential", { credentialId, error });
				outcome = classifyMcpAuthFailure(error, observed, Date.now());
			}

			if (outcome.kind === "failure") {
				throw new MCPAuthRequiredError(outcome.reason, describeMCPServerTarget(config), {
					cause: outcome.cause,
				});
			}
			if (outcome.brokerRedacted) {
				// The access token still works, so the session continues; the operator is
				// told once, here, rather than at the 401 this will become when it expires.
				logger.warn("MCP OAuth refresh token is broker-held; using the unexpired access token", {
					credentialId,
				});
			}
			const credential = outcome.credential;
			if (resolved.type === "http" || resolved.type === "sse") {
				resolved = {
					...resolved,
					headers: {
						...resolved.headers,
						Authorization: `Bearer ${credential.access}`,
					},
				};
			} else {
				resolved = {
					...resolved,
					env: {
						...resolved.env,
						OAUTH_ACCESS_TOKEN: credential.access,
					},
				};
			}
		}

		const requireResolved = async (key: string, value: string, describedAs: string): Promise<string | undefined> => {
			const present = await resolveConfigValue(value, `${describedAs} "${key}"`);
			if (present) return present;
			const reference = describeConfigEnvReference(value);
			if (!reference) return undefined;
			// An unresolved REFERENCE is fatal: proceeding means dialling the server with
			// the variable's own name as the credential. A failed `!command` is not
			// handled here — it has its own back-off and report, and its key is skipped.
			throw new MCPUnresolvedEnvReferenceError({
				variable: reference.variable,
				empty: process.env[reference.variable] !== undefined,
				describedAs: `${describedAs} "${key}"`,
				target: describeMCPServerTarget(config),
			});
		};

		if (resolved.type !== "http" && resolved.type !== "sse") {
			if (resolved.env) {
				const nextEnv: Record<string, string> = {};
				for (const [key, value] of Object.entries(resolved.env)) {
					const resolvedValue = await requireResolved(key, value, "environment variable");
					if (resolvedValue) nextEnv[key] = resolvedValue;
				}
				resolved = { ...resolved, env: nextEnv };
			}
		} else {
			if (resolved.headers) {
				const nextHeaders: Record<string, string> = {};
				for (const [key, value] of Object.entries(resolved.headers)) {
					const resolvedValue = await requireResolved(key, value, "header");
					if (resolvedValue) nextHeaders[key] = resolvedValue;
				}
				resolved = { ...resolved, headers: nextHeaders };
			}
		}

		return resolved;
	}
}

/** Create an MCP manager and discover servers. Convenience function for quick setup. */
export async function createMCPManager(
	cwd: string,
	options?: MCPDiscoverOptions,
): Promise<{
	manager: MCPManager;
	result: MCPLoadResult;
}> {
	const manager = new MCPManager(cwd);
	const result = await manager.discoverAndConnect(options);
	return { manager, result };
}
