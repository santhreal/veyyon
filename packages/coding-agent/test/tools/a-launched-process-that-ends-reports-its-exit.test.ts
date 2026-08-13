/**
 * WHY: a background thing the agent starts must report its own end.
 *
 * `launch start` returned as soon as the process was spawned and then went
 * silent forever. The only ways to learn that a supervised process had finished
 * were `wait` (blocks the turn) and polling `logs`, so "start it and go do
 * other work" — the entire reason to background anything — was the one thing
 * `launch` could not do. A finite command handed to it (the reported case was a
 * cargo test gate) trapped the caller in a poll loop with no exit.
 *
 * The class this closes: every terminal outcome of a supervised process reaches
 * the session that started it, through the same background-job delivery an
 * async `bash` command uses, and every end the caller ASKED for stays silent.
 * The suite drives the real `LaunchTool`, the real broker (a separate process),
 * and a real `AsyncJobManager`; nothing about the exit path is stubbed.
 *
 * What it does not catch: delivery across a veyyon restart (a watch lives in
 * the process that started it — a restarted session sees the exit only through
 * `list`), and the routing prose in `prompts/tools/launch.md` that tells the
 * model which tool a finite command belongs to.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@veyyon/coding-agent/async";
import { closeDaemonClients } from "@veyyon/coding-agent/launch/client";
import { resetLaunchExitWatchesForTests } from "@veyyon/coding-agent/tools/launch-exit-watch";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { LaunchTool } from "../../src/tools/launch";
import { makeToolSession } from "../helpers/tool-session";

let isolatedConfigRoot: IsolatedConfigRoot | undefined;
const cleanupDirs: string[] = [];

beforeAll(() => {
	isolatedConfigRoot = enterIsolatedConfigRoot("launch-exit-watch");
});

afterAll(() => {
	isolatedConfigRoot?.restore();
	isolatedConfigRoot = undefined;
});

afterEach(async () => {
	await closeDaemonClients();
	resetLaunchExitWatchesForTests();
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(block => block.type === "text")?.text ?? "";
}

interface Delivered {
	jobId: string;
	text: string;
	status: string;
	type: string;
}

async function projectWith(script: string): Promise<{ dir: string; scriptPath: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-launch-exit-"));
	cleanupDirs.push(dir);
	const scriptPath = path.join(dir, "run.ts");
	await fs.writeFile(scriptPath, script, "utf8");
	return { dir, scriptPath };
}

function harness(cwd: string): { tool: LaunchTool; manager: AsyncJobManager; delivered: Delivered[] } {
	const delivered: Delivered[] = [];
	const manager = new AsyncJobManager({
		onJobComplete: (jobId, text, job) => {
			delivered.push({ jobId, text, status: job?.status ?? "unknown", type: job?.type ?? "unknown" });
		},
	});
	const tool = new LaunchTool(makeToolSession({ cwd, asyncJobManager: manager }));
	return { tool, manager, delivered };
}

// The broker, the supervised process and the delivery retry loop are all real
// and cross-process, so progress is observed rather than clock-advanced.
async function until(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await Bun.sleep(25);
	}
	return condition();
}

describe("a launched process that ends reports its exit", () => {
	it("delivers a clean exit as a completed background job carrying the tail of its output", async () => {
		const { dir, scriptPath } = await projectWith(
			'console.log("first line");\nconsole.log("TAIL MARKER");\nprocess.exit(0);\n',
		);
		const { tool, delivered } = harness(dir);

		const started = await tool.execute("call-1", {
			op: "start",
			name: "finite",
			application: process.execPath,
			args: [scriptPath],
			pty: false,
		});
		expect(textOf(started)).toContain("Started finite");

		expect(await until(() => delivered.length > 0, 20_000)).toBeTrue();
		const [notice] = delivered;
		expect(notice?.type).toBe("launch");
		expect(notice?.status).toBe("completed");
		expect(notice?.text).toContain("Launched process finite exited 0");
		expect(notice?.text).toContain("TAIL MARKER");
	}, 30_000);

	it("delivers a non-zero exit as a failed background job naming the code", async () => {
		const { dir, scriptPath } = await projectWith('console.log("BOOM");\nprocess.exit(3);\n');
		const { tool, delivered } = harness(dir);

		await tool.execute("call-1", {
			op: "start",
			name: "broken",
			application: process.execPath,
			args: [scriptPath],
			pty: false,
		});

		expect(await until(() => delivered.length > 0, 20_000)).toBeTrue();
		expect(delivered[0]?.status).toBe("failed");
		expect(delivered[0]?.text).toContain("Launched process broken exited 3");
	}, 30_000);

	it("says nothing about an exit the caller asked for", async () => {
		const { dir, scriptPath } = await projectWith("setInterval(() => {}, 1000);\n");
		const { tool, manager, delivered } = harness(dir);

		await tool.execute("call-1", {
			op: "start",
			name: "service",
			application: process.execPath,
			args: [scriptPath],
			pty: false,
		});
		expect(manager.getRunningJobs()).toHaveLength(1);

		const stopped = await tool.execute("call-2", { op: "stop", name: "service", timeout: 5 });
		expect(textOf(stopped)).toContain("Stopped service");

		// The watch is gone the moment the stop is requested, and staying quiet is
		// the claim: give the delivery loop room to prove it has nothing to send.
		expect(manager.getRunningJobs()).toHaveLength(0);
		expect(await until(() => delivered.length > 0, 2_000)).toBeFalse();
		expect(delivered).toEqual([]);
	}, 30_000);

	it("watches the process a restart put in place, not the run the restart ended", async () => {
		const { dir, scriptPath } = await projectWith(
			'console.log("RUN " + (process.env.LAUNCH_RUN ?? "?"));\nsetInterval(() => {}, 1000);\n',
		);
		const { tool, manager, delivered } = harness(dir);

		await tool.execute("call-1", {
			op: "start",
			name: "cycled",
			application: process.execPath,
			args: [scriptPath],
			pty: false,
		});
		await tool.execute("call-2", { op: "restart", name: "cycled" });

		// The restart itself is an end the caller asked for: silent.
		expect(delivered).toEqual([]);
		expect(manager.getRunningJobs()).toHaveLength(1);

		// The process the restart installed is watched, so killing it from outside
		// still reports.
		const described = await tool.execute("call-3", { op: "describe", name: "cycled" });
		const pid = described.details?.daemon?.pid;
		expect(pid).toBeGreaterThan(0);
		if (pid !== undefined) process.kill(pid, "SIGKILL");

		expect(await until(() => delivered.length > 0, 20_000)).toBeTrue();
		expect(delivered[0]?.text).toContain("Launched process cycled");
		expect(delivered[0]?.status).toBe("failed");
	}, 40_000);

	it("registers no watch for a detached process, whose exit outlives the session", async () => {
		const { dir, scriptPath } = await projectWith("setInterval(() => {}, 1000);\n");
		const { tool, manager } = harness(dir);

		await tool.execute("call-1", {
			op: "start",
			name: "outliving",
			application: process.execPath,
			args: [scriptPath],
			detached: true,
		});
		expect(manager.getRunningJobs()).toEqual([]);

		await tool.execute("call-2", { op: "stop", name: "outliving", timeout: 5 });
	}, 30_000);
});
