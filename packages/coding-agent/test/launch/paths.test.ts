import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	daemonBrokerEndpoint,
	daemonBrokerLeasePath,
	daemonBrokerTokenPath,
	daemonPresenceDir,
	daemonPresenceEntryPath,
	daemonRuntimeDir,
	managedDaemonDir,
	managedDaemonLogPath,
	managedDaemonMetaPath,
	managedDaemonPreviousLogPath,
	managedDaemonProcessLeasePath,
	managedDaemonsRoot,
} from "@veyyon/coding-agent/launch/paths";

/**
 * These derive the per-project daemon runtime directory and broker endpoint. Both keys
 * are a wyhash of the RESOLVED project path, and that identity must be stable: every
 * veyyon process in one project directory has to compute the same path or a launching
 * client and a running daemon would talk past each other (the client would spawn a
 * second daemon at a different socket). They had no tests. These pin the derivation so
 * a change to the hashing or the path layout, which would silently orphan running
 * daemons, cannot slip through, and cover the platform split (Unix socket vs Windows
 * named pipe) including that the pipe key still tracks the runtime-dir key.
 *
 * The suites below the endpoint one cover the rest of the layout, which used to be spelled
 * inline by whoever needed it. `broker.token` was declared twice, once in `client.ts` (which
 * CREATES the file) and once in `broker.ts` (which READS it), with nothing tying the two
 * literals together: renaming either would have left the client writing a token the broker
 * never looks for, and the failure surfaces as an authentication error rather than as a
 * rename. `"daemons"` and `"process.pid"` were each written inline twice inside `broker.ts`.
 * These pin the exact bytes of every name through the owner's own functions, so a rename is
 * a deliberate, visible change to a running broker's on-disk contract instead of a silent one.
 */

const RESTORE: Array<() => void> = [];
afterEach(() => {
	while (RESTORE.length) RESTORE.pop()?.();
});

function withPlatform(value: NodeJS.Platform, run: () => void): void {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value, configurable: true });
	RESTORE.push(() => {
		if (original) Object.defineProperty(process, "platform", original);
	});
	run();
}

describe("daemonRuntimeDir", () => {
	it("places the daemon dir under <configRoot>/run/daemons/<16-hex key>", () => {
		const dir = daemonRuntimeDir("/home/x/proj", "/cfg");
		const key = dir.split("/").pop() ?? "";
		expect(dir).toBe("/cfg/run/daemons/0f63cb695d3d99fc");
		expect(key).toMatch(/^[0-9a-f]{16}$/);
	});

	it("normalizes the project path so a trailing slash yields the same key", () => {
		expect(daemonRuntimeDir("/home/x/proj/", "/cfg")).toBe(daemonRuntimeDir("/home/x/proj", "/cfg"));
	});

	it("gives different projects different keys", () => {
		expect(daemonRuntimeDir("/home/x/proj", "/cfg")).not.toBe(daemonRuntimeDir("/home/x/other", "/cfg"));
	});
});

describe("daemonBrokerEndpoint", () => {
	it("uses a broker.sock inside the runtime dir on non-Windows platforms", () => {
		withPlatform("linux", () => {
			expect(daemonBrokerEndpoint("/home/x/proj", "/cfg/run/daemons/0f63cb695d3d99fc")).toBe(
				"/cfg/run/daemons/0f63cb695d3d99fc/broker.sock",
			);
		});
	});

	it("uses a named pipe keyed by the project path on Windows, ignoring the runtime dir", () => {
		withPlatform("win32", () => {
			// The pipe key matches the runtime-dir key so client and daemon agree, and the
			// runtime-dir argument is irrelevant in the pipe namespace.
			expect(daemonBrokerEndpoint("/home/x/proj", "C:\\ignored")).toBe(
				"\\\\.\\pipe\\veyyon-daemon-0f63cb695d3d99fc",
			);
		});
	});

	/**
	 * The pipe name and the runtime directory identify the same project through what used to be two
	 * copies of the hash expression. A drift between them keys a broker to a pipe no client computes,
	 * so this asserts the shared key rather than trusting that both copies were edited together.
	 */
	it("reuses the runtime-dir key verbatim in the Windows pipe name", () => {
		const key = daemonRuntimeDir("/home/x/proj", "/cfg").split("/").pop() ?? "";
		withPlatform("win32", () => {
			expect(daemonBrokerEndpoint("/home/x/proj", "/cfg")).toBe(`\\\\.\\pipe\\veyyon-daemon-${key}`);
		});
	});
});

const RUNTIME = "/cfg/run/daemons/0f63cb695d3d99fc";

describe("the project runtime directory layout", () => {
	/**
	 * The name the client writes and the broker reads. Pinned to its exact bytes because the two sides
	 * are separate processes: an older broker already running against `broker.token` cannot be told
	 * about a rename, so changing this string orphans it.
	 */
	it("puts the broker token at broker.token directly in the runtime dir", () => {
		expect(daemonBrokerTokenPath(RUNTIME)).toBe(`${RUNTIME}/broker.token`);
	});

	/** The lease whose exclusive creation elects one broker per project. */
	it("puts the broker lease at broker.pid directly in the runtime dir", () => {
		expect(daemonBrokerLeasePath(RUNTIME)).toBe(`${RUNTIME}/broker.pid`);
	});

	/** The directory a second terminal registers in so a shared daemon outlives the first one. */
	it("puts presence entries under a clients directory", () => {
		expect(daemonPresenceDir(RUNTIME)).toBe(`${RUNTIME}/clients`);
	});

	/**
	 * `hasLiveDaemonProjectPresence` reads every entry in the presence directory as JSON and DELETES
	 * what it cannot parse, so the `.json` suffix is load-bearing: an entry written without it is swept
	 * on the next check and the project stops looking occupied.
	 */
	it("names a presence entry after the process id with a .json suffix", () => {
		expect(daemonPresenceEntryPath(daemonPresenceDir(RUNTIME), "4321-abc")).toBe(`${RUNTIME}/clients/4321-abc.json`);
	});

	/** Supervised processes get their own root, one directory per daemon name. */
	it("puts supervised daemons under a daemons directory inside the runtime dir", () => {
		expect(managedDaemonsRoot(RUNTIME)).toBe(`${RUNTIME}/daemons`);
		expect(managedDaemonDir(RUNTIME, "web")).toBe(`${RUNTIME}/daemons/web`);
	});

	/**
	 * The broker recovers records by listing this root and reading each entry's metadata, so the
	 * directory it writes into and the directory it scans have to be the same one. They were two inline
	 * `"daemons"` literals in the same file.
	 */
	it("nests a supervised daemon's directory inside the root it is recovered from", () => {
		expect(managedDaemonDir(RUNTIME, "web")).toBe(path.join(managedDaemonsRoot(RUNTIME), "web"));
	});

	/**
	 * Two different files in the layout are called a pid file and they mean different things: the
	 * broker's own election lease, and the pid of a process the broker supervises. Conflating them would
	 * make a daemon's pid look like a broker claim and stop a real broker from starting.
	 */
	it("keeps the broker lease and a supervised process's pid file distinct", () => {
		const daemonDir = managedDaemonDir(RUNTIME, "web");
		expect(managedDaemonProcessLeasePath(daemonDir)).toBe(`${RUNTIME}/daemons/web/process.pid`);
		expect(path.basename(managedDaemonProcessLeasePath(daemonDir))).not.toBe(
			path.basename(daemonBrokerLeasePath(RUNTIME)),
		);
	});
});

describe("a supervised daemon's directory layout", () => {
	const DAEMON_DIR = `${RUNTIME}/daemons/web`;

	/** Recovered across broker restarts, so its name is part of the persisted format. */
	it("persists a daemon's snapshot and spec in meta.json", () => {
		expect(managedDaemonMetaPath(DAEMON_DIR)).toBe(`${DAEMON_DIR}/meta.json`);
	});

	/** A detached daemon's output is appended here by the child process itself, through its fd. */
	it("captures output in output.log", () => {
		expect(managedDaemonLogPath(DAEMON_DIR)).toBe(`${DAEMON_DIR}/output.log`);
	});

	/** Rotation renames the log onto this name, and `logs` reads both files to span the boundary. */
	it("keeps one rotated log in output.previous.log", () => {
		expect(managedDaemonPreviousLogPath(DAEMON_DIR)).toBe(`${DAEMON_DIR}/output.previous.log`);
	});

	/**
	 * Rotation is `rename(log, previous)`. If the two resolved to one path the rename would destroy the
	 * log it was meant to preserve, and a `logs` read spanning the rotation would return the same file
	 * twice.
	 */
	it("gives the current and rotated logs different paths", () => {
		expect(managedDaemonLogPath(DAEMON_DIR)).not.toBe(managedDaemonPreviousLogPath(DAEMON_DIR));
	});

	/** Every per-daemon file stays inside the directory it was given, never escaping to a sibling. */
	it("resolves every per-daemon file inside the daemon directory", () => {
		for (const resolved of [
			managedDaemonMetaPath(DAEMON_DIR),
			managedDaemonLogPath(DAEMON_DIR),
			managedDaemonPreviousLogPath(DAEMON_DIR),
			managedDaemonProcessLeasePath(DAEMON_DIR),
		]) {
			expect(path.dirname(resolved)).toBe(DAEMON_DIR);
		}
	});
});

describe("the layout has one owner", () => {
	const LAUNCH_SOURCE_DIR = path.resolve(import.meta.dir, "../../src/launch");
	const OWNER = "paths.ts";
	const LAYOUT_NAMES = [
		"broker.sock",
		"broker.token",
		"broker.pid",
		"meta.json",
		"output.log",
		"output.previous.log",
		"process.pid",
		"clients",
	];

	async function launchSources(): Promise<Array<{ file: string; text: string }>> {
		const files = [...new Bun.Glob("*.ts").scanSync(LAUNCH_SOURCE_DIR)].sort();
		return await Promise.all(
			files.map(async file => ({
				file,
				text: await Bun.file(path.join(LAUNCH_SOURCE_DIR, file)).text(),
			})),
		);
	}

	/**
	 * The ratchet the unification exists for. Every name above was, or could become, a string literal in
	 * a module that merely uses the file: `broker.token` in both `broker.ts` and `client.ts`, `clients`
	 * in `presence.ts`, `daemons` and `process.pid` twice each in `broker.ts`. A second copy is not a
	 * style problem, it is how the client and the broker come to disagree about a filename, so this fails
	 * the moment one reappears.
	 */
	it("declares every on-disk name in paths.ts and nowhere else in src/launch", async () => {
		const offenders: string[] = [];
		for (const { file, text } of await launchSources()) {
			if (file === OWNER) continue;
			for (const name of LAYOUT_NAMES) {
				if (text.includes(`"${name}"`)) offenders.push(`${file} spells "${name}"`);
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * The non-vacuity twin. If the glob broke or the source moved, the case above would pass by reading
	 * nothing, so this proves the owner really is being read and really does hold the names.
	 */
	it("finds the names in the owner it exempted", async () => {
		const sources = await launchSources();
		expect(sources.map(entry => entry.file)).toContain(OWNER);
		const owner = sources.find(entry => entry.file === OWNER);
		if (!owner) throw new Error("paths.ts was not read");
		for (const name of LAYOUT_NAMES) {
			expect(owner.text).toContain(`"${name}"`);
		}
	});

	/**
	 * `broker.ts` and `client.ts` are the two processes the token name is a contract between, so the
	 * point of the unification is that both now ask the same function. A module that joined the name
	 * itself would not import it.
	 */
	it("has both sides of the token contract importing the owner's accessor", async () => {
		for (const file of ["broker.ts", "client.ts"]) {
			const text = await Bun.file(path.join(LAUNCH_SOURCE_DIR, file)).text();
			expect(text).toContain("daemonBrokerTokenPath");
			expect(text).toMatch(/from "\.\/paths"/);
		}
	});
});
