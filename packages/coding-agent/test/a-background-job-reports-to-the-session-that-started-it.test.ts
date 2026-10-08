/**
 * WHY: a background job's result must reach the conversation that started it.
 *
 * The defect: only the first top-level session in a process built an `AsyncJobManager`. A second
 * one (the foreground session after a `/new` handoff, the agent-creation architect) got none, so
 * it could not run background bash, the `job` tool or a daemon exit watch. Adopting the process
 * singleton instead would have been worse: its `onJobComplete` closes over the FIRST session, so
 * the second session's results would land in the first conversation.
 *
 * The class closed here is "a job reports to a session other than the one that started it", over
 * every kind of session that can start one: the first top-level session, a later top-level session
 * built while the first is still running a job, and a spawned agent of that later session. Each
 * starts a real background bash job through its own `bash` tool, and the suite asserts which
 * session's `deliverAsyncJobResult` received it and which session's `job` tool lists it. A job is
 * identified by the `AsyncJob` the delivery carries, not its id: every top-level session's manager
 * numbers from `bg_1`, so the first session's own `bg_1` landing late would otherwise read as the
 * second session's job reaching the first.
 *
 * Not caught: the interactive `/new` controller itself. The later session here is built the way
 * `nextSessionFactory` builds it (a fresh SessionManager through `createAgentSession`) while the
 * first session has a job in flight, not by driving the terminal UI.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { type AsyncJob, AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { CreateAgentSessionOptions } from "@veyyon/coding-agent/session/factory-options";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

describe("a background job reports to the session that started it", () => {
	const tempDirs: string[] = [];
	const sessions: AgentSession[] = [];
	let sharedTempDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "a-job-reports-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedTempDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedTempDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedTempDir);
	});

	beforeEach(() => {
		expect(AsyncJobManager.instance(), "an earlier suite left an AsyncJobManager installed").toBeUndefined();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		// Children first: a spawned agent runs on its parent's manager and must not outlive it.
		for (const session of sessions.splice(0).reverse()) await session.dispose();
		for (const tempDir of tempDirs.splice(0)) removeSyncWithRetries(tempDir);
		AsyncJobManager.resetForTests();
	});

	async function startSession(extra: Partial<CreateAgentSessionOptions> = {}): Promise<AgentSession> {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `a-job-reports-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(tempDir, "agent"),
			sessionManager: SessionManager.create(cwd, path.join(tempDir, "sessions")),
			settings: Settings.isolated({ "async.enabled": true }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry: sharedModelRegistry,
			...extra,
		});
		sessions.push(session);
		return session;
	}

	/** Start `command` (default `echo <marker>`) in the background through the session's own bash tool. */
	async function startBackground(
		session: AgentSession,
		marker: string,
		command = `echo ${marker}`,
	): Promise<AsyncJob> {
		const manager = session.asyncJobManager;
		expect(manager, "a session that cannot run background work cannot report it").toBeDefined();
		const before = new Set(manager!.getAllJobs().map(job => job.id));
		const bash = session.getToolByName("bash");
		expect(bash).toBeDefined();
		await bash!.execute(`call-${marker}`, { command, async: true });
		const started = manager!.getAllJobs().filter(job => !before.has(job.id));
		expect(started).toHaveLength(1);
		return started[0]!;
	}

	/**
	 * Record every job each watched session receives. The returned function resolves once each
	 * named job has been delivered somewhere among the watched sessions, then reports who got what.
	 * A job delivered to an unwatched session never resolves, so the test fails on its timeout.
	 */
	function watchDeliveries(...watched: AgentSession[]): (jobs: AsyncJob[]) => Promise<(AsyncJob | undefined)[][]> {
		const received = watched.map(() => [] as (AsyncJob | undefined)[]);
		const arrivals = new Map<AsyncJob | undefined, PromiseWithResolvers<void>>();
		const arrival = (job: AsyncJob | undefined) => {
			let pending = arrivals.get(job);
			if (!pending) {
				pending = Promise.withResolvers<void>();
				arrivals.set(job, pending);
			}
			return pending;
		};
		watched.forEach((session, index) => {
			const original = session.deliverAsyncJobResult.bind(session);
			vi.spyOn(session, "deliverAsyncJobResult").mockImplementation((jobId, text, job) => {
				received[index]!.push(job);
				arrival(job).resolve();
				return original(jobId, text, job);
			});
		});
		return async jobs => {
			await Promise.all(jobs.map(job => arrival(job).promise));
			return received;
		};
	}

	async function jobToolIds(session: AgentSession): Promise<string[]> {
		const job = session.getToolByName("job");
		expect(job, "the job tool must be registered for a session that runs background work").toBeDefined();
		const result = await job!.execute("list", { list: true });
		return (result.details as { jobs: { id: string }[] }).jobs.map(entry => entry.id);
	}

	/** `delivered` holds exactly `jobs`, in order, compared by identity. */
	function expectDelivered(delivered: (AsyncJob | undefined)[], jobs: AsyncJob[]): void {
		expect(delivered).toHaveLength(jobs.length);
		for (const [index, job] of jobs.entries()) expect(delivered[index]).toBe(job);
	}

	it("delivers a later top-level session's job to that session, not the first", async () => {
		const first = await startSession();
		// The first session has a job in flight when the second is built, as a `/new` handoff leaves it,
		// and that job finishes only after the second session's job has started, so both deliveries
		// land while the watch is installed.
		const release = path.join(tempDirs[0]!, "release-first");
		const firstJob = await startBackground(
			first,
			"first",
			`while [ ! -e '${release}' ]; do sleep 0.05; done; echo first`,
		);
		const second = await startSession();
		const settled = watchDeliveries(first, second);

		const secondJob = await startBackground(second, "second");
		fs.writeFileSync(release, "");
		const [toFirst, toSecond] = await settled([firstJob, secondJob]);

		expectDelivered(toFirst, [firstJob]);
		expectDelivered(toSecond, [secondJob]);
		expect(second.asyncJobManager).not.toBe(first.asyncJobManager);
		expect(await jobToolIds(second)).toEqual([secondJob.id]);
		expect(await jobToolIds(first)).toEqual([firstJob.id]);
	}, 60000);

	it("keeps delivering the first session's job to the first session after a later one exists", async () => {
		const first = await startSession();
		const second = await startSession();
		const settled = watchDeliveries(first, second);

		const firstJob = await startBackground(first, "first");
		const [toFirst, toSecond] = await settled([firstJob]);

		expectDelivered(toFirst, [firstJob]);
		expectDelivered(toSecond, []);
	}, 60000);

	it("delivers a spawned agent's job to the later session that spawned it", async () => {
		const first = await startSession();
		const second = await startSession();
		const childId = `Child-${Snowflake.next()}`;
		const child = await startSession({
			parentTaskPrefix: childId,
			agentId: childId,
			taskDepth: 1,
			asyncJobManager: second.asyncJobManager,
		});
		const settled = watchDeliveries(first, second);

		expect(child.asyncJobManager).toBe(second.asyncJobManager);
		const childJob = await startBackground(child, "child");
		const [toFirst, toSecond] = await settled([childJob]);

		expectDelivered(toSecond, [childJob]);
		expectDelivered(toFirst, []);
	}, 60000);

	it("falls back to the process manager for a spawned agent given no manager", async () => {
		const first = await startSession();
		await startSession();
		const childId = `Child-${Snowflake.next()}`;
		const child = await startSession({ parentTaskPrefix: childId, agentId: childId, taskDepth: 1 });

		expect(AsyncJobManager.instance()).toBe(first.asyncJobManager);
		expect(child.asyncJobManager).toBe(first.asyncJobManager);
	}, 60000);
});
