import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { CreateAgentSessionOptions } from "@veyyon/coding-agent/session/factory-options";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

describe("AsyncJobManager singleton across concurrent top-level sessions", () => {
	const tempDirs: string[] = [];
	// Building a ModelRegistry per session is the dominant cost here: createAgentSession
	// otherwise runs discoverAuthStorage (a fresh AuthStorage DB create+reload) and a
	// background online model refresh for every spawn (~450ms each). The singleton
	// ownership behavior under test is independent of model resolution, so we hand every
	// session one shared, network-free registry built once (~10ms/session instead).
	let sharedTempDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-async-singleton-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedTempDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedTempDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedTempDir);
	});

	/**
	 * Every test here reasons about who OWNS the process-wide manager, and ownership is decided at
	 * construction: `createAgentSession` builds a manager only when `AsyncJobManager.instance()` is empty,
	 * and clears the singleton on dispose only when it is still the one that session built. So a manager
	 * left installed by an earlier suite silently inverts this whole file: the "primary" session below
	 * constructs nothing, owns nothing, and clears nothing, while `instance()` keeps returning the stranger's
	 * manager. The assertions still read as if they were about ownership, and the last one -- that the
	 * singleton is empty once the owner disposes -- fails for a reason that is nowhere in this file.
	 *
	 * That is exactly how this suite failed: green alone, red inside the full `packages/coding-agent` run,
	 * because `sdk-preloaded-extensions-isolation.test.ts` created a top-level session and never disposed it.
	 * Checking here turns "a neighbour leaked" into a message that says so, instead of a confusing assertion
	 * failure about a manager this file never created.
	 */
	beforeEach(() => {
		expect(
			AsyncJobManager.instance(),
			"an earlier suite left an AsyncJobManager installed; every ownership assertion in this file is meaningless until it disposes its top-level session",
		).toBeUndefined();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
		AsyncJobManager.resetForTests();
	});

	async function spawnTopLevelSession(
		extraSettings?: Record<string, unknown>,
		extraOptions?: Pick<CreateAgentSessionOptions, "asyncJobManager" | "agentId">,
	) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-singleton-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settings: Settings.isolated({ "bash.autoBackground.enabled": true, ...(extraSettings ?? {}) }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry: sharedModelRegistry,
			...extraOptions,
		});
		return session;
	}

	/** Record which session each finished job's result reaches, in the order they arrive. */
	function recordDeliveries(sessions: Record<string, AgentSession>): Array<[string, string]> {
		const delivered: Array<[string, string]> = [];
		for (const [name, session] of Object.entries(sessions)) {
			vi.spyOn(session, "deliverAsyncJobResult").mockImplementation(jobId => {
				delivered.push([name, jobId]);
				return "queued";
			});
		}
		return delivered;
	}

	/** A job that finishes at once, owned by `ownerId`. */
	function finishedJob(manager: AsyncJobManager, ownerId: string): string {
		return manager.register("bash", `owned by ${ownerId}`, async () => "done", { ownerId });
	}

	/** A job that runs until it is cancelled or `release` resolves, owned by `ownerId`. */
	function runningJob(manager: AsyncJobManager, ownerId: string, release: Promise<string>): string {
		return manager.register(
			"bash",
			`held by ${ownerId}`,
			async ({ signal }) => {
				const aborted = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await Promise.race([release, aborted.promise]);
				return signal.aborted ? "aborted" : "completed";
			},
			{ ownerId },
		);
	}

	/**
	 * The terminal opens a conversation beside the first, with `/room new` or a
	 * `/new` that keeps a running turn, and hands it the first conversation's
	 * manager, because the first outlives every other. Before, that conversation
	 * had no manager at all: its `task` refused every background spawn and its
	 * `bash` every async command. The class closed here is a job that runs in the
	 * wrong place or reports to the wrong conversation: a shared manager whose
	 * results all land in the owner, a dispose that cancels the owner's work, and
	 * a sharer keyed so that it could.
	 *
	 * Not caught here: that the terminal hands the manager over (`main.ts`'s
	 * session factory), which no in-process suite constructs.
	 */
	describe("a top-level session handed the owner's manager", () => {
		it("runs async bash under its own id, and the result comes back to it, not to the owner", async () => {
			const primary = await spawnTopLevelSession({ "async.enabled": true });
			try {
				const manager = primary.asyncJobManager!;
				const secondary = await spawnTopLevelSession({ "async.enabled": true }, { asyncJobManager: manager });
				try {
					expect(AsyncJobManager.instance()).toBe(manager);
					const delivered = recordDeliveries({ primary, secondary });
					await secondary.getToolByName("bash")!.execute("call-1", { command: "echo hi", async: true });
					const jobs = manager.getAllJobs({ ownerId: secondary.getAgentId()! });
					expect(jobs).toHaveLength(1);
					await manager.waitForAll();
					await manager.drainDeliveries({ timeoutMs: 5_000 });
					expect(delivered).toEqual([["secondary", jobs[0]!.id]]);
				} finally {
					await secondary.dispose();
				}
				// The sharer never owned it: the owner's manager is still installed.
				expect(AsyncJobManager.instance()).toBe(manager);
			} finally {
				await primary.dispose();
			}
		}, 60000);

		it("delivers each job to the conversation of its owner, a spawn's included, and an orphan's to nobody", async () => {
			const registry = AgentRegistry.global();
			const primary = await spawnTopLevelSession();
			try {
				const manager = primary.asyncJobManager!;
				const secondary = await spawnTopLevelSession({}, { asyncJobManager: manager });
				const spawn = `Scout-${Snowflake.next()}`;
				registry.register({
					id: spawn,
					displayName: "scout",
					kind: "sub",
					parentId: secondary.getAgentId()!,
					session: null,
					status: "running",
				});
				try {
					const delivered = recordDeliveries({ primary, secondary });
					const ofPrimary = finishedJob(manager, primary.getAgentId()!);
					const ofSecondary = finishedJob(manager, secondary.getAgentId()!);
					const ofSpawn = finishedJob(manager, spawn);
					const ofNobody = finishedJob(manager, `gone-${Snowflake.next()}`);
					await manager.waitForAll();
					await manager.drainDeliveries({ timeoutMs: 5_000 });
					const expected: Array<[string, string]> = [
						["primary", ofPrimary],
						["secondary", ofSecondary],
						["secondary", ofSpawn],
					];
					expect(delivered.sort()).toEqual(expected.sort());
					expect(delivered.some(([, jobId]) => jobId === ofNobody)).toBe(false);
				} finally {
					registry.unregister(spawn);
					await secondary.dispose();
				}
			} finally {
				await primary.dispose();
			}
		}, 60000);

		it("stops only its own work when it disposes", async () => {
			const primary = await spawnTopLevelSession();
			try {
				const manager = primary.asyncJobManager!;
				const secondary = await spawnTopLevelSession({}, { asyncJobManager: manager });
				const release = Promise.withResolvers<string>();
				const ofPrimary = runningJob(manager, primary.getAgentId()!, release.promise);
				const ofSecondary = runningJob(manager, secondary.getAgentId()!, release.promise);
				expect(secondary.getAsyncJobSnapshot()?.running.map(job => job.id)).toEqual([ofSecondary]);
				await secondary.dispose();
				expect(manager.getJob(ofSecondary)?.status).toBe("cancelled");
				expect(manager.getJob(ofPrimary)?.status).toBe("running");
				release.resolve("done");
				await manager.waitForAll();
			} finally {
				await primary.dispose();
			}
		}, 60000);

		it("is refused when it would share the owner's manager under the bare alias", async () => {
			const primary = await spawnTopLevelSession();
			try {
				await expect(
					spawnTopLevelSession({}, { asyncJobManager: primary.asyncJobManager!, agentId: MAIN_AGENT_ID }),
				).rejects.toThrow("needs its own agent id");
			} finally {
				await primary.dispose();
			}
		}, 60000);
	});

	it("keeps the primary session's manager installed after a secondary session disposes", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			const secondary = await spawnTopLevelSession();
			try {
				// While the secondary is alive the global instance MUST still point at
				// the primary's manager so background tools keep delivering completions
				// to the primary session that owns them.
				expect(AsyncJobManager.instance()).toBe(primaryManager);
			} finally {
				await secondary.dispose();
			}

			// After the secondary disposes, the primary's manager MUST still be the
			// reachable singleton — otherwise the `task` async path errors with
			// "Async execution is enabled but no async job manager is available".
			expect(AsyncJobManager.instance()).toBe(primaryManager);
		} finally {
			await primary.dispose();
		}

		// Once the owning primary session disposes the singleton clears, matching
		// the documented single-owner invariant.
		expect(AsyncJobManager.instance()).toBeUndefined();
	}, 60000);

	it("does not cancel the primary session's running jobs when a secondary session disposes", async () => {
		const primary = await spawnTopLevelSession();
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();

			// Register a long-running job under the primary's OWN owner id, read
			// from the session rather than typed here: every interactive driver is
			// keyed `main:<sessionId>`, so a literal name matches whichever session
			// happened to claim it and the test would assert nothing once two
			// sessions exist. The secondary's dispose-time `cancelOwnAsyncJobs`
			// must not reach this job (issue #1923).
			const primaryOwner = primary.getAgentId();
			expect(primaryOwner).toBeTruthy();
			const release = Promise.withResolvers<string>();
			const jobId = primaryManager!.register(
				"bash",
				"sleep",
				async ({ signal }) => {
					const aborted = Promise.withResolvers<void>();
					signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					await Promise.race([release.promise, aborted.promise]);
					return signal.aborted ? "aborted" : "completed";
				},
				{ ownerId: primaryOwner ?? undefined },
			);
			expect(primary.getAsyncJobSnapshot()?.running.some(job => job.id === jobId)).toBe(true);

			const secondary = await spawnTopLevelSession();
			try {
				// The reason the isolation holds is structural rather than lucky:
				// two top-level sessions are two conversations and carry two owner
				// ids, so `cancelAll({ ownerId })` cannot reach across them. A
				// build that keys both drivers the same makes the assertion below
				// pass only until one of them cancels.
				expect(secondary.getAgentId()).not.toBe(primaryOwner);
				expect(secondary.getAsyncJobSnapshot()).toBeNull();
			} finally {
				await secondary.dispose();
			}

			const job = primaryManager!.getJob(jobId);
			expect(job?.status).toBe("running");

			release.resolve("done");
			await primaryManager!.waitForAll();
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("refuses async bash from a secondary session instead of routing it to the primary's manager", async () => {
		const primary = await spawnTopLevelSession({ "async.enabled": true });
		try {
			const primaryManager = AsyncJobManager.instance();
			expect(primaryManager).toBeDefined();
			const primaryJobCountBefore = primaryManager!.getAllJobs().length;

			const secondary = await spawnTopLevelSession({ "async.enabled": true });
			try {
				const bashTool = secondary.getToolByName("bash");
				expect(bashTool).toBeDefined();
				await expect(bashTool!.execute("call-1", { command: "echo hi", async: true })).rejects.toThrow(
					/Async job manager unavailable/,
				);
			} finally {
				await secondary.dispose();
			}

			// The secondary's failed async attempt must not have leaked a job into
			// the primary's manager.
			expect(primaryManager!.getAllJobs().length).toBe(primaryJobCountBefore);
		} finally {
			await primary.dispose();
		}
	}, 60000);

	/**
	 * The rule the two paragraphs above depend on, asserted directly instead of inferred from the tests
	 * that happen to exercise it: a top-level session that finds a manager already installed ADOPTS it and
	 * never takes ownership. It must not construct a second manager (nothing would route to it), must not
	 * replace the installed one (background completions would stop reaching the session that owns them,
	 * issue #1923), and must not clear the singleton when it disposes.
	 *
	 * Worth pinning as behavior rather than as suite hygiene, because a real process does hit this: the
	 * agent-creation architect in `agent-dashboard.ts` spins up a second top-level session while the first
	 * is live, and a regression here breaks its `bash`/`task` async paths with nothing in the log.
	 */
	it("adopts an already-installed manager instead of owning it", async () => {
		const stranger = new AsyncJobManager({
			maxRunningJobs: 1,
			// No jobs are registered on it, so completions cannot happen; the callback is required.
			onJobComplete: async () => {},
		});
		AsyncJobManager.setInstance(stranger);
		try {
			const session = await spawnTopLevelSession();

			expect(AsyncJobManager.instance()).toBe(stranger);
			await session.dispose();

			// Still installed: this session never owned it, so disposing it must not take it away.
			expect(AsyncJobManager.instance()).toBe(stranger);
		} finally {
			await stranger.dispose({ timeoutMs: 3_000 });
		}
	}, 60000);

	/**
	 * The process-wide agent lifecycle (park timers, adopted spawned sessions, revivers, the pins that
	 * keep an attached agent live) belongs to the same owner as the manager. A second driving session
	 * disposing it would release the spawned agents of every other conversation in the process:
	 * closing one room peer would park the launch conversation's agents. The owner still tears it
	 * down when it disposes. A pin is the observable: it survives exactly as long as the lifecycle.
	 */
	it("leaves the agent lifecycle to the session that owns the manager", async () => {
		const lifecycle = AgentLifecycleManager.global();
		const agent = "an-agent-a-screen-is-attached-to";
		const primary = await spawnTopLevelSession();
		const unpin = lifecycle.pin(agent);
		try {
			const secondary = await spawnTopLevelSession();
			await secondary.dispose();
			expect(lifecycle.isPinned(agent)).toBe(true);
		} finally {
			await primary.dispose();
		}
		expect(lifecycle.isPinned(agent)).toBe(false);
		unpin();
	}, 60000);

	it("clears a manager installed before a top-level session startup failure takes ownership", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-startup-failure-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				settings: Settings.isolated({ "bash.autoBackground.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry: sharedModelRegistry,
				systemPrompt: () => {
					throw new Error("forced startup failure");
				},
			}),
		).rejects.toThrow("forced startup failure");

		expect(AsyncJobManager.instance()).toBeUndefined();

		const replacement = await spawnTopLevelSession();
		try {
			expect(AsyncJobManager.instance()).toBeDefined();
			expect(replacement.getAsyncJobSnapshot()).not.toBeNull();
		} finally {
			await replacement.dispose();
		}
	}, 60000);
});
