/**
 * An exited launch process is retained for post-mortem inspection and then
 * purged from memory and disk after the configured cleanup wait TTL.
 *
 * WHY: `launch list` retained exited processes indefinitely, accumulating
 * dozens of corpses over days that cluttered process listings and held disk
 * records forever. Exited process records are needed briefly after exit for
 * crash diagnostics (logs, exit reason, spec restart), after which they must
 * be automatically purged.
 *
 * WHAT CLASS THIS CLOSES: accumulation of dead daemon records across sessions
 * and brokers.
 *
 * WHAT IT DOES NOT CATCH: processes that never exit (running services stay alive
 * and registered until explicitly stopped).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { SETTINGS_SCHEMA } from "../../src/config/settings-schema";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { managedDaemonDir, managedDaemonMetaPath } from "../../src/launch/paths";
import type { DaemonSpec } from "../../src/launch/protocol";
import { getSettingDef } from "../../src/modes/terminal/components/selectors/settings-defs";

const cleanupDirs: string[] = [];
let isolatedConfigRoot: IsolatedConfigRoot | undefined;

beforeAll(() => {
	isolatedConfigRoot = enterIsolatedConfigRoot("launch-cleanup-wait");
});

afterAll(() => {
	isolatedConfigRoot?.restore();
	isolatedConfigRoot = undefined;
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

// Cross-process integration: fake timers cannot advance a detached broker or OS process table.
async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await Bun.sleep(50);
	}
	return condition();
}

async function shutdown(client: DaemonBrokerClient): Promise<void> {
	try {
		await client.request({ op: "shutdown" });
	} catch {
		// A last-client shutdown may already have closed the broker.
	}
	client.close();
}

afterEach(async () => {
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("an exited launch process is purged after the configured cleanup wait", () => {
	it("retains an exited process immediately and purges it after cleanupWaitMs", async () => {
		const projectDir = await tempDir("launch-cleanup-project-");
		const runtimeDir = await tempDir("launch-cleanup-runtime-");
		const scriptPath = path.join(projectDir, "quick-exit.ts");
		await Bun.write(scriptPath, `console.log("READY"); setTimeout(() => process.exit(0), 100);\n`);

		const client = await createDaemonBrokerClient(projectDir, {
			runtimeDir,
			idleGraceMs: 10_000,
			cleanupWaitMs: 1_000,
		});

		try {
			const spec: DaemonSpec = {
				name: "short-lived",
				application: process.execPath,
				args: [scriptPath],
				env: {},
				cwd: projectDir,
				pty: false,
				ready: { log: "READY", timeoutMs: 5_000 },
				restart: "no",
				persist: false,
				detached: false,
			};

			const started = await client.request({ op: "start", spec });
			expect(started.op).toBe("start");
			if (started.op !== "start") throw new Error("Unexpected start result");

			// Wait for the process to exit.
			const exited = await waitUntil(async () => {
				const list = await client.request({ op: "list" });
				if (list.op !== "list") return false;
				const daemon = list.daemons.find(d => d.name === "short-lived");
				return daemon?.state === "exited";
			}, 3_000);
			expect(exited).toBeTrue();

			// Immediately after exit, the record and disk files still exist for inspection.
			const listAfterExit = await client.request({ op: "list" });
			if (listAfterExit.op !== "list") throw new Error("Unexpected list result");
			expect(listAfterExit.daemons.map(d => d.name)).toContain("short-lived");

			const daemonDir = managedDaemonDir(runtimeDir, "short-lived");
			const statBeforePurge = await fs.stat(daemonDir).catch(() => null);
			expect(statBeforePurge).not.toBeNull();

			// Wait for the 350ms cleanupWaitMs TTL to elapse.
			const purged = await waitUntil(async () => {
				const list = await client.request({ op: "list" });
				if (list.op !== "list") return false;
				return !list.daemons.some(d => d.name === "short-lived");
			}, 3_000);
			expect(purged).toBeTrue();

			// On-disk directory is also removed.
			const statAfterPurge = await fs.stat(daemonDir).catch(() => null);
			expect(statAfterPurge).toBeNull();
		} finally {
			await shutdown(client);
		}
	}, 15_000);

	it("retains exited processes indefinitely when cleanupWaitMs is 0", async () => {
		const projectDir = await tempDir("launch-cleanup-zero-project-");
		const runtimeDir = await tempDir("launch-cleanup-zero-runtime-");
		const scriptPath = path.join(projectDir, "quick-exit-zero.ts");
		await Bun.write(scriptPath, `console.log("READY"); setTimeout(() => process.exit(0), 50);\n`);

		const client = await createDaemonBrokerClient(projectDir, {
			runtimeDir,
			idleGraceMs: 10_000,
			cleanupWaitMs: 0,
		});

		try {
			const spec: DaemonSpec = {
				name: "never-purged",
				application: process.execPath,
				args: [scriptPath],
				env: {},
				cwd: projectDir,
				pty: false,
				ready: { log: "READY", timeoutMs: 5_000 },
				restart: "no",
				persist: false,
				detached: false,
			};

			await client.request({ op: "start", spec });

			const exited = await waitUntil(async () => {
				const list = await client.request({ op: "list" });
				if (list.op !== "list") return false;
				const daemon = list.daemons.find(d => d.name === "never-purged");
				return daemon?.state === "exited";
			}, 3_000);
			expect(exited).toBeTrue();

			// Cross-process integration: verify daemon is not purged after delay when cleanupWaitMs is 0.
			await Bun.sleep(200);
			const list = await client.request({ op: "list" });
			if (list.op !== "list") throw new Error("Unexpected list result");
			expect(list.daemons.map(d => d.name)).toContain("never-purged");

			const daemonDir = managedDaemonDir(runtimeDir, "never-purged");
			const stat = await fs.stat(daemonDir).catch(() => null);
			expect(stat).not.toBeNull();
		} finally {
			await shutdown(client);
		}
	}, 15_000);

	it("cancels the purge timer when the process is started again with the same name", async () => {
		const projectDir = await tempDir("launch-cleanup-restart-project-");
		const runtimeDir = await tempDir("launch-cleanup-restart-runtime-");
		const exitScript = path.join(projectDir, "exit-script.ts");
		const longScript = path.join(projectDir, "long-script.ts");
		await Bun.write(exitScript, `console.log("READY"); setTimeout(() => process.exit(0), 100);\n`);
		await Bun.write(longScript, `console.log("READY"); setInterval(() => {}, 1000);\n`);

		const client = await createDaemonBrokerClient(projectDir, {
			runtimeDir,
			idleGraceMs: 10_000,
			cleanupWaitMs: 600,
		});

		try {
			const exitSpec: DaemonSpec = {
				name: "reused-name",
				application: process.execPath,
				args: [exitScript],
				env: {},
				cwd: projectDir,
				pty: false,
				ready: { log: "READY", timeoutMs: 5_000 },
				restart: "no",
				persist: false,
				detached: false,
			};

			await client.request({ op: "start", spec: exitSpec });

			const exited = await waitUntil(async () => {
				const list = await client.request({ op: "list" });
				if (list.op !== "list") return false;
				const daemon = list.daemons.find(d => d.name === "reused-name");
				return daemon?.state === "exited";
			}, 3_000);
			expect(exited).toBeTrue();

			// Before the 600ms timer elapses, start the same name as a long-running daemon.
			const longSpec: DaemonSpec = {
				...exitSpec,
				args: [longScript],
			};
			const restarted = await client.request({ op: "start", spec: longSpec });
			expect(restarted.op).toBe("start");
			if (restarted.op !== "start") throw new Error("Unexpected start result");
			expect(restarted.daemon.state).toBe("ready");

			// Cross-process integration: verify restarted daemon remains ready past initial window.
			await Bun.sleep(300);
			const list = await client.request({ op: "list" });
			if (list.op !== "list") throw new Error("Unexpected list result");
			const current = list.daemons.find(d => d.name === "reused-name");
			expect(current?.state).toBe("ready");
		} finally {
			await shutdown(client);
		}
	}, 15_000);

	it("purges expired historical daemons from disk on broker recovery", async () => {
		const projectDir = await tempDir("launch-cleanup-recovery-project-");
		const runtimeDir = await tempDir("launch-cleanup-recovery-runtime-");

		// Pre-seed an expired daemon directory on disk.
		const expiredDir = managedDaemonDir(runtimeDir, "historical-dead");
		await fs.mkdir(expiredDir, { recursive: true, mode: 0o700 });
		const expiredMeta = {
			daemon: {
				name: "historical-dead",
				id: crypto.randomUUID(),
				state: "exited",
				createdAt: Date.now() - 100_000,
				startedAt: Date.now() - 100_000,
				exitedAt: Date.now() - 50_000, // 50s ago
				restartCount: 0,
				outputBytes: 0,
				persist: false,
				detached: false,
			},
			spec: {
				name: "historical-dead",
				application: "node",
				args: [],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			},
		};
		await Bun.write(managedDaemonMetaPath(expiredDir), JSON.stringify(expiredMeta));

		// Start a broker with 1_000ms cleanupWaitMs.
		const client = await createDaemonBrokerClient(projectDir, {
			runtimeDir,
			idleGraceMs: 10_000,
			cleanupWaitMs: 1_000,
		});

		try {
			const list = await client.request({ op: "list" });
			if (list.op !== "list") throw new Error("Unexpected list result");
			expect(list.daemons.map(d => d.name)).not.toContain("historical-dead");

			const stat = await fs.stat(expiredDir).catch(() => null);
			expect(stat).toBeNull();
		} finally {
			await shutdown(client);
		}
	}, 15_000);

	it("ensures an exited record is queryable via list, describe, and logs during wait and absent after purge", async () => {
		const projectDir = await tempDir("launch-cleanup-query-project-");
		const runtimeDir = await tempDir("launch-cleanup-query-runtime-");
		const scriptPath = path.join(projectDir, "log-exit.ts");
		await fs.writeFile(scriptPath, `console.log("HELLO_WORLD"); setTimeout(() => process.exit(0), 50);\n`);

		// The broker runs in its own process, so a fake clock in this one cannot
		// reach its cleanup timer. The TTL is real and short, and every wait below
		// polls for the state it needs rather than sleeping for a guessed duration.
		const client = await createDaemonBrokerClient(projectDir, {
			runtimeDir,
			idleGraceMs: 10_000,
			cleanupWaitMs: 1_000,
		});

		try {
			const spec: DaemonSpec = {
				name: "queryable-daemon",
				application: process.execPath,
				args: [scriptPath],
				env: {},
				cwd: projectDir,
				pty: false,
				ready: { log: "HELLO_WORLD", timeoutMs: 5_000 },
				restart: "no",
				persist: false,
				detached: false,
			};

			await client.request({ op: "start", spec });

			const exited = await waitUntil(async () => {
				const list = await client.request({ op: "list" });
				if (list.op !== "list") return false;
				const daemon = list.daemons.find(d => d.name === "queryable-daemon");
				return daemon?.state === "exited";
			}, 3_000);
			expect(exited).toBeTrue();

			// Queryable via list, describe, and logs during the retention wait.
			const listBefore = await client.request({ op: "list" });
			if (listBefore.op !== "list") throw new Error("Unexpected list result");
			expect(listBefore.daemons.some(d => d.name === "queryable-daemon")).toBeTrue();

			const describeBefore = await client.request({ op: "describe", name: "queryable-daemon" });
			expect(describeBefore.op).toBe("describe");
			if (describeBefore.op === "describe") {
				expect(describeBefore.daemon.state).toBe("exited");
				expect(describeBefore.spec.name).toBe("queryable-daemon");
			}

			const logsBefore = await client.request({
				op: "logs",
				name: "queryable-daemon",
				lines: 10,
				head: false,
				follow: false,
				timeoutMs: 5_000,
			});
			expect(logsBefore.op).toBe("logs");
			if (logsBefore.op === "logs") {
				expect(logsBefore.text).toContain("HELLO_WORLD");
			}

			// Wait for the purge TTL to elapse.
			const purged = await waitUntil(async () => {
				const list = await client.request({ op: "list" });
				if (list.op !== "list") return false;
				return !list.daemons.some(d => d.name === "queryable-daemon");
			}, 3_000);
			expect(purged).toBeTrue();

			// After purge, describe and logs fail with unknown daemon error.
			await expect(client.request({ op: "describe", name: "queryable-daemon" })).rejects.toThrow(/Unknown daemon/);
			await expect(
				client.request({
					op: "logs",
					name: "queryable-daemon",
					lines: 10,
					head: false,
					follow: false,
					timeoutMs: 5_000,
				}),
			).rejects.toThrow(/Unknown daemon/);
		} finally {
			await shutdown(client);
		}
	}, 15_000);

	it("clears cleanup timers on broker shutdown without holding the event loop open", async () => {
		const projectDir = await tempDir("launch-cleanup-shutdown-project-");
		const runtimeDir = await tempDir("launch-cleanup-shutdown-runtime-");
		const scriptPath = path.join(projectDir, "quick-exit-shutdown.ts");
		await fs.writeFile(scriptPath, `console.log("READY"); setTimeout(() => process.exit(0), 50);\n`);

		const client = await createDaemonBrokerClient(projectDir, {
			runtimeDir,
			idleGraceMs: 10_000,
			cleanupWaitMs: 60_000, // 1 minute retention
		});

		const spec: DaemonSpec = {
			name: "shutdown-daemon",
			application: process.execPath,
			args: [scriptPath],
			env: {},
			cwd: projectDir,
			pty: false,
			ready: { log: "READY", timeoutMs: 5_000 },
			restart: "no",
			persist: false,
			detached: false,
		};

		await client.request({ op: "start", spec });
		const exited = await waitUntil(async () => {
			const list = await client.request({ op: "list" });
			if (list.op !== "list") return false;
			const daemon = list.daemons.find(d => d.name === "shutdown-daemon");
			return daemon?.state === "exited";
		}, 3_000);
		expect(exited).toBeTrue();

		const shutdownStart = Date.now();
		await shutdown(client);
		const shutdownElapsed = Date.now() - shutdownStart;
		// Shutdown should complete promptly and not wait for the 60s cleanup timer.
		expect(shutdownElapsed).toBeLessThan(3_000);
	}, 15_000);

	it("declares launch.cleanupWaitMs in settings schema with 15-minute default, min 0, and hides it when launch is disabled", async () => {
		const setting = SETTINGS_SCHEMA["launch.cleanupWaitMs"];
		expect(setting).toBeDefined();
		expect(setting.type).toBe("number");
		expect(setting.default).toBe(15 * 60 * 1000);
		expect(setting.ui?.tab).toBe("tools");
		expect(setting.ui?.group).toBe("Launch");
		expect(setting.ui?.label).toBe("Launch Cleanup Wait");
		expect(setting.ui?.min).toBe(0);
		expect(setting.ui?.condition).toBe("launchEnabled");
		expect(setting.ui?.options).toBeArray();

		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "launch.enabled": true } });
		expect(Settings.instance.get("launch.cleanupWaitMs")).toBe(15 * 60 * 1000);

		const def = getSettingDef("launch.cleanupWaitMs");
		expect(def).not.toBeNull();
		expect(def?.condition?.()).toBeTrue();

		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "launch.enabled": false } });
		expect(def?.condition?.()).toBeFalse();

		resetSettingsForTest();
	});
});
