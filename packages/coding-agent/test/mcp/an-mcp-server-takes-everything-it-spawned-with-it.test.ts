/**
 * WHY. `StdioTransport.close()` sent one signal to one pid: the process veyyon
 * spawned. Almost no MCP server IS that process. Every published way to run one is a
 * wrapper — `npx -y @scope/server`, `uvx server`, `docker run …`, a shell script in a
 * repository — and the wrapper spawns the real server as a grandchild. Killing the
 * wrapper left that grandchild alive, holding the environment it was handed, with no
 * session able to reach it: one orphan per `/mcp reload` in a long session, and one from
 * a failed handshake before the operator had used the server at all.
 *
 * THE CLASS THIS CLOSES. Not "reload leaks a process". The invariant is that every route
 * which ends a stdio server ends everything that server started, and that the ending is
 * bounded. Three routes reach the teardown — an explicit close, a handshake that never
 * completes, and a session disconnecting its servers — and all three are driven here
 * against a real fixture that really forks. A server that ignores SIGTERM is covered too,
 * because a graceful signal with no escalation behind it is a teardown that hangs, and a
 * test that only observes a polite exit cannot see that.
 *
 * The other half of the contract is what must NOT be signalled. Killing the child's
 * process GROUP catches a grandchild re-parented to init, and on macOS and Windows that
 * group is VEYYON'S: the shell's descendant tracker made exactly this mistake and took
 * the harness down with the target. So the group is signalled only when the child leads
 * one of its own, decided from the observed ids, and swept here in both directions. That
 * gate is the second fence: the native `kill_process_group` refuses a pgid equal to the
 * caller's own group, which is pinned in `natives/shell`. Two fences is deliberate
 * — this one is what the TypeScript owns, and it is what a reader of this file can see.
 *
 * WHAT LIVENESS MEANS HERE. Not `kill(pid, 0)`. When the wrapper dies first, the
 * signalled grandchild sits in the process table as a zombie until an init that reaps
 * gets to it, and signal 0 succeeds against a zombie — so that spelling reports every
 * correctly-killed tree as a leak. A leak is a process still RUNNING, which is what the
 * native status answers.
 *
 * WHAT IT DOES NOT CATCH. A grandchild that double-forks into its own session, or one
 * that a wrapper deliberately daemonizes, is outside a descendant walk by construction —
 * the operator started a daemon and veyyon cannot know it was meant to be transient. Nor
 * does this cover Windows job objects: the native layer hard-kills the tree there through
 * Toolhelp, and this suite runs on the POSIX rung. And because the native layer refuses a
 * self-group signal on its own, forcing the JS flag on is not observable from here — that
 * mutant is recorded as uninjectable rather than passed off as covered.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { connectToServer } from "@veyyon/coding-agent/mcp/client";
import { MCPManager } from "@veyyon/coding-agent/mcp/manager";
import * as processTree from "@veyyon/coding-agent/mcp/transports/process-tree";
import { createStdioTransport, type StdioTransport } from "@veyyon/coding-agent/mcp/transports/stdio";
import type { MCPStdioServerConfig } from "@veyyon/coding-agent/mcp/types";
import { Process, ProcessStatus } from "@veyyon/natives";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirs("veyyon-mcp-reap-");

/**
 * A real stdio MCP server that forks a grandchild before it answers anything.
 *
 * `stubborn` makes both processes ignore SIGTERM, so only an escalation ends them.
 * `silent` never answers `initialize` and `reject` refuses it, which are the two
 * failed-handshake routes: one ends in the connect timeout, the other in the
 * handshake's own catch.
 */
const FIXTURE = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [pidPath, mode] = process.argv.slice(2);
const ignore = mode === "stubborn" ? "process.on('SIGTERM', () => {});" : "";
const grandchild = spawn(process.execPath, ["-e", ignore + "setInterval(() => {}, 1000);"], {
	stdio: "ignore",
});
if (mode === "stubborn") process.on("SIGTERM", () => {});
writeFileSync(pidPath, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));

let buffer = "";
process.stdin.on("data", chunk => {
	buffer += chunk;
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		index = buffer.indexOf("\\n");
		if (!line.trim()) continue;
		const message = JSON.parse(line);
		if (message.id === undefined || mode === "silent") continue;
		if (mode === "reject" && message.method === "initialize") {
			const error = { code: -32000, message: "this server refuses to initialize" };
			process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error }) + "\\n");
			index = buffer.indexOf("\\n");
			continue;
		}
		const result =
			message.method === "initialize"
				? {
						protocolVersion: "2024-11-05",
						capabilities: { tools: {} },
						serverInfo: { name: "forking", version: "1.0.0" },
					}
				: { tools: [] };
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
		index = buffer.indexOf("\\n");
	}
});
process.stdin.resume();
setInterval(() => {}, 1000);
`;

interface Forked {
	child: number;
	grandchild: number;
}

/**
 * True while this pid is a RUNNING process. A pid that is gone, or is an unreaped
 * zombie whose parent died before it, answers false: neither holds the environment
 * the leak was about.
 */
function running(pid: number): boolean {
	const handle = Process.fromPid(pid);
	return handle !== null && handle.status() === ProcessStatus.Running;
}

describe("an MCP server takes everything it spawned with it", () => {
	let dir: string;
	let fixture: string;
	let transports: StdioTransport[];
	let managers: MCPManager[];
	let forks: Forked[];

	beforeEach(() => {
		dir = makeTempDir();
		fixture = path.join(dir, "forking-server.mjs");
		fs.writeFileSync(fixture, FIXTURE);
		transports = [];
		managers = [];
		forks = [];
	});

	afterEach(async () => {
		for (const transport of transports) await transport.close().catch(() => {});
		for (const manager of managers) await manager.disconnectAll().catch(() => {});
		// Whatever a failing assertion left behind is this suite's to clean up, not the
		// next test's to inherit.
		for (const fork of forks) {
			for (const pid of [fork.grandchild, fork.child]) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Already gone, which is what every test here asserts.
				}
			}
		}
	});

	function config(mode: "normal" | "silent" | "stubborn" | "reject", pidPath: string): MCPStdioServerConfig {
		return {
			type: "stdio",
			command: process.execPath,
			args: [fixture, pidPath, mode],
			// Long enough that a healthy handshake never races it, short enough that the
			// silent case does not hold the suite.
			timeout: 4_000,
		};
	}

	/** Wait for the fixture to record both pids, without a wall-clock sleep of our own. */
	async function forked(pidPath: string): Promise<Forked> {
		// The pids are written before the server answers `initialize`, so a completed
		// handshake means the file is there. The silent mode has no handshake, so its
		// caller polls the file through the transport's own connect instead.
		const raw = fs.readFileSync(pidPath, "utf8");
		const fork = JSON.parse(raw) as Forked;
		forks.push(fork);
		return fork;
	}

	/**
	 * Bounded wait for a pid to stop running, using the native watcher rather than a
	 * timer of our own. Returns whether it is gone.
	 */
	async function gone(pid: number): Promise<boolean> {
		const handle = Process.fromPid(pid);
		if (!handle) return true;
		await handle.waitForExit({ timeoutMs: processTree.MCP_TREE_TIMEOUT_MS + processTree.MCP_TREE_GRACE_MS });
		return !running(pid);
	}

	async function connectedTransport(mode: "normal" | "stubborn"): Promise<{
		transport: StdioTransport;
		fork: Forked;
	}> {
		const pidPath = path.join(dir, `${mode}-${transports.length}.json`);
		const transport = await createStdioTransport(config(mode, pidPath));
		transports.push(transport);
		await transport.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "test", version: "1.0.0" },
		});
		return { transport, fork: await forked(pidPath) };
	}

	it("kills the grandchild the server spawned, not only the server", async () => {
		const { transport, fork } = await connectedTransport("normal");
		expect(running(fork.grandchild)).toBe(true);

		await transport.close();

		expect(await gone(fork.grandchild)).toBe(true);
		expect(await gone(fork.child)).toBe(true);
	});

	it("escalates when the server ignores the polite signal", async () => {
		// A graceful signal with nothing behind it is a teardown that hangs. Both
		// processes swallow SIGTERM here, so only the hard wave can end them — and the
		// wait for it is bounded, which is what `gone` observes.
		const { transport, fork } = await connectedTransport("stubborn");
		expect(running(fork.grandchild)).toBe(true);

		await transport.close();

		expect(await gone(fork.grandchild)).toBe(true);
		expect(await gone(fork.child)).toBe(true);
	});

	it("leaves nothing running when the handshake never completes", async () => {
		// `connectToServer` closes the transport it built when initialize times out. The
		// grandchild exists by then — the fixture forks before it reads a byte — so this
		// is the route that used to leak a process the operator never saw a tool from.
		const pidPath = path.join(dir, "silent.json");

		await expect(connectToServer("silent", config("silent", pidPath))).rejects.toThrow(/timed out/);

		const fork = await forked(pidPath);
		expect(await gone(fork.grandchild)).toBe(true);
		expect(await gone(fork.child)).toBe(true);
	});

	it("leaves nothing running when the server refuses the handshake", async () => {
		// The other failed-handshake route: initialize is ANSWERED, with an error. That
		// rejection is caught inside the connect, not by the connect timeout, so it is a
		// second place the teardown has to run — and a fix applied to one route only is
		// exactly how the class stays open.
		const pidPath = path.join(dir, "reject.json");

		await expect(connectToServer("reject", config("reject", pidPath))).rejects.toThrow(/refuses to initialize/);

		const fork = await forked(pidPath);
		expect(await gone(fork.grandchild)).toBe(true);
		expect(await gone(fork.child)).toBe(true);
	});

	it("does not signal veyyon's own process group to reap a child that shares it", async () => {
		// macOS spawns the server attached, so the child's group id IS this process's, and
		// Windows has no POSIX group at all. Signalling that group would take out whatever
		// else the session is running — the mistake the shell's descendant tracker already
		// made once. Two fences stop it, the JS gate here and the native refusal to signal
		// the caller's own group, and this asserts the outcome rather than which fence
		// held. The observable is a BYSTANDER in the same group, not this runner: inside a
		// container the runner is pid 1, which the kernel will not signal, so a suicide
		// check would pass no matter what the code did.
		// The probe only sleeps, but it is spawned from this repository's own runtime, so it
		// gets a hermetic HOME like every other spawn here rather than the developer's.
		const spawnShared = (): { pid: number; kill: () => void } => {
			const hermetic = hermeticSpawnEnv();
			const proc = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000);"], {
				env: hermetic.env,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			return {
				pid: proc.pid,
				kill: () => {
					proc.kill("SIGKILL");
					hermetic.cleanup();
				},
			};
		};
		const target = spawnShared();
		const bystander = spawnShared();
		try {
			expect(Process.fromPid(target.pid)?.groupId()).not.toBe(target.pid);
			expect(Process.fromPid(bystander.pid)?.groupId()).toBe(Process.fromPid(target.pid)?.groupId() ?? null);

			expect(await processTree.terminateMcpServerTree(target.pid)).toBe(true);

			expect(await gone(target.pid)).toBe(true);
			// Checking the bystander the instant the target dies would pass even while a
			// group signal was in flight, because a signalled process takes a moment to
			// go. `waitForExit` inverts that: false means it was still there at the end of
			// a window long enough for a SIGTERM to have landed and killed it.
			const survivor = Process.fromPid(bystander.pid);
			expect(survivor).not.toBeNull();
			expect(await survivor?.waitForExit({ timeoutMs: processTree.MCP_TREE_GRACE_MS })).toBe(false);
			expect(running(bystander.pid)).toBe(true);
		} finally {
			bystander.kill();
			target.kill();
		}
	});

	it("takes the trees with it when a session disconnects its servers", async () => {
		const pidPath = path.join(dir, "session.json");
		const manager = new MCPManager(dir);
		managers.push(manager);
		const result = await manager.connectServers({ forking: config("normal", pidPath) }, {});
		expect(result.errors.get("forking")).toBeUndefined();
		const fork = await forked(pidPath);
		expect(running(fork.grandchild)).toBe(true);

		await manager.disconnectAll();

		expect(await gone(fork.grandchild)).toBe(true);
		expect(await gone(fork.child)).toBe(true);
	});

	it("closes idempotently, and a second close signals nothing", async () => {
		// "Signals nothing" is not observable from the outside: a dead pid answers a
		// second teardown the same way it answers the first. So the reaper itself is
		// counted. The hazard it guards is real — the OS reuses pids, and a repeat close
		// that still held the number would signal whatever now owns it.
		const reap = spyOn(processTree, "terminateMcpServerTree");
		try {
			const { transport, fork } = await connectedTransport("normal");

			await transport.close();
			await transport.close();
			await transport.close();

			expect(reap.mock.calls.length).toBe(1);
			expect(await gone(fork.grandchild)).toBe(true);
			expect(transport.connected).toBe(false);
		} finally {
			reap.mockRestore();
		}
	});

	it("signals a process group only when the child leads one of its own", () => {
		// The group is what catches a grandchild re-parented to init. It is also veyyon's
		// own group on macOS and Windows, where the child is spawned attached, so both
		// answers are pinned rather than the interesting one alone.
		expect(processTree.leadsOwnProcessGroup(4242, 4242)).toBe(true);
		expect(processTree.leadsOwnProcessGroup(4242, 1)).toBe(false);
		expect(processTree.leadsOwnProcessGroup(4242, null)).toBe(false);
		// The session's own group id is the value that must never be treated as the
		// child's, so the real one is checked against a plausible child pid.
		expect(processTree.leadsOwnProcessGroup(process.pid + 1, process.pid)).toBe(false);
	});
});
