import type { SelectItem, SelectListLayoutOptions } from "@veyyon/tui";
import { SelectList } from "@veyyon/tui";
import { getSelectListTheme } from "../../theme/theme";
import type { SetupKeyHint } from "./types";

/** The one way a setup scene builds a picker. `SelectList` prints its own key legend on the status row ("↑↓ move · ↵ select */
export function createWizardList(
	items: readonly SelectItem[],
	maxVisible: number,
	layout: Omit<SelectListLayoutOptions, "statusLegend"> = {},
): SelectList {
	return new SelectList(items, maxVisible, getSelectListTheme(), { ...layout, statusLegend: false });
}

/** Escape's meaning while `list` holds a search the user typed, or `undefined` when Escape should keep its wizard-wide meaning of leaving setup. */
export function filterEscapeHint(list: SelectList): SetupKeyHint | undefined {
	return list.hasActiveFilter() ? { keys: "esc", label: "clear search" } : undefined;
}
