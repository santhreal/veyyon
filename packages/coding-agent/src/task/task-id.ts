/**
 * An agent's id as a reader sees it.
 *
 * Ids are name-based (`Anna`, `Anna-2`) and a `.` separates nesting levels (`Anna.Bob`), which is a
 * hierarchy rather than a filename, so it reads as a breadcrumb. Stated here rather than beside the
 * card that shows it, because the agent HUD, the transcript card and the roster all name the same
 * agent and a second spelling of this would show one agent two ways.
 */

import { sanitizeText } from "@veyyon/utils";

/** The id with its nesting levels as a `>` breadcrumb. */
export function formatTaskId(id: string): string {
	const sanitizedId = sanitizeText(id);
	const segments = sanitizedId.split(".");
	return segments.length < 2 ? sanitizedId : segments.join(">");
}
