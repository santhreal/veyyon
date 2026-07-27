import { errorMessage, isRecord } from "@veyyon/utils";
import { getToolDefinitions, handleToolCall, type ToolArguments, type ToolDefinition } from "./mcp-tools";

/**
 * A JSON-RPC request as this SERVER receives it: every field optional, because a client can send
 * anything and the handler has to answer malformed input rather than trust a shape.
 *
 * The client-side counterpart in `@veyyon/coding-agent/mcp/types` requires `jsonrpc`, `id` and
 * `method`, which is correct for a request this process BUILDS and wrong for one it PARSES. Both
 * were called `JsonRpcRequest`.
 */
export interface McpServerJsonRpcRequest {
	readonly jsonrpc?: string;
	readonly id?: string | number | null;
	readonly method?: string;
	readonly params?: Record<string, unknown>;
}

/**
 * A JSON-RPC response as this server SENDS it.
 *
 * `id` admits `null`, which the JSON-RPC 2.0 spec requires for an error the server could not
 * attribute to a request (a parse error, an invalid envelope). The client-side `JsonRpcResponse`
 * in `@veyyon/coding-agent/mcp/types` types `id` as `string | number` only, so the two disagreed
 * about the one case that matters most, under one name.
 */
export interface McpServerJsonRpcResponse {
	readonly jsonrpc: "2.0";
	readonly id: string | number | null;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string };
}

/**
 * The old names, kept because `@veyyon/mnemopi` is published.
 *
 * Deprecated: import the `McpServer`-prefixed spellings. Renamed exports rather than alias
 * declarations, so each name keeps exactly one declaration repo-wide.
 */
export type { McpServerJsonRpcRequest as JsonRpcRequest, McpServerJsonRpcResponse as JsonRpcResponse };

export interface ListToolsResponse {
	readonly tools: readonly ToolDefinition[];
}

export interface CallToolContent {
	readonly type: "text";
	readonly text: string;
}

export interface CallToolResponse {
	readonly content: readonly CallToolContent[];
	readonly isError?: boolean;
}

export interface WritableOutput {
	write(chunk: string): unknown;
}

function ok(id: string | number | null, result: unknown): McpServerJsonRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

function err(id: string | number | null, code: number, message: string): McpServerJsonRpcResponse {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function requestId(request: McpServerJsonRpcRequest): string | number | null {
	return typeof request.id === "string" || typeof request.id === "number" || request.id === null ? request.id : null;
}

function hasRequestId(request: McpServerJsonRpcRequest): boolean {
	return Object.hasOwn(request, "id");
}

export function listToolsJson(): ListToolsResponse {
	return { tools: getToolDefinitions() };
}

export async function callToolJson(name: string, args: ToolArguments = {}): Promise<CallToolResponse> {
	try {
		const result = await handleToolCall(name, args);
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
	} catch (error) {
		const message = errorMessage(error);
		return {
			content: [{ type: "text", text: JSON.stringify({ status: "error", message }, null, 2) }],
			isError: true,
		};
	}
}

export async function handleJsonRpc(request: McpServerJsonRpcRequest): Promise<McpServerJsonRpcResponse | null> {
	const method = request.method ?? "";
	if (method.startsWith("notifications/") || !hasRequestId(request)) return null;
	const id = requestId(request);
	if (method === "initialize") {
		return ok(id, {
			protocolVersion: "2024-11-05",
			serverInfo: { name: "mnemopi", version: "3.1.2" },
			capabilities: { tools: {} },
		});
	}
	if (method === "tools/list") return ok(id, listToolsJson());
	if (method === "tools/call") {
		const params = request.params ?? {};
		const name = typeof params.name === "string" ? params.name : "";
		const args = isRecord(params.arguments) ? (params.arguments as ToolArguments) : {};
		if (name.length === 0) return err(id, -32602, "tools/call requires params.name");
		return ok(id, await callToolJson(name, args));
	}
	return err(id, -32601, `Unknown method: ${method}`);
}

export async function runStdio(
	input: ReadableStream<Uint8Array> = Bun.stdin.stream(),
	output: WritableOutput = Bun.stdout,
): Promise<void> {
	const reader = input.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line.length > 0) {
					let parsed: unknown;
					try {
						parsed = JSON.parse(line);
					} catch {
						output.write(`${JSON.stringify(err(null, -32700, "Parse error"))}\n`);
						newline = buffer.indexOf("\n");
						continue;
					}
					const response = await handleJsonRpc(parsed as McpServerJsonRpcRequest);
					if (response !== null) output.write(`${JSON.stringify(response)}\n`);
				}
				newline = buffer.indexOf("\n");
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export function runMcpServer(
	transport = "stdio",
	options: { port?: number; bank?: string; host?: string } = {},
): Promise<void> {
	if (options.bank !== undefined && options.bank.length > 0) process.env.MNEMOPI_MCP_BANK = options.bank;
	if (transport !== "stdio") throw new Error("Only stdio transport is implemented in the TypeScript port");
	return runStdio();
}

export function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<void> {
	let transport = "stdio";
	let port: number | undefined;
	let bank: string | undefined;
	let host: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--transport") transport = argv[++i] ?? "stdio";
		else if (arg === "--port") {
			const parsed = Number(argv[++i] ?? "");
			if (Number.isFinite(parsed)) port = parsed;
		} else if (arg === "--bank") bank = argv[++i] ?? "";
		else if (arg === "--host") host = argv[++i] ?? "";
	}
	return runMcpServer(transport, { port, bank, host });
}

if (import.meta.main) await main();
