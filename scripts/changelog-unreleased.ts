/**
 * The one place that knows what a changelog heading looks like.
 *
 * Two headings matter on the release path: `## [Unreleased]` and `## [X.Y.Z]`.
 * Each had grown several private spellings, and both sets had drifted.
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

// By relative path, not "@veyyon/utils/semver". `checks.yml::changelog` and
// `ci.yml::release_notes_dryrun` run the scripts that reach this file without a
// `bun install`, so `node_modules/@veyyon/utils` does not exist there and the
// package specifier fails to resolve. `semver.ts` imports nothing of its own.
import { RELEASE_VERSION_BODY } from "../packages/utils/src/semver";

/** The heading, anchored to a line. */
const UNRELEASED_HEADING_LINE = /^## \[Unreleased\][^\n]*$/m;

/** The literal heading text, for the message that tells an author to write one. */
export const UNRELEASED_HEADING = "## [Unreleased]";

/**
 * A version heading, anchored to a line. The version body is the shared release
 * grammar, so this and `isReleaseVersion` cannot drift.
 */
const VERSION_HEADING_LINE = new RegExp(String.raw`^## \[(${RELEASE_VERSION_BODY})\]`);

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

/**
 * Every `## [X.Y.Z]` heading, in document order, with the line it sits on.
 *
 * The version grammar is `RELEASE_VERSION_PATTERN`, the same one the release
 * gate uses to decide whether a version is releasable at all, so a string that
 * is not a version cannot become a version section by being written as one.
 * The private spellings this replaces used `\d+\.\d+\.\d+`, which accepts
 * `01.2.3`, and the release path would then have carried a heading no tag could
 * ever match.
 *
 * `## [Unreleased]` is deliberately not a match. It is a placeholder, and every
 * caller here is asking about releases.
 */
export function versionHeadings(md: string): Array<{ version: string; line: number }> {
	const found: Array<{ version: string; line: number }> = [];
	md.split("\n").forEach((text, index) => {
		const match = VERSION_HEADING_LINE.exec(text);
		if (match) found.push({ version: match[1] as string, line: index + 1 });
	});
	return found;
}

/**
 * Whether the changelog already carries a section for this exact version.
 *
 * Dateless on purpose: the roll writes `## [X.Y.Z] - YYYY-MM-DD`, but a re-cut
 * of a version whose bump commit already landed has to recognise its own work,
 * and the gate that asks this runs before the date is known.
 */
export function hasVersionHeading(md: string, version: string): boolean {
	return versionHeadings(md).some(heading => heading.version === version);
}
