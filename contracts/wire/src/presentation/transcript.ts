/**
 * Transcript view-models: what a renderer draws, with no dependency on the
 * agent runtime that produced it.
 *
 * One block per `AgentMessage` variant the session can hold, so a renderer that
 * handles every `kind` handles every message. Blocks carry rendered-ready text
 * and flags only — never provider payloads, tool argument objects, or anything
 * whose shape a renderer would have to know the agent to interpret.
 */

/** Stable identity of a block across updates. Assigned by the builder, opaque to the renderer. */
export type BlockId = string;

/** A file or image the operator attached to a message. */
export interface Attachment {
	kind: "file" | "image";
	/** Display name, already shortened for presentation. */
	name: string;
	/** Byte size when known. */
	byteSize?: number;
	/** Line count for a text file, when known. */
	lineCount?: number;
	/** Why the content was not included. Absent when it was. */
	omittedReason?: "too-large" | "binary" | "not-replicated";
}

/** One span of an assistant turn, in emission order. */
export type AssistantSegment =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string; redacted: boolean }
	| { kind: "tool-call"; toolCallId: string; toolName: string; input: string }
	| { kind: "image"; mimeType: string; altText: string };

/** Lifecycle of a tool call as the renderer sees it. */
export type ToolStatus = "pending" | "running" | "succeeded" | "failed" | "aborted" | "rejected";

/** Why an assistant turn stopped, reduced to what a renderer displays. */
export type TurnStopReason = "complete" | "max-tokens" | "tool-call" | "aborted" | "error";

/** Token accounting for one assistant turn. */
export interface TurnUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Reasoning tokens the provider billed separately, when it reported them. */
	reasoning?: number;
	costUsd?: number;
}

export interface UserMessageBlock {
	kind: "user-message";
	id: BlockId;
	text: string;
	attachments: readonly Attachment[];
	timestamp: number;
}

/** A developer/system turn the operator can see (rules, injected instructions). */
export interface DeveloperMessageBlock {
	kind: "developer-message";
	id: BlockId;
	text: string;
	timestamp: number;
}

export interface AssistantMessageBlock {
	kind: "assistant-message";
	id: BlockId;
	segments: readonly AssistantSegment[];
	/** Model identity as displayed, e.g. `"anthropic/claude-sonnet-4"`. */
	model: string;
	stopReason: TurnStopReason;
	usage?: TurnUsage;
	/** Set when the turn ended in a provider or transport failure. */
	errorMessage?: string;
	/** True while the turn is still streaming. */
	streaming: boolean;
	timestamp: number;
}

export interface ToolExecutionBlock {
	kind: "tool-execution";
	id: BlockId;
	toolCallId: string;
	toolName: string;
	status: ToolStatus;
	/** Arguments rendered for display; secrets already redacted by the builder. */
	input: string;
	/** Result text rendered for display. Absent until the call finishes. */
	output?: string;
	error?: string;
	/** Wall-clock duration in milliseconds once the call finished. */
	durationMs?: number;
	timestamp: number;
}

export interface BashExecutionBlock {
	kind: "bash-execution";
	id: BlockId;
	command: string;
	output: string;
	exitCode: number | null;
	signal?: string;
	cancelled: boolean;
	timestamp: number;
}

export interface PythonExecutionBlock {
	kind: "python-execution";
	id: BlockId;
	code: string;
	output: string;
	exitCode: number | null;
	cancelled: boolean;
	timestamp: number;
}

/** A host-defined message with no runtime meaning to the renderer beyond its text. */
export interface CustomBlock {
	kind: "custom";
	id: BlockId;
	/** Discriminator the host assigned, e.g. `"notice"`. */
	customKind: string;
	text: string;
	/** Presentation weight the host asked for. */
	level: "info" | "warning" | "error";
	timestamp: number;
}

export interface HookBlock {
	kind: "hook";
	id: BlockId;
	hookName: string;
	text: string;
	timestamp: number;
}

export interface BranchSummaryBlock {
	kind: "branch-summary";
	id: BlockId;
	summary: string;
	/** Messages the branch replaced. */
	replacedCount: number;
	timestamp: number;
}

export interface CompactionSummaryBlock {
	kind: "compaction-summary";
	id: BlockId;
	summary: string;
	/** Messages compaction folded into the summary. */
	replacedCount: number;
	/** Tokens the compaction reclaimed, when measured. */
	reclaimedTokens?: number;
	timestamp: number;
}

export interface FileMentionBlock {
	kind: "file-mention";
	id: BlockId;
	files: readonly Attachment[];
	timestamp: number;
}

/** A failure with no message of its own: a transport reset, a rejected request. */
export interface ErrorBlock {
	kind: "error";
	id: BlockId;
	message: string;
	/** True when the session can continue; false when the turn is dead. */
	recoverable: boolean;
	timestamp: number;
}

/**
 * Every shape the transcript can hold. Exhaustive over `AgentMessage`: a new
 * message variant is a new member here, and a renderer that switches on `kind`
 * without a default fails to compile until it handles the new one.
 */
export type TranscriptBlock =
	| UserMessageBlock
	| DeveloperMessageBlock
	| AssistantMessageBlock
	| ToolExecutionBlock
	| BashExecutionBlock
	| PythonExecutionBlock
	| CustomBlock
	| HookBlock
	| BranchSummaryBlock
	| CompactionSummaryBlock
	| FileMentionBlock
	| ErrorBlock;

/** Every `TranscriptBlock["kind"]`, as a value, so a sweep can enumerate the union at run time. */
export const TRANSCRIPT_BLOCK_KINDS = [
	"user-message",
	"developer-message",
	"assistant-message",
	"tool-execution",
	"bash-execution",
	"python-execution",
	"custom",
	"hook",
	"branch-summary",
	"compaction-summary",
	"file-mention",
	"error",
] as const satisfies readonly TranscriptBlock["kind"][];

/**
 * A new `TranscriptBlock` member that is missing from TRANSCRIPT_BLOCK_KINDS makes this fail to
 * compile, naming the member. `satisfies` above rejects a stale entry; this
 * rejects a missing one, so the table cannot drift from the union either way.
 */
type UnlistedTranscriptBlock = Exclude<TranscriptBlock["kind"], (typeof TRANSCRIPT_BLOCK_KINDS)[number]>;
const _transcript_block_kinds_is_exhaustive: UnlistedTranscriptBlock extends never ? true : UnlistedTranscriptBlock =
	true;
void _transcript_block_kinds_is_exhaustive;
