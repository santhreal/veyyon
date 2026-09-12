/**
 * Transcript view-models: what a renderer draws, with no dependency on the
 * agent runtime that produced it.
 *
 * One block per `AgentMessage` variant the session can hold, so a renderer that
 * handles every `kind` handles every message. Blocks carry rendered-ready text
 * and flags only — never provider payloads, tool argument objects, or anything
 * whose shape a renderer would have to know the agent to interpret.
 */

import type { ToolView } from "@veyyon/view";
import type { BranchSummaryView, CompactionSummaryView } from "./summary";

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
	/** Raw base64 data for image payloads. */
	data?: string;
	/** MIME type for image payloads (e.g. image/png). */
	mimeType?: string;
	/** Original source URI or file link (e.g. file:///path/to/image.png). */
	uri?: string;
}

/** One span of an assistant turn, in emission order. */
export type AssistantSegment =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string; redacted: boolean; rawThinking?: string }
	| { kind: "tool-call"; toolCallId: string; toolName: string; input?: string }
	| { kind: "image"; mimeType: string; altText: string }
	| { kind: "fallback" };

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

/** Display presentation of turn errors or retry recovery notes. */
export type AssistantErrorPresentation =
	| { kind: "none" }
	| { kind: "full"; text: string; isError: true }
	| { kind: "compact-recovered"; text: string; isError: false };

/** Display data shared by user and visible developer messages. */
export interface UserMessageView {
	text: string;
	synthetic?: boolean;
	imageLinks?: readonly (string | undefined)[];
}

/** Display data for an assistant turn. */
export interface AssistantMessageView {
	segments: readonly AssistantSegment[];
	model?: string;
	stopReason?: TurnStopReason;
	usage?: TurnUsage;
	/** Pre-resolved presentation of turn errors or retry recovery notes. */
	errorPresentation?: AssistantErrorPresentation;
	/** Exact reported thinking/reasoning token count for live streaming indicator. */
	reportedThinkingTokens?: number;
	timestamp?: number;
	provider?: string;
	responseId?: string;
}

export interface UserMessageBlock extends UserMessageView {
	kind: "user-message";
	id: BlockId;
	attachments: readonly Attachment[];
	timestamp: number;
}

/** A developer/system turn the operator can see (rules, injected instructions). */
export interface DeveloperMessageBlock extends UserMessageView {
	kind: "developer-message";
	id: BlockId;
	timestamp: number;
}

export interface AssistantMessageBlock extends AssistantMessageView {
	kind: "assistant-message";
	id: BlockId;
	/** Model identity as displayed, e.g. `"anthropic/claude-sonnet-4"`. */
	model: string;
	stopReason: TurnStopReason;
	/** True while the turn is still streaming. */
	streaming: boolean;
	timestamp: number;
}

export interface ToolExecutionImageItem {
	data?: string;
	mimeType?: string;
}

export interface ToolExecutionMultiFileItem {
	path: string;
	isError?: boolean;
	view?: ToolView;
	errorNotice?: string;
}

export interface ToolExecutionGenericDisplay {
	icon: "pending" | "running" | "done" | "error";
	argsPreview?: string;
	outputText?: string;
	isJson?: boolean;
}

export interface ToolExecutionPolicies {
	mergeCallAndResult?: boolean;
	callIsLiveWidget?: boolean;
	inline?: boolean;
	animatedPendingPreview?: boolean;
	animatedPartialResult?: boolean;
	forceFirstResultViewportRepaint?: boolean;
	forceResultViewportRepaintOnSettle?: boolean;
	backgroundTaskFrozen?: boolean;
	displaceable?: "job" | "todo";
	sealed?: boolean;
}

/** Display state of one entry in a grouped read card. */
export interface ReadEntryView {
	toolCallId: string;
	path: string;
	displayPaths?: string[];
	linkPath?: string;
	status: "pending" | "success" | "warning" | "notExecuted" | "error";
	correctedFrom?: string;
	contentText?: string;
	conflictCount?: number;
	codeStartLine?: number;
	codeLineNumbers?: Array<number | null>;
}

export interface ToolExecutionDisplay {
	toolLabel?: string;
	readEntry?: ReadEntryView;
	callView?: ToolView;
	resultView?: ToolView;
	multiFileViews?: readonly ToolExecutionMultiFileItem[];
	remainingPendingFiles?: number;
	notExecutedReason?: string;
	neverRan?: boolean;
	generic?: ToolExecutionGenericDisplay;
	images?: readonly ToolExecutionImageItem[];
	imageSourcePath?: string;
	policies?: ToolExecutionPolicies;
	failures?: Partial<
		Record<
			"call" | "result",
			{
				error: string;
				fallbackText?: string;
			}
		>
	>;
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
	/** Canonical neutral tool presentation state. */
	display?: ToolExecutionDisplay;
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

export interface AsyncResultJobDisplay {
	jobId?: string;
	type?: string;
	label?: string;
	durationMs?: number;
}

export interface AsyncResultCustomDisplay {
	variant: "async-result";
	jobs: readonly AsyncResultJobDisplay[];
}

export interface LateDiagnosticsFileDisplay {
	path?: string;
	summary?: string;
	errored?: boolean;
	messages?: readonly string[];
}

export interface LateDiagnosticsCustomDisplay {
	variant: "late-diagnostics";
	files: readonly LateDiagnosticsFileDisplay[];
}

export interface CollabPromptCustomDisplay {
	variant: "collab-prompt";
	from: string;
	text: string;
}

export interface SkillPromptCustomDisplay {
	variant: "skill-prompt";
	name: string;
	path?: string;
	args?: string;
	lineCount?: number;
	promptBytes?: number;
	text: string;
}

export interface IrcMessageCustomDisplay {
	variant: "irc";
	kind: "incoming" | "autoreply" | "relay";
	from?: string;
	to?: string;
	body?: string;
	replyTo?: string;
	timestamp?: number;
}

export interface AdvisorNoteDisplay {
	note: string;
	severity?: "nit" | "concern" | "blocker";
	advisor?: string;
}
export interface AdvisorCustomDisplay {
	variant: "advisor";
	notes: readonly AdvisorNoteDisplay[];
}

export interface BackgroundTanDispatchCustomDisplay {
	variant: "background-tan";
	jobId: string;
	work?: string;
	sessionFile?: string;
}

export interface HandoffSummaryCustomDisplay {
	variant: "handoff";
	summary: string;
}

export type CustomBlockDisplay =
	| AsyncResultCustomDisplay
	| LateDiagnosticsCustomDisplay
	| CollabPromptCustomDisplay
	| SkillPromptCustomDisplay
	| IrcMessageCustomDisplay
	| AdvisorCustomDisplay
	| BackgroundTanDispatchCustomDisplay
	| HandoffSummaryCustomDisplay;

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
	display?: CustomBlockDisplay;
}

export interface HookBlock {
	kind: "hook";
	id: BlockId;
	hookName: string;
	text: string;
	timestamp: number;
	display?: CustomBlockDisplay;
	level?: "info" | "warning" | "error";
}

export interface BranchSummaryBlock extends BranchSummaryView {
	id: BlockId;
	timestamp: number;
}

export interface CompactionSummaryBlock extends CompactionSummaryView {
	id: BlockId;
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
