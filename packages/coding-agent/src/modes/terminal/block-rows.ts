/**
 * `TranscriptBlock` to terminal rows.
 *
 * One exhaustive switch over `TranscriptBlock["kind"]`, so a new block kind
 * fails to compile here rather than rendering as nothing. Every string a block
 * carries is sanitized before it reaches a row: tabs expanded, CR normalized,
 * and the result wrapped to the frame width, because a block's text is model
 * output and file content and neither is safe to paint raw.
 *
 * Pure: rows in, rows out, no engine and no device.
 */

import { truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { replaceTabs, wrapTextWithAnsi } from "@veyyon/utils/wrap";
import type {
	AssistantSegment,
	Attachment,
	PresentationTheme,
	StyleRole,
	ToolStatus,
	TranscriptBlock,
} from "@veyyon/wire/presentation";
import { paint } from "./theme-ansi";

/** Narrowest frame a block is rendered for. Below it, wrapping produces one column of letters. */
const MIN_WIDTH = 8;

/** Rows of tool output a block shows before it says how many it dropped. */
const TOOL_OUTPUT_ROWS = 12;

/** Rows of a command's output a bash or python block shows. */
const EXECUTION_OUTPUT_ROWS = 16;

/** Marks in the gutter, by what the row belongs to. */
const GUTTER = {
	user: ">",
	assistant: "",
	developer: "#",
	tool: "*",
	thinking: "~",
	error: "!",
	summary: "=",
} as const;

function usableWidth(width: number): number {
	return Math.max(MIN_WIDTH, Math.trunc(width));
}

/** Wrap display text to `width`, expanding tabs first so a measured row matches a painted one. */
function textRows(text: string, width: number): string[] {
	if (text === "") return [];
	return wrapTextWithAnsi(replaceTabs(text), usableWidth(width));
}

/** Wrap and paint, one role for the whole run. */
function paintedRows(text: string, width: number, role: StyleRole): string[] {
	return textRows(text, width).map(row => paint(row, role));
}

/** A `label body` row, painted in two roles, truncated rather than wrapped. */
function labelRow(label: string, body: string, width: number, labelRole: StyleRole, bodyRole: StyleRole): string {
	const usable = usableWidth(width);
	const painted = paint(label, labelRole);
	const remaining = usable - visibleWidth(label) - 1;
	if (remaining <= 0 || body === "") return painted;
	return `${painted} ${paint(truncateToWidth(replaceTabs(body), remaining), bodyRole)}`;
}

/** Prefix the first row with `mark` and indent the rest, so a wrapped block reads as one. */
function withGutter(rows: readonly string[], mark: string): string[] {
	if (mark === "") return [...rows];
	const indent = " ".repeat(mark.length + 1);
	return rows.map((row, index) => (index === 0 ? `${mark} ${row}` : `${indent}${row}`));
}

/** Keep the first `limit` rows and say how many were dropped. */
function capRows(rows: readonly string[], limit: number, role: StyleRole): string[] {
	if (rows.length <= limit) return [...rows];
	const dropped = rows.length - limit;
	return [...rows.slice(0, limit), paint(`… ${dropped} more ${dropped === 1 ? "row" : "rows"}`, role)];
}

function attachmentRow(attachment: Attachment, width: number, role: StyleRole): string {
	let detail = attachment.kind === "image" ? "image" : "file";
	if (attachment.lineCount !== undefined) detail += `, ${attachment.lineCount} lines`;
	if (attachment.byteSize !== undefined) detail += `, ${attachment.byteSize} bytes`;
	if (attachment.omittedReason !== undefined) detail += `, omitted: ${attachment.omittedReason}`;
	return paint(truncateToWidth(`  ${attachment.name} (${detail})`, usableWidth(width)), role);
}

const STATUS_MARK: Record<ToolStatus, string> = {
	pending: "…",
	running: "•",
	succeeded: "✓",
	failed: "✗",
	aborted: "⊘",
	rejected: "⊘",
};

function segmentRows(segment: AssistantSegment, width: number, theme: PresentationTheme): string[] {
	const transcript = theme.transcript;
	switch (segment.kind) {
		case "text":
			return paintedRows(segment.text, width, transcript.assistantMessage);
		case "thinking": {
			const body = segment.redacted ? "[reasoning withheld by the provider]" : segment.text;
			return withGutter(paintedRows(body, width - 2, transcript.thinking), GUTTER.thinking);
		}
		case "tool-call":
			return [
				labelRow(
					`${GUTTER.tool} ${segment.toolName}`,
					segment.input,
					width,
					transcript.toolName,
					transcript.toolInput,
				),
			];
		case "image":
			return [
				paint(
					truncateToWidth(`[image ${segment.mimeType}] ${segment.altText}`, usableWidth(width)),
					transcript.toolInput,
				),
			];
	}
}

/** Exit-code line for a command that ran, or the reason it did not finish. */
function exitRow(
	exitCode: number | null,
	cancelled: boolean,
	signal: string | undefined,
	theme: PresentationTheme,
): string[] {
	const chrome = theme.chrome;
	if (cancelled) return [paint("cancelled", chrome.warning)];
	if (signal !== undefined) return [paint(`killed by signal ${signal}`, chrome.error)];
	if (exitCode === null || exitCode === 0) return [];
	return [paint(`exit ${exitCode}`, chrome.error)];
}

/**
 * Rows for one block. The switch is exhaustive over the union, so the return at
 * the end is unreachable for a known kind and a new kind is a compile error.
 */
export function blockRows(block: TranscriptBlock, width: number, theme: PresentationTheme): string[] {
	const transcript = theme.transcript;
	const chrome = theme.chrome;
	switch (block.kind) {
		case "user-message": {
			const rows = withGutter(paintedRows(block.text, width - 2, transcript.userMessage), GUTTER.user);
			for (const attachment of block.attachments) rows.push(attachmentRow(attachment, width, chrome.muted));
			return rows;
		}
		case "developer-message":
			return withGutter(paintedRows(block.text, width - 2, chrome.muted), GUTTER.developer);
		case "assistant-message": {
			const rows: string[] = [];
			for (const segment of block.segments) rows.push(...segmentRows(segment, width, theme));
			if (block.errorMessage !== undefined)
				rows.push(paint(truncateToWidth(block.errorMessage, usableWidth(width)), chrome.error));
			if (block.stopReason === "max-tokens") rows.push(paint("stopped at the output limit", chrome.warning));
			if (block.stopReason === "aborted") rows.push(paint("interrupted", chrome.warning));
			return rows;
		}
		case "tool-execution": {
			const mark = `${STATUS_MARK[block.status]} ${block.toolName}`;
			const rows = [labelRow(mark, block.input, width, transcript.toolName, transcript.toolInput)];
			if (block.error !== undefined) {
				rows.push(
					...capRows(
						paintedRows(block.error, width - 2, transcript.toolError),
						TOOL_OUTPUT_ROWS,
						chrome.muted,
					).map(row => `  ${row}`),
				);
			} else if (block.output !== undefined) {
				rows.push(
					...capRows(
						paintedRows(block.output, width - 2, transcript.toolOutput),
						TOOL_OUTPUT_ROWS,
						chrome.muted,
					).map(row => `  ${row}`),
				);
			}
			return rows;
		}
		case "bash-execution": {
			const rows = [labelRow("$", block.command, width, chrome.accent, transcript.toolInput)];
			rows.push(
				...capRows(
					paintedRows(block.output, width - 2, transcript.toolOutput),
					EXECUTION_OUTPUT_ROWS,
					chrome.muted,
				).map(row => `  ${row}`),
			);
			rows.push(...exitRow(block.exitCode, block.cancelled, block.signal, theme));
			return rows;
		}
		case "python-execution": {
			const rows = [labelRow(">>>", block.code, width, chrome.accent, transcript.toolInput)];
			rows.push(
				...capRows(
					paintedRows(block.output, width - 2, transcript.toolOutput),
					EXECUTION_OUTPUT_ROWS,
					chrome.muted,
				).map(row => `  ${row}`),
			);
			rows.push(...exitRow(block.exitCode, block.cancelled, undefined, theme));
			return rows;
		}
		case "custom": {
			const role =
				block.level === "error" ? chrome.error : block.level === "warning" ? chrome.warning : chrome.muted;
			return [labelRow(`[${block.customKind}]`, block.text, width, role, role)];
		}
		case "hook":
			return [labelRow(`[hook ${block.hookName}]`, block.text, width, chrome.muted, chrome.muted)];
		case "branch-summary":
			return withGutter(paintedRows(block.summary, width - 2, transcript.summary), GUTTER.summary);
		case "compaction-summary": {
			const rows = withGutter(paintedRows(block.summary, width - 2, transcript.summary), GUTTER.summary);
			if (block.reclaimedTokens !== undefined) {
				rows.push(
					paint(
						`compacted ${block.replacedCount} messages, ${block.reclaimedTokens} tokens reclaimed`,
						chrome.muted,
					),
				);
			}
			return rows;
		}
		case "file-mention": {
			const rows = [
				paint(`${block.files.length} ${block.files.length === 1 ? "file" : "files"} read`, chrome.muted),
			];
			for (const file of block.files) rows.push(attachmentRow(file, width, chrome.muted));
			return rows;
		}
		case "error": {
			const rows = withGutter(paintedRows(block.message, width - 2, chrome.error), GUTTER.error);
			if (!block.recoverable) rows.push(paint("the session cannot continue", chrome.error));
			return rows;
		}
	}
}
