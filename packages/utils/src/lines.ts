/**
 * Split text into lines, ignoring the single empty line a trailing newline
 * would otherwise produce. Interior blank lines are preserved.
 *
 *   splitTextLines("a\nb")   → ["a", "b"]
 *   splitTextLines("a\nb\n") → ["a", "b"]   (trailing "\n" is not a line)
 *   splitTextLines("a\n\nb") → ["a", "", "b"] (interior blank kept)
 *   splitTextLines("")        → []            (a trailing-only empty is not a line)
 *
 * This is the ONE owner for that behavior. It is deliberately distinct from
 * the VCS-scoped `splitLines` in coding-agent/utils/git.ts, which additionally
 * trims each line and drops every blank (right for command output, wrong for
 * diff bodies where blank lines are meaningful).
 */
export function splitTextLines(text: string): string[] {
	return text.split("\n").filter((line, idx, arr) => idx < arr.length - 1 || line);
}
