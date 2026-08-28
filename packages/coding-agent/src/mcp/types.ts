import type { SourceMeta } from "../capability/types";

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse<T = unknown> {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: T;
	error?: JsonRpcError;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface MCPAuthConfig {
	type: "oauth" | "apikey";
	credentialId?: string;
	tokenUrl?: string;
	clientId?: string;
	clientSecret?: string;
	resource?: string;
}

interface MCPServerConfigBase {
	enabled?: boolean;
	timeout?: number;
	auth?: MCPAuthConfig;
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
		prompt?: string;
	};
}

export interface MCPStdioServerConfig extends MCPServerConfigBase {
	type?: "stdio"; // Default if not specified
	command: string;
	args?: string[];
	env?: Record<string, string>;
	envPassthrough?: string[];
	inheritEnv?: boolean;
	cwd?: string;
}

export interface MCPHttpServerConfig extends MCPServerConfigBase {
	type: "http";
	url: string;
	headers?: Record<string, string>;
}

export interface MCPSseServerConfig extends MCPServerConfigBase {
	type: "sse";
	url: string;
	headers?: Record<string, string>;
}

export type MCPServerConfig = MCPStdioServerConfig | MCPHttpServerConfig | MCPSseServerConfig;

export const MCP_CONFIG_SCHEMA_URL =
	"https://raw.githubusercontent.com/santhreal/veyyon/main/packages/coding-agent/src/config/mcp-schema.json";

export interface MCPConfigFile {
	$schema?: string;
	mcpServers?: Record<string, MCPServerConfig>;
	disabledServers?: string[];
	enabledServers?: string[];
}

export interface MCPImplementation {
	name: string;
	version: string;
}

export interface MCPClientCapabilities {
	roots?: { listChanged?: boolean };
	sampling?: Record<string, never>;
	experimental?: Record<string, unknown>;
}

export interface MCPServerCapabilities {
	tools?: { listChanged?: boolean };
	resources?: { subscribe?: boolean; listChanged?: boolean };
	prompts?: { listChanged?: boolean };
	logging?: Record<string, never>;
	experimental?: Record<string, unknown>;
}

export interface MCPInitializeParams {
	protocolVersion: string;
	capabilities: MCPClientCapabilities;
	clientInfo: MCPImplementation;
}

export interface MCPInitializeResult {
	protocolVersion: string;
	capabilities: MCPServerCapabilities;
	serverInfo: MCPImplementation;
	instructions?: string;
}

export interface MCPToolDefinition {
	name: string;
	description?: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, unknown>;
		required?: string[];
		[key: string]: unknown;
	};
}

export interface MCPToolsListResult {
	tools: MCPToolDefinition[];
	nextCursor?: string;
}

export interface MCPToolCallParams {
	name: string;
	arguments?: Record<string, unknown>;
}

export interface MCPTextContent {
	type: "text";
	text: string;
}

export interface MCPImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

export interface MCPResourceContent {
	type: "resource";
	resource: {
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	};
}

export type MCPContent = MCPTextContent | MCPImageContent | MCPResourceContent;

export interface MCPToolCallResult {
	content: MCPContent[];
	isError?: boolean;
}

export interface MCPRequestOptions {
	signal?: AbortSignal;
}

export interface MCPTransport {
	request<T = unknown>(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T>;

	notify(method: string, params?: Record<string, unknown>): Promise<void>;

	close(): Promise<void>;

	readonly connected: boolean;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
}

export type TransportFactory = (config: MCPServerConfig) => Promise<MCPTransport>;

export interface MCPServerConnection {
	name: string;
	config: MCPServerConfig;
	transport: MCPTransport;
	serverInfo: MCPImplementation;
	capabilities: MCPServerCapabilities;
	tools?: MCPToolDefinition[];
	_source?: SourceMeta;
	resources?: MCPResource[];
	resourceTemplates?: MCPResourceTemplate[];
	instructions?: string;
	prompts?: MCPPrompt[];
}

export interface MCPToolWithServer {
	server: MCPServerConnection;
	tool: MCPToolDefinition;
}

export interface MCPAnnotations {
	audience?: ("user" | "assistant")[];
	priority?: number;
	lastModified?: string;
}

export interface MCPResource {
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
	annotations?: MCPAnnotations;
}

export interface MCPResourceTemplate {
	uriTemplate: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	annotations?: MCPAnnotations;
}

export interface MCPResourcesListResult {
	resources: MCPResource[];
	nextCursor?: string;
}

export interface MCPResourceTemplatesListResult {
	resourceTemplates: MCPResourceTemplate[];
	nextCursor?: string;
}

export interface MCPResourceContentItem {
	uri: string;
	mimeType?: string;
	text?: string;
	blob?: string;
}

export interface MCPResourceReadResult {
	contents: MCPResourceContentItem[];
}

export interface MCPResourceReadParams {
	uri: string;
}

export interface MCPResourceSubscribeParams {
	uri: string;
}

export interface MCPPromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

export interface MCPPrompt {
	name: string;
	title?: string;
	description?: string;
	arguments?: MCPPromptArgument[];
}

export interface MCPPromptsListResult {
	prompts: MCPPrompt[];
	nextCursor?: string;
}

export interface MCPAudioContent {
	type: "audio";
	data: string;
	mimeType: string;
}

export type MCPPromptContent = MCPTextContent | MCPImageContent | MCPAudioContent | MCPResourceContent;

export interface MCPPromptMessage {
	role: "user" | "assistant";
	content: MCPPromptContent | MCPPromptContent[];
}

export interface MCPGetPromptParams {
	name: string;
	arguments?: Record<string, string>;
}

export interface MCPGetPromptResult {
	description?: string;
	messages: MCPPromptMessage[];
}

export const MCPNotificationMethods = {
	TOOLS_LIST_CHANGED: "notifications/tools/list_changed",
	RESOURCES_LIST_CHANGED: "notifications/resources/list_changed",
	RESOURCES_UPDATED: "notifications/resources/updated",
	PROMPTS_LIST_CHANGED: "notifications/prompts/list_changed",
} as const;

export function toJsonRpcError(error: unknown): JsonRpcError {
	if (error instanceof Error) {
		const code = "code" in error && typeof error.code === "number" ? error.code : -32603;
		return { code, message: error.message };
	}
	if (typeof error === "string") {
		return { code: -32603, message: error.length > 0 ? error : "Internal error" };
	}
	if (typeof error === "object" && error !== null) {
		const obj = error as Record<string, unknown>;
		if (typeof obj.code === "number" && typeof obj.message === "string") {
			return { code: obj.code, message: obj.message };
		}
	}
	return { code: -32603, message: "Internal error" };
}
