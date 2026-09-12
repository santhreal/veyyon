/**
 * Render helpers shared between the live transcript ({@link UiHelpers}) and the
 * file/remote-backed {@link ChatTranscriptBuilder}. Both surfaces build the same
 * transcript rows from persisted message entries; holding the row construction
 * here keeps the two byte-for-byte identical.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import { TOOL_BATCH_LEDGER_HEADLINE_PREFIX } from "@veyyon/agent-core/tool-batch-ledger";
import { type Component, Text } from "@veyyon/tui";
import { formatBytes, formatDuration, sanitizeText } from "@veyyon/utils";
import type { AsyncResultCustomDisplay, Attachment, IrcMessageCustomDisplay } from "@veyyon/wire/presentation";
import type { FileMentionMessage } from "../../../session/messages";
import { theme } from "../../../theme/theme";
import { shortenPath } from "../../../tools/core/render-utils";
import { canonicalizeMessage } from "../../../utils/thinking-display";
import { COMPOSER_INSET_COLS } from "../components/composer/composer-chrome";
import { createIrcMessageCard } from "../components/transcript/irc-message";
import { TranscriptBlock } from "../components/transcript/transcript-container";

type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;

/**
 * Render an `async-result` custom message (a completed background bash/task job,
 * or a batch of them) as a transcript block of one "Background job completed"
 * row per job.
 */
export function buildAsyncResultBlock(display: AsyncResultCustomDisplay): TranscriptBlock {
	const block = new TranscriptBlock();
	for (const job of display.jobs) {
		const jobId = job.jobId ?? "unknown";
		const typeLabel = job.type ? `[${job.type}]` : "[job]";
		const duration = typeof job.durationMs === "number" ? formatDuration(job.durationMs) : undefined;
		const line = [
			theme.fg("success", `${theme.status.done} Background job completed`),
			theme.fg("dim", typeLabel),
			theme.fg("accent", jobId),
			duration ? theme.fg("dim", `(${duration})`) : undefined,
		]
			.filter(Boolean)
			.join(" ");
		block.addChild(new Text(line, 1, 0));
	}
	return block;
}

/**
 * Render a live IRC traffic custom message (`irc:incoming` / `irc:autoreply` /
 * `irc:relay`) as a transcript card. `getExpanded` supplies the live
 * expanded-state getter for the cached card.
 */
export function buildIrcMessageCard(display: IrcMessageCustomDisplay, getExpanded: () => boolean): Component {
	return createIrcMessageCard(display, getExpanded, theme);
}
/**
 * Renderable file attachment or mention item.
 */
export type RenderableAttachment = Attachment | FileMentionMessage["files"][number];

/**
 * Render a single file attachment row with sanitized and shortened path.
 */
export function renderAttachmentRow(file: RenderableAttachment, indent = 1): Text {
	const rawPath = "path" in file ? file.path : file.name;
	const cleanPath = shortenPath(sanitizeText(rawPath));
	const isImage = "image" in file ? Boolean(file.image) : "kind" in file && file.kind === "image";
	const skipped =
		"skippedReason" in file
			? file.skippedReason === "tooLarge"
				? "tooLarge"
				: file.skippedReason === "binary"
					? "binary"
					: undefined
			: "omittedReason" in file
				? file.omittedReason === "too-large"
					? "tooLarge"
					: file.omittedReason === "binary"
						? "binary"
						: undefined
				: undefined;

	let suffix: string;
	if (skipped === "tooLarge" || skipped === "binary") {
		const size = typeof file.byteSize === "number" ? formatBytes(file.byteSize) : "unknown size";
		suffix = skipped === "binary" ? `(skipped: binary, ${size})` : `(skipped: ${size})`;
	} else if (
		("omittedReason" in file && file.omittedReason === "not-replicated") ||
		("contentNotReplicated" in file && file.contentNotReplicated)
	) {
		suffix = "(not replicated)";
	} else {
		suffix = isImage
			? "(image)"
			: file.lineCount === undefined
				? typeof file.byteSize === "number"
					? `(${formatBytes(file.byteSize)})`
					: "(unknown lines)"
				: `(${file.lineCount} lines)`;
	}
	const text = `${theme.fg("dim", `${theme.tree.last} `)}${theme.fg("muted", "Read")} ${theme.fg(
		"accent",
		cleanPath,
	)} ${theme.fg("dim", suffix)}`;
	return new Text(text, indent, 0);
}

/**
 * Render a `fileMention` message's files as a transcript block of "Read <path>"
 * rows. `indent` sets the left pad: the live chat renders within an outer gutter
 * (0), the transcript viewer renders body rows without one so rows own their pad
 * (1).
 */
export function buildFileMentionBlock(files: readonly RenderableAttachment[], indent: number): TranscriptBlock {
	const block = new TranscriptBlock();
	for (const file of files) {
		block.addChild(renderAttachmentRow(file, indent));
	}
	return block;
}

/**
 * Whether an assistant turn has visible text or thinking content (after
 * canonicalization) — i.e. content that closes the current read-tool run.
 */
export function assistantHasVisibleContent(message: AssistantAgentMessage): boolean {
	return message.content.some(
		content =>
			(content.type === "text" && canonicalizeMessage(content.text)) ||
			(content.type === "thinking" && canonicalizeMessage(content.thinking)),
	);
}

/**
 * Split mixed assistant turns into visible text before tool execution and
 * visible text segments that must render immediately after the preceding tool.
 * Cursor can return intro text, tool calls, progress text, and the final answer
 * in one assistant message; keeping every text block in the leading assistant
 * block buries post-tool text above tool results in the transcript.
 */
export function splitAssistantMessageToolTimeline(message: AssistantAgentMessage): {
	beforeTools: AssistantAgentMessage;
	afterToolCalls: ReadonlyMap<string, AssistantAgentMessage>;
	hasToolCalls: boolean;
} {
	const beforeTools: AssistantAgentMessage["content"] = [];
	const afterToolCalls = new Map<string, AssistantAgentMessage>();
	let pendingAfterTool: AssistantAgentMessage["content"] = [];
	let lastToolCallId: string | undefined;
	let sawToolCall = false;

	const displaySegment = (content: AssistantAgentMessage["content"]): AssistantAgentMessage => ({
		...message,
		content,
		stopReason: "stop",
		errorMessage: undefined,
		retryRecovery: undefined,
	});

	const flushPendingAfterTool = () => {
		if (!lastToolCallId || pendingAfterTool.length === 0) return;
		afterToolCalls.set(lastToolCallId, displaySegment(pendingAfterTool));
		pendingAfterTool = [];
	};

	for (const content of message.content) {
		if (content.type === "toolCall") {
			flushPendingAfterTool();
			sawToolCall = true;
			lastToolCallId = content.id;
			continue;
		}
		if (sawToolCall) {
			pendingAfterTool.push(content);
		} else {
			beforeTools.push(content);
		}
	}
	flushPendingAfterTool();

	if (!sawToolCall) {
		return { beforeTools: message, afterToolCalls, hasToolCalls: false };
	}

	// An after-tool segment is display-only, so `displaySegment` scrubs the stop:
	// the segment is not the turn and must not restate its ending. The leading
	// segment IS the turn's head and keeps it, which is what lets a stream death
	// state the provider's reason once, above the calls it cut short, instead of
	// once inside every dropped call's card. Live, the pinned banner suppresses
	// this copy until it is dismissed.
	return { beforeTools: { ...message, content: beforeTools }, afterToolCalls, hasToolCalls: true };
}

/**
 * Normalize raw tool-call arguments to a plain record, collapsing non-object or
 * array values to an empty object.
 */
export function normalizeToolArgs(args: unknown): Record<string, unknown> {
	return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

/**
 * Whether an assistant turn's `usage` reflects work the operator was billed
 * for. Empty automated turns from providers that emit `usage: 0` collapse to
 * `false`, but any input, output, cache, or premium request keeps the row so
 * cost transparency survives — the live path and the resume/rebuild path
 * agree turn-by-turn.
 */
export function assistantUsageIsBilled(usage: AssistantAgentMessage["usage"]): boolean {
	if (usage.input > 0 || usage.output > 0) return true;
	if (usage.cacheRead > 0 || usage.cacheWrite > 0) return true;
	if ((usage.premiumRequests ?? 0) > 0) return true;
	return false;
}

/**
 * Collapse a turn-level tool-batch ledger to a one-line transcript marker, or
 * return null when `text` is not a ledger. The ledger's full body is a standing
 * instruction to the MODEL (which calls ran, which to retry); the operator
 * needs only the fact that a batch was cut short and continued, in the same
 * dim one-liner language as the compaction marker.
 */
export function ledgerMarkerLine(text: string): string | null {
	if (!text.startsWith(TOOL_BATCH_LEDGER_HEADLINE_PREFIX)) return null;
	const headline = text.split("\n", 1)[0]!.replace(/\.$/, "");
	const summary = headline.slice(TOOL_BATCH_LEDGER_HEADLINE_PREFIX.length - 1);
	return theme.fg("dim", `${" ".repeat(COMPOSER_INSET_COLS)}${theme.status.warning} batch cut short ${summary}.`);
}
