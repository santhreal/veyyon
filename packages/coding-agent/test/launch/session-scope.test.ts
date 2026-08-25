import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { closeDaemonClients, createDaemonBrokerClient, daemonClientForProject } from "../../src/launch/client";
import { daemonRuntimeDir, daemonSessionRuntimeDir } from "../../src/launch/paths";
import { LaunchTool } from "../../src/tools/launch";
import { releaseLaunchExitWatch, watchLaunchedProcessExit } from "../../src/tools/launch-exit-watch";
import { makeToolSession } from "../helpers/tool-session";

/**
 * WHY THIS SUITE EXISTS.
 *
 * Launched processes were supervised by one broker per PROJECT directory, so every session in
 * that project listed, read, stopped and restarted every other session's processes. A session
 * that ran `veyyon` twice — or two agents in one checkout — shared one process table: session B
 * could kill session A's dev server, and A's logs leaked into B's context. That is the defect
 * class closed here: LAUNCH SCOPE MUST FOLLOW SESSION LIFETIME BY DEFAULT.
 *
 * The contract, driven through the real tool and real brokers (no fakes of the subject):
 *
 *  - Default (`launch.sharedCrossSession: false`, the shipped default): two sessions in the same
 *    project compute different broker runtime directories. Session B's `list` does not contain
 *    session A's process; neither does the project-shared scope a CLI client would join.
 *  - Opt-in (`launch.sharedCrossSession: true`): the historical behavior — the project broker,
 *    reachable from any session and from `veyyon launch` in a terminal.
 *  - The session runtime directory never collides with a project key and sanitizes its id, so a
 *    hostile session id cannot land one scope on another scope's socket or token.
 *
 * WHAT IT DOES NOT CATCH. It does not prove the TUI settings screen hides the knob while
 * `launch.enabled` is off (that predicate lives in settings-defs CONDITIONS and is covered by the
 * settings suites' sweep), and it does not exercise persistence across a session restart — a
 * resumed session intentionally finds its private daemons gone, which the broker's idle grace
 * guarantees structurally rather than by code this suite could pin.
 */

const cleanupDirs: string[] = [];
let isolatedConfigRoot: IsolatedConfigRoot | undefined;

beforeAll(() => {
	isolatedConfigRoot = enterIsolatedConfigRoot("launch-session-scope");
});

afterAll(async () => {
	isolatedConfigRoot?.restore();
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

function session(cwd: string, sessionId: string, sharedCrossSession: boolean): LaunchTool {
	const settings = new Map<string, boolean | number>([
		["launch.sharedCrossSession", sharedCrossSession],
		["session.cpuLimitCores", 0],
	]);
	return new LaunchTool(
		makeToolSession({
			cwd,
			getSessionId: () => sessionId,
			settings: { get: (key: string) => settings.get(key) },
		}),
	);
}

async function listNames(tool: LaunchTool): Promise<string[]> {
	const result = await tool.execute("id", { op: "list" }, undefined, undefined);
	const details = result.details as { daemons?: Array<{ name: string }> };
	return (details.daemons ?? []).map(daemon => daemon.name);
}

// Cross-process integration: the broker, its daemons and OS sockets live outside
// this process, so progress is observed by polling.
async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await delay(50);
	}
	return false;
}

describe("daemonSessionRuntimeDir", () => {
	it("keys one project's scopes apart by session id and apart from the project scope", async () => {
		const project = await tempDir("veyyon-scope-project-");
		const a = daemonSessionRuntimeDir(project, "session-a");
		const b = daemonSessionRuntimeDir(project, "session-b");
		expect(a).not.toBe(b);
		expect(a).toBe(daemonSessionRuntimeDir(project, "session-a"));
		expect(a).not.toBe(daemonRuntimeDir(project));
		// The layout stays under the broker root, beside the project scopes.
		expect(path.basename(path.dirname(a))).toBe(path.basename(path.dirname(daemonRuntimeDir(project))));
		expect(path.basename(a)).toMatch(/^session-/);
	});

	it("sanitizes hostile session ids instead of escaping the broker root", async () => {
		const project = await tempDir("veyyon-scope-project-");
		const hostile = daemonSessionRuntimeDir(project, "../../elsewhere/x");
		expect(hostile.startsWith(daemonSessionRuntimeDir(project, "")));
		expect(hostile).not.toContain("..");
	});

	it("does not collide ids that share a long sanitized prefix", async () => {
		const project = await tempDir("veyyon-scope-project-");
		const base = "x".repeat(60);
		expect(daemonSessionRuntimeDir(project, base)).not.toBe(daemonSessionRuntimeDir(project, `${base}-advisor`));
	});
});

describe("launch scope follows the session by default", () => {
	it("hides a session's launched process from every other session and from the shared scope", async () => {
		const project = await tempDir("veyyon-launch-project-");
		const scriptPath = path.join(project, "service.ts");
		await Bun.write(scriptPath, 'process.stdout.write("READY\\n");\nsetInterval(() => {}, 1000);\n');

		const owner = session(project, "session-owner", false);
		const bystander = session(project, "session-bystander", false);

		const started = await owner.execute("id", {
			op: "start",
			name: "private-server",
			application: process.execPath,
			args: [scriptPath],
			env: {},
			pty: false,
			ready: { log: "READY", timeout: 10 },
			restart: "no",
		});
		const details = started.details as { daemon?: { state: string } };
		expect(details.daemon?.state).toBe("ready");

		try {
			// Another session in the SAME project sees nothing.
			expect(await listNames(bystander)).toEqual([]);
			// And the project-shared scope a `veyyon launch` CLI client joins sees nothing either.
			const projectScope = await createDaemonBrokerClient(project);
			const sharedList = await projectScope.request({ op: "list" });
			if (sharedList.op !== "list") throw new Error("unexpected list result");
			expect(sharedList.daemons.map(daemon => daemon.name)).toEqual([]);
			await projectScope.request({ op: "shutdown" });
			projectScope.close();

			// The owning session still sees and can stop its own process.
			expect(await listNames(owner)).toEqual(["private-server"]);
		} finally {
			await owner.execute("id", { op: "stop", name: "private-server" });
		}
	}, 30_000);

	it("restores the shared project scope when launch.sharedCrossSession is on", async () => {
		const project = await tempDir("veyyon-launch-project-");
		const scriptPath = path.join(project, "service.ts");
		await Bun.write(scriptPath, 'process.stdout.write("READY\\n");\nsetInterval(() => {}, 1000);\n');

		const sharer = session(project, "session-sharer", true);
		const started = await sharer.execute("id", {
			op: "start",
			name: "shared-server",
			application: process.execPath,
			args: [scriptPath],
			env: {},
			pty: false,
			ready: { log: "READY", timeout: 10 },
			restart: "no",
		});
		const details = started.details as { daemon?: { state: string } };
		expect(details.daemon?.state).toBe("ready");

		const projectScope = await createDaemonBrokerClient(project);
		// The historical scope is back: a plain project client (what another
		// session and the CLI both join) lists the process while it runs.
		const sharedList = await projectScope.request({ op: "list" });
		if (sharedList.op !== "list") throw new Error("unexpected list result");
		expect(sharedList.daemons.map(daemon => daemon.name)).toEqual(["shared-server"]);

		try {
			await sharer.execute("id", { op: "stop", name: "shared-server" });
		} catch (error) {
			// A last-client shutdown racing the stop may have closed the socket
			// first; the process tree is gone either way.
			if (!(error instanceof Error) || !error.message.includes("connection closed")) throw error;
		}
		try {
			await projectScope.request({ op: "shutdown" });
		} catch {}
		projectScope.close();
	}, 30_000);

	it("lands persist starts in the shared scope even when sharing is off, visible to later sessions", async () => {
		const project = await tempDir("veyyon-launch-project-");
		const scriptPath = path.join(project, "service.ts");
		await Bun.write(scriptPath, 'process.stdout.write("READY\\n");\nsetInterval(() => {}, 1000);\n');

		const owner = session(project, "session-owner", false);
		const started = await owner.execute("id", {
			op: "start",
			name: "registry",
			application: process.execPath,
			args: [scriptPath],
			env: {},
			pty: false,
			ready: { log: "READY", timeout: 10 },
			restart: "no",
			persist: true,
		});
		const details = started.details as { daemon?: { state: string; persist: boolean } };
		expect(details.daemon?.state).toBe("ready");

		try {
			// The shared scope hosts it (the CLI and later sessions reach it there)...
			const projectScope = await createDaemonBrokerClient(project);
			const sharedList = await projectScope.request({ op: "list" });
			if (sharedList.op !== "list") throw new Error("unexpected list result");
			expect(sharedList.daemons.map(daemon => daemon.name)).toEqual(["registry"]);
			// ...and a LATER default-off session still sees it through the merged list and can
			// address it by name (the unknown-daemon fallback).
			const later = session(project, "session-later", false);
			expect(await listNames(later)).toEqual(["registry"]);
			const described = await later.execute("id", { op: "describe", name: "registry" });
			const describedDetails = described.details as { spec?: { name: string } };
			expect(describedDetails.spec?.name).toBe("registry");
			await later.execute("id", { op: "stop", name: "registry" });
			try {
				await projectScope.request({ op: "shutdown" });
			} catch {}
			projectScope.close();
		} catch (error) {
			// Best-effort teardown: whatever failed above is the real assertion result.
			try {
				await owner.execute("id", { op: "stop", name: "registry" });
			} catch {}
			throw error;
		}
	}, 30_000);

	it("lands completed persist daemons in shared completions, visible to later sessions", async () => {
		const project = await tempDir("veyyon-launch-project-");
		const scriptPath = path.join(project, "finite.ts");
		await fs.writeFile(scriptPath, 'process.stdout.write("DONE\\n");\nprocess.exit(0);\n');

		const owner = session(project, "session-owner", false);
		await owner.execute("id", {
			op: "start",
			name: "finite-persist",
			application: process.execPath,
			args: [scriptPath],
			env: {},
			pty: false,
			restart: "no",
			persist: true,
		});

		// Wait for process to exit and record completion in shared broker
		const projectScope = await createDaemonBrokerClient(project);
		const completed = await waitUntil(async () => {
			const list = await projectScope.request({ op: "list" });
			return list.op === "list" && list.completions.some(c => c.name === "finite-persist");
		}, 10_000);
		expect(completed).toBe(true);

		// When a new persist start replaces the name, the previous generation appears under Recently completed
		const script2 = path.join(project, "service2.ts");
		await fs.writeFile(script2, 'process.stdout.write("READY\\n");\nsetInterval(() => {}, 1000);\n');
		await owner.execute("id", {
			op: "start",
			name: "finite-persist",
			application: process.execPath,
			args: [script2],
			env: {},
			pty: false,
			ready: { log: "READY", timeout: 10 },
			restart: "no",
			persist: true,
		});

		// Another session listing with default-off sharing must see the completed record in list completions
		const later = session(project, "session-later", false);
		const listResult = await later.execute("id", { op: "list" });
		const details = listResult.details as { completions?: Array<{ name: string }> };
		expect((details.completions ?? []).map(c => c.name)).toContain("finite-persist");
		const text = listResult.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("finite-persist");
		expect(text).toContain("Recently completed");

		await later.execute("id", { op: "stop", name: "finite-persist" });
		try {
			await projectScope.request({ op: "shutdown" });
		} catch {}
		projectScope.close();
	}, 30_000);
});

describe("exit watches are scoped per broker", () => {
	it("two scopes may each watch the same name and releasing one keeps the other", () => {
		const jobs: string[] = [];
		const manager = {
			register: () => {
				const id = `job-${jobs.length + 1}`;
				jobs.push(id);
				return id;
			},
			cancel: (id: string) => {
				const index = jobs.indexOf(id);
				if (index >= 0) jobs.splice(index, 1);
			},
		};
		const watching = () =>
			makeToolSession({
				getSessionId: () => "session-x",
				asyncJobManager: manager as never,
			});
		const daemon = {
			name: "web",
			id: "web",
			state: "running",
			createdAt: 1,
			startedAt: 1,
			restartCount: 0,
			outputBytes: 0,
			persist: false,
			detached: false,
		} as never;
		const clientFor = (runtimeDir: string) =>
			({ projectDir: "p", runtimeDir, request: () => Promise.reject(new Error("unused")) }) as never;

		watchLaunchedProcessExit({ session: watching(), client: clientFor("rt-a"), daemon });
		watchLaunchedProcessExit({ session: watching(), client: clientFor("rt-b"), daemon });
		expect(jobs.length).toBe(2);

		releaseLaunchExitWatch(watching(), clientFor("rt-a"), "web");
		expect(jobs.length).toBe(1);
	});
});

/**
 * WHY: a broker client is cached as the in-flight promise, so a creation that
 * failed used to poison its key for the life of the process. Every later
 * request for that project awaited the same rejected promise and got the
 * original error, with no attempt to reconnect.
 *
 * What this does not catch: `closeDaemonClients` sweeping a cache entry that is
 * registered but has not rejected yet. Registration happens after an internal
 * await and eviction one microtask after the rejection, so the window is real
 * for a signal arriving mid-creation but cannot be entered from the public API
 * — a caller cannot observe the moment the entry lands. `Promise.allSettled`
 * there keeps the sweep total; no test in this file gates it.
 */
describe("a broker client that failed to open", () => {
	it("leaves its key free for the next attempt", async () => {
		const project = await tempDir("veyyon-launch-client-retry-");
		// A runtime directory under a regular file. Creation begins by creating
		// that directory, and ENOTDIR does not depend on who is running the
		// suite; a read-only parent would still be writable as root.
		const blocker = path.join(project, "not-a-directory");
		await fs.writeFile(blocker, "");

		await expect(daemonClientForProject(project, { runtimeDir: path.join(blocker, "run") })).rejects.toThrow();

		const validDir = path.join(project, "valid-run");
		const client = await daemonClientForProject(project, { runtimeDir: validDir, idleGraceMs: 5_000 });
		expect(client.projectDir).toBe(await fs.realpath(project));

		// The retry is a live client, not a cached husk: it answers a real ping.
		const ping = await client.request({ op: "ping" });
		expect(ping.op === "ping" && ping.projectDir).toBe(client.projectDir);
		await client.request({ op: "shutdown" }).catch(() => {});
		await closeDaemonClients();
	}, 30_000);
});
