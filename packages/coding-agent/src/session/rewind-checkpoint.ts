/**
 * Rewind and checkpoint facts recovered from persisted session entries.
 *
 * A resumed session reconstructs its last checkpoint start and its last
 * completed rewind by scanning entries an earlier run wrote. Every read here
 * takes one entry and returns a value; none of it touches live session state.
 */

import type { ImageContent, TextContent } from "@veyyon/ai";
import { TOOL } from "../tools/builtin-names";
import type { CompletedRewindState } from "../tools/checkpoint";
import type { SessionEntry, SessionMessageEntry } from "./session-entries";

function customMessageContentText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

/**
 * Read `key` off `value` as a string, considering own data properties only, so
 * an inherited member never answers for a field the entry does not carry.
 */
function stringProperty(value: object, key: string): string | undefined {
	const field = Object.getOwnPropertyDescriptor(value, key)?.value;
	return typeof field === "string" ? field : undefined;
}

/**
 * The report body of a rewind-report message. Content written before the last
 * `Report:` marker is preamble; an entry with no marker is all report.
 */
function reportFromRewindReportContent(content: string): string {
	const marker = "\nReport:\n";
	const index = content.lastIndexOf(marker);
	const report = index >= 0 ? content.slice(index + marker.length) : content;
	return report.trim();
}

/**
 * The completed rewind a `rewind-report` entry records, or undefined for any
 * other entry and for a report missing either timestamp or a non-empty body.
 * The structured `details.report` wins; the rendered content is the fallback.
 */
export function completedRewindFromEntry(entry: SessionEntry): CompletedRewindState | undefined {
	if (entry.type !== "custom_message" || entry.customType !== "rewind-report") return undefined;
	const details = entry.details;
	if (!details || typeof details !== "object") return undefined;
	const startedAt = stringProperty(details, "startedAt");
	const rewoundAt = stringProperty(details, "rewoundAt");
	if (!startedAt || !rewoundAt) return undefined;
	const report =
		stringProperty(details, "report")?.trim() ||
		reportFromRewindReportContent(customMessageContentText(entry.content));
	return report.length > 0 ? { report, startedAt, rewoundAt } : undefined;
}

/** A checkpoint tool result that succeeded. A failed checkpoint starts nothing. */
export function isSuccessfulCheckpointEntry(entry: SessionEntry): entry is SessionMessageEntry & {
	message: { role: "toolResult"; toolName: "checkpoint"; isError?: false };
} {
	return (
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolName === TOOL.checkpoint &&
		entry.message.isError !== true
	);
}

/**
 * When the checkpoint this entry reports began. The tool records its own
 * `startedAt`; entries written before it did fall back to the entry timestamp.
 */
export function checkpointStartedAtFromEntry(entry: SessionEntry): string | undefined {
	if (!isSuccessfulCheckpointEntry(entry)) return undefined;
	const details = entry.message.details;
	if (details && typeof details === "object") {
		const startedAt = stringProperty(details, "startedAt");
		if (startedAt) return startedAt;
	}
	return entry.timestamp;
}
