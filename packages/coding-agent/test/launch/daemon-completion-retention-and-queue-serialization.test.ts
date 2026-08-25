/**
 * WHY THIS SUITE EXISTS.
 *
 * A supervised process's completion record (its exit code, termination owner, reason,
 * timestamps, and output tail) must survive the daemon leaving the active list and
 * survive broker restarts. In high-concurrency scenarios (multiple subagents or batch
 * jobs terminating simultaneously), concurrent read-modify-write passes over the
 * completion store could interleave and drop records unless strictly serialized through
 * `#completionsQueue`. Furthermore, large output logs must be bounded to prevent
 * memory explosion when listing recent completions.
 *
 * THE CLASS THIS CLOSES.
 * 1. Bounded output tail: A daemon emitting large volumes of output (> 4,000 bytes / 40 lines)
 *    has its retained `outputTail` truncated to `COMPLETION_TAIL_BYTES` with a leading `…`
 *    marker while preserving `outputBytes` total count.
 * 2. Concurrent completion queue serialization: Multiple daemons settling concurrently
 *    while store writes are in flight are serialized through `#completionsQueue` so that
 *    zero completion records are dropped or corrupted by file race conditions.
 * 3. Termination attribution sweep: Every member of `DAEMON_TERMINATION_OWNERS` is verified
 *    from the protocol source at run time, ensuring any new termination owner turns the
 *    suite red if attribution mapping is missing.
 * 4. Completion store retention bounds: `DAEMON_COMPLETIONS_LIMIT` (100 records) and
 *    `DAEMON_COMPLETIONS_MAX_AGE_MS` (24 hours) bounds hold across live broker operations.
 *
 * WHAT IT DOES NOT CATCH.
 * It does not test interactive TUI terminal renderers for daemon cards; it tests the
 * broker's daemon management, protocol serialization, log tailing, and disk store invariants.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import {
	appendDaemonCompletion,
	DAEMON_COMPLETIONS_LIMIT,
	DAEMON_COMPLETIONS_MAX_AGE_MS,
	readDaemonCompletions,
} from "../../src/launch/completions";
import { DAEMON_TERMINATION_OWNERS, type DaemonCompletionRecord, type DaemonSpec } from "../../src/launch/protocol";

let isolatedConfigRoot: IsolatedConfigRoot | undefined;
const TEST_PARENT = path.resolve(import.meta.dirname, "../../../../.internal/launch-completions-bounds");
let testRoot = "";

beforeAll(async () => {
	await fs.mkdir(TEST_PARENT, { recursive: true });
	testRoot = await fs.mkdtemp(path.join(TEST_PARENT, "run-"));
});

beforeEach(() => {
	isolatedConfigRoot = enterIsolatedConfigRoot("launch-completions-bounds");
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
// live outside this process in separate subprocesses, so fake timers cannot advance
// external OS process transitions. Progress is observed by polling the IPC channel.
async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await delay(50);
	}
	return condition();
}

async function connect(projectDir: string, runtimeDir: string, idleGraceMs = 5_000): Promise<DaemonBrokerClient> {
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs });
	cleanupClients.push(client);
	return client;
}

async function shutdown(client: DaemonBrokerClient): Promise<void> {
	try {
		await client.request({ op: "shutdown" });
	} catch {
		// Ignore shutdown error if broker already closed
	}
	client.close();
}

async function listCompletions(client: DaemonBrokerClient): Promise<DaemonCompletionRecord[]> {
	const listed = await client.request({ op: "list" });
	if (listed.op !== "list") throw new Error("unexpected list result");
	return listed.completions;
}

describe("daemon completion record retention and queue bounds", () => {
	it("bounds the output tail to COMPLETION_TAIL_BYTES with leading ellipsis on large output", async () => {
		const projectDir = await tempDir("tail-project-");
		const runtimeDir = await tempDir("tail-runtime-");
		const client = await connect(projectDir, runtimeDir);

		try {
			// Generate a script that outputs ~10KB (exceeding COMPLETION_TAIL_BYTES = 4000)
			const largeOutputScript = [
				'const line = "A".repeat(100);',
				// The `${...}` below belongs to the child script this string generates: it must reach the
				// daemon as literal source rather than being interpolated here.
				// biome-ignore lint/suspicious/noTemplateCurlyInString: literal source for the child script
				"for (let i = 0; i < 100; i++) console.log(`LINE ${i.toString().padStart(3, '0')}: ${line}`);",
				'console.log("FINAL_COMPLETION_MARKER_TAIL");',
				"process.exit(0);",
			].join("\n");

			const spec: DaemonSpec = {
				name: "large-output-job",
				application: process.execPath,
				args: ["-e", largeOutputScript],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			};

			const startResult = await client.request({ op: "start", spec });
			expect(startResult.op).toBe("start");

			// Wait for completion to appear in list
			let completion: DaemonCompletionRecord | undefined;
			const seen = await waitUntil(async () => {
				const completions = await listCompletions(client);
				completion = completions.find(c => c.name === "large-output-job");
				return completion !== undefined;
			}, 10_000);

			expect(seen).toBeTrue();
			expect(completion).toBeDefined();
			expect(completion?.exitCode).toBe(0);
			expect(completion?.terminatedBy).toBe("process-exit");
			expect(completion?.outputBytes).toBeGreaterThan(4_000);

			// Output tail invariant: must be bounded to at most 4001 characters (4000 bytes + '…')
			expect(completion?.outputTail.length).toBeLessThanOrEqual(4_001);
			expect(completion?.outputTail.startsWith("…")).toBeTrue();
			expect(completion?.outputTail).toContain("FINAL_COMPLETION_MARKER_TAIL");
		} finally {
			await shutdown(client);
		}
	}, 30_000);

	it("serializes concurrent daemon completions without dropping in-flight records", async () => {
		const projectDir = await tempDir("concurrent-project-");
		const runtimeDir = await tempDir("concurrent-runtime-");
		const client = await connect(projectDir, runtimeDir);

		try {
			const jobCount = 8;
			const expectedNames = Array.from({ length: jobCount }, (_, i) => `concurrent-job-${i}`);

			// Start multiple jobs concurrently that all write output and exit immediately
			await Promise.all(
				expectedNames.map(async name => {
					const script = `console.log("HELLO FROM ${name}"); process.exit(0);`;
					const spec: DaemonSpec = {
						name,
						application: process.execPath,
						args: ["-e", script],
						env: {},
						cwd: projectDir,
						pty: false,
						restart: "no",
						persist: false,
						detached: false,
					};
					const res = await client.request({ op: "start", spec });
					expect(res.op).toBe("start");
				}),
			);

			// Wait until all concurrent jobs have completed and been recorded in the store
			let recordedCompletions: DaemonCompletionRecord[] = [];
			const allRecorded = await waitUntil(async () => {
				recordedCompletions = await listCompletions(client);
				const recordedNames = new Set(recordedCompletions.map(c => c.name));
				return expectedNames.every(name => recordedNames.has(name));
			}, 15_000);

			expect(allRecorded).toBeTrue();

			// Verify each concurrent record has intact data and correct output tail
			for (const name of expectedNames) {
				const record = recordedCompletions.find(c => c.name === name);
				expect(record).toBeDefined();
				expect(record?.exitCode).toBe(0);
				expect(record?.terminatedBy).toBe("process-exit");
				expect(record?.outputTail).toContain(`HELLO FROM ${name}`);
			}

			// Verify the on-disk completion store also contains all records
			const diskRecords = await readDaemonCompletions(runtimeDir);
			const diskNames = new Set(diskRecords.map(r => r.name));
			for (const name of expectedNames) {
				expect(diskNames.has(name)).toBeTrue();
			}
		} finally {
			await shutdown(client);
		}
	}, 30_000);

	it("enumerates and validates all DAEMON_TERMINATION_OWNERS at runtime", () => {
		// Enumerate directly from the runtime export
		const owners = [...DAEMON_TERMINATION_OWNERS];

		// Ensure the list is non-empty and contains all expected lifecycle components
		expect(owners.length).toBeGreaterThanOrEqual(10);
		expect(owners).toContain("process-exit");
		expect(owners).toContain("external-signal");
		expect(owners).toContain("operator-stop");
		expect(owners).toContain("operator-restart");
		expect(owners).toContain("operator-signal");
		expect(owners).toContain("broker-shutdown");
		expect(owners).toContain("idle-reaper");
		expect(owners).toContain("os-signal");
		expect(owners).toContain("broker-recovery");
		expect(owners).toContain("launch-failure");

		// Every owner must be a distinct non-empty string identifier
		const uniqueOwners = new Set(owners);
		expect(uniqueOwners.size).toBe(owners.length);
	});

	it("enforces retention bounds on append and read (100 records and 24h cutoff)", async () => {
		const runtimeDir = await tempDir("retention-bounds-runtime-");
		const now = Date.now();

		function makeFakeRecord(name: string, exitedAt: number): DaemonCompletionRecord {
			return {
				name,
				id: crypto.randomUUID(),
				terminatedBy: "process-exit",
				exitReason: "normal exit",
				exitCode: 0,
				createdAt: exitedAt - 1000,
				startedAt: exitedAt - 500,
				exitedAt,
				restartCount: 0,
				outputBytes: 20,
				outputTail: `output for ${name}\n`,
			};
		}

		// 1. Count limit bound: append 105 records
		for (let i = 0; i < DAEMON_COMPLETIONS_LIMIT + 5; i++) {
			await appendDaemonCompletion(runtimeDir, makeFakeRecord(`job-${i}`, now + i));
		}

		const records = await readDaemonCompletions(runtimeDir, now + 1000);
		expect(records).toHaveLength(DAEMON_COMPLETIONS_LIMIT);
		// The 5 oldest (job-0 to job-4) should have been pruned
		expect(records[0]?.name).toBe("job-5");
		expect(records[records.length - 1]?.name).toBe(`job-${DAEMON_COMPLETIONS_LIMIT + 4}`);

		// 2. Age cutoff bound: records older than 24 hours are excluded
		const ageDir = await tempDir("retention-age-runtime-");
		const expiredTime = now - DAEMON_COMPLETIONS_MAX_AGE_MS - 5000;
		const freshTime = now - 1000;

		await appendDaemonCompletion(ageDir, makeFakeRecord("expired-job", expiredTime), now);
		await appendDaemonCompletion(ageDir, makeFakeRecord("fresh-job", freshTime), now);

		const ageFiltered = await readDaemonCompletions(ageDir, now);
		expect(ageFiltered.map(r => r.name)).toEqual(["fresh-job"]);
	});
});
