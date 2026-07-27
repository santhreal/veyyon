/**
 * The filename extension every session transcript is written with, and the three questions asked about it.
 *
 * WHY THIS IS A CONTRACT AND NOT A DETAIL. One module WRITES a transcript path and several others DISCOVER
 * transcripts by scanning a directory for the extension. `session/session-manager.ts` builds
 * `<timestamp>_<id>.jsonl` in four places; `session/session-listing.ts`, `cli/gc-cli.ts`, `export/html`,
 * `modes/components/agent-hub.ts`, `debug/report-bundle.ts`, `internal-urls/registry-helpers.ts` and
 * `@veyyon/stats`'s parser each scan for it. A drift between the writer and any scanner is silent in the
 * worst direction: sessions keep being written and simply stop being listed, resumed, garbage-collected or
 * counted, and no error is raised because an empty directory listing is a valid answer.
 *
 * It had been spelled inline at dozens of sites in four packages, plus three constants that did not share a
 * name: `JSONL_SUFFIX` in `advisor/transcript-recorder.ts`, `SESSION_SUFFIX` in `cli/gc-cli.ts` and
 * `JSONL_SUFFIX_LENGTH` in `session/session-manager.ts`. Three names for one value is worse than three
 * copies of one name, because a reader who greps for any of them finds nothing and cannot tell it is shared.
 *
 * THE HELPERS ARE HERE FOR THE SAME REASON THE CONSTANT IS. Stripping the extension was written as
 * `path.basename(file, ".jsonl")` in some places, `name.slice(0, -".jsonl".length)` in others and
 * `file.slice(0, -JSONL_SUFFIX_LENGTH)` in a third, and those are not the same function: `basename` also
 * strips the directory. Naming both operations means a caller picks the one it meant.
 *
 * This module has no imports, so any package pays one module for the contract.
 */

/**
 * The extension, with its leading dot.
 *
 * JSON Lines, because a session is appended to one record at a time and must stay readable after a crash
 * mid-write: a truncated final line is one lost record rather than an unparseable file.
 */
export const SESSION_FILE_EXTENSION = ".jsonl";

/** Whether a filename is a session transcript. Case-sensitive, matching how the writer spells it. */
export function isSessionFileName(name: string): boolean {
	return name.endsWith(SESSION_FILE_EXTENSION);
}

/**
 * The name without its extension, leaving any directory part alone.
 *
 * Returns the input unchanged when it does not carry the extension, so a caller that hands over an already
 * stripped stem gets the stem back rather than losing its last five characters.
 */
export function sessionFileStem(name: string): string {
	return isSessionFileName(name) ? name.slice(0, -SESSION_FILE_EXTENSION.length) : name;
}

/**
 * A stem with the extension applied, applied exactly once.
 *
 * Idempotent because callers pass both forms: some hold `<id>` and some hold `<id>.jsonl`, and appending
 * unconditionally would produce `<id>.jsonl.jsonl`, a file the scanners would happily list as a session.
 */
export function sessionFileName(stem: string): string {
	return isSessionFileName(stem) ? stem : `${stem}${SESSION_FILE_EXTENSION}`;
}

/**
 * The suffix a moved-aside session transcript carries.
 *
 * A backup exists only in one situation: `session/session-storage.ts` fails to rename a freshly written
 * temp file over the live transcript (Windows EPERM, a virus scanner or an editor holding the handle), so it
 * moves the live one aside first. The name it moves to is `<primary>.<snowflake>.bak`, and the snowflake is
 * there so two rescues in the same millisecond cannot collide.
 */
export const SESSION_BACKUP_EXTENSION = ".bak";

/**
 * The name a transcript is moved aside to, given the transcript's own name and a unique id.
 *
 * The FORMAT is the contract, not just the suffix. `session-listing.ts` reads it back to recover a session
 * stranded by a crash between the two renames, `cli/gc-cli.ts` globs for it to sweep old ones, and the Agent
 * Hub and HTML export filter it out of session lists. Four readers against one writer, and the writer's
 * template and the reader's parse had been written independently: if they disagreed, a user who hit the EPERM
 * path would keep the only copy of their session in a file nothing recovers, nothing lists and nothing
 * collects, which looks exactly like having lost the session.
 */
export function sessionBackupName(primaryName: string, id: string | number): string {
	return `${primaryName}.${id}${SESSION_BACKUP_EXTENSION}`;
}

/** Whether a filename is a moved-aside file of any kind. */
export function isSessionBackupName(name: string): boolean {
	return name.endsWith(SESSION_BACKUP_EXTENSION);
}

/**
 * The transcript a backup belongs to, or `undefined` when the name is not a backup OF A SESSION.
 *
 * The exact inverse of {@link sessionBackupName}, which is why it lives beside it. It returns `undefined`
 * rather than a best guess for anything that does not fit, including a `.bak` whose primary is not a
 * transcript: recovery RENAMES the backup over the returned path, so a wrong answer here does not degrade a
 * listing, it overwrites a file.
 */
export function sessionBackupPrimaryName(name: string): string | undefined {
	if (!isSessionBackupName(name)) return undefined;
	const withoutSuffix = name.slice(0, -SESSION_BACKUP_EXTENSION.length);
	const idStart = withoutSuffix.lastIndexOf(".");
	if (idStart <= 0) return undefined;
	const primary = withoutSuffix.slice(0, idStart);
	// The id segment must be present, so `a.jsonl..bak` is not a backup of `a.jsonl`.
	if (withoutSuffix.length - idStart <= 1) return undefined;
	return isSessionFileName(primary) ? primary : undefined;
}

/**
 * The stem an advisor's transcript is named with.
 *
 * Here rather than in `@veyyon/coding-agent` because this is the same writer-and-scanner shape crossing a
 * PACKAGE boundary: `advisor/transcript-recorder.ts` names the file, and `@veyyon/stats`'s parser classifies
 * a transcript as the advisor's by matching the name. Stats cannot import the coding agent, so it had
 * declared `"__advisor.jsonl"` itself, and `modes/components/agent-hub.ts` had spelled `"__advisor."` inline
 * a third time to slice the prefix off. If the stem ever moved, the writer would move and the classifiers
 * would not: advisor transcripts would be counted as ordinary subagent sessions, which is a wrong number
 * rather than an error.
 *
 * The leading underscores keep it out of the task-subagent id namespace, so a subagent can never be handed
 * an id that produces this filename.
 */
export const ADVISOR_TRANSCRIPT_STEM = "__advisor";

/** The default advisor's transcript filename. A named advisor is `__advisor.<slug>.jsonl`. */
export const ADVISOR_TRANSCRIPT_FILENAME = sessionFileName(ADVISOR_TRANSCRIPT_STEM);

/** The prefix a NAMED advisor's transcript starts with, stem and separator, as one thing to match or strip. */
export const ADVISOR_TRANSCRIPT_PREFIX = `${ADVISOR_TRANSCRIPT_STEM}.`;

/**
 * Whether a filename is any advisor transcript, default or named.
 *
 * Both halves are needed: the default advisor's file is exactly `__advisor.jsonl`, which does NOT start with
 * the named prefix followed by a slug, and a named advisor's is `__advisor.<slug>.jsonl`.
 */
export function isAdvisorTranscriptName(name: string): boolean {
	return (
		name === ADVISOR_TRANSCRIPT_FILENAME || (name.startsWith(ADVISOR_TRANSCRIPT_PREFIX) && isSessionFileName(name))
	);
}

/** The slug of a named advisor's transcript, or `""` for the default advisor's. */
export function advisorTranscriptSlug(name: string): string {
	return name === ADVISOR_TRANSCRIPT_FILENAME ? "" : sessionFileStem(name).slice(ADVISOR_TRANSCRIPT_PREFIX.length);
}
