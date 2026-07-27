import * as os from "node:os";
import * as path from "node:path";

const WINDOWS_DRIVE_EXTENDED_PREFIX = /^\\\\[?]\\([A-Za-z]:[\\/].*)$/;
const WINDOWS_UNC_EXTENDED_PREFIX = /^\\\\[?]\\UNC[\\/]([^\\/]+)[\\/](.+)$/i;
const WINDOWS_DRIVE_EXTENDED_FORWARD_PREFIX = /^\/\/[?]\/([A-Za-z]:\/.*)$/;
const WINDOWS_UNC_EXTENDED_FORWARD_PREFIX = /^\/\/[?]\/UNC\/([^/]+)\/(.+)$/i;
const WINDOWS_DRIVE_NT_PREFIX = /^\\\\[?][?]\\([A-Za-z]:[\\/].*)$/;
const WINDOWS_UNC_NT_PREFIX = /^\\\\[?][?]\\UNC[\\/]([^\\/]+)[\\/](.+)$/i;

/** Removes Win32 extended-length prefixes before passing paths to Bun APIs. */
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

/**
 * Whether a string was WRITTEN as a file path, judged without touching the disk.
 *
 * The question every "a path or the value itself?" option has to answer, and the
 * only honest way to answer it. Deciding by whether the file opens conflates two
 * different facts: `--system-prompt ./promtps/main.md` is a path with a typo in it,
 * and a reader that falls back to the literal string on `ENOENT` runs the agent with
 * a system prompt whose entire content is `./promtps/main.md` — no error, no warning,
 * and a prompt so short the model's behaviour changes completely. Asking about the
 * SHAPE first separates "you meant a file and it is not there" (an error naming the
 * path) from "you meant this text" (use it).
 *
 * A separator is decisive: no literal value contains `/` or `\` by accident. The
 * extension list is the caller's, because what looks like a filename is domain
 * knowledge — `.pem`/`.crt` for a certificate option, `.md`/`.txt` for a prompt —
 * and a shared list would either miss real filenames or claim ordinary prose.
 *
 * One owner because it was two: a private copy in the Anthropic provider decided it
 * for certificate options while prompt resolution had no shape check at all, so the
 * same class of typo was an error in one place and silent in the other.
 */
export function looksLikeFilePath(value: string, extensions: readonly string[] = []): boolean {
	if (value.includes("/") || value.includes("\\")) return true;
	if (extensions.length === 0) return false;
	const suffix = /\.([A-Za-z0-9]+)$/.exec(value)?.[1]?.toLowerCase();
	return suffix !== undefined && extensions.some(extension => extension.toLowerCase() === suffix);
}

/**
 * Expand a leading `~` to the home directory. Handles `~`, `~/x`, `~\x`
 * (Windows), and the bare `~name` form (joined under home). Everything else is
 * returned unchanged.
 */
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
