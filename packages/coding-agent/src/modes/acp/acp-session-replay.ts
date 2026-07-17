import type { AgentSideConnection, PromptRequest, SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentToolResult } from "@veyyon/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { type BlobStore, resolveImageDataSync } from "../../session/blob-store";
import { isSilentAbort } from "../../session/messages";
import { canonicalizeMessage } from "../../utils/thinking-display";
import {
	buildToolCallStartUpdate,
	mapAgentSessionEventToAcpSessionUpdates,
	normalizeReplayToolArguments,
} from "./acp-event-mapper";

type ReplayableMessage = {
	role: string;
	content?: unknown;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
	isError?: boolean;
};

type ReplayableToolItem = {
	type?: unknown;
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
	input?: unknown;
};

/**
 * Replay a loaded session's stored messages to the ACP client as session
 * notifications — user/assistant chunks, thought chunks, and reconstructed
 * tool call start/end pairs (deduplicated so a tool call replayed from the
 * assistant message is not re-started by its tool result).
 */
export async function replaySessionHistory(
	connection: Pick<AgentSideConnection, "sessionUpdate">,
	blobs: BlobStore,
	session: AgentSession,
): Promise<void> {
	const cwd = session.sessionManager.getCwd();
	const replayedToolCallIds = new Set<string>();
	const replayedToolCallArgs = new Map<string, unknown>();
	for (const message of session.sessionManager.buildSessionContext().messages as ReplayableMessage[]) {
		for (const notification of messageToReplayNotifications(
			blobs,
			session.sessionId,
			message,
			cwd,
			replayedToolCallIds,
			replayedToolCallArgs,
		)) {
			await connection.sessionUpdate(notification);
		}
	}
}

function messageToReplayNotifications(
	blobs: BlobStore,
	sessionId: string,
	message: ReplayableMessage,
	cwd: string,
	replayedToolCallIds: Set<string>,
	replayedToolCallArgs: Map<string, unknown>,
): SessionNotification[] {
	if (message.role === "assistant") {
		return replayAssistantMessage(sessionId, message, cwd, replayedToolCallIds, replayedToolCallArgs);
	}
	if (
		message.role === "user" ||
		message.role === "developer" ||
		message.role === "custom" ||
		message.role === "hookMessage"
	) {
		return wrapReplayContent(
			sessionId,
			extractReplayContent(message.content, undefined),
			"user_message_chunk",
			crypto.randomUUID(),
		);
	}
	if (
		message.role === "toolResult" &&
		typeof message.toolCallId === "string" &&
		typeof message.toolName === "string"
	) {
		return replayToolResult(
			blobs,
			sessionId,
			cwd,
			{
				...message,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
			},
			{
				includeStart: !replayedToolCallIds.has(message.toolCallId),
				toolArgs: replayedToolCallArgs.get(message.toolCallId),
			},
		);
	}
	if (message.role === "bashExecution" || message.role === "pythonExecution" || message.role === "compactionSummary") {
		return wrapReplayContent(
			sessionId,
			extractReplayContent(message.content, undefined),
			"user_message_chunk",
			crypto.randomUUID(),
		);
	}
	return [];
}

function replayAssistantMessage(
	sessionId: string,
	message: ReplayableMessage,
	cwd: string,
	replayedToolCallIds: Set<string>,
	replayedToolCallArgs: Map<string, unknown>,
): SessionNotification[] {
	const notifications: SessionNotification[] = [];
	const messageId = crypto.randomUUID();
	if (Array.isArray(message.content)) {
		for (const item of message.content) {
			if (typeof item !== "object" || item === null || !("type" in item)) {
				continue;
			}
			if (item.type === "text" && "text" in item && typeof item.text === "string" && item.text.length > 0) {
				notifications.push({
					sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: item.text },
						messageId,
					},
				});
				continue;
			}
			if (item.type === "thinking" && "thinking" in item && typeof item.thinking === "string") {
				const thinking = canonicalizeMessage(item.thinking);
				if (thinking.length === 0) continue;
				notifications.push({
					sessionId,
					update: {
						sessionUpdate: "agent_thought_chunk",
						content: { type: "text", text: thinking },
						messageId,
					},
				});
				continue;
			}
			const toolItem = item as ReplayableToolItem;
			if (
				(toolItem.type === "toolCall" || toolItem.type === "tool_use") &&
				typeof toolItem.id === "string" &&
				typeof toolItem.name === "string"
			) {
				const args = buildReplayAssistantToolArgs(toolItem);
				const update = buildToolCallStartUpdate({
					toolCallId: toolItem.id,
					toolName: toolItem.name,
					args,
					status: "completed",
					cwd,
				});
				notifications.push({ sessionId, update });
				replayedToolCallIds.add(toolItem.id);
				replayedToolCallArgs.set(toolItem.id, args);
			}
		}
	}
	if (notifications.length === 0 && message.errorMessage && !isSilentAbort(message)) {
		notifications.push({
			sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: message.errorMessage },
				messageId,
			},
		});
	}
	return notifications;
}

function buildReplayAssistantToolArgs(item: ReplayableToolItem): unknown {
	if ("arguments" in item) {
		return normalizeReplayToolArguments(item.arguments).args;
	}
	if (item.type === "tool_use" && "input" in item) {
		return item.input;
	}
	return {};
}

function replayToolResult(
	blobs: BlobStore,
	sessionId: string,
	cwd: string,
	message: Required<Pick<ReplayableMessage, "toolCallId" | "toolName">> & ReplayableMessage,
	options: { includeStart?: boolean; toolArgs?: unknown } = {},
): SessionNotification[] {
	const args = buildReplayToolArgs(message.details);
	const startEvent: AgentSessionEvent = {
		type: "tool_execution_start",
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		args,
	};
	const endEvent: AgentSessionEvent = {
		type: "tool_execution_end",
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		isError: message.isError === true,
		// Replayed from persisted session state: the on-disk shape is the
		// tool-result content the session originally recorded, plus the legacy
		// `errorMessage` field the ACP mapper still coerces into readable text.
		result: {
			content: message.content,
			details: message.details,
			errorMessage: message.errorMessage,
		} as unknown as AgentToolResult<unknown>,
	};
	const notifications = mapAgentSessionEventToAcpSessionUpdates(endEvent, sessionId, {
		cwd,
		getToolArgs: toolCallId => (toolCallId === message.toolCallId ? options.toolArgs : undefined),
		resolveImageData: (data, _mimeType) => resolveImageDataSync(blobs, data),
	});
	if (options.includeStart === false) {
		return notifications;
	}
	return [...mapAgentSessionEventToAcpSessionUpdates(startEvent, sessionId, { cwd }), ...notifications];
}

function buildReplayToolArgs(details: unknown): { path?: string } {
	if (typeof details !== "object" || details === null || !("path" in details)) {
		return {};
	}
	const value = (details as { path?: unknown }).path;
	return typeof value === "string" && value.length > 0 ? { path: value } : {};
}

function wrapReplayContent(
	sessionId: string,
	content: PromptRequest["prompt"],
	kind: "agent_message_chunk" | "user_message_chunk",
	messageId: string,
): SessionNotification[] {
	return content.map(block => ({
		sessionId,
		update: {
			sessionUpdate: kind,
			content: block,
			messageId,
		},
	}));
}

function extractReplayContent(content: unknown, errorMessage: string | undefined): PromptRequest["prompt"] {
	const replay: PromptRequest["prompt"] = [];
	if (Array.isArray(content)) {
		for (const item of content) {
			if (typeof item !== "object" || item === null || !("type" in item)) {
				continue;
			}
			if (item.type === "text" && "text" in item && typeof item.text === "string" && item.text.length > 0) {
				replay.push({ type: "text", text: item.text });
				continue;
			}
			if (
				item.type === "image" &&
				"data" in item &&
				"mimeType" in item &&
				typeof item.data === "string" &&
				typeof item.mimeType === "string"
			) {
				replay.push({ type: "image", data: item.data, mimeType: item.mimeType });
			}
		}
	}
	if (replay.length === 0 && errorMessage) {
		replay.push({ type: "text", text: errorMessage });
	}
	return replay;
}
