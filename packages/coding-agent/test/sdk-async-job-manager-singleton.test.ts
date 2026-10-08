import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
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
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
		AsyncJobManager.resetForTests();
	});

	async function spawnTopLevelSession(extraSettings?: Record<string, unknown>) {
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
		});
		return session;
	}

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
				// The secondary runs jobs on a manager of its own, so the primary's job is not in its view.
				expect(secondary.asyncJobManager).toBeDefined();
				expect(secondary.asyncJobManager).not.toBe(primaryManager);
				expect(secondary.getAsyncJobSnapshot()?.running.some(job => job.id === jobId)).toBe(false);
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

	/**
	 * A top-level session that finds a manager already installed builds its own and leaves the installed
	 * one in place. Replacing it would stop background completions reaching the session that installed it
	 * (issue #1923), and clearing it on dispose would take that session's `bash`/`task` async paths down.
	 * A real process hits this: the agent-creation architect in `agent-dashboard.ts` and the foreground
	 * session after a `/new` handoff are both second top-level sessions.
	 */
	it("runs on a manager of its own and leaves an already-installed manager in place", async () => {
		const stranger = new AsyncJobManager({
			maxRunningJobs: 1,
			// No jobs are registered on it, so completions cannot happen; the callback is required.
			onJobComplete: async () => {},
		});
		AsyncJobManager.setInstance(stranger);
		try {
			const session = await spawnTopLevelSession();

			expect(session.asyncJobManager).toBeDefined();
			expect(session.asyncJobManager).not.toBe(stranger);
			expect(AsyncJobManager.instance()).toBe(stranger);
			await session.dispose();

			// Still installed: this session never owned it, so disposing it must not take it away.
			expect(AsyncJobManager.instance()).toBe(stranger);
		} finally {
			await stranger.dispose({ timeoutMs: 3_000 });
		}
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
