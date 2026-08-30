import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import { errorMessage, prompt } from "@veyyon/utils";
import { type } from "arktype";
import type { AsyncJob, AsyncJobManager, AsyncJobType } from "../async";
import { toolsPrompts } from "../prompts/tools/rows";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import type { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from "./index";
import { formatDuration, PREVIEW_LIMITS } from "./render-utils";
import { ToolError } from "./tool-errors";

const jobSchema = type({
	"poll?": type("string[]").describe("job ids to wait for; omit to wait on all running jobs"),
	"cancel?": type("string[]").describe("job ids to cancel"),
	"list?": type("boolean").describe("snapshot all jobs"),
});

type JobParams = typeof jobSchema.infer;

const WAIT_DURATION_MS: Record<string, number> = {
	"5s": 5_000,
	"10s": 10_000,
	"30s": 30_000,
	"1m": 60_000,
	"5m": 5 * 60_000,
};

function parseWaitDurationMs(value: string | undefined): number {
	return (value ? WAIT_DURATION_MS[value] : undefined) ?? WAIT_DURATION_MS["30s"];
}

export interface JobSnapshot {
	id: string;
	type: AsyncJobType;
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
	resultText?: string;
	errorText?: string;
}

type CancelStatus = "cancelled" | "not_found" | "already_completed";

interface CancelOutcome {
	id: string;
	status: CancelStatus;
	message: string;
}

/**
 * A live subagent from the AgentRegistry that has no backing job in the
 * AsyncJobManager — e.g. an idle agent woken (or a parked agent revived) via
 * `irc`, or a spawn owned by another agent. Surfaced by `list` and empty-poll
 * snapshots so the job tool's picture matches the UI's running-agent count.
 */
export interface AgentActivitySnapshot {
	id: string;
	parentId?: string;
	/** Latest activity gist recorded by the registry (display-only). */
	activity?: string;
	/** Time since the agent was registered. */
	ageMs: number;
}

export interface JobToolDetails {
	jobs: JobSnapshot[];
	cancelled?: { id: string; status: CancelStatus }[];
	/** Running subagents not represented by a job row in this result. */
	agents?: AgentActivitySnapshot[];
}

/**
 * A poll snapshot where every watched job is still running and nothing was
 * cancelled — pure "still waiting" noise once a newer poll exists. The TUI
 * keeps such a block un-finalized (displaceable) so a follow-up `job` call
 * replaces it instead of stacking another waiting frame in the transcript.
 */
export function isWaitingPollDetails(details: unknown): boolean {
	const d = details as JobToolDetails | undefined;
	if (!d || !Array.isArray(d.jobs) || d.jobs.length === 0) return false;
	if (d.cancelled?.length) return false;
	return d.jobs.every(job => job?.status === "running");
}

export class JobTool implements AgentTool<typeof jobSchema, JobToolDetails> {
	readonly name = "job";
	readonly approval = "read" as const;
	readonly label = "Job";
	readonly summary = "Manage long-running background jobs (async bash/python)";
	readonly description: string;
	readonly parameters = jobSchema;
	readonly strict = true;
	// Only a polling call blocks. A `list` snapshot and a cancel-only call return
	// at once (see `execute`), so an interrupt must not be able to replace their
	// result with a "skipped" placeholder — `list` combined with `poll`/`cancel`
	// raises a ToolError the caller has to see.
	readonly interruptible = (args: Partial<JobParams>): boolean => {
		if (args.list === true) return false;
		return !(Array.isArray(args.cancel) && args.cancel.length > 0 && args.poll === undefined);
	};
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(toolsPrompts["tools/job"].text);
	}

	async execute(
		_toolCallId: string,
		params: JobParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<JobToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<JobToolDetails>> {
		const manager = this.session.asyncJobManager;
		if (!manager) {
			return {
				content: [{ type: "text", text: "Async execution is disabled; no background jobs are available." }],
				details: { jobs: [] },
			};
		}

		// Scope every visible operation to the calling agent. Tests / SDK
		// consumers without an agent id see everything (legacy behavior).
		const ownerId = this.session.getAgentId?.() ?? undefined;
		const ownerFilter = ownerId ? { ownerId } : undefined;

		// `list` is a read-only snapshot mode. Replaces the legacy `jobs://` URL.
		if (params.list) {
			if (params.cancel?.length || params.poll?.length) {
				throw new ToolError("`list` cannot be combined with `poll` or `cancel`.");
			}
			const jobs = manager.getAllJobs(ownerFilter);
			const agents = this.#runningAgentsOutsideJobs();
			return this.#buildResult(manager, jobs, [], agents);
		}

		const cancelIds = params.cancel ?? [];
		const cancelOutcomes: CancelOutcome[] = [];
		for (const id of cancelIds) {
			const existing = manager.getJob(id);
			if (!existing || (ownerId && existing.ownerId !== ownerId)) {
				// Not a job of the caller's, so it may still be a running agent with
				// no job entry: an irc-woken peer, or a spawn whose job row already
				// settled while the agent kept running. Those are exactly the agents
				// that used to be un-killable, and the pair that traps itself in an
				// irc loop is always one of them.
				cancelOutcomes.push(await this.#cancelAgent(id, ownerId));
				continue;
			}
			if (existing.status !== "running") {
				cancelOutcomes.push({
					id,
					status: "already_completed",
					message: `Background job ${id} is already ${existing.status}.`,
				});
				continue;
			}
			const cancelled = manager.cancel(id, ownerFilter);
			cancelOutcomes.push(
				cancelled
					? { id, status: "cancelled", message: `Cancelled background job ${id}.` }
					: { id, status: "already_completed", message: `Background job ${id} is already completed.` },
			);
		}

		const requestedPollIds = params.poll;
		// If only `cancel` was provided (no `poll`), don't wait \u2014 return immediately.
		const shouldPoll = requestedPollIds !== undefined || cancelIds.length === 0;

		if (!shouldPoll) {
			const cancelledJobs = this.#visibleJobs(manager, cancelIds, ownerId);
			return this.#buildResult(manager, cancelledJobs, cancelOutcomes);
		}

		// Resolve which jobs to watch.
		// - If `poll` was passed explicitly, watch exactly those (filtered to existing).
		// - If `poll` was omitted (and so was `cancel`), default to all running jobs.
		const jobsToWatch = requestedPollIds
			? this.#visibleJobs(manager, requestedPollIds, ownerId)
			: manager.getRunningJobs(ownerFilter);

		if (jobsToWatch.length === 0) {
			if (cancelOutcomes.length > 0) {
				const cancelledJobs = this.#visibleJobs(manager, cancelIds, ownerId);
				return this.#buildResult(manager, cancelledJobs, cancelOutcomes);
			}
			// Zero pollable jobs is not necessarily "nothing running": agents
			// woken via irc or owned by another agent run with no job entry.
			// Report them so the snapshot matches the UI's running-agent count
			// (task job ids are agent ids, so a stale poll id often names one).
			const agents = this.#runningAgentsOutsideJobs();
			const lines: string[] = [];
			if (requestedPollIds?.length) {
				lines.push(`No matching jobs found for IDs: ${requestedPollIds.join(", ")}`);
				const registry = this.session.agentRegistry;
				for (const id of requestedPollIds) {
					const ref = registry?.get(id);
					if (!ref) continue;
					lines.push(
						ref.status === "running"
							? `- \`${id}\` is a running agent with no job entry — coordinate via \`irc\`; transcript at history://${id}`
							: `- \`${id}\` is a ${ref.status} agent (its job is gone) — transcript at history://${id}`,
					);
				}
			} else {
				lines.push("No running background jobs to wait for.");
			}
			if (agents.length > 0) {
				lines.push("", ...this.#describeAgents(agents));
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { jobs: [], ...(agents.length ? { agents } : {}) },
				// Nothing found / nothing to wait for is noise once consumed —
				// the follow-up call has already corrected course. Running agents
				// are real state the model may act on, so keep those results.
				...(agents.length === 0 ? { useless: true } : {}),
			};
		}

		// If all watched jobs are already done, build immediate result.
		const runningJobs = jobsToWatch.filter(j => j.status === "running");
		if (runningJobs.length === 0) {
			const cancelledJobs = cancelIds.map(id => manager.getJob(id)).filter(j => j != null);
			return this.#buildResult(manager, [...cancelledJobs, ...jobsToWatch], cancelOutcomes);
		}

		// Wait until at least one running job finishes, the wait window elapses,
		// or the call is aborted. With `async.pollWaitDuration` set to `smart`,
		// the window adapts: it starts at the ladder floor and climbs as the agent
		// polls in a tight loop, then resets to the floor once the agent steps
		// away from polling (see AsyncJobManager.nextPollWaitMs). Any fixed value
		// waits that exact duration every time.
		const racePromises: Promise<unknown>[] = runningJobs.map(j => j.promise);
		const pollSetting = this.session.settings.get("async.pollWaitDuration");
		const smartPoll = pollSetting === "smart";
		const waitMs = smartPoll ? manager.nextPollWaitMs(ownerId) : parseWaitDurationMs(pollSetting);
		const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<void>();
		const timeoutHandle = setTimeout(() => timeoutResolve(), waitMs);
		racePromises.push(timeoutPromise);

		const watchedJobIds = runningJobs.map(job => job.id);
		manager.watchJobs(watchedJobIds);

		const cancelledJobs = this.#visibleJobs(manager, cancelIds, ownerId);
		const allTrackedJobs = [...cancelledJobs, ...jobsToWatch];

		const PROGRESS_INTERVAL_MS = 500;
		const emitProgress = () => {
			if (!onUpdate) return;
			const snapshot = this.#snapshotJobs(allTrackedJobs);
			onUpdate({
				content: [{ type: "text", text: "" }],
				details: {
					jobs: snapshot,
					...(cancelOutcomes.length
						? { cancelled: cancelOutcomes.map(({ id, status }) => ({ id, status })) }
						: {}),
				},
			});
		};
		const progressTimer = onUpdate ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		emitProgress();

		try {
			if (signal) {
				const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
				const onAbort = () => abortResolve();
				signal.addEventListener("abort", onAbort, { once: true });
				racePromises.push(abortPromise);
				try {
					await Promise.race(racePromises);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			} else {
				await Promise.race(racePromises);
			}
		} finally {
			clearTimeout(timeoutHandle);
			clearInterval(progressTimer);
			if (smartPoll) {
				// Reset the idle-gap clock: escalate if the agent polls again soon,
				// drop back to the floor once it goes quiet for a while.
				manager.recordPollWaitEnd(ownerId);
			}
		}

		// `#buildResult` acknowledges every settled job it reports, and `unwatchJobs`
		// re-arms the async delivery of anything that settled inside the window and was
		// NOT acknowledged. So the order is the exactly-once contract, in both
		// directions: acknowledge first and the re-arm stays quiet; unwatch first and
		// the operator gets the same subagent report twice. The `finally` is what makes
		// the watch impossible to leak if `#buildResult` ever throws.
		try {
			return this.#buildResult(manager, allTrackedJobs, cancelOutcomes);
		} finally {
			manager.unwatchJobs(watchedJobIds);
		}
	}

	/**
	 * Resolve a list of job ids to job records visible to the calling agent.
	 * Drops missing ids and ids owned by other agents, so cross-agent inspection
	 * via the `job` tool is impossible.
	 */
	#visibleJobs(manager: AsyncJobManager, ids: string[], ownerId: string | undefined): AsyncJob[] {
		const out: AsyncJob[] = [];
		for (const id of ids) {
			const job = manager.getJob(id);
			if (!job) continue;
			if (ownerId && job.ownerId !== ownerId) continue;
			out.push(job);
		}
		return out;
	}

	/**
	 * Kill a running agent that has no job row, when `cancel` names one.
	 *
	 * A spawner could always SEE these agents (`job list` reports them under
	 * "Running Agents") and could never stop them, and the tool said so: it told
	 * the model to coordinate via `irc`. That is fine advice for an agent that is
	 * working and unfine for two agents answering each other forever, which is
	 * the case where the only thing left to do is kill one of them. Now the same
	 * id the listing prints is an id `cancel` accepts.
	 *
	 * Bounded by descent, not by scope. The caller may kill an agent it spawned,
	 * directly or transitively, and nothing else: a child must not be able to
	 * kill its own parent (which would orphan the whole run) or a sibling it does
	 * not own. Scope alone would allow both, because everything in one
	 * conversation shares a scope.
	 */
	async #cancelAgent(id: string, ownerId: string | undefined): Promise<CancelOutcome> {
		const registry = this.session.agentRegistry;
		const ref = registry?.get(id);
		if (!registry || !ref || ref.kind !== "sub") {
			return { id, status: "not_found", message: `Background job not found: ${id}` };
		}
		if (ownerId && !this.#isDescendant(registry, id, ownerId)) {
			return { id, status: "not_found", message: `Background job not found: ${id}` };
		}
		if (ref.status === "aborted") {
			return { id, status: "already_completed", message: `Agent ${id} is already aborted.` };
		}
		try {
			await AgentLifecycleManager.global().terminate(id, `Killed by ${ownerId ?? "the operator"}`);
		} catch (error) {
			// The agent is still there: terminate leaves it registered when the
			// abort fails, so reporting a kill would be a lie the spawner acts on.
			return {
				id,
				status: "not_found",
				message: `Could not kill agent ${id} — it is still running: ${errorMessage(error)}`,
			};
		}
		return {
			id,
			status: "cancelled",
			message: `Killed agent ${id}. Its transcript remains readable at history://${id}.`,
		};
	}

	/** Whether `id` sits anywhere under `ancestorId` in the spawn tree. */
	#isDescendant(registry: AgentRegistry, id: string, ancestorId: string): boolean {
		const seen = new Set<string>();
		let current = registry.get(id)?.parentId;
		// Guarded against a cycle: a corrupted parent chain must not hang the tool.
		while (current && !seen.has(current)) {
			if (current === ancestorId) return true;
			seen.add(current);
			current = registry.get(current)?.parentId;
		}
		return false;
	}

	/**
	 * Running subagents from the registry that are not covered by one of the
	 * caller's running jobs. Agents woken via `irc` (idle wake / park revival)
	 * and spawns owned by another agent run with no AsyncJobManager entry, yet
	 * the UI's agent badge counts them — a snapshot must account for that
	 * activity instead of implying the system is quiet. Existence is already
	 * public via the `irc` roster, so listing ids here leaks nothing new; job
	 * *control* stays owner-scoped.
	 */
	#runningAgentsOutsideJobs(): AgentActivitySnapshot[] {
		const registry = this.session.agentRegistry;
		if (!registry) return [];
		const selfId = this.session.getAgentId?.() ?? undefined;
		// Cover = the caller's RUNNING jobs only. A settled job still sitting in
		// delivery retention must not hide its agent if that agent was re-woken
		// (e.g. via irc) and is running again without a job.
		const covered = new Set<string>();
		const manager = this.session.asyncJobManager;
		if (manager) {
			for (const job of manager.getRunningJobs(selfId ? { ownerId: selfId } : undefined)) {
				covered.add(job.id);
				if (job.agentId) covered.add(job.agentId);
			}
		}
		const now = Date.now();
		const out: AgentActivitySnapshot[] = [];
		// The caller's conversation only, resolved through the same registry owner
		// that decides what `irc list` shows. The comment above is right that
		// existence is already public via the `irc` roster, but that roster is
		// scoped and this list was not, so this was the one surface that named
		// agents `irc list` deliberately withholds. It then tells the model to
		// "coordinate via irc", which for a foreign id is advice that cannot be
		// followed: the send is refused by scope. Listing an unreachable stranger
		// is worse than listing nothing.
		for (const ref of registry.listInScope(registry.scopeOf(selfId))) {
			if (ref.kind !== "sub" || ref.status !== "running") continue;
			if (ref.id === selfId || covered.has(ref.id)) continue;
			out.push({
				id: ref.id,
				...(ref.parentId ? { parentId: ref.parentId } : {}),
				...(ref.activity ? { activity: ref.activity } : {}),
				ageMs: Math.max(0, now - ref.createdAt),
			});
		}
		return out;
	}

	/** Model-facing lines for the running-agents section shared by `list` and empty-poll results. */
	#describeAgents(agents: AgentActivitySnapshot[]): string[] {
		const lines = [`## Running Agents (${agents.length}) — not job-backed\n`];
		for (const agent of agents) {
			const parent = agent.parentId ? ` (spawned by \`${agent.parentId}\`)` : "";
			const activity = agent.activity ? ` — ${agent.activity}` : "";
			lines.push(`- \`${agent.id}\`${parent} — up ${formatDuration(agent.ageMs)}${activity}`);
		}
		lines.push(
			"",
			"These agents have no job entry. Coordinate via `irc`, read transcripts at `history://<id>`, and kill one you spawned by passing its id to `cancel`.",
		);
		return lines;
	}

	#snapshotJobs(
		jobs: {
			id: string;
			type: AsyncJobType;
			status: string;
			label: string;
			startTime: number;
			resultText?: string;
			errorText?: string;
		}[],
	): JobSnapshot[] {
		const now = Date.now();
		return jobs.map(j => {
			const current = this.session.asyncJobManager?.getJob(j.id);
			const latest = current ?? j;
			return {
				id: latest.id,
				type: latest.type,
				status: latest.status as JobSnapshot["status"],
				label: latest.label,
				durationMs: Math.max(0, now - latest.startTime),
				...(latest.resultText ? { resultText: latest.resultText } : {}),
				...(latest.errorText ? { errorText: latest.errorText } : {}),
			};
		});
	}

	#buildResult(
		manager: AsyncJobManager,
		jobs: {
			id: string;
			type: AsyncJobType;
			status: string;
			label: string;
			startTime: number;
			resultText?: string;
			errorText?: string;
		}[],
		cancelOutcomes: CancelOutcome[],
		agents: AgentActivitySnapshot[] = [],
	): AgentToolResult<JobToolDetails> {
		// Deduplicate by id (cancelled jobs may also appear in the watched set).
		const seen = new Set<string>();
		const uniqueJobs = jobs.filter(j => {
			if (seen.has(j.id)) return false;
			seen.add(j.id);
			return true;
		});
		const jobResults = this.#snapshotJobs(uniqueJobs);

		manager.acknowledgeDeliveries(jobResults.filter(j => j.status !== "running").map(j => j.id));

		const completed = jobResults.filter(j => j.status !== "running");
		const running = jobResults.filter(j => j.status === "running");

		const lines: string[] = [];

		if (cancelOutcomes.length > 0) {
			lines.push(`## Cancelled (${cancelOutcomes.length})\n`);
			for (const o of cancelOutcomes) lines.push(`- ${o.message}`);
			lines.push("");
		}

		if (completed.length > 0) {
			lines.push(`## Completed (${completed.length})\n`);
			for (const j of completed) {
				lines.push(`### ${j.id} [${j.type}] — ${j.status}`);
				lines.push(`Label: ${j.label}`);
				if (j.resultText) {
					lines.push("```", j.resultText, "```");
				}
				if (j.errorText) {
					lines.push(`Error: ${j.errorText}`);
				}
				lines.push("");
			}
		}

		if (running.length > 0) {
			lines.push(`## Still Running (${running.length})\n`);
			for (const j of running) {
				lines.push(`- \`${j.id}\` [${j.type}] — ${j.label} (up ${formatDuration(j.durationMs)})`);
			}
		}

		if (agents.length > 0) {
			if (lines.length > 0) lines.push("");
			lines.push(...this.#describeAgents(agents));
		}

		// A tool result must never be empty text — the model cannot tell "no
		// jobs" from a malfunction (reported exactly that way in QA).
		if (lines.length === 0) {
			lines.push("No background jobs.");
		}

		const details: JobToolDetails = {
			jobs: jobResults,
			...(cancelOutcomes.length ? { cancelled: cancelOutcomes.map(({ id, status }) => ({ id, status })) } : {}),
			...(agents.length ? { agents } : {}),
		};
		return {
			content: [{ type: "text", text: lines.join("\n").trimEnd() }],
			details,
			// A poll where everything is still running carries no new information
			// once a later poll exists — same predicate the TUI uses to displace
			// stale waiting frames.
			...(isWaitingPollDetails(details) ? { useless: true } : {}),
		};
	}
}

export const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;
