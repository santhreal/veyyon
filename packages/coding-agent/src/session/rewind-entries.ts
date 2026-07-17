/**
 * Rewind/checkpoint session-entry inspection: recover completed-rewind state
 * and checkpoint timestamps from persisted entries, and sanitize assistant
 * messages that get reparented under a different user turn.
 */
import type { SessionMessageEntry } from "@veyyon/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, TextContent } from "@veyyon/pi-ai";
import { getStringProperty } from "@veyyon/pi-utils";
import type { CompletedRewindState } from "../tools/checkpoint";
import type { SessionEntry } from "./session-entries";

function customMessageContentText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

function reportFromRewindReportContent(content: string): string {
	const marker = "\nReport:\n";
	const index = content.lastIndexOf(marker);
	const report = index >= 0 ? content.slice(index + marker.length) : content;
	return report.trim();
}

export function completedRewindFromEntry(entry: SessionEntry): CompletedRewindState | undefined {
	if (entry.type !== "custom_message" || entry.customType !== "rewind-report") return undefined;
	const details = entry.details;
	if (!details || typeof details !== "object") return undefined;
	const startedAt = getStringProperty(details, "startedAt");
	const rewoundAt = getStringProperty(details, "rewoundAt");
	if (!startedAt || !rewoundAt) return undefined;
	const report =
		getStringProperty(details, "report")?.trim() ||
		reportFromRewindReportContent(customMessageContentText(entry.content));
	return report.length > 0 ? { report, startedAt, rewoundAt } : undefined;
}

export function isSuccessfulCheckpointEntry(entry: SessionEntry): entry is SessionMessageEntry & {
	message: { role: "toolResult"; toolName: "checkpoint"; isError?: false };
} {
	return (
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolName === "checkpoint" &&
		entry.message.isError !== true
	);
}

export function checkpointStartedAtFromEntry(entry: SessionEntry): string | undefined {
	if (!isSuccessfulCheckpointEntry(entry)) return undefined;
	const details = entry.message.details;
	if (details && typeof details === "object") {
		const startedAt = getStringProperty(details, "startedAt");
		if (startedAt) return startedAt;
	}
	return entry.timestamp;
}

// A side-channel assistant response is signed for the hidden prompt/history that
// produced it. If we persist that response under a different user turn, native
// replay anchors become invalid; keep only visible, non-cryptographic content.
export function sanitizeAssistantForReparentedHistory(message: AssistantMessage): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "redactedThinking") continue;
		if (block.type === "thinking") {
			content.push({ type: "thinking", thinking: block.thinking });
			continue;
		}
		content.push(block);
	}
	return { ...message, content, providerPayload: undefined };
}
