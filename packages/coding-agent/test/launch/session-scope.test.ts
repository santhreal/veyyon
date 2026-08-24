import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import type { ToolSession } from "../../src";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { daemonRuntimeDir, daemonSessionRuntimeDir } from "../../src/launch/paths";
import { LaunchTool } from "../../src/tools/launch";

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
	return new LaunchTool({
		cwd,
		settings: { get: (key: string) => settings.get(key) },
		getSessionId: () => sessionId,
	} as unknown as ToolSession);
}

async function listNames(tool: LaunchTool): Promise<string[]> {
	const result = await tool.execute("id", { op: "list" }, undefined, undefined);
	const details = result.details as { daemons?: Array<{ name: string }> };
	return (details.daemons ?? []).map(daemon => daemon.name);
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

		try {
			// The historical scope is back: a plain project client (what another
			// session and the CLI both join) lists the process.
			const projectScope = await createDaemonBrokerClient(project);
			const sharedList = await projectScope.request({ op: "list" });
			if (sharedList.op !== "list") throw new Error("unexpected list result");
			expect(sharedList.daemons.map(daemon => daemon.name)).toEqual(["shared-server"]);
			await projectScope.request({ op: "shutdown" });
			projectScope.close();
		} finally {
			await sharer.execute("id", { op: "stop", name: "shared-server" });
		}
	}, 30_000);
});
