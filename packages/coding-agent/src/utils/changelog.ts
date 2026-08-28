import { getLastChangelogVersionPath, isEnoent, logger } from "@veyyon/utils";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	content: string;
}

/** What startup should say about the version it is running. Startup never prints release notes. It prints at most one line naming the */
export interface UpdateNoticeDecision {
	/** Version to announce, or `undefined` when there is nothing to say. */
	installedVersion: string | undefined;
	/** Whether the marker should advance to the running version. */
	persistCurrentVersion: boolean;
}

/** Parse changelog entries from the file at `changelogPath`. Scans for `## [x.y.z]` headings and collects each block until the next heading or EOF. */
export async function parseChangelog(changelogPath: string | undefined): Promise<ChangelogEntry[]> {
	if (!changelogPath) {
		return [];
	}
	try {
		const content = await Bun.file(changelogPath).text();
		const lines = content.split("\n");
		const entries: ChangelogEntry[] = [];

		let currentLines: string[] = [];
		let currentVersion: { major: number; minor: number; patch: number } | null = null;

		for (const line of lines) {
			// Check if this is a version header (## [x.y.z] ...)
			if (line.startsWith("## ")) {
				// Save previous entry if exists
				if (currentVersion && currentLines.length > 0) {
					entries.push({
						...currentVersion,
						content: currentLines.join("\n").trim(),
					});
				}

				// Try to parse version from this line
				const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
				if (versionMatch) {
					currentVersion = {
						major: Number.parseInt(versionMatch[1], 10),
						minor: Number.parseInt(versionMatch[2], 10),
						patch: Number.parseInt(versionMatch[3], 10),
					};
					currentLines = [line];
				} else {
					// Reset if we can't parse version
					currentVersion = null;
					currentLines = [];
				}
			} else if (currentVersion) {
				// Collect lines for current version
				currentLines.push(line);
			}
		}

		// Save last entry
		if (currentVersion && currentLines.length > 0) {
			entries.push({
				...currentVersion,
				content: currentLines.join("\n").trim(),
			});
		}

		return entries;
	} catch (error) {
		if (isEnoent(error)) {
			return [];
		}
		logger.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

/** Compare two versions by major, then minor, then patch. Returns a number whose sign is the ordering: negative when `v1 < v2`, zero when equal, positive when */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	return v1.patch - v2.patch;
}

/**
 * Parse a veyyon changelog marker version into comparable parts.
 */
export function parseChangelogVersion(version: string | undefined): ChangelogEntry | undefined {
	const match = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!match) {
		return undefined;
	}

	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		content: "",
	};
}

/** Decide whether this launch should announce an update. `lastVersion` is the marker written by the previous run. Comparing it to the */
export function decideUpdateNotice(lastVersion: string | undefined, currentVersion: string): UpdateNoticeDecision {
	const parsedLast = parseChangelogVersion(lastVersion);
	if (!parsedLast) {
		// No marker, or one we cannot read: treat as a fresh install.
		return { installedVersion: undefined, persistCurrentVersion: true };
	}
	if (lastVersion === currentVersion) {
		return { installedVersion: undefined, persistCurrentVersion: false };
	}

	const parsedCurrent = parseChangelogVersion(currentVersion);
	if (!parsedCurrent) {
		// The running version is not a plain x.y.z (a dev or prerelease build).
		// Nothing meaningful to announce, and advancing the marker to it would
		// swallow the notice for the next real release.
		return { installedVersion: undefined, persistCurrentVersion: false };
	}
	if (compareVersions(parsedCurrent, parsedLast) <= 0) {
		return { installedVersion: undefined, persistCurrentVersion: true };
	}
	return { installedVersion: currentVersion, persistCurrentVersion: true };
}

// Re-export getChangelogPath from paths.ts for convenience
export { getChangelogPath } from "../config";

/** Last veyyon version whose changelog the user has seen. Stored as a plain-text marker file (`~/.veyyon/agent/last-changelog-version`) rather than in */
export async function readLastChangelogVersion(agentDir?: string): Promise<string | undefined> {
	try {
		const value = (await Bun.file(getLastChangelogVersionPath(agentDir)).text()).trim();
		return value || undefined;
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to read last-changelog-version marker", { error: String(error) });
		}
		return undefined;
	}
}

/** Persist the last-seen changelog version marker. Best-effort: failures are logged, never thrown. */
export async function writeLastChangelogVersion(version: string, agentDir?: string): Promise<void> {
	try {
		await Bun.write(getLastChangelogVersionPath(agentDir), version);
	} catch (error) {
		logger.warn("Failed to persist last-changelog-version marker", { error: String(error) });
	}
}
