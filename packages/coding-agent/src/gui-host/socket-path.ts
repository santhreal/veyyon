/**
 * Where the GUI host's default Unix socket goes, and the limit that decides it.
 *
 * `sockaddr_un.sun_path` is a fixed byte array, so a Unix socket has a maximum
 * addressable path length: 108 bytes on Linux, 104 on the BSDs and macOS, one
 * of which is the terminating NUL. A profile directory under a long home
 * directory pushes `<agent-dir>/gui-host.sock` past it.
 *
 * Bun binds such a path anyway, through `/proc/self/fd/<n>/gui-host.sock`,
 * producing a listening socket that no client can address by its real path:
 * `connect()` from the desktop window, from `nc`, or from any other process
 * fails with EINVAL before it reaches the file. The desktop client and this
 * module therefore apply one rule, so both sides name the same socket:
 *
 * 1. `<agent-dir>/gui-host.sock` when it fits.
 * 2. `<runtime-dir>/veyyon-gui-<digest>.sock`, where `<digest>` is the first 16
 *    hex characters of the SHA-256 of the absolute agent directory, so two
 *    profiles never share a socket, and `<runtime-dir>` is `$XDG_RUNTIME_DIR`,
 *    else Linux's `/run/user/<uid>` when the current user owns it, else macOS's
 *    per-user `$TMPDIR`.
 * 3. Otherwise a refusal naming both candidates, their sizes and the limit.
 *
 * The mirror of this rule is `crates/veyyon-desktop/src/endpoint/socket_path.rs`.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Default socket filename inside an agent profile directory. */
export const SOCKET_FILENAME = "gui-host.sock";

/** `sun_path` capacity per platform, including the terminating NUL. */
const SUN_PATH_BYTES: Readonly<Record<string, number>> = {
	linux: 108,
	darwin: 104,
	freebsd: 104,
	openbsd: 104,
	netbsd: 104,
};

/** The BSD capacity, used for a platform not named above. */
const SUN_PATH_BYTES_FALLBACK = 104;

/** Prefix of a socket placed in the runtime directory. */
const RUNTIME_SOCKET_PREFIX = "veyyon-gui-";

/** Hex characters of the agent-directory digest kept in a runtime socket name. */
const DIGEST_CHARS = 16;

/** Longest socket path this platform can address, excluding the NUL. */
export function unixPathLimit(platform: string = process.platform): number {
	return (SUN_PATH_BYTES[platform] ?? SUN_PATH_BYTES_FALLBACK) - 1;
}

/** Whether `socketPath` is short enough for `connect()` to address it. */
export function unixPathFits(socketPath: string, platform: string = process.platform): boolean {
	return Buffer.byteLength(socketPath) <= unixPathLimit(platform);
}

export interface SocketPathEnvironment {
	env?: NodeJS.ProcessEnv;
	platform?: string;
	/** Current user id; `undefined` on a platform without one. */
	uid?: number;
	/** Owner of a directory, or `undefined` when it is not a directory. */
	directoryOwner?: (dir: string) => number | undefined;
}

function directoryOwnerOnDisk(dir: string): number | undefined {
	try {
		const stat = fs.statSync(dir);
		return stat.isDirectory() ? stat.uid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The short per-user directory a socket falls back to, or `null` when this
 * system offers none.
 */
export function runtimeDirectory(options: SocketPathEnvironment = {}): string | null {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const declared = env.XDG_RUNTIME_DIR?.trim();
	if (declared !== undefined && declared.length > 0) {
		return declared;
	}
	if (platform === "linux") {
		const uid = options.uid ?? process.getuid?.();
		if (uid === undefined) {
			return null;
		}
		const owner = (options.directoryOwner ?? directoryOwnerOnDisk)(`/run/user/${uid}`);
		return owner === uid ? `/run/user/${uid}` : null;
	}
	if (platform === "darwin") {
		const tmp = env.TMPDIR?.trim();
		return tmp !== undefined && tmp.length > 0 ? tmp : null;
	}
	return null;
}

/** The runtime-directory socket for `agentDir`, or `null` without such a directory. */
export function runtimeSocketPath(agentDir: string, options: SocketPathEnvironment = {}): string | null {
	const runtimeDir = runtimeDirectory(options);
	if (runtimeDir === null) {
		return null;
	}
	const digest = createHash("sha256").update(path.resolve(agentDir)).digest("hex").slice(0, DIGEST_CHARS);
	return path.join(runtimeDir, `${RUNTIME_SOCKET_PREFIX}${digest}.sock`);
}

function refusal(candidates: readonly string[], limit: number): Error {
	const sizes = candidates.map(c => `${c} (${Buffer.byteLength(c)} bytes)`).join(" and ");
	return new Error(
		`No GUI host socket path fits this platform's ${limit}-byte limit: tried ${sizes}. ` +
			`A client cannot connect to a longer path. Set XDG_RUNTIME_DIR to a short directory, ` +
			`or bind an explicit endpoint: veyyon gui unix:/short/path.sock`,
	);
}

/**
 * The default socket path for `agentDir`, applying the rule above.
 *
 * @throws when neither the profile path nor a runtime-directory path fits.
 */
export function guiHostSocketPath(agentDir: string, options: SocketPathEnvironment = {}): string {
	const platform = options.platform ?? process.platform;
	const preferred = path.join(path.resolve(agentDir), SOCKET_FILENAME);
	if (unixPathFits(preferred, platform)) {
		return preferred;
	}
	const fallback = runtimeSocketPath(agentDir, options);
	if (fallback !== null && unixPathFits(fallback, platform)) {
		return fallback;
	}
	throw refusal(fallback === null ? [preferred] : [preferred, fallback], unixPathLimit(platform));
}

/**
 * Refuses an explicit socket path a client could not connect to.
 *
 * @throws when `socketPath` exceeds the platform limit.
 */
export function assertUnixPathFits(socketPath: string, platform: string = process.platform): void {
	if (unixPathFits(socketPath, platform)) {
		return;
	}
	const limit = unixPathLimit(platform);
	throw new Error(
		`Unix endpoint path is ${Buffer.byteLength(socketPath)} bytes, over this platform's ` +
			`${limit}-byte limit, and a client cannot connect to it: ${socketPath}`,
	);
}
