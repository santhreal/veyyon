/**
 * A conversation `/new` left running is disposed once it goes quiet, and its disposal leaves the
 * conversation on screen intact.
 *
 * WHY THIS SUITE EXISTS: `BackgroundSessions` flushed a handed-off session and dropped it without
 * disposing it, because disposing a top-level session also tore down what every other top-level
 * session in the process shares: the global agent lifecycle, the tiny-model and embedding worker
 * subprocesses, and an MCP manager the next session was handed. So the handed-off conversation kept
 * its browser tabs, eval kernels, advisor runtime and registry entry for the life of the process,
 * wrote no `session_exit` record, and its MCP servers were orphaned at exit because the session
 * handed the manager never disconnected it.
 *
 * The class is "one top-level conversation ending changes what another still holds", in both
 * directions: the ending one must release everything it owns, and must release nothing the survivor
 * uses. Every case drives real `createAgentSession` sessions through the real keeper, and observes
 * releases at their boundaries: the transcript, the agent registry, the owner-scoped resource
 * dispatch that browser tabs and eval kernels register with, the MCP manager's `disconnectAll`,
 * and the worker shutdown.
 *
 * Not caught: a real Chromium tab or Python kernel closing (their disposers are reached through
 * `disposeOwnedResources`, which this suite observes, not through the subsystems themselves), and a
 * background job whose completion delivery starts another turn (the delivery prompts a model; the
 * job case here covers only the wait and the stop).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { MCPManager } from "@veyyon/coding-agent/mcp";
import * as embedClient from "@veyyon/coding-agent/memory/mnemopi/embed-client";
import { AgentRegistry, mainAgentIdFor } from "@veyyon/coding-agent/registry/agent-registry";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { QUIESCENCE_RECHECK_MS } from "@veyyon/coding-agent/session/agent-session-types";
import { BackgroundSessions } from "@veyyon/coding-agent/session/background-sessions";
import type { CreateAgentSessionResult } from "@veyyon/coding-agent/session/factory-options";
import { liveTopLevelSessionCount } from "@veyyon/coding-agent/session/top-level-sessions";
import * as titleClient from "@veyyon/coding-agent/tiny/title-client";
import { SESSION_EXIT_CUSTOM_TYPE } from "@veyyon/kernel/session/exit-diagnostics";
import * as ownedResources from "@veyyon/kernel/session/owned-resources";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

const finishedAnswer: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "Done." }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "mock",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

describe("a conversation /new left running", () => {
	const tempDirs: string[] = [];
	const live: AgentSession[] = [];
	let sharedTempDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-background-dispose-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedTempDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedTempDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedTempDir);
	});

	// Which disposal is the last one is a property of the whole process, so a top-level session an
	// earlier suite never disposed makes every "last one" assertion here fail for a reason outside
	// this file. Say so instead.
	beforeEach(() => {
		expect(
			liveTopLevelSessionCount(),
			"an earlier suite left a top-level session undisposed; the last-disposal assertions here cannot hold",
		).toBe(0);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await BackgroundSessions.global().drain(1_000);
		for (const session of live.splice(0)) await session.dispose();
		for (const tempDir of tempDirs.splice(0)) removeSyncWithRetries(tempDir);
		AsyncJobManager.resetForTests();
	});

	async function topLevelSession(options: { enableMCP?: boolean; mcpManager?: MCPManager } = {}) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `veyyon-background-dispose-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const created: CreateAgentSessionResult = await createAgentSession({
			cwd,
			agentDir: path.join(tempDir, "agent"),
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated({ "compaction.enabled": false }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: options.enableMCP ?? false,
			mcpManager: options.mcpManager,
			enableLsp: false,
			hasUI: false,
			modelRegistry: sharedModelRegistry,
		});
		live.push(created.session);
		return created;
	}

	/** Forget `session` in the cleanup list: the keeper disposes it, and a second dispose is a no-op anyway. */
	function handOff(session: AgentSession) {
		live.splice(live.indexOf(session), 1);
		return BackgroundSessions.global().keep(session, 3);
	}

	function registered(session: AgentSession): boolean {
		return AgentRegistry.global().get(mainAgentIdFor(session.sessionManager.getSessionId())) !== undefined;
	}

	/**
	 * The process-wide releases disposals make from here on, in order: `manager`'s servers disconnecting
	 * and the two worker subprocesses stopping. Each release still runs.
	 */
	function recordReleases(manager: MCPManager, workers: boolean): string[] {
		const log: string[] = [];
		const passThrough = (label: string, release: () => Promise<void>) => async () => {
			log.push(label);
			await release();
		};
		const disconnectAll = manager.disconnectAll.bind(manager);
		vi.spyOn(manager, "disconnectAll").mockImplementation(passThrough("mcp disconnected", disconnectAll));
		if (workers) {
			const { shutdownTinyTitleClient } = titleClient;
			const { shutdownMnemopiEmbedClient } = embedClient;
			vi.spyOn(titleClient, "shutdownTinyTitleClient").mockImplementation(
				passThrough("title worker stopped", shutdownTinyTitleClient),
			);
			vi.spyOn(embedClient, "shutdownMnemopiEmbedClient").mockImplementation(
				passThrough("embed worker stopped", shutdownMnemopiEmbedClient),
			);
		}
		return log;
	}

	it("releases what it holds once it goes quiet, and nothing the conversation on screen uses", async () => {
		const first = await topLevelSession({ enableMCP: true });
		const manager = first.mcpManager;
		if (!manager) throw new Error("a session with MCP enabled creates its manager");
		first.session.sessionManager.appendMessage(finishedAnswer);
		const next = await topLevelSession({ mcpManager: manager });

		const released = vi.spyOn(ownedResources, "disposeOwnedResources");
		const processReleases = recordReleases(manager, true);
		const firstId = first.session.sessionManager.getSessionId();
		const nextId = next.session.sessionManager.getSessionId();

		await handOff(first.session).settled;

		const exit = first.session.sessionManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
		expect(exit?.type === "custom" ? exit.data : undefined).toMatchObject({ reason: "dispose", kind: "normal" });
		expect(registered(first.session)).toBe(false);
		expect(released.mock.calls.filter(([scope]) => scope === "session")).toEqual([["session", firstId]]);
		expect(released.mock.calls.filter(([scope]) => scope === "eval-kernel-owner")).toHaveLength(1);
		expect(BackgroundSessions.global().size).toBe(0);

		// The conversation on screen keeps its registry entry, its resources, the MCP servers it was
		// handed, and the process-wide workers.
		expect(registered(next.session)).toBe(true);
		expect(released.mock.calls.some(([, owner]) => owner === nextId)).toBe(false);
		expect(processReleases).toEqual([]);

		// It is the last one, so its disposal disconnects the servers and stops the workers.
		live.splice(live.indexOf(next.session), 1);
		await next.session.dispose();
		expect(processReleases.toSorted()).toEqual(["embed worker stopped", "mcp disconnected", "title worker stopped"]);
	}, 60_000);

	it("the session that created the manager disconnects it only after every session it handed it to", async () => {
		const creator = await topLevelSession({ enableMCP: true });
		const manager = creator.mcpManager;
		if (!manager) throw new Error("a session with MCP enabled creates its manager");
		const processReleases = recordReleases(manager, false);
		const first = await topLevelSession({ mcpManager: manager });
		const next = await topLevelSession({ mcpManager: manager });

		await handOff(first.session).settled;
		live.splice(live.indexOf(next.session), 1);
		await next.session.dispose();
		expect(processReleases).toEqual([]);

		live.splice(live.indexOf(creator.session), 1);
		await creator.session.dispose();
		expect(processReleases).toEqual(["mcp disconnected"]);
	}, 60_000);

	it("a manager the caller built is disconnected by no session", async () => {
		const manager = new MCPManager(sharedTempDir);
		const processReleases = recordReleases(manager, false);
		const first = await topLevelSession({ mcpManager: manager });
		const next = await topLevelSession({ mcpManager: manager });

		await handOff(first.session).settled;
		live.splice(live.indexOf(next.session), 1);
		await next.session.dispose();
		expect(processReleases).toEqual([]);
	}, 60_000);

	it("ends the agents it spawned and none of the conversation on screen", async () => {
		const first = await topLevelSession();
		const next = await topLevelSession();
		const disposed: string[] = [];
		const spawn = (id: string, parent: AgentSession) =>
			AgentRegistry.global().register({
				id,
				displayName: id,
				kind: "sub",
				parentId: mainAgentIdFor(parent.sessionManager.getSessionId()),
				status: "idle",
				session: {
					abort: async () => {},
					dispose: async () => void disposed.push(id),
				} as unknown as AgentSession,
			});
		spawn("0-FirstWorker", first.session);
		spawn("0-NextWorker", next.session);

		await handOff(first.session).settled;

		expect(disposed).toEqual(["0-FirstWorker"]);
		expect(AgentRegistry.global().get("0-FirstWorker")).toBeUndefined();
		expect(AgentRegistry.global().get("0-NextWorker")?.status).toBe("idle");
		AgentRegistry.global().unregister("0-NextWorker");
	}, 60_000);

	it("stays registered while a background job it owns runs, and a stop cancels the job", async () => {
		const first = await topLevelSession();
		await topLevelSession();
		const manager = AsyncJobManager.instance();
		if (!manager) throw new Error("the first top-level session installs the process manager");
		const aborted = Promise.withResolvers<void>();
		const jobId = manager.register(
			"bash",
			"a job that runs until cancelled",
			({ signal }) => {
				const { promise, reject } = Promise.withResolvers<string>();
				signal.addEventListener("abort", () => {
					aborted.resolve();
					reject(new Error("cancelled"));
				});
				return promise;
			},
			{ ownerId: mainAgentIdFor(first.session.sessionManager.getSessionId()) },
		);
		// Held here: the manager's disposal empties its table.
		const job = manager.getJob(jobId);

		const kept = handOff(first.session);
		// Longer than one re-check, so a wait that ignored the job would have settled by now.
		const outcome = await Promise.race([
			kept.settled.then(() => "settled" as const),
			delay(QUIESCENCE_RECHECK_MS + 250).then(() => "still running" as const),
		]);
		expect(outcome).toBe("still running");
		expect(BackgroundSessions.global().size).toBe(1);
		expect(registered(first.session)).toBe(true);

		expect(await BackgroundSessions.global().cancel(kept.sessionId, "stopped by the test")).toBe(true);
		await aborted.promise;
		expect(job?.status).toBe("cancelled");
		expect(registered(first.session)).toBe(false);
		expect(BackgroundSessions.global().size).toBe(0);
	}, 60_000);
});
