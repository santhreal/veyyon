/**
 * The chrome around the transcript: the status line, the composer zone and the
 * dialogs, each as rows.
 *
 * Pure like `block-rows`: a view-model and a width in, rows out. Keeping the
 * chrome's text here rather than inside the driver's components is what lets a
 * test assert the exact bytes of a status line without starting an engine.
 */

import { truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { replaceTabs, sanitizeSingleLine, wrapTextWithAnsi } from "@veyyon/utils/wrap";
import type {
	ComposerState,
	DialogViewModel,
	PresentationTheme,
	SessionActivity,
	StatusLineState,
} from "@veyyon/wire/presentation";
import { paint } from "./theme-ansi";

/** What each activity is called on the status line. */
const ACTIVITY_LABEL: Record<SessionActivity, string> = {
	idle: "ready",
	thinking: "thinking",
	streaming: "writing",
	"tool-running": "running",
	compacting: "compacting",
	"waiting-approval": "waiting",
};

/** Separator between status segments. */
const SEPARATOR = "  ";

function contextPercent(state: StatusLineState): number {
	const total = state.context.total;
	if (total <= 0) return 0;
	return Math.min(100, Math.round((state.context.used / total) * 100));
}

/**
 * One row of session state. Segments are dropped from the right when the frame
 * is too narrow, so the activity and the model — the two facts that change what
 * the operator does next — survive at any width.
 */
export function statusRow(state: StatusLineState, width: number, theme: PresentationTheme): string {
	const usable = Math.max(1, Math.trunc(width));
	const chrome = theme.chrome;
	const segments: string[] = [];
	segments.push(paint(ACTIVITY_LABEL[state.activity], state.activity === "idle" ? chrome.muted : chrome.accent));
	segments.push(paint(state.model, chrome.statusLine));
	if (state.thinkingLevel !== undefined) segments.push(paint(state.thinkingLevel, chrome.muted));
	segments.push(paint(`${contextPercent(state)}% ctx`, chrome.muted));
	if (state.cost.totalUsd > 0) segments.push(paint(`$${state.cost.totalUsd.toFixed(2)}`, chrome.muted));
	segments.push(paint(sanitizeSingleLine(state.workingDirectory), chrome.muted));
	if (state.gitBranch !== undefined) segments.push(paint(sanitizeSingleLine(state.gitBranch), chrome.muted));
	if (state.queuedMessages > 0) segments.push(paint(`${state.queuedMessages} queued`, chrome.warning));
	if (state.notice !== undefined) {
		const role =
			state.notice.level === "error"
				? chrome.error
				: state.notice.level === "warning"
					? chrome.warning
					: chrome.muted;
		segments.push(paint(sanitizeSingleLine(state.notice.text), role));
	}

	let row = "";
	for (const segment of segments) {
		const candidate = row === "" ? segment : `${row}${SEPARATOR}${segment}`;
		// Measured, not counted: every segment carries SGR bytes that occupy no
		// columns, so a length check would shed segments a wide frame has room for.
		if (visibleWidth(candidate) > usable) break;
		row = candidate;
	}
	return row === "" ? truncateToWidth(ACTIVITY_LABEL[state.activity], usable) : row;
}

/** The prompt each composer mode shows. */
const PROMPT: Record<ComposerState["mode"], string> = {
	input: "›",
	shell: "!",
	search: "/",
	"awaiting-approval": "?",
	disabled: "×",
};

/**
 * The composer zone: a prompt row with the operator's text, then the completion
 * rows and the hint. The caret is not drawn here — the engine places the
 * hardware cursor — so the rows carry no cursor marker.
 */
export function composerRows(state: ComposerState, width: number, theme: PresentationTheme): string[] {
	const usable = Math.max(4, Math.trunc(width));
	const chrome = theme.chrome;
	const prompt = PROMPT[state.mode];
	const body =
		state.text === ""
			? paint(state.placeholder, chrome.placeholder)
			: paint(replaceTabs(state.text), chrome.composer);
	const rows = wrapTextWithAnsi(body, usable - prompt.length - 1).map((row, index) =>
		index === 0 ? `${paint(prompt, chrome.accent)} ${row}` : `${" ".repeat(prompt.length + 1)}${row}`,
	);
	if (rows.length === 0) rows.push(paint(prompt, chrome.accent));

	for (const attachment of state.attachments) {
		rows.push(paint(truncateToWidth(`  + ${attachment.name}`, usable), chrome.muted));
	}
	if (state.completion !== undefined && state.completion.candidates.length > 0) {
		const completion = state.completion;
		for (const [index, candidate] of completion.candidates.entries()) {
			const role = index === completion.selectedIndex ? chrome.selection : chrome.muted;
			const label = candidate.label ?? candidate.value;
			const shown = candidate.detail === undefined ? label : `${label}  ${candidate.detail}`;
			rows.push(paint(truncateToWidth(`  ${shown}`, usable), role));
		}
	}
	if (state.queueOnSubmit) rows.push(paint("  a turn is running; enter queues this message", chrome.muted));
	if (state.hint !== undefined)
		rows.push(paint(truncateToWidth(`  ${sanitizeSingleLine(state.hint)}`, usable), chrome.muted));
	return rows;
}

/** Transient state a dialog holds while it is open, which the view-model does not carry. */
export interface DialogRenderState {
	selectedIndex: number;
	entered: string;
}

/** Rows for a dialog. Exhaustive over the union, so a new dialog kind is a compile error. */
export function dialogRows(
	dialog: DialogViewModel,
	width: number,
	theme: PresentationTheme,
	state: DialogRenderState,
): string[] {
	const usable = Math.max(8, Math.trunc(width));
	const chrome = theme.chrome;
	switch (dialog.kind) {
		case "confirm": {
			const rows = [paint(truncateToWidth(dialog.title, usable), dialog.destructive ? chrome.error : chrome.accent)];
			rows.push(...wrapTextWithAnsi(paint(replaceTabs(dialog.body), { fg: chrome.foreground }), usable));
			rows.push(paint(`[y] ${dialog.confirmLabel}   [n] ${dialog.cancelLabel}`, chrome.muted));
			return rows;
		}
		case "tool-approval": {
			const rows = [paint(truncateToWidth(`Run ${dialog.toolName}?`, usable), chrome.accent)];
			rows.push(...wrapTextWithAnsi(paint(replaceTabs(dialog.input), theme.transcript.toolInput), usable));
			if (dialog.impact !== undefined) {
				rows.push(...wrapTextWithAnsi(paint(replaceTabs(dialog.impact), chrome.warning), usable));
			}
			rows.push(paint("[y] run   [n] refuse   [esc] cancel", chrome.muted));
			return rows;
		}
		case "select": {
			const rows = [paint(truncateToWidth(dialog.title, usable), chrome.accent)];
			for (const [index, option] of dialog.options.entries()) {
				const mark = index === state.selectedIndex ? "›" : " ";
				const label = option.description === undefined ? option.label : `${option.label}  ${option.description}`;
				const role =
					option.disabled === true
						? chrome.muted
						: index === state.selectedIndex
							? chrome.selection
							: chrome.statusLine;
				rows.push(paint(truncateToWidth(`${mark} ${label}`, usable), role));
			}
			if (dialog.filterable) rows.push(paint("type to filter", chrome.muted));
			return rows;
		}
		case "prompt": {
			const rows = [paint(truncateToWidth(dialog.title, usable), chrome.accent)];
			const shown = dialog.masked ? "•".repeat(state.entered.length) : state.entered;
			const body = shown === "" ? paint(dialog.placeholder, chrome.placeholder) : paint(shown, chrome.composer);
			rows.push(...wrapTextWithAnsi(body, usable));
			rows.push(paint("[enter] accept   [esc] cancel", chrome.muted));
			return rows;
		}
	}
}
