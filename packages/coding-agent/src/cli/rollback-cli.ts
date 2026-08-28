/** `veyyon rollback` — move this install to any published version. updater deletes its `.bak` after a successful install, so there is nothing */
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

/** Opens a URL in the operator's browser. Named once and shared by the picker's callbacks and its host, rather than */
export type UrlOpener = (url: string) => void;

export interface RollbackCommandResult {
	output: string;
	exitCode: number;
}

/** The moving parts a test replaces. Injected as one object rather than a parameter each so adding a dependency */
export interface RollbackDeps {
	/** The published catalog. No timeout parameter: every caller wants the default, and a knob nothing turns is API surface a reader has to rule out. */
	listReleases: () => Promise<ReleaseListing[]>;
	rollback: (version: string) => Promise<void>;
	history: () => Promise<UpdateHistoryEntry[]>;
	currentVersion: string;
	/** Shows the interactive picker and resolves the chosen version, or null when the operator cancelled. */
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

/** Turn releases plus local history into rows. Split out from the printing because the picker needs exactly this and nothing */
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

/** The publish date as a plain `YYYY-MM-DD`, or blank. Blank rather than a placeholder, and blank for BOTH the missing case and the */
export function rollbackPublishedDate(publishedAt?: string): string {
	if (!publishedAt) return "";
	const date = new Date(publishedAt);
	return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/** What a row says about where you stand, in reading order. The ONE owner of the marker rules, because two surfaces render them: this */
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
	// Every line is right-trimmed. The columns are padded so they line up, which leaves trailing spaces on the header and on every row with no marker, and
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

/** Run the command. Terminal detection is the CALLER's job, not this function's: it takes a */
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

	// A bare invocation on a terminal is a browse, so it opens the picker. The choice is resolved with the overlay torn down, because the install that
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

/** Perform the move and report it. Shared by the typed form and the picker so a rollback reports the same thing */
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
