import { getLastChangelogVersionPath, isEnoent, logger } from "@veyyon/utils";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	content: string;
}

export interface UpdateNoticeDecision {
	installedVersion: string | undefined;
	persistCurrentVersion: boolean;
}

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
			if (line.startsWith("## ")) {
				if (currentVersion && currentLines.length > 0) {
					entries.push({
						...currentVersion,
						content: currentLines.join("\n").trim(),
					});
				}

				const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
				if (versionMatch) {
					currentVersion = {
						major: Number.parseInt(versionMatch[1], 10),
						minor: Number.parseInt(versionMatch[2], 10),
						patch: Number.parseInt(versionMatch[3], 10),
					};
					currentLines = [line];
				} else {
					currentVersion = null;
					currentLines = [];
				}
			} else if (currentVersion) {
				currentLines.push(line);
			}
		}

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

export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	return v1.patch - v2.patch;
}

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

export function decideUpdateNotice(lastVersion: string | undefined, currentVersion: string): UpdateNoticeDecision {
	const parsedLast = parseChangelogVersion(lastVersion);
	if (!parsedLast) {
		return { installedVersion: undefined, persistCurrentVersion: true };
	}
	if (lastVersion === currentVersion) {
		return { installedVersion: undefined, persistCurrentVersion: false };
	}

	const parsedCurrent = parseChangelogVersion(currentVersion);
	if (!parsedCurrent) {
		return { installedVersion: undefined, persistCurrentVersion: false };
	}
	if (compareVersions(parsedCurrent, parsedLast) <= 0) {
		return { installedVersion: undefined, persistCurrentVersion: true };
	}
	return { installedVersion: currentVersion, persistCurrentVersion: true };
}

export { getChangelogPath } from "../config";

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

export async function writeLastChangelogVersion(version: string, agentDir?: string): Promise<void> {
	try {
		await Bun.write(getLastChangelogVersionPath(agentDir), version);
	} catch (error) {
		logger.warn("Failed to persist last-changelog-version marker", { error: String(error) });
	}
}
