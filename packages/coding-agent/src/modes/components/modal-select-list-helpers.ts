import type { SelectItem, SelectListLayoutOptions, SelectListTheme } from "@veyyon/tui";

export interface ModalSelectListCallbacks {
	onSelect: (item: SelectItem) => void;
	onCancel: () => void;
	onSelectionChange?: (item: SelectItem) => void;
}

export interface ModalSelectListOptions {
	title: string;
	items: SelectItem[];
	theme: SelectListTheme;
	/** Preselected index; -1 leaves the list default. */
	selectedIndex?: number;
	maxVisible?: number;
	/** Override terminal rows (tests). */
	getTerminalRows?: () => number;
	tipCandidates?: readonly string[];
	/** Column sizing for the hosted list. Worth exposing because the default primary column is 32 cells wide, which */
	layout?: SelectListLayoutOptions;
}
/** Floating medium ModalShell hosting a SelectList. Host as a fullscreen overlay so the shell can paint clear underpaint around the card. */
