import * as os from "node:os";
import * as path from "node:path";

const WINDOWS_DRIVE_EXTENDED_PREFIX = /^\\\\[?]\\([A-Za-z]:[\\/].*)$/;
const WINDOWS_UNC_EXTENDED_PREFIX = /^\\\\[?]\\UNC[\\/]([^\\/]+)[\\/](.+)$/i;
const WINDOWS_DRIVE_EXTENDED_FORWARD_PREFIX = /^\/\/[?]\/([A-Za-z]:\/.*)$/;
const WINDOWS_UNC_EXTENDED_FORWARD_PREFIX = /^\/\/[?]\/UNC\/([^/]+)\/(.+)$/i;
const WINDOWS_DRIVE_NT_PREFIX = /^\\\\[?][?]\\([A-Za-z]:[\\/].*)$/;
const WINDOWS_UNC_NT_PREFIX = /^\\\\[?][?]\\UNC[\\/]([^\\/]+)[\\/](.+)$/i;

export function stripWindowsExtendedLengthPathPrefix(
	filePath: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform !== "win32") return filePath;

	const uncMatch = WINDOWS_UNC_EXTENDED_PREFIX.exec(filePath) ?? WINDOWS_UNC_NT_PREFIX.exec(filePath);
	if (uncMatch) return `\\\\${uncMatch[1]}\\${uncMatch[2]}`;

	const driveMatch = WINDOWS_DRIVE_EXTENDED_PREFIX.exec(filePath) ?? WINDOWS_DRIVE_NT_PREFIX.exec(filePath);
	if (driveMatch) return driveMatch[1];

	const forwardUncMatch = WINDOWS_UNC_EXTENDED_FORWARD_PREFIX.exec(filePath);
	if (forwardUncMatch) return `//${forwardUncMatch[1]}/${forwardUncMatch[2]}`;

	const forwardDriveMatch = WINDOWS_DRIVE_EXTENDED_FORWARD_PREFIX.exec(filePath);
	if (forwardDriveMatch) return forwardDriveMatch[1];

	return filePath;
}

export function looksLikeFilePath(value: string, extensions: readonly string[] = []): boolean {
	if (value.includes("/") || value.includes("\\")) return true;
	if (extensions.length === 0) return false;
	const suffix = /\.([A-Za-z0-9]+)$/.exec(value)?.[1]?.toLowerCase();
	return suffix !== undefined && extensions.some(extension => extension.toLowerCase() === suffix);
}

export function expandTilde(filePath: string, home?: string): string {
	const h = home ?? os.homedir();
	if (filePath === "~") return h;
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
		return h + filePath.slice(1);
	}
	if (filePath.startsWith("~")) {
		return path.join(h, filePath.slice(1));
	}
	return filePath;
}
