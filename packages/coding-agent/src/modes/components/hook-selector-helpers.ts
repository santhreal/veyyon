import type { TUI } from "@veyyon/tui";
import { theme } from "../../modes/theme/theme";

/** One segment of a {@link HookSelectorSlider} — a label and an optional
 *  detail line (e.g. the resolved model name) shown beneath the track while
 *  the segment is active. Segment colors come from the track's theme palette,
 *  assigned by position. */
export interface HookSelectorSliderSegment {
	label: string;
	/** Secondary line rendered under the track when this segment is selected. */
	detail?: string;
}

/**
 * A horizontal left/right selector rendered above the option list. Unlike the
 * up/down option cursor, the slider is moved with the left/right arrows from
 * any list position, letting the caller capture an orthogonal choice (e.g. the
 * model tier to continue execution with) alongside the selected option.
 */
export interface HookSelectorSlider {
	/** Dim caption rendered before the slider track (e.g. "continue with"). */
	caption?: string;
	segments: HookSelectorSliderSegment[];
	/** Initially highlighted segment index. */
	index: number;
	/** Invoked with the new index whenever the slider moves. */
	onChange?: (index: number) => void;
}

export interface HookSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onTimeout?: () => void;
	onTimeoutStart?: () => void;
	onTimeoutReset?: () => void;
	initialIndex?: number;
	maxVisible?: number;
	onLeft?: () => void;
	onRight?: () => void;
	onExternalEditor?: () => void;
	helpText?: string;
	slider?: HookSelectorSlider;
	/** Indices into the original options that cannot be selected: they render
	 *  dimmed, are skipped during navigation, and reject enter/timeout. */
	disabledIndices?: readonly number[];
	/** Render a leading radio/checkbox marker before each markable option,
	 *  matching the ask transcript. "radio" fills the marker on the cursor row
	 *  (single-choice); "checkbox" reflects {@link checkedIndices} per row
	 *  (multi-select). Options at or beyond {@link markableCount} keep the plain
	 *  cursor prefix — used for trailing control rows like "Other"/"Done". */
	selectionMarker?: "radio" | "checkbox";
	/** For `selectionMarker: "checkbox"`: original-indices currently checked. */
	checkedIndices?: readonly number[];
	/** Number of leading options (original order) that receive a selection
	 *  marker. Defaults to every option when {@link selectionMarker} is set. */
	markableCount?: number;
	/**
	 * `"card"` (default) is the standalone surface: a floating ModalShell over
	 * the transcript, with house footer chips and pointer support. `"embedded"`
	 * renders the bare title and option list for a host that already owns a
	 * card and mounts this inside its body (the session picker's delete
	 * confirmation), so the two frames never nest.
	 */
	presentation?: "card" | "embedded";
	/** Card presentation only: repaint request for hover and countdown paints. */
	onRequestRender?: () => void;
}

export interface HookSelectorOption {
	label: string;
	description?: string;
}

export type HookSelectorOptionInput = string | HookSelectorOption;

export function normalizeHookSelectorOption(option: HookSelectorOptionInput): HookSelectorOption {
	if (typeof option === "string") return { label: option };
	if (option.description?.trim()) {
		return { label: option.label, description: option.description.trim() };
	}
	return { label: option.label };
}

/** One row of the option list. `highlight` causes the row (and its wrapped
 *  continuations, plus trailing padding) to be painted with the theme's
 *  `selectedBg` band — the focus cue that survives themes where `accent` fg is
 *  close to the terminal foreground. `option` is the filtered option index the
 *  row belongs to, so the pointer can answer a click on any of an option's
 *  lines with that option. */
export type SelectorRow = { text: string; highlight: boolean; option?: number };

/** Paint `content` with the `selectedBg` background, applied AFTER any inner
 *  ANSI styling so the band spans padding as well as content. */
export function paintSelectedRow(content: string): string {
	return theme.bg("selectedBg", content);
}

/** A filtered option paired with its index into the original options array, so
 *  disabled-index lookups survive fuzzy filtering and reordering. */
export type FilteredOption = { option: HookSelectorOption; index: number };
