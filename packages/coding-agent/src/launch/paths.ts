/**
 * Where every file a project's daemon broker keeps on disk lives.
 *
 * WHY THIS MODULE OWNS THE NAMES. The broker writes these files and other processes read them, so a
 * filename is a contract between two programs, not an implementation detail of either one. It was written
 * as an implementation detail of both: `broker.ts` and `client.ts` each declared their own
 * `const TOKEN_FILE = "broker.token"`, the client creating the file and the broker reading it. Nothing
 * connected the two literals. Rename one and the client writes a token the broker never finds, so every
 * daemon RPC fails authentication with a message about a missing token rather than about a rename.
 * `"daemons"` and `"process.pid"` were each spelled inline twice in `broker.ts` for the same reason.
 *
 * So the names live here once, privately, and callers ask for a path instead of joining a string. There is
 * nothing to keep in sync because there is nothing to disagree with.
 *
 * TWO DIRECTORIES, AND THE PREFIX TELLS YOU WHICH. `daemonBroker*` paths sit directly in a project's
 * runtime directory and belong to the one broker serving that project. `managedDaemon*` paths sit in a
 * per-daemon directory under `daemons/` and belong to one long-running process the broker supervises for
 * you. Both take their base directory as an argument; the prefix says which base is expected.
 *
 * THE WORD "daemons" MEANS TWO THINGS HERE, deliberately kept apart. Under the config root it names the
 * directory holding one entry per project broker. Under a project's runtime directory it names the
 * directory holding one entry per supervised process. Same spelling, unrelated contents, which is exactly
 * why neither is written inline any more.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, isEnoent } from "@veyyon/utils";

/**
 * Every on-disk name in the daemon runtime layout, in the one place a rename can be made.
 *
 * Private on purpose: callers take a path from a function below, never a name from this table, so the
 * table can be reshaped without touching a caller. `test/launch/daemon-runtime-layout.test.ts` pins the
 * bytes of each name through those functions, because a rename is a compatibility break for any broker
 * already running against an older layout.
 */
const NAMES = {
	/** Under the config root: one entry per project broker, keyed by project hash. */
	brokerRoot: path.join("run", "daemons"),
	/** In a project runtime directory: the broker's listening socket on platforms that have them. */
	brokerSocket: "broker.sock",
	/** In a project runtime directory: the shared secret the client creates and the broker reads. */
	brokerToken: "broker.token",
	/** In a project runtime directory: the lease proving which process is THE broker for this project. */
	brokerLease: "broker.pid",
	/** In a project runtime directory: one entry per supervised process. */
	managedRoot: "daemons",
	/** In a project runtime directory: one entry per live veyyon process holding the project open. */
	presenceRoot: "clients",
	/** In a managed daemon directory: its persisted snapshot and spec. */
	managedMeta: "meta.json",
	/** In a managed daemon directory: its captured output. */
	managedLog: "output.log",
	/** In a managed daemon directory: the previous log, kept across one rotation. */
	managedPreviousLog: "output.previous.log",
	/** In a managed daemon directory: the pid of the supervised process, distinct from `brokerLease`. */
	managedProcessLease: "process.pid",
} as const;

/**
 * The stable key one project directory hashes to.
 *
 * Shared by the runtime directory and the Windows pipe name, which is the point: they identified the same
 * project through two copies of this expression, so a change to the hash or the padding would have keyed
 * them apart and left a broker listening on a pipe no client computed.
 */
function projectKey(projectDir: string): string {
	return Bun.hash.wyhash(path.resolve(projectDir)).toString(16).padStart(16, "0");
}

/** Resolve the private runtime directory shared by veyyon processes in one project directory. */
export function daemonRuntimeDir(projectDir: string, configRoot: string = getConfigRootDir()): string {
	return path.join(configRoot, NAMES.brokerRoot, projectKey(projectDir));
}

/** Resolve the Unix socket or Windows named pipe used by one project broker. */
export function daemonBrokerEndpoint(projectDir: string, runtimeDir: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\veyyon-daemon-${projectKey(projectDir)}`;
	}
	return path.join(runtimeDir, NAMES.brokerSocket);
}

/**
 * The shared secret a client and its broker authenticate with.
 *
 * The client creates this file and the broker reads it, so the two agreed on the name by coincidence until
 * both asked here for it.
 */
export function daemonBrokerTokenPath(runtimeDir: string): string {
	return path.join(runtimeDir, NAMES.brokerToken);
}

/** The lease file whose exclusive creation elects one broker per project. */
export function daemonBrokerLeasePath(runtimeDir: string): string {
	return path.join(runtimeDir, NAMES.brokerLease);
}

/**
 * The directory holding one presence entry per live veyyon process in a project.
 *
 * The broker exits when this directory holds no live pid, so its name is what keeps a shared daemon alive
 * across two terminals in the same project.
 */
export function daemonPresenceDir(runtimeDir: string): string {
	return path.join(runtimeDir, NAMES.presenceRoot);
}

/**
 * One process's presence entry.
 *
 * The `.json` suffix is part of the contract: `hasLiveDaemonProjectPresence` reads every entry in the
 * directory as JSON and deletes what it cannot parse, so an entry written without it would be swept.
 */
export function daemonPresenceEntryPath(presenceDir: string, id: string): string {
	return path.join(presenceDir, `${id}.json`);
}

/** The directory holding one entry per supervised process in a project. */
export function managedDaemonsRoot(runtimeDir: string): string {
	return path.join(runtimeDir, NAMES.managedRoot);
}

/** The directory one supervised process keeps its log and metadata in. */
export function managedDaemonDir(runtimeDir: string, name: string): string {
	return path.join(managedDaemonsRoot(runtimeDir), name);
}

/** A supervised process's persisted snapshot and spec, rewritten atomically on every state change. */
export function managedDaemonMetaPath(daemonDir: string): string {
	return path.join(daemonDir, NAMES.managedMeta);
}

/** A supervised process's captured output. */
export function managedDaemonLogPath(daemonDir: string): string {
	return path.join(daemonDir, NAMES.managedLog);
}

/** The log kept from before the last rotation, read together with the current one when serving logs. */
export function managedDaemonPreviousLogPath(daemonDir: string): string {
	return path.join(daemonDir, NAMES.managedPreviousLog);
}

/** The pid of a supervised process. Not the broker's own lease, which is `daemonBrokerLeasePath`. */
export function managedDaemonProcessLeasePath(daemonDir: string): string {
	return path.join(daemonDir, NAMES.managedProcessLease);
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
