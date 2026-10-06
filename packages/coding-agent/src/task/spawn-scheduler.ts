/**
 * How the spawns of one `task` call run: inline on the parent's turn, as background jobs, or both. Every
 * spawn waits on the spawn semaphore and runs through {@link runSpawn}; this module decides when it
 * starts and how its result reaches the parent.
 */
import type { AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { Usage } from "@veyyon/ai";
import { emptyCost, emptyUsage } from "@veyyon/catalog/models";
import { errorMessage, formatCount, pluralize } from "@veyyon/utils";
import type { ToolSession } from "..";
import type { AsyncJobManager } from "../async";
import { AgentRegistry } from "../registry/agent-registry";
import { classifyAgentOutcome, describeAgentBatch, summarizeAgentBatch } from "./outcome";
import { mapWithConcurrencyLimit, Semaphore } from "./parallel";
import { appendAdvisory } from "./spawn-advisory";
import { agentOutputManagerFor, allocateAgentId, pendingSpawnProgress, runSpawn, type SpawnRequest } from "./spawn-run";
import { treeSpawnSemaphore } from "./spawn-semaphore";
import type { AgentDefinition, AgentProgress, SingleResult, TaskItem, TaskParams, TaskToolDetails } from "./types";

/** One `task` call as the scheduler runs it. */
export interface SpawnCall {
	toolCallId: string;
	params: TaskParams;
	/** The agent a spawn runs when its item names none, from the session's spawn policy. */
	defaultAgent: string;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<TaskToolDetails>;
}

/** A spawn of the call with the agent it resolved to. */
export interface CallSpawn {
	item: TaskItem;
	/** The agent name the item resolved to, which the spawn's progress row reports. */
	agentName: string;
	agent: AgentDefinition;
}

/** How the background half of a call runs. */
export interface BackgroundOptions {
	manager: AsyncJobManager;
	ircEnabled: boolean;
	/** Appended to the result once at least one spawn started. */
	advisory: string | undefined;
}

/** One inline spawn: its item, position in the call, and (for a mixed call) the agent id claimed up front. */
interface InlineSpawnRef {
	item: TaskItem;
	index: number;
	preAllocatedId?: string;
}

/** Inline spawn payloads merged into one result view: joined text plus flattened results, usage and paths. */
interface MergedInlinePayloads {
	contentParts: string[];
	results: SingleResult[];
	usage?: Usage;
	outputPaths?: string[];
	projectAgentsDir: string | null;
	/**
	 * Spawns cancelled before they started, so they have no payload and no `SingleResult` to classify.
	 * Counted separately because the batch summary is built from `results`, and a spawn that never ran is
	 * absent there: without this, cancelling a five-agent fan-out before two of them started reported
	 * "3 of 3 agents completed".
	 */
	cancelledBeforeStart: number;
}

/** A spawn of a background call, with the agent id claimed up front so the immediate result can name it. */
interface ScheduledSpawn {
	agentId: string;
	item: TaskItem;
	index: number;
	/** The agent type declares `blocking: true`, so the spawn runs inline and the parent waits on it. */
	blocking: boolean;
	progress: AgentProgress;
}

/** A background job a spawn started as. */
interface StartedJob {
	agentId: string;
	jobId: string;
}

/** The jobs a call started and the spawns that could not be scheduled, each as `<agent id>: <reason>`. */
interface JobStart {
	started: StartedJob[];
	failures: string[];
}

/**
 * Per-spawn params handed to the executor path: top-level call fields with the item's identity
 * substituted in. Each spawn's `agent` resolves here: the item's own value, else `defaultAgent` from the
 * session spawn policy. `tasks` never reaches a spawn; the shared `context` is passed unchanged. Keys are
 * materialized only when present, because the spawn tells an absent `isolated` from an explicit one. The
 * item's `isolated` (batch form) wins over the top-level flag (flat form).
 */
function spawnParamsFor(params: TaskParams, item: TaskItem, defaultAgent: string): TaskParams {
	const spawn: TaskParams = { agent: item.agent?.trim() || defaultAgent };
	if (item.name !== undefined) spawn.name = item.name;
	if (item.task !== undefined) spawn.task = item.task;
	if (params.context !== undefined) spawn.context = params.context;
	if (item.isolated !== undefined) {
		spawn.isolated = item.isolated;
	} else if ("isolated" in params) {
		spawn.isolated = params.isolated;
	}
	if (item.cwd !== undefined) {
		spawn.cwd = item.cwd;
	} else if (params.cwd !== undefined) {
		spawn.cwd = params.cwd;
	}
	return spawn;
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost = usage.cost ?? emptyCost();

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

/**
 * Merge per-spawn inline payloads into one result view. `index` is each spawn's position in the call, so
 * batch rows keep the call's order; a missing payload (cancelled before start) becomes an explanatory
 * content line.
 */
function mergeInlinePayloads(
	spawns: InlineSpawnRef[],
	payloads: (AgentToolResult<TaskToolDetails> | undefined)[],
): MergedInlinePayloads {
	const results: SingleResult[] = [];
	const contentParts: string[] = [];
	const outputPaths: string[] = [];
	const usageTotals = emptyUsage();
	let hasUsage = false;
	let cancelledBeforeStart = 0;
	let projectAgentsDir: string | null = null;
	for (let position = 0; position < spawns.length; position++) {
		const payload = payloads[position];
		const { item, index } = spawns[position];
		if (!payload) {
			cancelledBeforeStart++;
			contentParts.push(`Task ${item.name?.trim() || `#${index + 1}`}: cancelled before start.`);
			continue;
		}
		projectAgentsDir ??= payload.details?.projectAgentsDir ?? null;
		const text = payload.content.find(part => part.type === "text")?.text;
		if (text) contentParts.push(text);
		for (const result of payload.details?.results ?? []) {
			results.push({ ...result, index });
			if (result.usage) {
				addUsageTotals(usageTotals, result.usage);
				hasUsage = true;
			}
			if (result.outputPath) outputPaths.push(result.outputPath);
		}
	}
	return {
		contentParts,
		results,
		usage: hasUsage ? usageTotals : undefined,
		outputPaths: outputPaths.length > 0 ? outputPaths : undefined,
		projectAgentsDir,
		cancelledBeforeStart,
	};
}

/** An inline batch's headline and whether it failed. A cancelled child is not a failure: see `AgentBatchSummary.isError`. */
interface InlineSummary {
	headline: string | undefined;
	isError: boolean;
}

/**
 * Cancellation and failure are different answers. `mapWithConcurrencyLimit` does not throw on abort: it
 * stops picking up new work and returns partial results, so a five-agent fan-out stopped after three
 * finished has the same shape as one where two agents crashed. The summary keeps them apart, and its
 * headline leads the content so the reader knows up front that more agents were expected.
 */
function summarizeInline(merged: MergedInlinePayloads): InlineSummary {
	const summary = summarizeAgentBatch(merged.results);
	summary.cancelled += merged.cancelledBeforeStart;
	return { headline: describeAgentBatch(summary), isError: summary.isError };
}

/** Copy a finished job's result onto its progress row. Returns whether the spawn failed. */
function settleJobProgress(progress: AgentProgress, result: SingleResult | undefined, startedAt: number): boolean {
	// A missing result means the spawn failed at the tool level (`results: []`) and there is nothing to
	// classify, so it is a failure by construction.
	const outcome = result ? classifyAgentOutcome(result) : undefined;
	const failed = outcome ? outcome.isError : true;
	progress.status = !outcome ? "failed" : outcome.kind === "aborted" ? "aborted" : failed ? "failed" : "completed";
	progress.durationMs = result?.durationMs ?? Math.max(0, Date.now() - startedAt);
	progress.tokens = result?.tokens ?? 0;
	progress.requests = result?.requests ?? 0;
	progress.contextTokens = result?.contextTokens;
	progress.contextWindow = result?.contextWindow;
	progress.cost = result?.usage?.cost.total ?? 0;
	progress.extractedToolData = result?.extractedToolData;
	progress.retryFailure = result?.retryFailure;
	progress.retryState = undefined;
	return failed;
}

/** Settle the inline spawns' progress rows from their merged results, so a job update after the call returns carries final statuses rather than the last snapshot. */
function settleInlineProgress(
	inline: ScheduledSpawn[],
	merged: MergedInlinePayloads,
	payloads: (AgentToolResult<TaskToolDetails> | undefined)[],
): void {
	for (let position = 0; position < inline.length; position++) {
		const spawn = inline[position];
		const result = merged.results.find(r => r.id === spawn.agentId);
		if (!result) {
			spawn.progress.status = payloads[position] ? "failed" : "aborted";
			continue;
		}
		const outcome = classifyAgentOutcome(result);
		spawn.progress.status = outcome.kind === "aborted" ? "aborted" : outcome.isError ? "failed" : "completed";
		spawn.progress.durationMs = result.durationMs;
	}
}

/** What the parent reads once a background agent stops: how to reach it and where its transcript is. */
function followUpHint(agentId: string, aborted: boolean, ircEnabled: boolean): string {
	if (aborted) {
		const status = AgentRegistry.global().get(agentId)?.status;
		if (status === "idle" || status === "parked") {
			const followUp = ircEnabled ? "message it via `irc` to resume; " : "";
			return `\n\n${agentId} was stopped but is still resumable — ${followUp}transcript at history://${agentId}`;
		}
		return `\n\n${agentId} was aborted — transcript at history://${agentId}`;
	}
	const followUp = ircEnabled ? "message it via `irc` to follow up; " : "";
	return `\n\n${agentId} is now idle — ${followUp}transcript at history://${agentId}`;
}

/** How the parent follows the jobs a call started. */
function coordinationHint(started: StartedJob[], ircEnabled: boolean): string {
	if (started.length === 1) {
		return ircEnabled
			? `DM \`${started[0].agentId}\` via \`irc\` to coordinate while it runs; use \`job\` only to inspect (\`list\`), wait (\`poll\`), or cancel a stuck task.`
			: `Use \`job\` to inspect (\`list\`), wait (\`poll\`), or cancel a stuck task.`;
	}
	return ircEnabled
		? `DM these ids via \`irc\` to coordinate while they run; use \`job\` only to inspect (\`list\`), wait (\`poll\`), or cancel a stuck task.`
		: `Use \`job\` to inspect (\`list\`), wait (\`poll\`), or cancel a stuck task by id.`;
}

function jobListing(started: StartedJob[]): string {
	return started.map(({ agentId, jobId }) => `- \`${agentId}\` (job \`${jobId}\`)`).join("\n");
}

function scheduleFailureSummary(failures: string[]): string {
	return failures.length > 0
		? ` Failed to schedule ${formatCount("spawn", failures.length)}: ${failures.join("; ")}.`
		: "";
}

/**
 * The aggregate state of one call's background spawns, which every job's progress update and the call's
 * own result report. The background half reads "running" until every job settles, then "failed" if any
 * spawn failed. Blocking spawns run inline and land in `inline` before the call returns, so a job update
 * after the return still carries them.
 */
class BackgroundBatch {
	readonly spawns: ScheduledSpawn[];
	readonly jobs: ScheduledSpawn[];
	primaryJobId: string;
	inline: MergedInlinePayloads | undefined;
	readonly #startedAt: number;
	#settled = 0;
	#failed = 0;

	constructor(spawns: ScheduledSpawn[], startedAt: number) {
		this.spawns = spawns;
		this.jobs = spawns.filter(spawn => !spawn.blocking);
		this.primaryJobId = this.jobs[0].agentId;
		this.#startedAt = startedAt;
	}

	settle(failed: boolean): void {
		this.#settled += 1;
		if (failed) this.#failed += 1;
	}

	details(): TaskToolDetails {
		const inline = this.inline;
		return {
			projectAgentsDir: inline?.projectAgentsDir ?? null,
			results: inline ? inline.results.slice() : [],
			totalDurationMs: Date.now() - this.#startedAt,
			usage: inline?.usage,
			outputPaths: inline?.outputPaths,
			progress: this.spawns.map(spawn => ({ ...spawn.progress })),
			async: {
				state: this.#settled < this.jobs.length ? "running" : this.#failed > 0 ? "failed" : "completed",
				jobId: this.primaryJobId,
				type: "task", // not-a-tool-name: async job kind
			},
		};
	}
}

/** The result of a call none of whose spawns started. Nothing will arrive later, so it is an error. */
function nothingStarted(failures: string[]): AgentToolResult<TaskToolDetails> {
	return {
		content: [
			{
				type: "text",
				text: `Failed to start background task ${pluralize("job", failures.length)}: ${failures.join("; ")}`, // not-a-tool-name: the English word
			},
		],
		isError: true,
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
	};
}

/** The result of a call whose spawns all run as jobs. Whether each agent succeeds is reported when it yields. */
function reportStartedJobs(
	call: SpawnCall,
	batch: BackgroundBatch,
	start: JobStart,
	ircEnabled: boolean,
): AgentToolResult<TaskToolDetails> {
	const { started, failures } = start;
	const hint = coordinationHint(started, ircEnabled);
	if (batch.spawns.length === 1) {
		const { agentId, jobId } = started[0];
		call.onUpdate?.({
			content: [{ type: "text", text: `Spawned agent \`${agentId}\`...` }],
			details: batch.details(),
		});
		const text = `Spawned agent \`${agentId}\` (job \`${jobId}\`). The result will be delivered when it yields. ${hint}`;
		return { content: [{ type: "text", text }], details: batch.details() };
	}
	const agentLabel = Array.from(new Set(batch.jobs.map(spawn => spawn.progress.agent))).join(", ");
	call.onUpdate?.({
		content: [{ type: "text", text: `Spawned ${started.length} agents...` }],
		details: batch.details(),
	});
	return {
		content: [
			{
				type: "text",
				text: `Spawned ${started.length} background agents using ${agentLabel}.${scheduleFailureSummary(failures)} Each result will be delivered when that agent yields.\n${jobListing(started)}\n${hint}`,
			},
		],
		// A partial spawn is a failure of the call the parent made, even though the survivors still run.
		isError: failures.length > 0,
		details: batch.details(),
	};
}

/**
 * Runs the spawns of a `task` call, each once the spawn semaphore admits it.
 *
 * The semaphore is the session tree's when the session has a budget group, so a concurrency ceiling is
 * not multiplied by the number of agents spawning (`treeSpawnSemaphore`); a session with none (the
 * embedded SDK case) uses this scheduler's own.
 */
export class SpawnScheduler {
	readonly #session: ToolSession;
	#fallbackSemaphore: Semaphore | undefined;
	/**
	 * Reads the `/yolo` bypass live, so `/yolo off` reaches an agent that is already running. A field
	 * rather than an arrow in the spawn body: the child session holds it for as long as the agent is kept
	 * alive, and an arrow there would hold the whole spawn scope, including its progress snapshot and the
	 * tool call's update callback.
	 */
	readonly #parentApprovalBypassed = (): boolean => this.#session.isApprovalBypassed?.() ?? false;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	/**
	 * Run every spawn to completion inline and merge the per-spawn payloads into one result, for a call
	 * with no job manager or whose agent types all declare `blocking: true`.
	 */
	async runInline(call: SpawnCall, items: TaskItem[]): Promise<AgentToolResult<TaskToolDetails>> {
		if (items.length === 1) {
			const params = spawnParamsFor(call.params, items[0], call.defaultAgent);
			const { toolCallId, signal, onUpdate } = call;
			return this.#runAdmitted({ toolCallId, params, signal, onUpdate, index: 0, detached: false });
		}

		const startTime = Date.now();
		const latestProgress = new Map<number, AgentProgress>();
		const onUpdate = call.onUpdate;
		const refs = items.map((item, index) => ({ item, index }));
		const payloads = await this.#runInlineSpawns(
			call,
			refs,
			onUpdate
				? (index, progress) => {
						latestProgress.set(index, { ...progress, index });
						onUpdate({
							content: [{ type: "text", text: `Running ${items.length} agents...` }],
							details: {
								projectAgentsDir: null,
								results: [],
								totalDurationMs: Date.now() - startTime,
								progress: Array.from(latestProgress.entries())
									.sort((a, b) => a[0] - b[0])
									.map(([, progress]) => progress),
							},
						});
					}
				: undefined,
		);

		const merged = mergeInlinePayloads(refs, payloads);
		const { headline, isError } = summarizeInline(merged);
		const contentParts = headline ? [headline, ...merged.contentParts] : merged.contentParts;
		return {
			content: [{ type: "text", text: contentParts.join("\n\n") }],
			// A batch is an error if any child failed: reporting success because most of them worked puts the
			// failures inside successful output, which is where a parent stops reading.
			isError,
			details: {
				projectAgentsDir: merged.projectAgentsDir,
				results: merged.results,
				totalDurationMs: Date.now() - startTime,
				usage: merged.usage,
				outputPaths: merged.outputPaths,
			},
		};
	}

	/**
	 * Start the call's non-blocking spawns as background jobs and run its blocking ones inline. Agent ids
	 * are claimed up front so the immediate result can name every agent.
	 */
	async runInBackground(
		call: SpawnCall,
		spawns: CallSpawn[],
		options: BackgroundOptions,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const callStartedAt = Date.now();
		const batch = new BackgroundBatch(await this.#claimIds(spawns), callStartedAt);
		const start = this.#startJobs(call, batch, options);
		const inline = batch.spawns.filter(spawn => spawn.blocking);
		if (start.started.length === 0 && inline.length === 0) return nothingStarted(start.failures);
		const result =
			inline.length === 0
				? reportStartedJobs(call, batch, start, options.ircEnabled)
				: await this.#runMixed(call, batch, inline, start, options.ircEnabled);
		return appendAdvisory(result, options.advisory);
	}

	#semaphore(): Semaphore {
		const max = this.#session.settings.get("agent.maxConcurrency");
		// Resized on every acquire and release so a mid-session settings change applies to queued work as
		// well as to new spawns.
		const shared = treeSpawnSemaphore(this.#session.getSessionId?.() ?? null, max);
		if (shared) return shared;
		if (this.#fallbackSemaphore) {
			this.#fallbackSemaphore.resize(max);
		} else {
			this.#fallbackSemaphore = new Semaphore(max);
		}
		return this.#fallbackSemaphore;
	}

	#release(): void {
		this.#semaphore().release();
	}

	/** Run one spawn inline once the semaphore admits it, stamping the wait for the launch-timing log. */
	async #runAdmitted(request: Omit<SpawnRequest, "launchTiming">): Promise<AgentToolResult<TaskToolDetails>> {
		const invokedAt = Date.now();
		await this.#semaphore().acquire(request.signal);
		const acquiredAt = Date.now();
		try {
			return await runSpawn(this.#session, this.#parentApprovalBypassed, {
				...request,
				launchTiming: { invokedAt, acquiredAt },
			});
		} finally {
			this.#release();
		}
	}

	/**
	 * Run a set of spawns inline, each once the semaphore admits it. Per-item progress snapshots go to
	 * `onItemProgress` under the item's position in the call. Returns per-spawn payloads in input order;
	 * `undefined` marks a spawn cancelled before it started.
	 */
	async #runInlineSpawns(
		call: SpawnCall,
		spawns: InlineSpawnRef[],
		onItemProgress?: (index: number, progress: AgentProgress) => void,
	): Promise<(AgentToolResult<TaskToolDetails> | undefined)[]> {
		const { results } = await mapWithConcurrencyLimit(
			spawns,
			spawns.length,
			(spawn, _position, workerSignal) =>
				this.#runAdmitted({
					toolCallId: call.toolCallId,
					params: spawnParamsFor(call.params, spawn.item, call.defaultAgent),
					signal: workerSignal,
					onUpdate: onItemProgress
						? update => {
								const progress = update.details?.progress?.[0];
								if (progress) onItemProgress(spawn.index, progress);
							}
						: undefined,
					preAllocatedId: spawn.preAllocatedId,
					index: spawn.index,
					detached: false,
				}),
			call.signal,
		);
		return results;
	}

	async #claimIds(spawns: CallSpawn[]): Promise<ScheduledSpawn[]> {
		const outputManager = agentOutputManagerFor(this.#session);
		const scheduled: ScheduledSpawn[] = [];
		for (let index = 0; index < spawns.length; index++) {
			const { item, agentName, agent } = spawns[index];
			const agentId = await allocateAgentId(outputManager, item.name);
			const assignment = (item.task ?? "").trim();
			scheduled.push({
				agentId,
				item,
				index,
				blocking: agent.blocking === true,
				progress: pendingSpawnProgress(index, agentId, agentName, agent.source, assignment),
			});
		}
		return scheduled;
	}

	#startJobs(call: SpawnCall, batch: BackgroundBatch, options: BackgroundOptions): JobStart {
		const started: StartedJob[] = [];
		const failures: string[] = [];
		for (const spawn of batch.jobs) {
			try {
				const jobId = this.#registerJob(call, spawn, batch, options);
				if (started.length === 0) batch.primaryJobId = jobId;
				started.push({ agentId: spawn.agentId, jobId });
			} catch (error) {
				failures.push(`${spawn.agentId}: ${errorMessage(error)}`);
				spawn.progress.status = "failed";
				batch.settle(true);
			}
		}
		return { started, failures };
	}

	/**
	 * Register the background job that runs one spawn to completion and delivers its yield text. A spawn
	 * that fails or is aborted fails the job; the agent behind it stays reachable.
	 */
	#registerJob(call: SpawnCall, spawn: ScheduledSpawn, batch: BackgroundBatch, options: BackgroundOptions): string {
		const { agentId, progress } = spawn;
		const params = spawnParamsFor(call.params, spawn.item, call.defaultAgent);
		return options.manager.register(
			"task", // not-a-tool-name: async job kind
			agentId,
			async ({ signal, reportProgress, markRunning }) => {
				const startedAt = Date.now();
				const admitted = await this.#semaphore()
					.acquire(signal)
					.then(
						() => true,
						() => false,
					);
				const acquiredAt = Date.now();
				if (!admitted || signal.aborted) {
					// An abort while queued settles the row as well, or the batch reads "running" forever. A
					// permit this job never acquired is never released: that would let a later spawn start past
					// `agent.maxConcurrency`.
					if (admitted) this.#release();
					progress.status = "aborted";
					batch.settle(true);
					throw new Error("Aborted before execution");
				}
				let delivery: { text: string; failed: boolean };
				try {
					markRunning();
					progress.status = "running";
					await reportProgress(`Running background task ${agentId}...`);
					const result = await runSpawn(this.#session, this.#parentApprovalBypassed, {
						toolCallId: call.toolCallId,
						params,
						signal,
						preAllocatedId: agentId,
						index: spawn.index,
						detached: true,
						launchTiming: { invokedAt: startedAt, acquiredAt },
					});
					const single = result.details?.results[0];
					const failed = settleJobProgress(progress, single, startedAt);
					batch.settle(failed);
					await reportProgress(
						failed ? `Background task ${agentId} failed.` : `Background task ${agentId} complete.`,
					);
					const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
					delivery = {
						text: `${finalText}${followUpHint(agentId, single?.aborted === true, options.ircEnabled)}`,
						failed,
					};
				} catch (error) {
					progress.status = "failed";
					progress.durationMs = Math.max(0, Date.now() - startedAt);
					batch.settle(true);
					await reportProgress(`Background task ${agentId} failed.`);
					const hint = AgentRegistry.global().get(agentId) ? followUpHint(agentId, false, options.ircEnabled) : "";
					throw new Error(`${errorMessage(error)}${hint}`);
				} finally {
					this.#release();
				}
				if (delivery.failed) throw new Error(delivery.text);
				return delivery.text;
			},
			{
				id: agentId,
				agentId,
				queued: true,
				ownerId: this.#session.getAgentId?.() ?? undefined,
				toolCallId: call.toolCallId,
				onProgress: text => {
					call.onUpdate?.({ content: [{ type: "text", text }], details: batch.details() });
				},
			},
		);
	}

	/**
	 * A mixed call: the jobs already run detached, and the blocking spawns run inline and hold the call's
	 * return, as each agent type declares (`blocking: true`: the parent waits on it).
	 */
	async #runMixed(
		call: SpawnCall,
		batch: BackgroundBatch,
		inline: ScheduledSpawn[],
		start: JobStart,
		ircEnabled: boolean,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const { started, failures } = start;
		const inlineLabel = inline.map(spawn => `\`${spawn.agentId}\``).join(", ");
		const onUpdate = call.onUpdate;
		onUpdate?.({
			content: [
				{
					type: "text",
					text: `Running ${inlineLabel} inline; ${formatCount("background agent", started.length)} spawned...`,
				},
			],
			details: batch.details(),
		});
		const refs = inline.map(spawn => ({ item: spawn.item, index: spawn.index, preAllocatedId: spawn.agentId }));
		const payloads = await this.#runInlineSpawns(
			call,
			refs,
			onUpdate
				? (index, progress) => {
						const spawn = batch.spawns[index];
						if (spawn) spawn.progress = { ...progress, index };
						onUpdate({
							content: [{ type: "text", text: `Running ${inlineLabel} inline...` }],
							details: batch.details(),
						});
					}
				: undefined,
		);
		const merged = mergeInlinePayloads(refs, payloads);
		batch.inline = merged;
		settleInlineProgress(inline, merged, payloads);

		const failureSummary = scheduleFailureSummary(failures);
		const spawnedSummary =
			started.length > 0
				? `Spawned ${formatCount("background agent", started.length)}.${failureSummary} Each result will be delivered when that agent yields.\n${jobListing(started)}\n${coordinationHint(started, ircEnabled)}`
				: failureSummary.trim();
		const { headline, isError } = summarizeInline(merged);
		const text = [headline ?? "", merged.contentParts.join("\n\n"), spawnedSummary]
			.filter(section => section.trim().length > 0)
			.join("\n\n");
		return {
			content: [{ type: "text", text: text.length > 0 ? text : "No results." }],
			// A mixed call fails if any spawn could not be scheduled or any inline child failed. The detached
			// ones report themselves later.
			isError: failures.length > 0 || isError,
			details: batch.details(),
		};
	}
}
