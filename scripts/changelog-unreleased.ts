/**
 * The one parser for `## [Unreleased]` entries.
 *
 * There used to be two, `parseUnreleasedBullets` in `require-changelog.ts` and
 * `unreleasedBullets` in `sync-root-changelog.ts`, and both sit on the release
 * path. They had drifted apart on four axes, and one of those disagreements
 * destroyed data: `sync-root-changelog` detected a bullet with
 * `line.startsWith("- ")` against the untrimmed line, so an entry indented under
 * a `### Added` sub-heading was invisible to it. `orphanedRootEntries` is what
 * refuses to overwrite entries nobody has claimed, and an entry it cannot see
 * looks like nothing to protect, so the root changelog writer overwrote it.
 *
 * Splitting the difference is what caused the bug, so this takes the safer
 * behavior on each axis rather than the average one.
 */

/** The heading, anchored to a line. */
const UNRELEASED_HEADING_LINE = /^## \[Unreleased\][^\n]*$/m;

/** The literal heading text, for the message that tells an author to write one. */
export const UNRELEASED_HEADING = "## [Unreleased]";

/**
 * Every entry under `## [Unreleased]`, one string per entry, prefix stripped and
 * whitespace collapsed.
 *
 * Four decisions, each one the safer half of a disagreement between the two
 * parsers this replaces:
 *
 * - The heading is matched as a LINE and may carry a suffix, so `## [Unreleased]`
 *   and `## [Unreleased] - TBD` are both the heading, and prose that merely
 *   quotes the heading is not. The root changelog's own banner tells contributors
 *   where to write, and an unanchored search once matched that banner and
 *   reported an empty section for a file full of entries.
 * - A bullet is detected on the TRIMMED line, so an entry indented under a
 *   sub-heading counts. This is the one that destroyed data.
 * - A wrapped entry is joined into one string, because a re-wrapped paragraph is
 *   the same entry and half a paragraph is not an entry at all. Identity is taken
 *   from the opening characters, so entries must not be split at the line break.
 * - A bullet with no text is not an entry. `-` alone used to satisfy the
 *   changelog gate, which let an empty placeholder buy a release.
 */
export function unreleasedEntries(md: string): string[] {
	const heading = UNRELEASED_HEADING_LINE.exec(md);
	if (!heading) return [];
	const rest = md.slice(heading.index + heading[0].length);
	const nextRelease = rest.search(/\n## /);
	const block = nextRelease === -1 ? rest : rest.slice(0, nextRelease);

	const entries: string[] = [];
	let current: string[] = [];
	const flush = () => {
		if (current.length > 0) entries.push(current.join(" "));
		current = [];
	};

	for (const line of block.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("- ") || trimmed === "-") {
			flush();
			current = [trimmed.slice(1).trim()];
		} else if (trimmed.startsWith("#")) {
			flush();
		} else if (current.length > 0 && trimmed.length > 0) {
			current.push(trimmed);
		}
	}
	flush();

	return entries.map(entry => entry.replace(/\s+/g, " ").trim()).filter(entry => entry.length > 0);
}
