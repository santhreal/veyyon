/**
 * The commit agent's console reporter: the one place its run is drawn.
 *
 * `runCommitAgentSession` reports what happened — a thinking preview, a message,
 * a finished tool, a total — and this states what that looks like on a terminal:
 * a dim overwritten line while the model thinks, markdown rendered to the
 * terminal's width, and a tool's arguments as a small tree. A host that is not a
 * terminal supplies its own reporter and none of this loads.
 */

import { Markdown } from "@veyyon/tui";
import { INTENT_FIELD } from "@veyyon/wire";
import chalk from "chalk";
import { getMarkdownTheme } from "../../theme/markdown-theme";
import type { CommitAgentReporter } from "./agent";

/** Cells a thinking preview is bounded to, so the line never wraps and leaves a stripe behind. */
const PREVIEW_WIDTH = 40;
/** Terminal width the markdown is laid out at when the stream reports none. */
const FALLBACK_WIDTH = 100;
/** Narrowest layout worth wrapping to; below it markdown reads worse wrapped than overflowing. */
const MIN_WIDTH = 40;
/** Nerd Font marks for a tool that finished and one that failed. */
const DONE_MARK = "";
const FAILED_MARK = "";

/** The reporter the `veyyon commit` CLI installs. */
export function createCommitConsoleReporter(): CommitAgentReporter {
	let thinkingLineActive = false;
	const clearThinkingLine = () => {
		if (!thinkingLineActive) return;
		if (!process.stdout.isTTY) return;
		process.stdout.write("\r\x1b[2K");
		thinkingLineActive = false;
	};
	return {
		thinking(preview: string): void {
			if (!process.stdout.isTTY) return;
			process.stdout.write(`\r\x1b[2K${chalk.dim(`… ${truncatePreview(preview)}`)}`);
			thinkingLineActive = true;
		},
		messageEnded(): void {
			clearThinkingLine();
		},
		assistantError(message: string): void {
			process.stdout.write(`● Error: ${message}\n`);
		},
		assistantMessage(markdown: string): void {
			const lines = renderMarkdownLines(markdown);
			if (lines.length === 0) return;
			let firstContentIndex = lines.findIndex(line => line.trim().length > 0);
			if (firstContentIndex === -1) {
				firstContentIndex = 0;
			}
			for (const [index, line] of lines.entries()) {
				const prefix = index === firstContentIndex ? "● " : "  ";
				process.stdout.write(`${`${prefix}${line}`.trimEnd()}\n`);
			}
		},
		toolFinished(toolName: string, args: Record<string, unknown> | undefined, isError: boolean): void {
			clearThinkingLine();
			process.stdout.write(`${isError ? FAILED_MARK : DONE_MARK} ${formatToolLabel(toolName)}\n`);
			const argsLines = formatToolArgs(args);
			if (argsLines.length > 0) {
				process.stdout.write(`${formatToolArgsBlock(argsLines)}\n`);
			}
		},
		finished(messageCount: number, toolCalls: number): void {
			process.stdout.write(`● agent finished (${messageCount} messages, ${toolCalls} tools)\n`);
		},
	};
}

function truncatePreview(value: string): string {
	if (value.length <= PREVIEW_WIDTH) return value;
	return `${value.slice(0, PREVIEW_WIDTH - 1)}…`;
}

function renderMarkdownLines(message: string): readonly string[] {
	const width = Math.max(MIN_WIDTH, process.stdout.columns ?? FALLBACK_WIDTH);
	return new Markdown(message, 0, 0, getMarkdownTheme()).render(width);
}

function formatToolLabel(toolName: string): string {
	return toolName
		.split(/[_-]/)
		.map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
		.join("");
}

function formatToolArgs(args?: Record<string, unknown>): string[] {
	if (!args || Object.keys(args).length === 0) return [];
	const lines: string[] = [];
	const visit = (value: unknown, keyPath: string) => {
		if (value === null || value === undefined) return;
		if (Array.isArray(value)) {
			if (value.length === 0) return;
			const rendered = value.map(item => renderPrimitive(item)).filter(Boolean);
			if (rendered.length > 0) {
				lines.push(`${keyPath}: ${rendered.join(", ")}`);
			}
			return;
		}
		if (typeof value === "object") {
			const entries = Object.entries(value as Record<string, unknown>);
			if (entries.length === 0) return;
			for (const [childKey, childValue] of entries) {
				visit(childValue, `${keyPath}.${childKey}`);
			}
			return;
		}
		const rendered = renderPrimitive(value);
		if (rendered) {
			lines.push(`${keyPath}: ${rendered}`);
		}
	};
	for (const [key, value] of Object.entries(args)) {
		if (key === INTENT_FIELD) continue;
		visit(value, key);
	}
	return lines;
}

function renderPrimitive(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return null;
}

function formatToolArgsBlock(lines: string[]): string {
	return lines
		.map((line, index) => {
			if (index === 0) return `  ⎿ ${line}`;
			const branch = index === lines.length - 1 ? "└" : "├";
			return `    ${branch} ${line}`;
		})
		.join("\n");
}
