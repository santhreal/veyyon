import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hasLiveDaemonProjectPresence, registerDaemonProjectPresence } from "../../src/launch/presence";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

/**
 * The daemon broker idle-reaps ONLY when no registered veyyon process is still
 * alive in its runtime dir — it reschedules its shutdown as long as
 * `hasLiveDaemonProjectPresence` returns true (broker.ts #scheduleIdleShutdown).
 * So this function is the gate on the whole broker lifetime, and the
 * cross-session broker leak in GRAN-11 was a broker that never reaped because
 * something kept presence true.
 *
 * The end-to-end drain (open presence keeps the broker up, closing it lets the
 * broker reap the daemon) is already covered by the cross-process integration
 * test in tools/launch.test.ts. What was NOT covered is the SELF-HEALING of
 * this function against presence files whose owner is gone but that were never
 * cleaned up — the exact way a broker gets pinned forever:
 *
 *   1. A parent veyyon that crashed / was SIGKILLed never ran its postmortem, so
 *      its `clients/<id>.json` file survives with a now-DEAD pid. If
 *      `hasLiveDaemonProjectPresence` trusted the file's existence it would keep
 *      the broker awake for a process that no longer exists.
 *   2. A truncated / non-JSON / wrong-shape presence file (partial write, disk
 *      full) must not throw and must not count as a live presence.
 *
 * Both must be pruned and must NOT count as live. These tests assert the real
 * boolean AND that the offending file is removed from disk, so a regression that
 * stops pruning (and thus re-pins the broker) fails here.
 */

const CLIENTS = "clients";

async function tempRuntimeDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-presence-test-"));
}

/** Write a raw presence file exactly where the reader looks, for the crash/corrupt cases. */
async function writePresenceFile(runtimeDir: string, name: string, contents: string): Promise<string> {
	const clientsDir = path.join(runtimeDir, CLIENTS);
	await fs.mkdir(clientsDir, { recursive: true });
	const file = path.join(clientsDir, name);
	await fs.writeFile(file, contents);
	return file;
}

/** A pid that is guaranteed dead: spawn a trivial process, kill it, wait until
 * the OS reaps it. Spawned hermetically — a bare `-e` probe inherits the real
 * HOME and can read (or migrate) the developer's ~/.veyyon (hermetic gate). */
async function deadPid(): Promise<number> {
	const { env, cleanup } = hermeticSpawnEnv();
	const proc = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
		stdout: "ignore",
		stderr: "ignore",
		env,
	});
	const pid = proc.pid;
	proc.kill("SIGKILL");
	await proc.exited;
	cleanup();
	// Poll until process.kill(pid, 0) proves ESRCH, so the test never races the reaper.
	for (let i = 0; i < 200; i++) {
		try {
			process.kill(pid, 0);
			await Bun.sleep(10);
		} catch {
			return pid;
		}
	}
	throw new Error(`pid ${pid} never became dead`);
}

describe("hasLiveDaemonProjectPresence", () => {
	it("returns false when the runtime dir has never held a presence (no clients dir)", async () => {
		const runtimeDir = await tempRuntimeDir();
		// ENOENT on the clients dir is "nobody registered", not an error.
		expect(await hasLiveDaemonProjectPresence(runtimeDir)).toBe(false);
	});

	it("reports a live presence while its owner (this process) is registered, then false after close", async () => {
		const runtimeDir = await tempRuntimeDir();
		const projectDir = await tempRuntimeDir();
		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
		try {
			// This test process is the owner and is obviously alive.
			expect(await hasLiveDaemonProjectPresence(runtimeDir)).toBe(true);
		} finally {
			await presence.close();
		}
		// close() removes the presence file, so the broker gate now reads false and reaps.
		expect(await hasLiveDaemonProjectPresence(runtimeDir)).toBe(false);
		const clientsDir = path.join(runtimeDir, CLIENTS);
		expect(await fs.readdir(clientsDir)).toEqual([]);
	});

	it("prunes a presence file whose owner pid is dead and does NOT count it as live (crashed-parent case)", async () => {
		// The GRAN-11 pin: a veyyon that died without running its postmortem leaves a
		// stale clients/<id>.json with a dead pid. Trusting the file would keep the
		// broker awake forever; the reader must verify liveness and delete the corpse.
		const runtimeDir = await tempRuntimeDir();
		const pid = await deadPid();
		const file = await writePresenceFile(
			runtimeDir,
			"dead.json",
			JSON.stringify({ pid, id: "dead", projectDir: "/tmp/whatever" }),
		);
		expect(await hasLiveDaemonProjectPresence(runtimeDir)).toBe(false);
		// The corpse is removed so it can never pin a future broker either.
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("keeps a live presence even when a dead-owner sibling is present, and prunes only the corpse", async () => {
		const runtimeDir = await tempRuntimeDir();
		const projectDir = await tempRuntimeDir();
		const dead = await deadPid();
		const corpse = await writePresenceFile(
			runtimeDir,
			"corpse.json",
			JSON.stringify({ pid: dead, id: "corpse", projectDir: "/tmp/whatever" }),
		);
		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
		try {
			// One live (this process) + one dead sibling => still live overall.
			expect(await hasLiveDaemonProjectPresence(runtimeDir)).toBe(true);
			// The dead sibling is pruned; the live presence file survives.
			expect(await Bun.file(corpse).exists()).toBe(false);
			const remaining = await fs.readdir(path.join(runtimeDir, CLIENTS));
			expect(remaining.length).toBe(1);
			expect(remaining[0]).not.toBe("corpse.json");
		} finally {
			await presence.close();
		}
	});

	it("prunes a malformed presence file (truncated / wrong shape) without throwing and reads false", async () => {
		const runtimeDir = await tempRuntimeDir();
		const truncated = await writePresenceFile(runtimeDir, "truncated.json", '{"pid": 12');
		const wrongShape = await writePresenceFile(runtimeDir, "wrong.json", JSON.stringify({ notPid: "x" }));
		const nonObject = await writePresenceFile(runtimeDir, "array.json", JSON.stringify([1, 2, 3]));

		expect(await hasLiveDaemonProjectPresence(runtimeDir)).toBe(false);

		// Every unusable file is removed rather than left to be re-parsed forever.
		expect(await Bun.file(truncated).exists()).toBe(false);
		expect(await Bun.file(wrongShape).exists()).toBe(false);
		expect(await Bun.file(nonObject).exists()).toBe(false);
	});
});
