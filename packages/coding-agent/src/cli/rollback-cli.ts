import { APP_NAME, bareVersion, changelogUrlForVersion, compareSemver, errorMessage, VERSION } from "@veyyon/utils";
import {
	getAllReleases,
	type ReleaseListing,
	readVersionMoves,
	rollbackToVersion,
	type UpdateHistoryEntry,
} from "./update-cli";

export interface RollbackCommandFlags {
	list?: boolean;
	version?: string;
	json?: boolean;
}

export type UrlOpener = (url: string) => void;

export interface RollbackCommandResult {
	output: string;
	exitCode: number;
}

export interface RollbackDeps {
	listReleases: () => Promise<ReleaseListing[]>;
	rollback: (version: string) => Promise<void>;
	history: () => Promise<UpdateHistoryEntry[]>;
	currentVersion: string;
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

export interface RollbackRow {
	version: string;
	publishedAt?: string;
	current: boolean;
	newer: boolean;
	visited: boolean;
	changelogUrl: string;
}

export function buildRollbackRows(
	releases: readonly ReleaseListing[],
	currentVersion: string,
	moves: readonly UpdateHistoryEntry[] = [],
): RollbackRow[] {
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

export function rollbackPublishedDate(publishedAt?: string): string {
	if (!publishedAt) return "";
	const date = new Date(publishedAt);
	return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export function rollbackMarkers(row: RollbackRow): string[] {
	const markers: string[] = [];
	if (row.current) markers.push("current");
	else if (row.newer) markers.push("newer");
	if (row.visited && !row.current) markers.push("previously run");
	return markers;
}

export function formatRollbackList(rows: readonly RollbackRow[]): string {
	const width = Math.max(...rows.map(row => row.version.length), "VERSION".length);
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

export async function runRollbackCommand(
	flags: RollbackCommandFlags,
	deps: RollbackDeps = defaultRollbackDeps(),
): Promise<RollbackCommandResult> {
	let releases: ReleaseListing[];
	try {
		releases = await deps.listReleases();
	} catch (err) {
		return { output: `Could not read the published versions: ${errorMessage(err)}`, exitCode: 1 };
	}

	const rows = buildRollbackRows(releases, deps.currentVersion, await deps.history());

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
