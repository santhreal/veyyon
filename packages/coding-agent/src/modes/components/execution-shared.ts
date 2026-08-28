import {
	type Component,
	Container,
	Ellipsis,
	Loader,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/tui";
import { formatMoreLines } from "@veyyon/utils/format";
import { getSymbolTheme } from "../../modes/theme/symbol-theme";
import { theme } from "../../modes/theme/theme-binding";
import { formatTruncationMetaNotice, type TruncationMeta } from "../../tools/output-meta";
import { expandHintSuffix } from "../utils/key-hint";
import { truncateToVisualLines } from "./visual-truncate";

export type ExecutionStatus = "running" | "complete" | "cancelled" | "error";

export const EXECUTION_PREVIEW_LINES = 20;

export const EXECUTION_MAX_DISPLAY_COLUMNS = 4_000;

export const EXECUTION_STREAMING_LINE_CAP = EXECUTION_PREVIEW_LINES * 5;

export function capExecutionOutputLines(lines: string[]): number {
	if (lines.length <= EXECUTION_STREAMING_LINE_CAP) return 0;
	const dropped = lines.length - EXECUTION_STREAMING_LINE_CAP;
	lines.splice(0, dropped);
	return dropped;
}

export function clampExecutionDisplayLine(line: string): string {
	const visible = visibleWidth(line);
	if (visible <= EXECUTION_MAX_DISPLAY_COLUMNS) return line;
	const omitted = visible - EXECUTION_MAX_DISPLAY_COLUMNS;
	return `${truncateToWidth(line, EXECUTION_MAX_DISPLAY_COLUMNS, Ellipsis.Omit)}… [${omitted} visible columns omitted]`;
}

export type ExecutionColorKey = "dim" | "bashMode" | "pythonMode";

export function buildExecutionFrame(
	parent: Container,
	ui: TUI,
	colorKey: ExecutionColorKey,
): { contentContainer: Container; loader: Loader } {
	const contentContainer = new Container();
	parent.addChild(contentContainer);

	const loader = new Loader(
		ui,
		spinner => theme.fg(colorKey, spinner),
		text => theme.fg("muted", text),
		`Running… (esc to cancel)`,
		getSymbolTheme().spinnerFrames,
	);

	return { contentContainer, loader };
}

export function createCollapsedPreview(previewText: string, previewLines: number): Component {
	return {
		render: (width: number) => truncateToVisualLines(previewText, previewLines, width, 2).visualLines,
		invalidate: () => {},
	};
}

export function buildStatusFooter(opts: {
	status: ExecutionStatus;
	exitCode: number | undefined;
	truncation: TruncationMeta | undefined;
	hiddenLineCount: number;
	droppedLineCount?: number;
	suppressHiddenCount?: boolean;
}): Text | undefined {
	const parts: string[] = [];

	if ((opts.droppedLineCount ?? 0) > 0) {
		parts.push(theme.fg("warning", `… ${opts.droppedLineCount} earlier lines dropped while streaming`));
	}
	if (opts.hiddenLineCount > 0 && !opts.suppressHiddenCount) {
		parts.push(theme.fg("dim", `… ${formatMoreLines(opts.hiddenLineCount)}${expandHintSuffix()}`));
	}
	if (opts.status === "cancelled") {
		parts.push(theme.fg("warning", "(cancelled)"));
	} else if (opts.status === "error") {
		parts.push(theme.fg("error", `(exit ${opts.exitCode})`));
	}
	if (opts.truncation) {
		parts.push(theme.fg("warning", formatTruncationMetaNotice(opts.truncation)));
	}

	if (parts.length === 0) return undefined;
	return new Text(`\n${parts.join("\n")}`, 2, 0);
}

export function resolveExecutionStatus(exitCode: number | undefined, cancelled: boolean): ExecutionStatus {
	if (cancelled) return "cancelled";
	if (exitCode !== 0 && exitCode !== undefined && exitCode !== null) return "error";
	return "complete";
}
