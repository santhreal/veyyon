import type { AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type {
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolResult,
	RpcHostToolUpdate,
} from "./rpc-types";

export type RpcHostToolOutput = (frame: RpcHostToolCallRequest | RpcHostToolCancelRequest) => void;

export type PendingHostToolCall = {
	resolve: (result: AgentToolResult<unknown>) => void;
	reject: (error: Error) => void;
	onUpdate?: AgentToolUpdateCallback<unknown>;
};

export function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
	if (!value || typeof value !== "object") return false;
	const content = (value as { content?: unknown }).content;
	return Array.isArray(content);
}

export function isRpcHostToolResult(value: unknown): value is RpcHostToolResult {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; result?: unknown };
	return frame.type === "host_tool_result" && typeof frame.id === "string" && isAgentToolResult(frame.result);
}

export function isRpcHostToolUpdate(value: unknown): value is RpcHostToolUpdate {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; partialResult?: unknown };
	return frame.type === "host_tool_update" && typeof frame.id === "string" && isAgentToolResult(frame.partialResult);
}
