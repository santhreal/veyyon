import type { Model } from "@veyyon/ai";

export interface ModelPickerCallbacks {
	onPick: (model: Model, selector: string) => void;
	onCancel: () => void;
}

export interface ModelPickerOptions {
	currentContextTokens?: number;
	currentSelector?: string;
}

export const BROWSER_FRAME_ROWS = 5;
export const MIN_VISIBLE = 5;

export const STATUS_HINT = "Interactive model — role / subagent / compaction slots stay unchanged";
export const REFRESH_HINT = "Don't see a model? ctrl+r reloads the catalog from your providers and models.dev";
export const REFRESH_HINT_SHORT = "Don't see a model? ctrl+r reloads the catalog";
export const REFRESHING_HINT = "Reloading the model catalog…";
