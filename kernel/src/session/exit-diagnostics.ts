import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { emptyUsage } from "@veyyon/catalog/models";
import { collapseWhitespace, formatCount, truncate } from "@veyyon/utils";
import { isRecord } from "@veyyon/utils/type-guards";
import { compactedHistoryEnd } from "./session-context";
import type { SessionEntry } from "./session-entries";

export const TOOL_EXECUTION_START_CUSTOM_TYPE = "tool_execution_start";
export const SESSION_EXIT_CUSTOM_TYPE = "session_exit";

/**
 * Compact projection of tool-call arguments persisted with the start marker.
 * The assistant message already carries the full arguments; this exists only
 * so `appendArgumentSummary` can name the command/path in resume warnings
 * without duplicating whole argument payloads into the session JSONL.
 */
export interface ToolArgumentSummary {
	command?: string;
	path?: string;
}

/**
 * Persisted marker written before a tool implementation starts running. The entry's timestamp is the
 * start time.
 */
export interface ToolExecutionStartData {
	toolCallId: string;
	toolName: string;
	/**
	 * Absent when the newest assistant message on the branch records the call
	 * ({@link assistantRecordsToolCall}), since the pending-call reader takes that message's arguments.
	 */
	args?: ToolArgumentSummary;
	intent?: string;
	/** Written by sessions from before the entry timestamp served as the start time. */
	startedAt?: string;
}

/** A start marker as the pending-call reader applies it: `startedAt` from the marker or its entry. */
interface ToolExecutionStart extends ToolExecutionStartData {
	startedAt: string;
}

/** Tool call left without a matching toolResult at the end of a branch. */
export interface PendingToolCallDiagnostic {
	toolCallId?: string;
	toolName: string;
	args?: unknown;
	intent?: string;
	assistantTimestamp?: number;
	startedAt?: string;
}

/** Session shutdown marker written during normal and fatal process teardown. */
export interface SessionExitData {
	reason: string;
	kind: "normal" | "signal" | "fatal" | "process_exit";
	recordedAt: string;
	pendingToolCalls?: PendingToolCallDiagnostic[];
}

/** How loudly a recorded exit reads in the log. */
export type SessionExitLogLevel = "debug" | "warn" | "error";

/**
 * The severity of one recorded exit, from what actually happened to the session.
 *
 * WHY THIS IS A FUNCTION AND NOT A TERNARY AT THE CALL SITE. The call site asked one
 * question — "was this a clean dispose?" — and answered it with two levels, so a session
 * killed by an uncaught exception and a session whose terminal closed with nothing in
 * flight were both a warning. Measured across 19 profile logs: 23 exits logged at warn,
 * 17 of them `sighup` with zero pending tool calls, 4 of them `fatal`. So the level that
 * meant "look at this" was carried four times out of twenty-three by the records that
 * deserved it, and the crashes were indistinguishable from a closed window.
 *
 * The three levels are the three things a reader of the log does about it:
 *
 * - `error`: the session died on an unhandled throw or rejection. Nothing else in the
 *   log says so, because the record is written from the teardown path, not the thrower.
 * - `warn`: tool calls were in flight and are now orphaned. The resume path renders them
 *   to the operator, so the log line is the trace of a warning already shown.
 * - `debug`: a signal, a `process.exit`, or a normal dispose with nothing in flight. The
 *   session ended for a reason outside itself and lost no work. Still recorded, because
 *   "which of my sessions ended and why" is a real question, but it is not a problem.
 *
 * A fatal exit that also orphaned tool calls is an `error`: the crash is the finding and
 * the pending count travels in the payload.
 */
export function sessionExitLogLevel(kind: SessionExitData["kind"], pendingToolCalls: number): SessionExitLogLevel {
	if (kind === "fatal") return "error";
	return pendingToolCalls > 0 ? "warn" : "debug";
}

interface PendingToolCallRecord extends PendingToolCallDiagnostic {
	key: string;
}

interface ToolCallContent {
	type: "toolCall";
	id?: string;
	name?: string;
	arguments?: unknown;
}

export interface AssistantModelMetadata {
	api: AssistantMessage["api"];
	provider: string;
	model: string;
}

function isPendingToolCallDiagnostic(value: unknown): value is PendingToolCallDiagnostic {
	if (!isRecord(value) || typeof value.toolName !== "string") return false;
	if ("toolCallId" in value && typeof value.toolCallId !== "string") return false;
	if ("intent" in value && typeof value.intent !== "string") return false;
	if ("assistantTimestamp" in value && typeof value.assistantTimestamp !== "number") return false;
	if ("startedAt" in value && typeof value.startedAt !== "string") return false;
	return true;
}

function readPendingToolCalls(value: unknown): PendingToolCallDiagnostic[] | undefined {
	if (!Array.isArray(value) || !value.every(isPendingToolCallDiagnostic)) return undefined;
	return value;
}

function readSessionExit(entry: SessionEntry): SessionExitData | undefined {
	if (entry.type !== "custom" || entry.customType !== SESSION_EXIT_CUSTOM_TYPE || !isRecord(entry.data)) {
		return undefined;
	}
	const { reason, kind, recordedAt } = entry.data;
	if (
		typeof reason !== "string" ||
		(kind !== "normal" && kind !== "signal" && kind !== "fatal" && kind !== "process_exit") ||
		typeof recordedAt !== "string"
	) {
		return undefined;
	}
	return {
		reason,
		kind,
		recordedAt,
		pendingToolCalls: readPendingToolCalls(entry.data.pendingToolCalls),
	};
}

/**
 * createInterruptedTurnAbortMessage returns a terminal assistant record when
 * the latest persisted process exit follows a non-terminal conversation tail.
 */
export function createInterruptedTurnAbortMessage(
	entries: readonly SessionEntry[],
	fallbackModel?: AssistantModelMetadata,
): AssistantMessage | undefined {
	let exitIndex = -1;
	let exit: SessionExitData | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const candidate = readSessionExit(entries[index]!);
		if (!candidate) continue;
		exitIndex = index;
		exit = candidate;
		break;
	}
	if (!exit || (exit.kind === "normal" && !exit.pendingToolCalls?.length)) return undefined;

	let tailIndex = -1;
	let tail: AgentMessage | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "message") continue;
		tailIndex = index;
		tail = entry.message;
		break;
	}
	if (!tail || tailIndex > exitIndex) return undefined;
	if (tail.role === "assistant" && !tail.content.some(isToolCallContent)) return undefined;

	let previousAssistant: AssistantMessage | undefined;
	for (let index = tailIndex; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		previousAssistant = entry.message;
		break;
	}
	if (
		tail.role === "toolResult" &&
		(previousAssistant?.stopReason === "error" || previousAssistant?.stopReason === "aborted")
	) {
		return undefined;
	}
	const model = previousAssistant ?? fallbackModel;
	if (!model) return undefined;

	const recordedAt = Date.parse(exit.recordedAt);
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.model,
		usage: emptyUsage(),
		stopReason: "aborted",
		errorMessage: "Previous veyyon process exited before completing the turn.",
		timestamp: Number.isFinite(recordedAt) ? recordedAt : Date.now(),
	};
}

function isToolCallContent(value: unknown): value is ToolCallContent {
	if (!isRecord(value)) return false;
	return value.type === "toolCall" && (typeof value.name === "string" || typeof value.id === "string");
}

/** Character cap for each summarized argument field. */
const ARGUMENT_SUMMARY_MAX_CHARS = 200;

function truncateSummaryField(value: string): string {
	return value.length > ARGUMENT_SUMMARY_MAX_CHARS ? `${value.slice(0, ARGUMENT_SUMMARY_MAX_CHARS)}…` : value;
}

/**
 * Project full tool-call arguments down to the fields the pending-tool-call
 * resume warning actually renders (`command`/`path`), truncated. Returns
 * `undefined` when the arguments carry neither, so callers can omit `args`
 * entirely instead of persisting an empty object.
 *
 * PASS `redact` ON ANY PATH THAT PERSISTS THE RESULT. The arguments reaching a
 * running tool are post-expansion: `#GITHUB_TOKEN#` has already become the
 * credential, because that is the whole point of expansion. Writing them to the
 * session file verbatim puts the plaintext credential next to the encrypted
 * vault, and from there into `/share`, exports, backups and bug reports.
 * Redaction runs before truncation so a placeholder is never cut in half and a
 * long command can never keep a raw prefix of a value the redactor replaced.
 */
export function summarizeToolArguments(
	args: unknown,
	redact?: (text: string) => string,
): ToolArgumentSummary | undefined {
	if (!isRecord(args)) return undefined;
	const project = (value: string): string => truncateSummaryField(redact ? redact(value) : value);
	const summary: ToolArgumentSummary = {};
	if (typeof args.command === "string" && args.command.length > 0) {
		summary.command = project(args.command);
	}
	if (typeof args.path === "string" && args.path.length > 0) {
		summary.path = project(args.path);
	}
	return summary.command !== undefined || summary.path !== undefined ? summary : undefined;
}

function readToolExecutionStart(entry: SessionEntry): ToolExecutionStart | undefined {
	if (entry.type !== "custom" || entry.customType !== TOOL_EXECUTION_START_CUSTOM_TYPE) return undefined;
	const data = entry.data;
	if (!isRecord(data)) return undefined;
	if (typeof data.toolCallId !== "string" || typeof data.toolName !== "string") return undefined;
	const startedAt = typeof data.startedAt === "string" ? data.startedAt : entry.timestamp;
	const result: ToolExecutionStart = {
		toolCallId: data.toolCallId,
		toolName: data.toolName,
		startedAt,
	};
	// Legacy sessions persisted full argument objects; project them down.
	if ("args" in data) {
		const args = summarizeToolArguments(data.args);
		if (args) result.args = args;
	}
	if (typeof data.intent === "string") result.intent = data.intent;
	return result;
}

/**
 * Whether `part` is a renamed repeat of an earlier call in the same message.
 *
 * The agent loop keeps stored ids unique by renaming a repeated id `<id>_<n>`. When the repeat has
 * the same tool and arguments as `<id>`, it is one call recorded twice (Cursor re-sent an exec
 * request and an older build synthesized a second block for it), so it is answered by `<id>`'s
 * result and never gets one of its own. Counting it reported every such call as pending on resume.
 */
function isRenamedRepeat(part: ToolCallContent, earlier: readonly ToolCallContent[]): boolean {
	const id = part.id;
	if (id === undefined) return false;
	// Serialized only once an earlier call's id qualifies, since most calls have no such twin.
	let args: string | undefined;
	return earlier.some(other => {
		if (
			other.id === undefined ||
			other.name !== part.name ||
			id.length <= other.id.length + 1 ||
			!id.startsWith(`${other.id}_`) ||
			!/^\d+$/.test(id.slice(other.id.length + 1))
		) {
			return false;
		}
		args ??= JSON.stringify(part.arguments);
		return JSON.stringify(other.arguments) === args;
	});
}

function appendAssistantToolCalls(pending: Map<string, PendingToolCallRecord>, message: AgentMessage): void {
	if (message.role !== "assistant") return;
	const content = Array.isArray(message.content) ? message.content : [];
	const toolCalls: PendingToolCallRecord[] = [];
	const seen: ToolCallContent[] = [];
	for (let index = 0; index < content.length; index++) {
		const part = content[index];
		if (!isToolCallContent(part)) continue;
		if (isRenamedRepeat(part, seen)) continue;
		seen.push(part);
		const toolName = part.name ?? "unknown";
		const key = part.id ?? `assistant:${message.timestamp ?? "unknown"}:${index}:${toolName}`;
		const record: PendingToolCallRecord = {
			key,
			toolName,
		};
		if (typeof message.timestamp === "number") record.assistantTimestamp = message.timestamp;
		if (part.id) record.toolCallId = part.id;
		if ("arguments" in part) record.args = part.arguments;
		toolCalls.push(record);
	}
	pending.clear();
	for (const toolCall of toolCalls) pending.set(toolCall.key, toolCall);
}

function applyToolExecutionStart(pending: Map<string, PendingToolCallRecord>, marker: ToolExecutionStart): void {
	const existing = pending.get(marker.toolCallId);
	if (existing) {
		existing.startedAt = marker.startedAt;
		// The assistant message carries the full arguments; the marker only has
		// the command/path projection. Keep the richer copy when present.
		existing.args ??= marker.args;
		if (marker.intent) existing.intent = marker.intent;
		return;
	}
	const record: PendingToolCallRecord = {
		key: marker.toolCallId,
		toolCallId: marker.toolCallId,
		toolName: marker.toolName,
		args: marker.args,
		startedAt: marker.startedAt,
	};
	if (marker.intent) record.intent = marker.intent;
	pending.set(marker.toolCallId, record);
}

function applyMessageEntry(pending: Map<string, PendingToolCallRecord>, message: AgentMessage): void {
	if (message.role === "toolResult") {
		const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
		if (toolCallId) pending.delete(toolCallId);
		return;
	}
	appendAssistantToolCalls(pending, message);
}

/**
 * Finds tool calls left pending at the end of a session branch: calls an assistant message or a
 * start marker records with no tool result after them on the branch, from the keep boundary of the
 * newest compaction on ({@link compactedHistoryEnd}). A call before that boundary is history a
 * compaction summarized and no context sends again, and its entry's payload may be in the session
 * file rather than in memory, so reading it would read the compacted history back.
 */
export function collectPendingToolCalls(branch: readonly SessionEntry[]): PendingToolCallDiagnostic[] {
	const pending = new Map<string, PendingToolCallRecord>();
	for (let i = compactedHistoryEnd(branch); i < branch.length; i++) {
		const entry = branch[i]!;
		if (entry.type === "message") {
			applyMessageEntry(pending, entry.message);
			continue;
		}
		const marker = readToolExecutionStart(entry);
		if (marker) applyToolExecutionStart(pending, marker);
	}
	return Array.from(pending.values()).map(({ key: _key, ...toolCall }) => toolCall);
}

/**
 * Whether {@link collectPendingToolCalls} takes `toolCallId`'s arguments from an assistant message when
 * a start marker is appended after `leaf`: the newest assistant message on the branch records the call
 * and no tool result for it follows. The walk goes back over custom entries and tool results; any other
 * message ends it unanswered, so a marker written then keeps its own copy of the arguments.
 */
export function assistantRecordsToolCall(
	leaf: SessionEntry | undefined,
	getEntry: (id: string) => SessionEntry | undefined,
	toolCallId: string,
): boolean {
	for (let entry = leaf; entry !== undefined; entry = entry.parentId === null ? undefined : getEntry(entry.parentId)) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult") {
			if (message.toolCallId === toolCallId) return false;
			continue;
		}
		if (message.role !== "assistant") return false;
		const pending = new Map<string, PendingToolCallRecord>();
		appendAssistantToolCalls(pending, message);
		return pending.get(toolCallId)?.args !== undefined;
	}
	return false;
}

/** Calls named in the resume warning; the rest are counted, so a large batch stays one line. */
const PENDING_WARNING_LISTED_CALLS = 3;
/** Longest command or path quoted per listed call. */
const PENDING_WARNING_ARGUMENT_CHARS = 80;

/** One line of `text`, bounded: ids and commands can carry newlines and whole scripts. */
function oneLine(text: string, maxLength: number): string {
	return truncate(collapseWhitespace(text), maxLength);
}

function appendArgumentSummary(parts: string[], args: unknown): void {
	if (!isRecord(args)) return;
	const command = args.command;
	if (typeof command === "string" && command.length > 0) {
		parts.push(`command \`${oneLine(command, PENDING_WARNING_ARGUMENT_CHARS)}\``);
		return;
	}
	const path = args.path;
	if (typeof path === "string" && path.length > 0) {
		parts.push(`path \`${oneLine(path, PENDING_WARNING_ARGUMENT_CHARS)}\``);
	}
}

function formatPendingToolCall(call: PendingToolCallDiagnostic): string {
	const parts = [call.toolName];
	if (call.toolCallId) parts.push(oneLine(call.toolCallId, PENDING_WARNING_ARGUMENT_CHARS));
	appendArgumentSummary(parts, call.args);
	return parts.join(" ");
}

/** Builds the resume warning shown when a prior branch ended mid-tool-call. */
export function describePendingToolCalls(entries: readonly SessionEntry[]): string | undefined {
	const pending = collectPendingToolCalls(entries);
	if (pending.length === 0) return undefined;
	const listed = pending.slice(0, PENDING_WARNING_LISTED_CALLS).map(formatPendingToolCall);
	const unlisted = pending.length - listed.length;
	if (unlisted > 0) listed.push(`and ${unlisted} more`);
	return `Previous session ended while ${formatCount("tool call", pending.length)} remained pending: ${listed.join(", ")}. The prior veyyon process exited before recording tool result(s).`;
}
