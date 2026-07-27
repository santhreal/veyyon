/**
 * `veyyon rollback` — move this install to any published version.
 *
 * WHY THIS EXISTS. Until now the only supported direction was forward. The
 * updater deletes its `.bak` after a successful install, so there is nothing
 * local to restore, which meant a release that broke your workflow left you on
 * it until the next one shipped. "Go back to the version that worked" is the
 * first thing anyone asks in that situation, and the answer was to reinstall by
 * hand from a release URL you had to construct yourself.
 *
 * The command is deliberately usable three ways, because the three readers want
 * different things. `--list` is for a person orienting themselves or a script;
 * a named version is for someone who already knows where they are going, and is
 * the form that goes in a bug report; and the bare form opens the picker, which
 * is for the common case of "something broke recently and I want the one before
 * that".
 *
 * Everything here returns its text rather than printing it, so the tests read
 * the real output of the real command instead of capturing a global.
 */
import { APP_NAME, bareVersion, changelogUrlForVersion, compareSemver, errorMessage, VERSION } from "@veyyon/utils";
import {
	getAllReleases,
	type ReleaseListing,
	readVersionMoves,
	rollbackToVersion,
	type UpdateHistoryEntry,
} from "./update-cli";

export interface RollbackCommandFlags {
	/** Print every published version instead of changing anything. */
	list?: boolean;
	/** The version to move to. Mutually exclusive with `list`. */
	version?: string;
	/** Machine-readable output for `--list`. */
	json?: boolean;
}

/**
 * Opens a URL in the operator's browser.
 *
 * Named once and shared by the picker's callbacks and its host, rather than
 * spelled `(url: string) => void` in one place and `BrowserOpener` in another:
 * two names for one concept read as two concepts.
 */
export type UrlOpener = (url: string) => void;

export interface RollbackCommandResult {
	output: string;
	exitCode: number;
}

/**
 * The moving parts a test replaces.
 *
 * Injected as one object rather than a parameter each so adding a dependency
 * later does not reorder an existing call, and so a test that only fakes the
 * release list keeps the real everything else.
 */
export interface RollbackDeps {
	/**
	 * The published catalog. No timeout parameter: every caller wants the
	 * default, and a knob nothing turns is API surface a reader has to rule out.
	 * `getAllReleases` still takes one for a caller that genuinely needs it.
	 */
	listReleases: () => Promise<ReleaseListing[]>;
	rollback: (version: string) => Promise<void>;
	history: () => Promise<UpdateHistoryEntry[]>;
	currentVersion: string;
	/**
	 * Shows the interactive picker and resolves the chosen version, or null when
	 * the operator cancelled.
	 *
	 * Optional because the picker needs a terminal: the caller supplies it only
	 * when stdin and stdout are both TTYs, and without it a bare invocation
	 * falls back to printing the list, which is still useful. A non-TTY run
	 * never blocks waiting for a keypress nobody can send.
	 */
	pickVersion?: (rows: readonly RollbackRow[]) => Promise<string | null>;
}

export function defaultRollbackDeps(): RollbackDeps {
	return {
		listReleases: getAllReleases,
		rollback: version => rollbackToVersion(version),
		history: readVersionMoves,
		currentVersion: VERSION,
	};
}

/** A version as the list renders it, with everything a row needs already resolved. */
export interface RollbackRow {
	version: string;
	publishedAt?: string;
	/** True for the version running right now, which is not a rollback target. */
	current: boolean;
	/** True when this version is newer than the running one, so choosing it moves forward. */
	newer: boolean;
	/** True when the history file records having run this version before. */
	visited: boolean;
	changelogUrl: string;
}

/**
 * Turn releases plus local history into rows.
 *
 * Split out from the printing because the picker needs exactly this and nothing
 * about the text: one owner for what a row MEANS, two renderers for how it
 * looks.
 */
export function buildRollbackRows(
	releases: readonly ReleaseListing[],
	currentVersion: string,
	moves: readonly UpdateHistoryEntry[] = [],
): RollbackRow[] {
	// Both ends of every recorded move count as visited: you ran the version you
	// left as much as the one you arrived at, and a picker that only marked
	// arrivals would leave the version you are trying to get back to unmarked.
	const visited = new Set<string>();
	for (const move of moves) {
		visited.add(move.from);
		visited.add(move.to);
	}
	return releases.map(release => ({
		version: release.version,
		publishedAt: release.publishedAt,
		current: release.version === currentVersion,
		newer: compareSemver(release.version, currentVersion) > 0,
		visited: visited.has(release.version),
		changelogUrl: changelogUrlForVersion(release.version),
	}));
}

/**
 * The publish date as a plain `YYYY-MM-DD`, or blank.
 *
 * Blank rather than a placeholder, and blank for BOTH the missing case and the
 * unparseable one, because to a reader they mean the same thing: this release
 * has no date to show. A release whose timestamp the source omitted or returned
 * unparseably is still installable, so dropping the row to keep the column tidy
 * would silently shorten the catalog.
 */
export function rollbackPublishedDate(publishedAt?: string): string {
	if (!publishedAt) return "";
	const date = new Date(publishedAt);
	return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/**
 * What a row says about where you stand, in reading order.
 *
 * The ONE owner of the marker rules, because two surfaces render them: this
 * module's text listing and the picker's right-hand column. They were computed
 * separately at first, which is how a list and a picker end up disagreeing
 * about which version is current — a disagreement no test catches, since each
 * one is self-consistent.
 *
 * `newer` is mutually exclusive with `current` (the running version is not
 * newer than itself), and `previously run` is suppressed on the current row,
 * where it is noise: of course you have run the version you are running.
 */
export function rollbackMarkers(row: RollbackRow): string[] {
	const markers: string[] = [];
	if (row.current) markers.push("current");
	else if (row.newer) markers.push("newer");
	if (row.visited && !row.current) markers.push("previously run");
	return markers;
}

/** One line per version: what it is, when it shipped, and where you stand. */
export function formatRollbackList(rows: readonly RollbackRow[]): string {
	const width = Math.max(...rows.map(row => row.version.length), "VERSION".length);
	// Every line is right-trimmed. The columns are padded so they line up, which
	// leaves trailing spaces on the header and on every row with no marker, and
	// those are invisible on screen but real in a file: this output gets pasted
	// into bug reports and piped into diffs, where a line that ends in three
	// spaces is a line that does not match the same line typed by hand.
	const lines = [`${"VERSION".padEnd(width)}  PUBLISHED`];
	for (const row of rows) {
		const markers = rollbackMarkers(row);
		const marker = markers.length > 0 ? `  (${markers.join(", ")})` : "";
		lines.push(
			`${row.version.padEnd(width)}  ${rollbackPublishedDate(row.publishedAt).padEnd(10)}${marker}`.trimEnd(),
		);
	}
	return lines.join("\n");
}

/**
 * Run the command.
 *
 * Terminal detection is the CALLER's job, not this function's: it takes a
 * `pickVersion` or it does not, and behaves accordingly. That keeps the whole
 * command testable without a PTY, and means a non-TTY run can never block
 * waiting for a keypress nobody is able to send.
 */
export async function runRollbackCommand(
	flags: RollbackCommandFlags,
	deps: RollbackDeps = defaultRollbackDeps(),
): Promise<RollbackCommandResult> {
	let releases: ReleaseListing[];
	try {
		releases = await deps.listReleases();
	} catch (err) {
		// Loud, with the reason: an empty or silently-short list would read as
		// "there is nothing to roll back to", which is a different fact entirely.
		return { output: `Could not read the published versions: ${errorMessage(err)}`, exitCode: 1 };
	}

	const rows = buildRollbackRows(releases, deps.currentVersion, await deps.history());

	// A bare invocation on a terminal is a browse, so it opens the picker. The
	// choice is resolved with the overlay torn down, because the install that
	// follows prints progress and can fail with a message worth reading, and
	// none of that survives painting under an overlay that is about to be
	// restored away.
	if (!flags.list && !flags.version && deps.pickVersion) {
		const chosen = await deps.pickVersion(rows);
		if (chosen === null) return { output: "", exitCode: 0 };
		return installChosen(rows, chosen, deps);
	}

	if (flags.list || !flags.version) {
		if (flags.json) return { output: JSON.stringify(rows, null, 2), exitCode: 0 };
		return { output: formatRollbackList(rows), exitCode: 0 };
	}

	const requested = bareVersion(flags.version);
	const match = rows.find(row => row.version === requested);
	if (!match) {
		// Naming the known versions rather than only rejecting the typo: the whole
		// reason someone types a version by hand is that they half-remember it.
		const known = rows
			.slice(0, 10)
			.map(row => row.version)
			.join(", ");
		return {
			output: `No published version ${JSON.stringify(flags.version)}. Recent versions: ${known}. Run \`${APP_NAME} rollback --list\` for all of them.`,
			exitCode: 1,
		};
	}

	return installChosen(rows, match.version, deps);
}

/**
 * Perform the move and report it.
 *
 * Shared by the typed form and the picker so a rollback reports the same thing
 * however it was chosen, and an installer failure can never be swallowed on one
 * path and surfaced on the other.
 */
async function installChosen(
	rows: readonly RollbackRow[],
	version: string,
	deps: RollbackDeps,
): Promise<RollbackCommandResult> {
	const row = rows.find(candidate => candidate.version === version);
	try {
		await deps.rollback(version);
	} catch (err) {
		return { output: errorMessage(err), exitCode: 1 };
	}
	const changelog = row ? `Changelog for ${version}: ${row.changelogUrl}` : "";
	return { output: changelog, exitCode: 0 };
}
