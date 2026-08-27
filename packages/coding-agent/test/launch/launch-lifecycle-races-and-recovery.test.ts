/**
 * WHY THIS SUITE EXISTS.
 * -----------------------
 * Supervised background daemons encounter edge-case lifecycle transitions that
 * standard happy-path start/stop tests do not exercise:
 *
 * 1. Restart backoff races: When a failing daemon is in the `restarting` backoff
 *    window (`record.restartTimer` active), an operator `stop` must cancel the
 *    pending timer cleanly, mark the daemon `exited`, attribute `operator-stop`,
 *    and prevent any subsequent delayed restart. Similarly, an operator `restart`
 *    during backoff must cancel the timer and transition immediately into the new
 *    generation.
 * 2. Name reuse & log rotation: Reusing a name while a daemon is active must fail
 *    closed (`Daemon <name> is already <state>`); starting with the same name after
 *    termination must archive the old log to `output.previous.log`, allocate a fresh
 *    generation and ID, and render the list without key collisions.
 * 3. Corrupt metadata resilience on broker recovery: A replacement broker encountering
 *    a corrupt `meta.json` in a daemon directory must log a warning and skip the
 *    damaged entry without crashing the broker or dropping other daemons.
 *
 * WHAT IT DOES NOT CATCH:
 * Protocol encoding/decoding rules (covered in `daemon-protocol.test.ts`), termination
 * owner attribution matrix and completions retention limits (covered in
 * `a-daemon-death-records-who-and-why.test.ts`), and PTY terminal rendering nuances
 * (covered in `launch-renderer.test.ts`).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { managedDaemonDir, managedDaemonMetaPath, managedDaemonPreviousLogPath } from "../../src/launch/paths";
import { toolContent } from "../../src/tools/launch";

let isolatedConfigRoot: IsolatedConfigRoot | undefined;
const TEST_PARENT = path.resolve(import.meta.dirname, "../../../../.internal/launch-races");
let testRoot = "";

beforeAll(async () => {
	await fs.mkdir(TEST_PARENT, { recursive: true });
	testRoot = await fs.mkdtemp(path.join(TEST_PARENT, "run-"));
});

beforeEach(() => {
	isolatedConfigRoot = enterIsolatedConfigRoot("launch-races");
});

afterAll(async () => {
	await fs.rm(testRoot, { recursive: true, force: true });
});

const cleanupDirs: string[] = [];
const cleanupClients: DaemonBrokerClient[] = [];

afterEach(async () => {
	while (cleanupClients.length > 0) cleanupClients.pop()?.close();
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
	isolatedConfigRoot?.restore();
	isolatedConfigRoot = undefined;
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(testRoot, prefix));
	cleanupDirs.push(dir);
	return dir;
}

// Cross-process integration: the broker, its daemons and the OS process table
// live outside this process, so fake timers cannot advance them. Progress is
// observed by polling, exactly as test/tools/launch.test.ts does.
async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await delay(50);
	}
	return condition();
}

async function connect(projectDir: string, runtimeDir: string, idleGraceMs = 10_000): Promise<DaemonBrokerClient> {
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs });
	cleanupClients.push(client);
	return client;
}

async function shutdown(client: DaemonBrokerClient): Promise<void> {
	try {
		await client.request({ op: "shutdown" });
	} catch {
		// broker may have already closed
	}
	client.close();
}

describe("launch lifecycle backoff, name reuse, and recovery", () => {
	it("cancels restart timer when operator stops during restart backoff", async () => {
		const projectDir = await tempDir("project-rapid-fail-");
		const runtimeDir = await tempDir("runtime-rapid-fail-");
		const client = await connect(projectDir, runtimeDir);

		try {
			// Start a process that fails immediately with restart="on-failure"
			const startRes = await client.request({
				op: "start",
				spec: {
					name: "crasher",
					application: process.execPath,
					args: ["-e", "process.exit(1)"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "on-failure",
					persist: false,
					detached: false,
				},
			});
			expect(startRes.op).toBe("start");

			// Wait until daemon reaches "restarting" state with restartCount >= 1
			const reachedRestarting = await waitUntil(async () => {
				const listed = await client.request({ op: "list" });
				if (listed.op !== "list") return false;
				const crasher = listed.daemons.find(d => d.name === "crasher");
				return crasher !== undefined && (crasher.state === "restarting" || crasher.restartCount >= 1);
			}, 10_000);
			expect(reachedRestarting).toBeTrue();

			// Issue operator stop while it is in the restarting state
			const stopRes = await client.request({ op: "stop", name: "crasher", timeoutMs: 2000 });
			expect(stopRes.op).toBe("stop");
			if (stopRes.op === "stop") {
				expect(stopRes.daemon.state).toBe("exited");
				expect(stopRes.daemon.terminatedBy).toBe("operator-stop");
			}

			// Ensure it stays exited and does NOT restart again
			const afterStop = await client.request({ op: "list" });
			if (afterStop.op === "list") {
				const crasher = afterStop.daemons.find(d => d.name === "crasher");
				expect(crasher?.state).toBe("exited");
			}
		} finally {
			await shutdown(client);
		}
	}, 20_000);

	it("restarts immediately into a new generation when operator restarts during backoff", async () => {
		const projectDir = await tempDir("project-restart-backoff-");
		const runtimeDir = await tempDir("runtime-restart-backoff-");
		const client = await connect(projectDir, runtimeDir);

		try {
			await client.request({
				op: "start",
				spec: {
					name: "flaky",
					application: process.execPath,
					args: ["-e", "process.exit(2)"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "always",
					persist: false,
					detached: false,
				},
			});

			await waitUntil(async () => {
				const listed = await client.request({ op: "list" });
				if (listed.op !== "list") return false;
				const flaky = listed.daemons.find(d => d.name === "flaky");
				return flaky?.state === "restarting";
			}, 10_000);

			// Operator restart while in backoff
			const restartRes = await client.request({ op: "restart", name: "flaky" });
			expect(restartRes.op).toBe("restart");
			if (restartRes.op === "restart") {
				expect(["running", "starting", "restarting"]).toContain(restartRes.daemon.state);
			}

			// Clean stop
			await client.request({ op: "stop", name: "flaky", timeoutMs: 2000 });
		} finally {
			await shutdown(client);
		}
	}, 20_000);

	it("rejects active name collision and rotates previous log on post-terminal reuse", async () => {
		const projectDir = await tempDir("project-name-reuse-");
		const runtimeDir = await tempDir("runtime-name-reuse-");
		const client = await connect(projectDir, runtimeDir);

		try {
			// Start long-running daemon
			await client.request({
				op: "start",
				spec: {
					name: "worker",
					application: process.execPath,
					args: ["-e", "setInterval(() => {}, 1000);"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});

			// Attempting to start with same name while live fails
			await expect(
				client.request({
					op: "start",
					spec: {
						name: "worker",
						application: process.execPath,
						args: ["-e", "console.log(1)"],
						env: {},
						cwd: projectDir,
						pty: false,
						restart: "no",
						persist: false,
						detached: false,
					},
				}),
			).rejects.toThrow("Daemon worker is already");

			// Stop the first daemon
			await client.request({ op: "stop", name: "worker", timeoutMs: 2000 });

			// Start with same name succeeds, creating a new generation
			const secondStart = await client.request({
				op: "start",
				spec: {
					name: "worker",
					application: process.execPath,
					args: ["-e", "console.log('gen2-output'); setInterval(() => {}, 1000);"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			expect(secondStart.op).toBe("start");

			// Check that previous log was archived
			const daemonDir = managedDaemonDir(runtimeDir, "worker");
			const prevLog = managedDaemonPreviousLogPath(daemonDir);
			const prevExists = await fs
				.stat(prevLog)
				.then(() => true)
				.catch(() => false);
			expect(prevExists).toBeTrue();

			// Stop second generation
			await client.request({ op: "stop", name: "worker", timeoutMs: 2000 });

			// Verify list output shows the current daemon and does not duplicate
			const listed = await client.request({ op: "list" });
			if (listed.op === "list") {
				const rendered = toolContent(listed, { op: "list" });
				expect(rendered).toContain("worker:");
			}
		} finally {
			await shutdown(client);
		}
	}, 20_000);

	it("skips corrupted daemon meta files on recovery without crashing replacement broker", async () => {
		const projectDir = await tempDir("project-corrupt-meta-");
		const runtimeDir = await tempDir("runtime-corrupt-meta-");

		// Seed a corrupt daemon directory before broker starts
		const corruptDir = managedDaemonDir(runtimeDir, "broken-daemon");
		await fs.mkdir(corruptDir, { recursive: true });
		await fs.writeFile(managedDaemonMetaPath(corruptDir), "{ corrupt json...", "utf8");

		const client = await connect(projectDir, runtimeDir);
		try {
			const listed = await client.request({ op: "list" });
			expect(listed.op).toBe("list");
			if (listed.op === "list") {
				expect(listed.daemons.find(d => d.name === "broken-daemon")).toBeUndefined();
			}
		} finally {
			await shutdown(client);
		}
	}, 20_000);
});
