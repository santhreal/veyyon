import type { Markdown } from "@veyyon/tui";
import type { HookSelectorSlider } from "./hook-selector";
import { MODAL_SIZING_LARGE, minModalChromeRows } from "./modal-shell";

export const OVERLAY_TITLE = "Plan Review";
export const MIN_BODY_ROWS = 3;
export const SIDEBAR_MIN_HEADINGS = 2;
export const SIDEBAR_MIN_TOTAL_WIDTH = 64;
export const SIDEBAR_MIN_BODY_WIDTH = 40;
export const SIDEBAR_DIVIDER_COLS = 3;
export const CHROME_ROWS = minModalChromeRows(MODAL_SIZING_LARGE);

export type Focus = "toc" | "body" | "actions";

export interface OverlaySection {
	level: number;
	title: string;
	raw: string;
	md: Markdown;
	annotations: string[];
}

export interface UndoEntry {
	text: string;
	annotations: string[][];
	deleted: string[];
}

export interface PlanReviewOverlayCallbacks {
	onPick: (label: string) => void;
	onCancel: () => void;
	onCopyPlan?: (content: string) => void | Promise<void>;
	onExternalEditor?: () => void;
	onAnnotationExternalEditor?: (draft: string, commit: (text: string | null) => void) => void;
	onPlanEdited?: (content: string) => void;
	onFeedbackChange?: (feedback: string) => void;
}

export interface PlanReviewOverlayOptions {
	promptTitle?: string;
	options: string[];
	disabledIndices?: number[];
	helpText?: string;
	initialIndex?: number;
	slider?: HookSelectorSlider;
	externalEditorLabel?: string;
	requestRender?: () => void;
}

export const DEFAULT_HELP_SUFFIX = "esc cancel";
