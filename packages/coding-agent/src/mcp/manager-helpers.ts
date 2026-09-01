import type { TSchema } from "@veyyon/ai";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { McpConnectionStatusEvent } from "./startup-events";
import type { MCPToolDetails } from "./tool-bridge";
import type { MCPServerConnection, MCPToolDefinition, MCPTransport } from "./types";

export type ToolLoadResult = {
	connection: MCPServerConnection;
	serverTools: MCPToolDefinition[];
};

export interface AuthRefreshableMCPTransport extends MCPTransport {
	onAuthError?: () => Promise<Record<string, string> | null>;
}

export function isAuthRefreshableMCPTransport(transport: MCPTransport): transport is AuthRefreshableMCPTransport {
	return "onAuthError" in transport;
}
export type TrackedPromise<T> = {
	promise: Promise<T>;
	status: "pending" | "fulfilled" | "rejected";
	value?: T;
	reason?: unknown;
};

export const STARTUP_TOOL_WAIT_MS = 250;

export const RECONNECT_BURST_WINDOW_MS = 30_000;
export const RECONNECT_BURST_LIMIT = 5;

export function trackPromise<T>(promise: Promise<T>): TrackedPromise<T> {
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
export interface MCPLoadResult {
	tools: CustomTool<TSchema, MCPToolDetails>[];
	errors: Map<string, string>;
	connectedServers: string[];
	exaApiKeys: string[];
}

export interface MCPDiscoverOptions {
	filterExa?: boolean;
	filterBrowser?: boolean;
	agentDir?: string;
	onStatus?: (event: McpConnectionStatusEvent) => void;
}
