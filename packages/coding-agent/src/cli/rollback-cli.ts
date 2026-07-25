/**
 * `veyyon rollback` — move the install to a specific published version.
 *
 * The interactive picker (bare `veyyon rollback` on a TTY) lives in
 * `cli/rollback-picker.ts`, a session-free TUI host. This module owns the two
 * NON-interactive paths, which are pure enough to test without a terminal:
 *
 *  - `veyyon rollback --list` (and the non-TTY fallback) prints every published
 *    version, newest first, with its publish date and a marker on the version
 *    currently running.
 *  - `veyyon rollback <version>` validates the version against the published set
 *    and hands off to {@link rollbackToVersion}; an unknown version fails loudly
 *    with a pointer at `--list` rather than attempting an install that cannot
 *    succeed.
 */
import { APP_NAME, VERSION } from "@veyyon/utils";
import chalk from "chalk";
import { getAllReleases, type ReleaseListing, rollbackToVersion } from "./update-cli";

/** Publish date as `YYYY-MM-DD`, or an empty string when the registry omitted it. */
export function formatPublishDate(publishedAt: string | undefined): string {
	if (!publishedAt) return "";
	// npm `time` values are ISO-8601; the date is the first 10 chars. Guard the
	// shape so a malformed value degrades to empty rather than a wrong date.
	return /^\d{4}-\d{2}-\d{2}/.test(publishedAt) ? publishedAt.slice(0, 10) : "";
}

/**
 * Render the version list for `--list`, newest first, one per line: the
 * version, its publish date, and `(current)` on the running version. Pure so a
 * test can assert the exact lines. `currentVersion` is injected (defaults to the
 * running {@link VERSION}) so the "current" marker is testable without spawning.
 */
export function formatReleaseList(releases: readonly ReleaseListing[], currentVersion: string = VERSION): string {
	if (releases.length === 0) return "No published versions found.";
	const lines = releases.map(release => {
		const date = formatPublishDate(release.publishedAt);
		const current = release.version === currentVersion ? "  (current)" : "";
		const dateCol = date ? `  ${date}` : "";
		return `${release.version}${dateCol}${current}`;
	});
	return lines.join("\n");
}

/** Print every published version (used by `--list` and as the non-TTY fallback). */
export async function runRollbackList(): Promise<void> {
	const releases = await getAllReleases();
	process.stdout.write(`${formatReleaseList(releases, VERSION)}\n`);
}

/**
 * Roll back to `version` non-interactively. Validates the version against the
 * published set first: an unknown version exits non-zero with a pointer at
 * `--list`, so a typo never reaches the installer. A valid version is handed to
 * {@link rollbackToVersion}, which enforces the method/no-op/brew guards.
 */
export async function runRollbackToVersion(version: string): Promise<void> {
	const releases = await getAllReleases();
	if (!releases.some(release => release.version === version)) {
		process.stderr.write(
			`Unknown version '${version}'. Run \`${APP_NAME} rollback --list\` to see available versions.\n`,
		);
		process.exitCode = 1;
		return;
	}
	try {
		await rollbackToVersion(version);
	} catch (err) {
		process.stderr.write(chalk.red(`${err instanceof Error ? err.message : String(err)}\n`));
		process.exitCode = 1;
	}
}
