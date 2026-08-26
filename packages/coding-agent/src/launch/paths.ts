/**
 * Where every file a project's daemon broker keeps on disk lives. Filenames are a contract between
 * broker and client, so they live here once, privately; callers ask for a path, never join a string.
 * `daemonBroker*` paths sit in a project's runtime dir (one broker per project). `managedDaemon*` paths
 * sit under `daemons/` (one per supervised process). "daemons" means two unrelated things: under the
 * config root, one entry per project broker; under a project runtime dir, one entry per supervised process.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, isEnoent } from "@veyyon/utils";

/**
 * Every on-disk name in the daemon runtime layout, in the one place a rename can be made.
 * Private: callers take a path from a function below, never a name from this table. A rename is a
 * compatibility break for any running broker; `test/launch/daemon-runtime-layout.test.ts` pins the bytes.
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
	/** In a project runtime directory: the retained records of completed daemons. */
	completions: "completions.json",
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
 * The shared secret a client and its broker authenticate with. Client creates, broker reads —
 * both agree on the name through this function.
 */
export function daemonBrokerTokenPath(runtimeDir: string): string {
	return path.join(runtimeDir, NAMES.brokerToken);
}

/** The lease file whose exclusive creation elects one broker per project. */
export function daemonBrokerLeasePath(runtimeDir: string): string {
	return path.join(runtimeDir, NAMES.brokerLease);
}

/**
 * The directory holding one presence entry per live veyyon process. The broker exits when this is empty,
 * so its name is what keeps a shared daemon alive across two terminals.
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

/**
 * The retained completion records of a project's supervised processes.
 *
 * Lives beside the per-daemon directories rather than inside one: a record
 * outlives the daemon it describes, including the daemon's name being reused
 * and its directory rewritten by a later start. The file is versioned (see
 * `completions.ts`), and a store from another version is rejected rather than
 * served.
 */
export function daemonCompletionsPath(runtimeDir: string): string {
	return path.join(runtimeDir, NAMES.completions);
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
