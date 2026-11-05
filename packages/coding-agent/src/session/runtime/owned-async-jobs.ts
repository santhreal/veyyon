/**
 * The background jobs a session owns: their delivery to the conversation, the snapshot a status
 * view reads, their cancellation, and the wake they hold over a settle.
 *
 * This is a session collaborator. It holds the job manager the session runs its jobs on and the
 * agent id that scopes the session's view of it, and reaches the session only through
 * {@link OwnedAsyncJobsHost}. Every read is scoped to this agent's jobs: a secondary top-level
 * session, which has no manager, reads nothing, and a spawned agent that runs on its spawner's
 * manager reads only its own.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import type { ToolResultMessage } from "@veyyon/ai";
import type { AsyncJob, AsyncJobFilter, AsyncJobManager } from "../../async";
import { AgentRegistry } from "../../registry/agent-registry";
import {
	type AgentSessionEventListener,
	type AsyncJobSnapshot,
	type AsyncJobSnapshotItem,
	type AsyncResultEntry,
	QUIESCENCE_RECHECK_MS,
} from "../agent-session-types";

/** What {@link OwnedAsyncJobs} needs from the session that holds it. */
export interface OwnedAsyncJobsHost {
	/** The conversation's messages, searched for the call a late result answers. */
	messages(): readonly AgentMessage[];
	/** Append `message` to the conversation, persist it and emit its start and end events. */
	appendLateToolResult(message: ToolResultMessage): void;
	/** Queue a finished job's result as the async-result follow-up, which wakes the loop. */
	enqueueAsyncResult(entry: AsyncResultEntry): void;
	/** Call `listener` on each session event until the returned function is called. */
	subscribe(listener: AgentSessionEventListener): () => void;
	/** Run `run` with agent-initiated turns allowed for a client that defers them. */
	allowingAgentInitiatedTurns<T>(run: () => Promise<T>): Promise<T>;
}

export class OwnedAsyncJobs {
	readonly #host: OwnedAsyncJobsHost;
	readonly #manager: AsyncJobManager | undefined;
	readonly #agentId: string | undefined;
	readonly #ownerFilter: AsyncJobFilter | undefined;

	/**
	 * `manager` is the one the session runs its jobs on, which is not always the one it owns: a
	 * spawned agent runs on its spawner's manager under its own `agentId`, and a secondary top-level
	 * session has none, so it never reads the primary's jobs.
	 */
	constructor(host: OwnedAsyncJobsHost, manager: AsyncJobManager | undefined, agentId: string | undefined) {
		this.#host = host;
		this.#manager = manager;
		this.#agentId = agentId;
		this.#ownerFilter = agentId ? { ownerId: agentId } : undefined;
	}

	get manager(): AsyncJobManager | undefined {
		return this.#manager;
	}

	/**
	 * Deliver a finished job's result to the conversation.
	 *
	 * When the job names the tool call that started it and that call is still pending in the
	 * current context (its `toolCall` block has no `toolResult` because a continuation, abort or
	 * crash split the pair), the result attaches to the original call and no model turn is
	 * enqueued: the loop does not need to reason over an arrival the transcript can record. When
	 * the call is answered already, or no longer present (the session branched away from it), the
	 * result takes the async-result follow-up, which re-wakes the loop; a request that then replays
	 * the unanswered call keeps the provider-side orphan-placeholder repair.
	 */
	deliver(jobId: string, text: string, job?: AsyncJob): "attached" | "queued" {
		const toolCallId = job?.toolCallId;
		if (toolCallId && this.#attachLateToolResult(toolCallId, text, job)) return "attached";
		this.#host.enqueueAsyncResult({
			jobId,
			result: text,
			job,
			durationMs: job ? Math.max(0, Date.now() - job.startTime) : undefined,
		});
		return "queued";
	}

	/**
	 * Append a `toolResult` for a call the current context left unanswered. False, and the caller
	 * falls back to the follow-up, when the call is not in the message list at all (branched away,
	 * compacted out) or already has its result.
	 */
	#attachLateToolResult(toolCallId: string, text: string, job: AsyncJob | undefined): boolean {
		const messages = this.#host.messages();
		let callIndex = -1;
		let toolName: string | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			const block = message.content.find(part => part.type === "toolCall" && part.id === toolCallId);
			if (block && block.type === "toolCall") {
				callIndex = i;
				toolName = block.name;
				break;
			}
		}
		if (callIndex < 0) return false;
		for (let i = callIndex + 1; i < messages.length; i++) {
			const message = messages[i];
			if (message.role === "toolResult" && message.toolCallId === toolCallId) return false;
		}
		this.#host.appendLateToolResult({
			role: "toolResult",
			toolCallId,
			toolName: toolName ?? job?.type ?? "tool",
			content: [{ type: "text", text }],
			details: job
				? { async: { state: job.status === "failed" ? "failed" : "completed", jobId: job.id } }
				: undefined,
			isError: job?.status === "failed",
			timestamp: Date.now(),
		});
		return true;
	}

	/** This agent's running jobs, its `recentLimit` most recent ones, and its delivery state. */
	snapshot(recentLimit = 5): AsyncJobSnapshot | null {
		const manager = this.#manager;
		if (!manager) return null;
		const summary = (job: AsyncJob): AsyncJobSnapshotItem => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		});
		return {
			running: manager.getRunningJobs(this.#ownerFilter).map(summary),
			recent: manager.getRecentJobs(recentLimit, this.#ownerFilter).map(summary),
			delivery: manager.getDeliveryState(this.#ownerFilter),
		};
	}

	/**
	 * Cancel the jobs registered by this agent and by every agent it spawned, as a lifecycle
	 * transition (a new session, a switch, a handoff, dispose) cleans up its own background work.
	 *
	 * DOWN the spawn tree, never up or sideways. A spawned agent serves the agent that spawned it,
	 * so once this session is torn down or moved to a new one, a grandchild's job has no one to
	 * deliver to: it would keep running, keep spending, and report to a session that is gone.
	 * Reaching UP would let a secondary in-process session tear down the primary's work (issue
	 * #1923), which is also why a secondary top-level session, which defaults to `MAIN_AGENT_ID`,
	 * gets no manager to cancel through.
	 *
	 * Does nothing when no manager is reachable or this session has no agent id.
	 */
	cancelOwn(): void {
		const agentId = this.#agentId;
		const manager = this.#manager;
		if (!agentId || !manager) return;
		for (const owner of jobOwnersUnder(agentId)) manager.cancelAll({ ownerId: owner });
	}

	/**
	 * True when a job this agent owns is still running with an unsuppressed delivery, or a finished
	 * job's delivery is still queued or in flight. Either way the async-result follow-up re-wakes
	 * the loop, so a settle observed now is a scheduling pause rather than a terminal stop:
	 * stop-time passes (todo reminder, session_stop hooks) defer to the settle reached once the
	 * session is fully idle. A suppressed delivery (acknowledged, or watched by an in-flight `job`
	 * poll) never wakes the loop, so it does not count. With `endingJobsOnly`, neither does a job
	 * that runs until stopped.
	 */
	hasPendingWake(endingJobsOnly = false): boolean {
		const manager = this.#manager;
		if (!manager) return false;
		return (
			manager
				.getRunningJobs(this.#ownerFilter)
				.some(job => !manager.isDeliverySuppressed(job.id) && (!endingJobsOnly || job.endsOnItsOwn)) ||
			manager.hasPendingDeliveries(this.#ownerFilter)
		);
	}

	/**
	 * Resolve on the first event that can change {@link hasPendingWake}: an owned job settling, a
	 * turn starting, `signal` aborting, or {@link QUIESCENCE_RECHECK_MS} passing.
	 */
	async nextWakeChange(signal: AbortSignal | undefined): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const wake = (): void => resolve();
		const timer = setTimeout(wake, QUIESCENCE_RECHECK_MS);
		const unsubscribe = this.#host.subscribe(event => {
			if (event.type === "agent_start") wake();
		});
		signal?.addEventListener("abort", wake, { once: true });
		for (const job of this.#manager?.getRunningJobs(this.#ownerFilter) ?? []) {
			job.promise.then(wake, wake);
		}
		try {
			await promise;
		} finally {
			clearTimeout(timer);
			unsubscribe();
			signal?.removeEventListener("abort", wake);
		}
	}

	/**
	 * Deliver every queued or in-flight result of this agent's jobs, with agent-initiated turns
	 * allowed while they land. True when the drain finished and moved the delivery state.
	 */
	async drainDeliveries(timeoutMs?: number): Promise<boolean> {
		const manager = this.#manager;
		if (!manager) return false;
		const before = manager.getDeliveryState(this.#ownerFilter);
		if (before.queued === 0 && !before.delivering) return false;
		return this.#host.allowingAgentInitiatedTurns(async () => {
			const drained = await manager.drainDeliveries({ timeoutMs, filter: this.#ownerFilter });
			const after = manager.getDeliveryState(this.#ownerFilter);
			return drained && (before.queued !== after.queued || before.delivering !== after.delivering);
		});
	}
}

/**
 * The agents whose jobs {@link OwnedAsyncJobs.cancelOwn} cancels for `agentId`: the agent and every
 * agent it spawned, directly or transitively.
 */
function jobOwnersUnder(agentId: string): string[] {
	return [agentId, ...AgentRegistry.global().descendantsOf(agentId)];
}

/**
 * True while a job the teardown of `agentId`'s session would cancel is still running on `manager`:
 * one registered by the agent or by an agent it spawned.
 */
export function hasRunningJobsUnder(manager: AsyncJobManager, agentId: string): boolean {
	return jobOwnersUnder(agentId).some(owner => manager.getRunningJobs({ ownerId: owner }).length > 0);
}
