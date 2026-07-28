/**
 * Shared rendering primitives for bash/eval execution components.
 *
 * Each helper isolates a piece of structure both components share verbatim
 * (frame layout, collapsed preview, post-run status line). Differences in
 * how each component prepares its header, output lines, or sixel masking
 * stay in their respective files.
 */

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

/**
 * Output rows an execution block shows before it is expanded.
 *
 * Deliberately not one of `PREVIEW_LIMITS.OUTPUT_*` and not `DEFAULT_TERMINAL_PREVIEW_LINES`. Those describe how
 * a FINISHED tool result is summarised in the transcript, three rows collapsed and ten expanded. This is a live
 * block a user is watching run, so it keeps a screenful: the point of watching is to see the output scroll, and
 * three rows of a build log is not watching anything. Both components declared it as their own `PREVIEW_LINES`.
 */
export const EXECUTION_PREVIEW_LINES = 20;

/**
 * Widest single output line an execution block draws, in terminal COLUMNS.
 *
 * The unit is the whole point and it is where the two copies of this had diverged. Both declared
 * `MAX_DISPLAY_LINE_CHARS = 4000`, but bash measured `visibleWidth` and eval measured `line.length`, so the
 * same named limit meant two different things:
 *
 * - `line.length` counts ANSI escape bytes. Eval output is syntax-highlighted, so a styled line was charged for
 *   invisible colour codes and truncated while it still displayed far short of the limit.
 * - `line.length` counts a wide character as one. Two thousand CJK characters occupy 4000 columns and would
 *   overflow, yet measured 2000 and passed through untouched.
 * - `line.slice(4000)` cuts wherever 4000 code units land, which can be the middle of an escape sequence or of a
 *   surrogate pair, so the fragment reaches the terminal and the styling of everything after it is undefined.
 *
 * The column measurement is the correct one, so it is the one that survives here.
 */
export const EXECUTION_MAX_DISPLAY_COLUMNS = 4_000;

/**
 * Retained output lines during streaming, after which the oldest are dropped.
 *
 * Five screenfuls, so expanding a block that is still running still shows more than the collapsed view had. The
 * bound exists because a build or a test run emits tens of thousands of lines and a component that kept them all
 * would grow without limit while the user watched.
 *
 * `bash-execution.ts` had this and `eval-execution.ts` did not, so a long-running eval cell grew unbounded.
 */
export const EXECUTION_STREAMING_LINE_CAP = EXECUTION_PREVIEW_LINES * 5;

/**
 * Trim a retained-output buffer in place to {@link EXECUTION_STREAMING_LINE_CAP}, returning how many lines were
 * dropped from the front.
 *
 * The RETURN VALUE is the reason this is a function rather than two lines inline. Dropping output silently is
 * indistinguishable to a user from a program that produced less output, and the previous inline version dropped
 * lines and then computed its "… N more lines" hint from the already-trimmed buffer, so a five-thousand-line run
 * reported eighty hidden lines and expanding revealed a hundred. The caller now has the number it needs to say
 * what actually happened.
 */
export function capExecutionOutputLines(lines: string[]): number {
	if (lines.length <= EXECUTION_STREAMING_LINE_CAP) return 0;
	const dropped = lines.length - EXECUTION_STREAMING_LINE_CAP;
	lines.splice(0, dropped);
	return dropped;
}

/**
 * Clamp one output line to {@link EXECUTION_MAX_DISPLAY_COLUMNS} display columns, with a note saying how much
 * was dropped.
 *
 * The count in the note is columns, matching what was measured, so a user comparing it against a wrapped
 * terminal sees a number that corresponds to what they are looking at.
 */
export function clampExecutionDisplayLine(line: string): string {
	const visible = visibleWidth(line);
	if (visible <= EXECUTION_MAX_DISPLAY_COLUMNS) return line;
	const omitted = visible - EXECUTION_MAX_DISPLAY_COLUMNS;
	return `${truncateToWidth(line, EXECUTION_MAX_DISPLAY_COLUMNS, Ellipsis.Omit)}… [${omitted} visible columns omitted]`;
}

/** Theme color keys valid for an execution frame. */
export type ExecutionColorKey = "dim" | "bashMode" | "pythonMode";

/**
 * Build the content container + loader scaffold that bash and eval execution
 * components share. The caller appends the header (command vs `>>>` prompt)
 * and the returned loader to `contentContainer` so per-mode order is
 * preserved. No full-width border rules: the V1 aligned-quiet merge
 * (user-approved 2026-07-22) sits execution blocks on the transcript's shared
 * left rail — the mode color lives on the `$`/`>>>` header, and two
 * full-bleed rules around two short lines read as chrome shouting over
 * content.
 */
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

/**
 * Wrap a styled preview block in a render-time visual-line truncator.
 * Recomputed per render width so wrapping stays in sync with terminal size.
 */
export function createCollapsedPreview(previewText: string, previewLines: number): Component {
	return {
		render: (width: number) => truncateToVisualLines(previewText, previewLines, width, 2).visualLines,
		invalidate: () => {},
	};
}

/**
 * Build the post-run status block (hidden-line hint, exit/cancel marker,
 * truncation notice). Returns undefined when there is nothing to display so
 * callers can skip appending a stray Text child.
 */
export function buildStatusFooter(opts: {
	status: ExecutionStatus;
	exitCode: number | undefined;
	truncation: TruncationMeta | undefined;
	hiddenLineCount: number;
	/**
	 * Lines dropped from the front of the buffer by {@link capExecutionOutputLines}.
	 *
	 * Reported separately from `hiddenLineCount` and in a warning colour, because the two are different facts and
	 * conflating them would be a lie. Hidden lines are still held and expanding reveals them; dropped lines are
	 * gone, and a hint that says "ctrl+o to expand" would promise something that cannot happen.
	 */
	droppedLineCount?: number;
	/** Suppress the "… N more lines" hint (used when sixel passthrough renders the full output). */
	suppressHiddenCount?: boolean;
}): Text | undefined {
	const parts: string[] = [];

	if ((opts.droppedLineCount ?? 0) > 0) {
		parts.push(theme.fg("warning", `… ${opts.droppedLineCount} earlier lines dropped while streaming`));
	}
	if (opts.hiddenLineCount > 0 && !opts.suppressHiddenCount) {
		// The gesture is `app.tools.expand`, which is remappable, so the hint is read
		// rather than written out. The COUNT is stated either way: a block that hid
		// eighty lines silently reads as a block that had none.
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

/**
 * Derive the post-run status from an exit code + cancellation flag using the
 * same precedence both execution components apply.
 */
export function resolveExecutionStatus(exitCode: number | undefined, cancelled: boolean): ExecutionStatus {
	if (cancelled) return "cancelled";
	if (exitCode !== 0 && exitCode !== undefined && exitCode !== null) return "error";
	return "complete";
}
