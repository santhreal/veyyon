import type { SymbolTheme } from "../symbols";

export const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
export const PRIMARY_COLUMN_GAP = 2;
export const MIN_DESCRIPTION_WIDTH = 10;

export const DEFAULT_CURSOR_SYMBOL = ">";

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
	hint?: string;
	group?: string;
	filterText?: string;
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	symbols: SymbolTheme;
	hovered?: (text: string, strength: number) => string;
	matchHighlight?: (text: string) => string;
	groupHeader?: (text: string) => string;
}

export interface SelectListTruncatePrimaryContext {
	text: string;
	maxWidth: number;
	columnWidth: number;
	item: SelectItem;
	isSelected: boolean;
}

export interface SelectListLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
	overflowSearch?: boolean;
	wrapDescription?: boolean;
	statusLegend?: boolean;
}

export type SelectItemLayout =
	| {
			kind: "description";
			prefix: string;
			truncatedValue: string;
			spacing: string;
			descriptionSingleLine: string;
			descriptionStart: number;
			remainingWidth: number;
	  }
	| {
			kind: "primary";
			prefix: string;
			truncatedValue: string;
			spacing: "";
	  };
