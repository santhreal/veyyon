import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, isEnoent } from "@veyyon/utils";

/** Resolve the private runtime directory shared by veyyon processes in one project directory. */
export function daemonRuntimeDir(projectDir: string, configRoot: string = getConfigRootDir()): string {
	const key = Bun.hash.wyhash(path.resolve(projectDir)).toString(16).padStart(16, "0");
	return path.join(configRoot, "run", "daemons", key);
}

/** Resolve the Unix socket or Windows named pipe used by one project broker. */
export function daemonBrokerEndpoint(projectDir: string, runtimeDir: string): string {
	if (process.platform === "win32") {
		const key = Bun.hash.wyhash(path.resolve(projectDir)).toString(16).padStart(16, "0");
		return `\\\\.\\pipe\\veyyon-daemon-${key}`;
	}
	return path.join(runtimeDir, "broker.sock");
}

/**
 * The canonical directory a project's daemon is keyed by.
 *
 * Symlinks matter here: a project reached through a link and through its real path must resolve to ONE
 * daemon, or a second broker starts and the two never see each other's sessions. The client and the
 * presence file each had their own copy of this, which is how two spellings of one project could have
 * drifted apart.
 *
 * A directory that does not exist yet resolves to its absolute path rather than failing, because a
 * caller may be registering presence for a project it is about to create. Any other error is real and
 * propagates: a permission failure must not silently key the daemon by a path nobody could read.
 */
export async function canonicalProjectDir(projectDir: string): Promise<string> {
	const resolved = path.resolve(projectDir);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error)) return resolved;
		throw error;
	}
}
