/**
 * WHY THIS SUITE EXISTS.
 *
 * Two defects in daemon broker restart and recovery lifecycle were identified during audit:
 *
 * 1. Dead code in broker recovery: When a broker crashes or is killed while a daemon is
 *    in its restart backoff window (`state === "restarting"`), the replacement broker's
 *    recovery logic contained an unreachable `else if (snapshot.state === "restarting")`
 *    branch that attempted to set state to `"starting"`/`"running"` without a process PID.
 *    Because non-detached and non-running daemons evaluate `!detached && !wasTerminal`,
 *    the daemon was unconditionally handled by the fallback and marked `exited` with
 *    `terminatedBy = "broker-recovery"`. This suite proves that daemons left in
 *    `"restarting"` state settle cleanly as `exited` with `broker-recovery` attribution
 *    and no lingering ghost state or unreachable branch.
 *
 * 2. Duplicate completion records on operator stop during backoff: When a daemon configured
 *    with `restart` crashes, `#settle` queues a completion record for that execution
 *    generation and arms `restartTimer`. When an operator stops the daemon during the
 *    backoff window, `#stopRecord` previously called `#queueCompletion` a second time for
 *    the same execution generation, writing duplicate records into `completions.json` and
 *    causing `launch list` to report two deaths for a single run. This suite proves that
 *    cancelling an active `restartTimer` updates the in-memory/persisted snapshot with
 *    `operator-stop` attribution and retains exactly one completion record in `completions.json`.
 *
 * WHAT IT DOES NOT CATCH:
 * PTY-specific terminal rendering nuances (covered in `launch-renderer.test.ts`) and protocol
 * wire-format serialization bounds (covered in `daemon-protocol.test.ts`).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { parseDaemonCompletionsFile, readDaemonCompletions } from "../../src/launch/completions";
import {
	daemonCompletionsPath,
	managedDaemonDir,
	managedDaemonMetaPath,
	managedDaemonsRoot,
} from "../../src/launch/paths";
import type { DaemonSnapshot, DaemonSpec } from "../../src/launch/protocol";

let isolatedConfigRoot: IsolatedConfigRoot | undefined;
const TEST_PARENT = path.resolve(import.meta.dirname, "../../../../.internal/launch-restarting-tests");
let testRoot = "";

beforeAll(async () => {
	await fs.mkdir(TEST_PARENT, { recursive: true });
	testRoot = await fs.mkdtemp(path.join(TEST_PARENT, "run-"));
});

beforeEach(() => {
	isolatedConfigRoot = enterIsolatedConfigRoot("launch-restarting");
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

describe("a restarting daemon settles cleanly on recovery and stop", () => {
	it("marks a daemon left in restarting state as exited with broker-recovery upon broker recovery", async () => {
		const projectDir = await tempDir("project-recover-restarting-");
		const runtimeDir = await tempDir("runtime-recover-restarting-");

		// Seed a daemon directory in the restarting state as if the previous broker died mid-backoff
		const daemonsDir = managedDaemonsRoot(runtimeDir);
		await fs.mkdir(daemonsDir, { recursive: true });
		const daemonDir = managedDaemonDir(runtimeDir, "restarting-daemon");
		await fs.mkdir(daemonDir, { recursive: true });

		const spec: DaemonSpec = {
			name: "restarting-daemon",
			application: process.execPath,
			args: ["-e", "process.exit(1)"],
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "always",
			persist: false,
			detached: false,
		};
		const snapshot: DaemonSnapshot = {
			name: "restarting-daemon",
			id: "seed-restarting-id-12345",
			owner: "test-seed",
			state: "restarting",
			createdAt: Date.now() - 5000,
			startedAt: Date.now() - 4000,
			exitedAt: Date.now() - 3000,
			exitCode: 1,
			restartCount: 1,
			outputBytes: 0,
			persist: false,
			detached: false,
		};
		await fs.writeFile(managedDaemonMetaPath(daemonDir), JSON.stringify({ daemon: snapshot, spec }), "utf8");

		const client = await connect(projectDir, runtimeDir);
		try {
			const described = await client.request({ op: "describe", name: "restarting-daemon" });
			expect(described.op).toBe("describe");
			if (described.op === "describe") {
				expect(described.daemon.state).toBe("exited");
				expect(described.daemon.terminatedBy).toBe("broker-recovery");
				expect(described.daemon.exitReason).toContain(
					"the previous broker exited; its replacement terminated this non-detached daemon",
				);
				expect(described.daemon.pid).toBeUndefined();
			}

			const listed = await client.request({ op: "list" });
			expect(listed.op).toBe("list");
			if (listed.op === "list") {
				const active = listed.daemons.find(d => d.name === "restarting-daemon");
				expect(active?.state).toBe("exited");
				expect(active?.terminatedBy).toBe("broker-recovery");

				const completion = listed.completions.find(c => c.name === "restarting-daemon");
				expect(completion).toBeDefined();
				expect(completion?.terminatedBy).toBe("broker-recovery");
			}
		} finally {
			await shutdown(client);
		}
	}, 20_000);

	it("retains exactly one completion record when operator stops a daemon during restart backoff", async () => {
		const projectDir = await tempDir("project-stop-during-backoff-");
		const runtimeDir = await tempDir("runtime-stop-during-backoff-");
		const client = await connect(projectDir, runtimeDir);

		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "backoff-crasher",
					application: process.execPath,
					args: ["-e", "process.exit(1)"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "always",
					persist: false,
					detached: false,
				},
			});
			expect(started.op).toBe("start");

			// Wait until daemon reaches "restarting" state with restartCount >= 1
			const reachedRestarting = await waitUntil(async () => {
				const listed = await client.request({ op: "list" });
				if (listed.op !== "list") return false;
				const crasher = listed.daemons.find(d => d.name === "backoff-crasher");
				return crasher !== undefined && crasher.state === "restarting" && crasher.restartCount >= 1;
			}, 10_000);
			expect(reachedRestarting).toBeTrue();

			// Stop the daemon while it is in the restart backoff window
			const stopRes = await client.request({ op: "stop", name: "backoff-crasher", timeoutMs: 2000 });
			expect(stopRes.op).toBe("stop");
			if (stopRes.op === "stop") {
				expect(stopRes.daemon.state).toBe("exited");
				expect(stopRes.daemon.terminatedBy).toBe("operator-stop");
				expect(stopRes.daemon.exitReason).toContain("stopped by launch stop");
				expect(stopRes.daemon.exitReason).toContain("pending restart is cancelled");
			}

			// Wait for completion queue write to settle on disk
			const completionsReady = await waitUntil(async () => {
				const stored = await readDaemonCompletions(runtimeDir).catch(() => []);
				return stored.some(c => c.name === "backoff-crasher");
			}, 5_000);
			expect(completionsReady).toBeTrue();

			// Read via helper and assert bound strictly: exactly 1 completion record
			const records = await readDaemonCompletions(runtimeDir);
			const crasherRecords = records.filter(c => c.name === "backoff-crasher");
			expect(crasherRecords.length).toBe(1);

			// Read completions.json directly from disk and verify raw array length
			const rawFile = JSON.parse(await fs.readFile(daemonCompletionsPath(runtimeDir), "utf8"));
			const parsedCompletions = parseDaemonCompletionsFile(rawFile);
			const rawMatching = parsedCompletions.filter(c => c.name === "backoff-crasher");
			expect(rawMatching.length).toBe(1);

			// Verify active list state has operator-stop attribution
			const listed = await client.request({ op: "list" });
			expect(listed.op).toBe("list");
			if (listed.op === "list") {
				const active = listed.daemons.find(d => d.name === "backoff-crasher");
				expect(active?.state).toBe("exited");
				expect(active?.terminatedBy).toBe("operator-stop");
				const listCompletions = listed.completions.filter(c => c.name === "backoff-crasher");
				expect(listCompletions.length).toBe(1);
			}
		} finally {
			await shutdown(client);
		}
	}, 20_000);
});
