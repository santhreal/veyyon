/**
 * The one owner of the unified-diff hunk-header grammar:
 * `@@ -oldStart,oldLines +newStart,newLines @@ optional change context`.
 *
 * Two parsers used to carry their own regex for this single rule, and they could only
 * disagree in the fail-open direction. `edit/diff.ts` (apply-patch) anchored the match,
 * accepted any run of whitespace between the two ranges, and captured the trailing change
 * context. `commit/git/diff.ts` (the staging pipeline) matched unanchored, required exactly
 * one whitespace character on each side of the ranges, and answered `{0, 0, 0, 0}` for a
 * header it could not read. So a combined merge header (`@@@ -1,2 -1,2 +1,2 @@@`), or any
 * separator git does not spell with a single space, placed every hunk of that file at line
 * zero: `selectHunks` in `utils/git.ts` then dropped all of them from a line-range
 * selection and the operator was told nothing at all, while the apply-patch path given the
 * same bytes refused loudly.
 *
 * Both sides parse through this module now. A header this grammar does not recognise is
 * `undefined`, never a header with invented numbers, so each caller states out loud what it
 * does about one.
 */

/**
 * `@@ -a,b +c,d @@ context`. Anchored, so a line that merely contains a header somewhere is
 * not one; `\s+` between the ranges because a hand-written patch pads them; the trailing
 * capture is the change context git puts after the second `@@`.
 */
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
