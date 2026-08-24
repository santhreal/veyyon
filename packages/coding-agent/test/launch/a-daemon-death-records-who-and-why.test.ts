/**
 * WHY THIS SUITE EXISTS.
 *
 * Field feedback from a 49-minute bug-bounty session: a supervised target browser was
 * SIGTERMed and the agent could not tell WHO killed it or WHY — a `launch stop`, the
 * last-client idle reaper, a broker shutdown and an OOM kill all surfaced as the same
 * bare exit, and an unexplained death is indistinguishable from a crash. In the same
 * session a finite cooldown job left the job list with no completion record at all: no
 * exit code, no output tail, no reason, nothing queryable after the fact.
 *
 * THE CLASS THIS CLOSES. Every terminal transition of a supervised process records a
 * distinct owner (which component ended it) and reason (the triggering condition),
 * surfaced in `launch list` and the exit notice; every completed daemon leaves a
 * retained, versioned, bounded record (exit code, owner, reason, output tail,
 * timestamps) that survives the active list and a broker restart; and a store written
 * by another schema version is rejected rather than served. The termination paths are
 * enumerated from `DAEMON_TERMINATION_OWNERS` in the protocol source at run time, so a
 * new path turns this suite RED until it is driven, and every driver below reaches the
 * defect the way a user does: a real broker process, real daemons, real OS signals.
 *
 * WHAT IT DOES NOT CATCH. The rendering of these fields inside the interactive TUI
 * (the model-facing `toolContent` text is asserted here; the themed component is not),
 * and attribution when a broker is SIGKILLed between signalling a daemon and writing
 * the pending attribution — that window is one synchronous block, but a kill inside it
 * leaves the death to the replacement broker's recovery path.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Process } from "@veyyon/natives";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import {
	appendDaemonCompletion,
	DAEMON_COMPLETIONS_LIMIT,
	DAEMON_COMPLETIONS_MAX_AGE_MS,
	DAEMON_COMPLETIONS_SCHEMA_VERSION,
	parseDaemonCompletionsFile,
	readDaemonCompletions,
} from "../../src/launch/completions";
import { daemonBrokerEndpoint, daemonBrokerLeasePath, daemonCompletionsPath } from "../../src/launch/paths";
import { registerDaemonProjectPresence } from "../../src/launch/presence";
import {
	DAEMON_TERMINATION_OWNERS,
	type DaemonCompletionRecord,
	type DaemonSnapshot,
	type DaemonSpec,
	type DaemonTerminationOwner,
	parseDaemonSnapshot,
} from "../../src/launch/protocol";
import { toolContent } from "../../src/tools/launch";

// The broker worker is the veyyon CLI (inherits this process's env); isolate the
// config root so a real ~/.veyyon cannot break broker startup, exactly as
// test/tools/launch.test.ts does.
let isolatedConfigRoot: IsolatedConfigRoot | undefined;

const TEST_PARENT = path.resolve(import.meta.dirname, "../../../../.internal/launch-lifecycle");
let testRoot = "";

beforeAll(async () => {
	await fs.mkdir(TEST_PARENT, { recursive: true });
	testRoot = await fs.mkdtemp(path.join(TEST_PARENT, "run-"));
});

beforeEach(() => {
	isolatedConfigRoot = enterIsolatedConfigRoot("launch-termination");
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

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function shutdown(client: DaemonBrokerClient): Promise<void> {
	try {
		await client.request({ op: "shutdown" });
	} catch {
		// A last-client shutdown may already have closed the broker.
	}
	client.close();
}

function idleSpec(name: string, overrides?: Partial<DaemonSpec>): DaemonSpec {
	return {
		name,
		application: process.execPath,
		args: ["-e", "setInterval(() => {}, 1000);"],
		env: {},
		cwd: process.cwd(),
		pty: false,
		restart: "no",
		persist: false,
		detached: false,
		...overrides,
	};
}

async function connect(projectDir: string, runtimeDir: string, idleGraceMs = 5_000): Promise<DaemonBrokerClient> {
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs });
	cleanupClients.push(client);
	return client;
}

async function listCompletions(client: DaemonBrokerClient): Promise<DaemonCompletionRecord[]> {
	const listed = await client.request({ op: "list" });
	if (listed.op !== "list") throw new Error("unexpected list result");
	return listed.completions;
}

/** Poll `list` until a completion record for `name` with `terminatedBy` is served. */
async function completionFor(
	client: DaemonBrokerClient,
	name: string,
	terminatedBy: DaemonTerminationOwner,
	timeoutMs = 10_000,
): Promise<DaemonCompletionRecord | undefined> {
	let found: DaemonCompletionRecord | undefined;
	const seen = await waitUntil(async () => {
		found = (await listCompletions(client)).find(
			record => record.name === name && record.terminatedBy === terminatedBy,
		);
		return found !== undefined;
	}, timeoutMs);
	return seen ? found : undefined;
}

async function waitForBrokerExit(projectDir: string, runtimeDir: string): Promise<void> {
	const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
	const gone = await waitUntil(async () => {
		try {
			await fs.stat(endpoint);
			return false;
		} catch {
			return true;
		}
	}, 10_000);
	if (!gone) throw new Error("broker did not exit in time");
}

/**
 * The termination owners driven so far, with the record each produced. The final
 * sweep compares this against the source enumeration: a path nobody drives, or a
 * path that records nothing, fails the suite.
 */
const covered = new Map<DaemonTerminationOwner, DaemonCompletionRecord>();

function recordCoverage(
	record: DaemonCompletionRecord | undefined,
	owner: DaemonTerminationOwner,
): DaemonCompletionRecord {
	if (!record) throw new Error(`no completion record retained for ${owner}`);
	expect(record.terminatedBy).toBe(owner);
	expect(typeof record.exitReason).toBe("string");
	expect(record.exitReason?.length).toBeGreaterThan(0);
	covered.set(owner, record);
	return record;
}

describe("every termination path records who and why", () => {
	it("records distinct owners and reasons on the paths one broker can produce", async () => {
		const projectDir = await tempDir("veyyon-term-project-");
		const runtimeDir = await tempDir("veyyon-term-runtime-");
		const client = await connect(projectDir, runtimeDir);
		try {
			// process-exit: a finite command that ends on its own.
			await client.request({
				op: "start",
				spec: idleSpec("settle-ok", { args: ["-e", "process.exit(0)"] }),
			});
			// external-signal: killed by us from OUTSIDE the broker, with no veyyon
			// component asking — the 49-minute SIGTERM case.
			const killed = await client.request({ op: "start", spec: idleSpec("settle-killed") });
			if (killed.op !== "start" || killed.daemon.pid === undefined) throw new Error("settle-killed did not start");
			process.kill(killed.daemon.pid, "SIGTERM");
			// operator-stop.
			await client.request({ op: "start", spec: idleSpec("settle-stop") });
			await client.request({ op: "stop", name: "settle-stop", timeoutMs: 2_000 });
			// operator-restart: the restart's first generation.
			await client.request({ op: "start", spec: idleSpec("settle-restart") });
			await client.request({ op: "restart", name: "settle-restart" });
			// operator-signal.
			await client.request({ op: "start", spec: idleSpec("settle-signal") });
			await client.request({ op: "send", name: "settle-signal", signal: "SIGTERM" });
			// launch-failure: the binary does not exist.
			await client.request({
				op: "start",
				spec: idleSpec("settle-spawn", { application: "/nonexistent/veyyon-missing-binary" }),
			});

			const expectations: Array<[string, DaemonTerminationOwner]> = [
				["settle-ok", "process-exit"],
				["settle-killed", "external-signal"],
				["settle-stop", "operator-stop"],
				["settle-restart", "operator-restart"],
				["settle-signal", "operator-signal"],
				["settle-spawn", "launch-failure"],
			];
			const records: DaemonCompletionRecord[] = [];
			for (const [name, owner] of expectations) {
				records.push(recordCoverage(await completionFor(client, name, owner), owner));
			}

			// The death details are honest, not only present.
			expect(records[0]?.exitCode).toBe(0);
			expect(records[1]?.signal).toBe("SIGTERM");
			expect(records[1]?.exitReason).toContain("no veyyon component");
			expect(records[2]?.signal).toBe("SIGTERM");
			expect(records[4]?.signal).toBe("SIGTERM");
			expect(records[5]?.exitReason).toContain("failed to launch");

			// Distinct paths read as distinct deaths: no two owners carry the same reason.
			const reasons = records.map(record => record.exitReason);
			expect(new Set(reasons).size).toBe(reasons.length);
		} finally {
			await shutdown(client);
		}
	}, 30_000);

	it("records broker-shutdown when a client asks the broker to stop", async () => {
		const projectDir = await tempDir("veyyon-term-bsd-project-");
		const runtimeDir = await tempDir("veyyon-term-bsd-runtime-");
		const client = await connect(projectDir, runtimeDir);
		await client.request({ op: "start", spec: idleSpec("shutdown-victim") });
		await client.request({ op: "shutdown" });
		client.close();
		await waitForBrokerExit(projectDir, runtimeDir);

		const recovered = await connect(projectDir, runtimeDir);
		recordCoverage(await completionFor(recovered, "shutdown-victim", "broker-shutdown"), "broker-shutdown");
		await shutdown(recovered);
	}, 30_000);

	it("records idle-reaper when the last client and presence leave", async () => {
		const projectDir = await tempDir("veyyon-term-idle-project-");
		const runtimeDir = await tempDir("veyyon-term-idle-runtime-");
		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
		const first = await connect(projectDir, runtimeDir, 200);
		const second = await connect(projectDir, runtimeDir, 200);
		await first.request({ op: "start", spec: idleSpec("reaped") });
		first.close();
		second.close();
		await presence.close();
		await waitForBrokerExit(projectDir, runtimeDir);

		const recovered = await connect(projectDir, runtimeDir);
		recordCoverage(await completionFor(recovered, "reaped", "idle-reaper"), "idle-reaper");
		await shutdown(recovered);
	}, 30_000);

	it("records os-signal when the broker process itself is terminated", async () => {
		const projectDir = await tempDir("veyyon-term-sig-project-");
		const runtimeDir = await tempDir("veyyon-term-sig-runtime-");
		const client = await connect(projectDir, runtimeDir);
		await client.request({ op: "start", spec: idleSpec("orphaned") });
		const lease: unknown = JSON.parse(await fs.readFile(daemonBrokerLeasePath(runtimeDir), "utf8"));
		if (typeof lease !== "object" || lease === null || !("pid" in lease) || typeof lease.pid !== "number") {
			throw new Error("broker lease did not name a pid");
		}
		process.kill(lease.pid, "SIGTERM");
		client.close();
		await waitForBrokerExit(projectDir, runtimeDir);

		const recovered = await connect(projectDir, runtimeDir);
		recordCoverage(await completionFor(recovered, "orphaned", "os-signal"), "os-signal");
		await shutdown(recovered);
	}, 30_000);

	it("records broker-recovery when a replacement broker reaps a leftover daemon", async () => {
		const projectDir = await tempDir("veyyon-term-rec-project-");
		const runtimeDir = await tempDir("veyyon-term-rec-runtime-");
		const client = await connect(projectDir, runtimeDir);
		const started = await client.request({ op: "start", spec: idleSpec("leftover") });
		if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("leftover did not start");
		const daemonPid = started.daemon.pid;
		const lease: unknown = JSON.parse(await fs.readFile(daemonBrokerLeasePath(runtimeDir), "utf8"));
		if (typeof lease !== "object" || lease === null || !("pid" in lease) || typeof lease.pid !== "number") {
			throw new Error("broker lease did not name a pid");
		}
		const brokerPid = lease.pid;
		// SIGKILL: the dead broker writes nothing, so the replacement owns the attribution.
		process.kill(brokerPid, "SIGKILL");
		client.close();
		expect(await waitUntil(() => !processExists(brokerPid), 5_000)).toBeTrue();

		const recovered = await connect(projectDir, runtimeDir);
		try {
			const record = recordCoverage(
				await completionFor(recovered, "leftover", "broker-recovery"),
				"broker-recovery",
			);
			expect(record.exitReason).toContain("previous broker exited");
			// The leftover process is really dead (the PID may linger as a zombie
			// until init reaps it, so check via Process.fromPid which reports the
			// actual state rather than kill(pid, 0) which returns 0 for zombies).
			const leftoverRef = Process.fromPid(daemonPid);
			expect(!leftoverRef || leftoverRef.status() !== "running").toBeTrue();
			const described = await recovered.request({ op: "describe", name: "leftover" });
			if (described.op !== "describe") throw new Error("unexpected describe result");
			expect(described.daemon.state).toBe("exited");
			expect(described.daemon.terminatedBy).toBe("broker-recovery");
		} finally {
			if (processExists(daemonPid)) process.kill(daemonPid, "SIGKILL");
			await shutdown(recovered);
		}
	}, 30_000);

	it("drives and records every owner the source enumerates", () => {
		// The sweep is the fail-by-default gate: adding a member to
		// DAEMON_TERMINATION_OWNERS without a driver above turns this RED, and a
		// driver whose path stops recording (the mutation gate target) empties a
		// slot and turns it RED too.
		expect([...covered.keys()].sort()).toEqual([...DAEMON_TERMINATION_OWNERS].sort());
		// Across the whole matrix, no two paths tell the same story.
		const reasons = [...covered.values()].map(record => record.exitReason);
		expect(new Set(reasons).size).toBe(DAEMON_TERMINATION_OWNERS.length);
	});
});

describe("a completed finite job stays queryable", () => {
	it("retains the record after the name is reused and after a broker restart", async () => {
		const projectDir = await tempDir("veyyon-term-fin-project-");
		const runtimeDir = await tempDir("veyyon-term-fin-runtime-");
		const client = await connect(projectDir, runtimeDir);
		const started = await client.request({
			op: "start",
			spec: idleSpec("cooldown", { args: ["-e", 'console.log("FINAL LINE"); process.exit(0);'] }),
		});
		if (started.op !== "start") throw new Error("cooldown did not start");
		const firstId = started.daemon.id;

		const record = await completionFor(client, "cooldown", "process-exit");
		if (!record) throw new Error("no completion record for the finite job");
		expect(record.id).toBe(firstId);
		expect(record.exitCode).toBe(0);
		expect(record.outputTail).toContain("FINAL LINE");
		expect(record.exitedAt).toBeGreaterThanOrEqual(record.startedAt);
		expect(record.startedAt).toBeGreaterThanOrEqual(record.createdAt);

		// The name is reused: the old generation leaves the active list, and its
		// record stays retrievable.
		const restarted = await client.request({ op: "start", spec: idleSpec("cooldown") });
		if (restarted.op !== "start") throw new Error("cooldown did not restart");
		expect(restarted.daemon.id).not.toBe(firstId);
		const listed = await client.request({ op: "list" });
		if (listed.op !== "list") throw new Error("unexpected list result");
		expect(listed.daemons.map(daemon => daemon.id)).toEqual([restarted.daemon.id]);
		expect(listed.completions.some(entry => entry.id === firstId && entry.exitCode === 0)).toBeTrue();

		// Across a broker restart the record comes from the store on disk.
		await shutdown(client);
		await waitForBrokerExit(projectDir, runtimeDir);
		const recovered = await connect(projectDir, runtimeDir);
		try {
			const completions = await listCompletions(recovered);
			const retained = completions.find(entry => entry.id === firstId);
			expect(retained?.exitCode).toBe(0);
			expect(retained?.terminatedBy).toBe("process-exit");
			expect(retained?.outputTail).toContain("FINAL LINE");
			// And the store itself, read through the real reader, agrees.
			const onDisk = await readDaemonCompletions(runtimeDir);
			expect(onDisk.some(entry => entry.id === firstId)).toBeTrue();
		} finally {
			await shutdown(recovered);
		}
	}, 30_000);

	it("retains a failed generation before restart policy replaces it", async () => {
		const projectDir = await tempDir("veyyon-term-restart-project-");
		const runtimeDir = await tempDir("veyyon-term-restart-runtime-");
		const client = await connect(projectDir, runtimeDir);
		try {
			await client.request({
				op: "start",
				spec: idleSpec("flapping", {
					args: ["-e", 'process.stderr.write("FAILED GENERATION\\n"); process.exit(1);'],
					restart: "on-failure",
				}),
			});
			const failedGeneration = await completionFor(client, "flapping", "process-exit", 2_000);
			expect(failedGeneration?.exitCode).toBe(1);
			expect(failedGeneration?.outputTail).toContain("FAILED GENERATION");
			await client.request({ op: "stop", name: "flapping", timeoutMs: 2_000 });
		} finally {
			await shutdown(client);
		}
	}, 15_000);
});

describe("a stale completion store is rejected, not served", () => {
	function fakeRecord(name: string, exitedAt: number): DaemonCompletionRecord {
		return {
			name,
			id: crypto.randomUUID(),
			terminatedBy: "process-exit",
			exitReason: "exited with code 0",
			exitCode: 0,
			createdAt: exitedAt - 2_000,
			startedAt: exitedAt - 1_000,
			exitedAt,
			restartCount: 0,
			outputBytes: 12,
			outputTail: "some output\n",
		};
	}

	it("throws on a missing version, a wrong version, and non-array records", () => {
		expect(() => parseDaemonCompletionsFile({ records: [] })).toThrow("schema version");
		expect(() => parseDaemonCompletionsFile({ version: DAEMON_COMPLETIONS_SCHEMA_VERSION + 1, records: [] })).toThrow(
			"schema version",
		);
		expect(() => parseDaemonCompletionsFile({ version: DAEMON_COMPLETIONS_SCHEMA_VERSION, records: "x" })).toThrow(
			"must be an array",
		);
	});

	it("refuses the stale file through the store and serves nothing stale over the wire", async () => {
		const projectDir = await tempDir("veyyon-term-stale-project-");
		const runtimeDir = await tempDir("veyyon-term-stale-runtime-");
		const staleRecord = fakeRecord("from-the-future", Date.now());
		await fs.writeFile(
			daemonCompletionsPath(runtimeDir),
			JSON.stringify({ version: DAEMON_COMPLETIONS_SCHEMA_VERSION + 1, records: [staleRecord] }),
		);

		// The store reader rejects it outright.
		await expect(readDaemonCompletions(runtimeDir)).rejects.toThrow("schema version");

		// The broker rejects it too: list serves NO completions, stays responsive,
		// and never returns the stale record.
		const client = await connect(projectDir, runtimeDir);
		try {
			expect(await listCompletions(client)).toEqual([]);
			const ping = await client.request({ op: "ping" });
			expect(ping.op).toBe("ping");

			// The next append discards the stale store instead of merging it.
			const fresh = fakeRecord("fresh", Date.now());
			await appendDaemonCompletion(runtimeDir, fresh);
			const stored = await readDaemonCompletions(runtimeDir);
			expect(stored.map(record => record.name)).toEqual(["fresh"]);
			expect((await listCompletions(client)).map(record => record.name)).toEqual(["fresh"]);
		} finally {
			await shutdown(client);
		}
	}, 30_000);

	it("keeps the last 100 records or 24h, whichever bites first", async () => {
		const runtimeDir = await tempDir("veyyon-term-bounds-runtime-");
		const now = Date.now();
		for (let index = 0; index < DAEMON_COMPLETIONS_LIMIT + 5; index++) {
			await appendDaemonCompletion(runtimeDir, fakeRecord(`job-${index}`, now));
		}
		const countBounded = await readDaemonCompletions(runtimeDir);
		expect(countBounded).toHaveLength(DAEMON_COMPLETIONS_LIMIT);
		// The five oldest are the ones dropped.
		expect(countBounded[0]?.name).toBe("job-5");

		// A record older than 24h is dropped even when the count bound has room.
		const agedDir = await tempDir("veyyon-term-aged-runtime-");
		await appendDaemonCompletion(agedDir, fakeRecord("ancient", now - DAEMON_COMPLETIONS_MAX_AGE_MS - 1));
		await appendDaemonCompletion(agedDir, fakeRecord("recent", now));
		expect((await readDaemonCompletions(agedDir)).map(record => record.name)).toEqual(["recent"]);

		// Age is enforced when reading too, not only when another completion happens to append.
		const expiredDir = await tempDir("veyyon-term-expired-runtime-");
		await fs.writeFile(
			daemonCompletionsPath(expiredDir),
			JSON.stringify({
				version: DAEMON_COMPLETIONS_SCHEMA_VERSION,
				records: [fakeRecord("expired-without-an-append", now - DAEMON_COMPLETIONS_MAX_AGE_MS - 1)],
			}),
		);
		expect(await readDaemonCompletions(expiredDir, now)).toEqual([]);
	}, 30_000);
});

describe("job list output shows the lifetime before it bites", () => {
	function wire(overrides: Partial<DaemonSnapshot>): DaemonSnapshot {
		// Run the literal through the wire parser so the label reads exactly what a
		// client receives, not a hand-maintained side shape.
		return parseDaemonSnapshot({
			name: "web",
			id: crypto.randomUUID(),
			state: "running",
			createdAt: 1_000,
			startedAt: 1_000,
			restartCount: 0,
			outputBytes: 0,
			persist: false,
			...overrides,
		});
	}

	it("names the owning condition for the default, persist, and detached lifetimes", () => {
		const text = toolContent(
			{
				op: "list",
				daemons: [
					wire({ name: "defaulted" }),
					wire({ name: "persistent", persist: true }),
					wire({ name: "outliving", persist: true, detached: true }),
				],
				completions: [],
			},
			{ op: "list" },
		);
		expect(text).toContain("defaulted: running");
		expect(text).toContain("lifetime=last-client-exit");
		expect(text).toContain("lifetime=broker-shutdown");
		expect(text).toContain("lifetime=detached");
	});

	it("names the termination owner and reason on a terminal daemon", () => {
		const text = toolContent(
			{
				op: "list",
				daemons: [
					wire({
						name: "killed",
						state: "exited",
						exitedAt: 61_000,
						signal: "SIGTERM",
						terminatedBy: "idle-reaper",
						exitReason: "the last veyyon client disconnected",
					}),
				],
				completions: [],
			},
			{ op: "list" },
		);
		expect(text).toContain("terminated-by=idle-reaper");
		expect(text).toContain("the last veyyon client disconnected");
	});

	it("lists retained completions with owner, reason, and a tail snippet", () => {
		const record: DaemonCompletionRecord = {
			name: "cooldown",
			id: crypto.randomUUID(),
			terminatedBy: "process-exit",
			exitReason: "exited with code 0",
			exitCode: 0,
			createdAt: 1_000,
			startedAt: 2_000,
			exitedAt: 62_000,
			restartCount: 0,
			outputBytes: 40,
			outputTail: "line one\nFINAL LINE\n",
		};
		const text = toolContent({ op: "list", daemons: [], completions: [record] }, { op: "list" });
		expect(text).toContain("Recently completed");
		expect(text).toContain("cooldown: exit=0 terminated-by=process-exit");
		expect(text).toContain("FINAL LINE");
	});
});
