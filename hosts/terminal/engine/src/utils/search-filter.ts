import { Ellipsis } from "@veyyon/natives";
import { getKeybindings } from "@veyyon/utils/keybindings";
import { extractPrintableText } from "@veyyon/utils/keys";
import { truncateToWidth } from "@veyyon/utils/width";
import { sanitizeSingleLine } from "@veyyon/utils/wrap";
import { dropLastCodePoint } from "./text-layout";

/**
 * Handle search keyboard input (Backspace, typing characters) for list filters.
 * Returns the new query string if input was consumed, or null if unhandled.
 */
export function handleSearchKeyInput(data: string, query: string, canEdit: boolean, canClear: boolean): string | null {
	const kb = getKeybindings();
	if (kb.matches(data, "tui.editor.deleteCharBackward")) {
		if (!canClear) return null;
		return dropLastCodePoint(query);
	}
	if (!canEdit) return null;
	const printableText = extractPrintableText(data);
	if (printableText === undefined) return null;
	if (query.length === 0 && printableText.trim().length === 0) return null;
	return query + printableText;
}

/**
 * Format search status hint line with query or placeholder text.
 */
export function formatSearchStatus(
	query: string,
	width: number,
	hintFn: (text: string) => string,
	prefix = "  Search: ",
	emptyText = "  Type to search",
): string {
	const clean = sanitizeSingleLine(query);
	const text = clean ? `${prefix}${clean}` : emptyText;
	return hintFn(truncateToWidth(text, width, Ellipsis.Omit));
}
