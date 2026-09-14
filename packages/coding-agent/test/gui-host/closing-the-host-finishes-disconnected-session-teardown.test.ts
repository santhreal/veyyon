/**
 * WHY: socket closure previously detached session disposal from server closure,
 * allowing fixture removal (or process exit) before the final session rewrite.
 * These real socket/branch/session cases hold an external filesystem operation
 * across connected shutdown, prior disconnect, and extension initialization.
 * Every close caller must wait for durable exit records and closed file handles.
 * GAP: provider streams, arbitrary in-flight actions, and OS process reaping are
 * not exercised; startup and completion waits fail within five seconds.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/discovery/capability/fs";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { getAgentDir } from "@veyyon/utils";
import { withTimeout } from "@veyyon/utils/async";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { AgentSession } from "../../src/session/agent-session";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { snapshotSections, TestSocketClient } from "./test-client";

useIsolatedAgentDir();

describe("closing the host finishes disconnected session teardown", () => {
	let root: string | undefined;
	let server: GuiHostServer | undefined;
	let client: TestSocketClient | undefined;
	let release: (() => void) | undefined;
	let restore: (() => void) | undefined;

	afterEach(async () => {
		release?.();
		client?.destroy();
		try {
			if (server) await withTimeout(server.close(), 5_000, "host teardown did not finish");
		} finally {
			restore?.();
			if (root) await fs.promises.rm(root, { recursive: true, force: true });
			await fs.promises.rm(path.join(getAgentDir(), "extensions"), { recursive: true, force: true });
			clearFsCache();
			root = undefined;
			server = undefined;
			client = undefined;
			release = undefined;
			restore = undefined;
		}
	});

	test("a failed session file close still releases owned transports before rejecting", async () => {
		root = await fs.promises.mkdtemp(path.join(process.cwd(), ".internal-gui-close-"));
		const manager = SessionManager.create(root, path.join(root, "sessions"), new FileSessionStorage());
		await manager.ensureOnDisk();
		manager.appendMessage({ role: "user", content: "persist this prompt", timestamp: 1 });
		await manager.flush();
		const identity = fs.statSync(manager.getSessionFile()!);
		const resource = net.createServer();
		const listening = Promise.withResolvers<void>();
		resource.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const auth = await AuthStorage.create(path.join(root, "auth.db"));
		const entered = Promise.withResolvers<void>();
		const blocked = Promise.withResolvers<void>();
		release = blocked.resolve;
		const session = new AgentSession({
			agent: new Agent(),
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(auth),
			disconnectOwnedMcpManager: async () => {
				entered.resolve();
				await blocked.promise;
				const closed = Promise.withResolvers<void>();
				resource.close(() => closed.resolve());
				await closed.promise;
			},
		});
		const failure = new Error("session file close failed");
		const close = fs.closeSync;
		const heldClose = spyOn(fs, "closeSync").mockImplementation(fd => {
			const actual = fs.fstatSync(fd);
			close(fd);
			if (actual.dev === identity.dev && actual.ino === identity.ino) throw failure;
		});
		restore = () => heldClose.mockRestore();
		let completed = false;
		const disposal = session.dispose().then(
			() => {
				completed = true;
				return undefined;
			},
			error => {
				completed = true;
				return error;
			},
		);
		try {
			await withTimeout(entered.promise, 5_000, "persistence failure skipped owned transport cleanup");
			expect(resource.listening).toBe(true);
			expect(completed).toBe(false);
			blocked.resolve();
			expect(await withTimeout(disposal, 5_000, "failed disposal did not finish")).toBe(failure);
			expect(resource.listening).toBe(false);
		} finally {
			blocked.resolve();
			await disposal;
			heldClose.mockRestore();
			auth.close();
			resource.close();
		}
	}, 15_000);

	for (const transition of ["connected", "disconnected", "initializing"] as const) {
		test(transition, async () => {
			root = await fs.promises.mkdtemp(path.join(process.cwd(), ".internal-gui-close-"));
			const workspace = path.join(root, "workspace");
			const profile = getAgentDir();
			await fs.promises.mkdir(workspace);
			await fs.promises.mkdir(path.join(profile, "extensions"), { recursive: true });
			const storage = new FileSessionStorage();
			const sessionDir = computeDefaultSessionDir(workspace, storage, path.join(profile, "sessions"));
			const manager = SessionManager.create(workspace, sessionDir, storage);
			manager.appendMessage({ role: "user", content: "first prompt", timestamp: 1 });
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "first answer" }],
				api: "openai-chat",
				provider: "openai",
				model: "gpt-4o-mini",
				stopReason: "stop",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 2,
			});
			const entry = manager.appendMessage({ role: "user", content: "second prompt", timestamp: 3 });
			await manager.ensureOnDisk();
			await manager.close();
			let sessionId = manager.getSessionId();
			const startupFile = path.join(root, "startup-resource");
			const shutdownFile = path.join(root, "shutdown-resource");
			await fs.promises.writeFile(
				path.join(profile, "extensions", "lifecycle.ts"),
				`
import * as fs from "node:fs/promises";
export default function(api) {
	api.on("session_start", async (_event, ctx) => {
		const handle = await fs.open(${JSON.stringify(startupFile)}, "w");
		await handle.write("started");
		await handle.close();
		if (${transition === "initializing"}) await ctx.ui.confirm("Continue initialization?", "The client may disconnect", { timeout: 6_000 });
	});
	api.on("session_shutdown", async () => {
		const handle = await fs.open(${JSON.stringify(shutdownFile)}, "w");
		await handle.write("finished");
		await handle.close();
	});
}
`,
			);
			clearFsCache();
			server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: workspace, agentDir: profile });
			client = await TestSocketClient.connect(server.endpoint);
			await client.nextFrame();
			await client.nextFrame();
			const entered = Promise.withResolvers<void>();
			const blocked = Promise.withResolvers<void>();
			const teardownEntered = Promise.withResolvers<void>();
			const teardownBlocked = Promise.withResolvers<void>();
			release = () => {
				blocked.resolve();
				teardownBlocked.resolve();
			};
			const handles: FileHandle[] = [];
			const open = fsPromises.open;
			let armed = transition === "initializing";
			const heldOpen = spyOn(fsPromises, "open").mockImplementation(async (file, flags, mode) => {
				const handle = await open(file, flags, mode);
				if (
					armed &&
					typeof file === "string" &&
					(file === shutdownFile || (transition === "initializing" && file === startupFile))
				) {
					handles.push(handle);
					if (transition === "initializing" && file === shutdownFile) {
						teardownEntered.resolve();
						await teardownBlocked.promise;
					} else {
						entered.resolve();
						await blocked.promise;
					}
				}
				return handle;
			});
			restore = () => heldOpen.mockRestore();
			const branch = { BranchSession: { session: sessionId, entry } };
			if (transition === "initializing") {
				client.send({ id: 1, action: branch });
				await withTimeout(entered.promise, 5_000, "session startup did not reach filesystem boundary");
			} else {
				const result = await client.request(1, branch);
				expect(result.outcome.RequestSucceeded).toBeDefined();
				expect(await fs.promises.readFile(startupFile, "utf8")).toBe("started");
				sessionId = snapshotSections<{ value: { id: string } }>(result.frames, "ActiveSession").at(-1)!.value.id;
				armed = true;
			}
			if (transition !== "connected") client.destroy();
			if (transition === "disconnected") {
				await withTimeout(entered.promise, 5_000, "disconnect did not immediately start disposal");
			}
			const first = server.close();
			const second = server.close();
			const completed: string[] = [];
			void first.then(() => completed.push("first"));
			void second.then(() => completed.push("second"));
			await withTimeout(entered.promise, 5_000, "shutdown did not reach filesystem boundary");
			await withTimeout(client.waitForClose(), 5_000, "socket did not close");
			await delay(20);
			try {
				expect(completed).toEqual([]);
				expect(handles.every(handle => handle.fd >= 0)).toBe(true);
			} finally {
				blocked.resolve();
			}
			if (transition === "initializing") {
				try {
					await withTimeout(teardownEntered.promise, 5_000, "unattached session did not start disposal");
					await delay(20);
					expect(completed).toEqual([]);
				} finally {
					teardownBlocked.resolve();
				}
			}
			await withTimeout(Promise.all([first, second]), 5_000, "concurrent closes did not finish");
			expect(completed).toEqual(["first", "second"]);
			expect(handles.map(handle => handle.fd)).toEqual(handles.map(() => -1));
			expect(await fs.promises.readFile(shutdownFile, "utf8")).toBe("finished");
			const files = (await fs.promises.readdir(sessionDir)).filter(file => file.endsWith(".jsonl"));
			const sessionFile = files.find(file => file.includes(sessionId));
			expect(sessionFile).toBeDefined();
			const records = (await fs.promises.readFile(path.join(sessionDir, sessionFile!), "utf8"))
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(records.filter(record => record.customType === "session_exit").map(record => record.data.kind)).toEqual(
				["normal"],
			);
			if (transition === "initializing") expect(files).toHaveLength(1);
		}, 15_000);
	}
});
