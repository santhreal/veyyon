/** The one owner of the unified-diff hunk-header grammar: `@@ -oldStart,oldLines +newStart,newLines @@ optional change context`. */

/** `@@ -a,b +c,d @@ context`. Anchored, so a line that merely contains a header somewhere is not one; `\s+` between the ranges because a hand-written patch pads them; the trailing */
const UNIFIED_HUNK_HEADER_REGEX = /^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@(?:\s*(.*))?$/;

export interface UnifiedHunkHeader {
	/** First line of the hunk in the pre-image, 1-based as git writes it. */
	oldStart: number;
	/** Pre-image line count. Absent in the header means 1, which is git's own default. */
	oldLines: number;
	/** First line of the hunk in the post-image, 1-based. */
	newStart: number;
	/** Post-image line count, defaulting to 1 the same way. */
	newLines: number;
	/** The text after the closing `@@`, when there is any. */
	changeContext?: string;
}

/** Parse one header line, or answer `undefined` when it is not one this grammar knows. */
export function parseUnifiedHunkHeader(line: string): UnifiedHunkHeader | undefined {
	const match = line.match(UNIFIED_HUNK_HEADER_REGEX);
	if (!match) return undefined;

	const changeContext = match[5]?.trim();
	return {
		oldStart: Number(match[1]),
		oldLines: match[2] ? Number(match[2]) : 1,
		newStart: Number(match[3]),
		newLines: match[4] ? Number(match[4]) : 1,
		changeContext: changeContext && changeContext.length > 0 ? changeContext : undefined,
	};
}
