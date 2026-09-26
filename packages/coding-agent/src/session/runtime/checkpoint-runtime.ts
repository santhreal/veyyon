/**
 * The checkpoint a `checkpoint` call opened, the report a `rewind` call carries back to it, and the
 * rewind that last closed one.
 *
 * This is a session collaborator. It holds the four fields that move together through a checkpoint's
 * life, and never touches the session: the session reports each `checkpoint` and `rewind` result,
 * rewrites the branch when a rewind completes, and asks this collaborator what state it is in.
 *
 * - **Open**: a `checkpoint` call succeeded. The model must call `rewind` before it yields.
 * - **Reported**: a `rewind` call succeeded with a report, which the turn end applies.
 * - **Completed**: the branch was rewound to the checkpoint. A repeat `rewind` call receives the
 *   completed rewind, and the `rewind` result that closed it is not persisted a second time.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import type { ImageContent, TextContent } from "@veyyon/ai";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { TOOL } from "../../tools/core/builtin-names";
import type { CheckpointState, CompletedRewindState } from "../../tools/fs/checkpoint";
import {
	checkpointStartedAtFromEntry,
	completedRewindFromEntry,
	isSuccessfulCheckpointEntry,
} from "../rewind-checkpoint";

/** Every field of a {@link CheckpointRuntime}, taken before a session switch to restore if it fails. */
export interface CheckpointSnapshot {
	readonly state: CheckpointState | undefined;
	readonly pendingReport: string | undefined;
	readonly lastCompleted: CompletedRewindState | undefined;
	readonly rewoundToolResultIds: ReadonlySet<string>;
}

/**
 * The report a successful `rewind` result carries: the structured `details.report`, else its first
 * text part, trimmed. Empty when it carries neither.
 */
function rewindReportOf(details: unknown, content: ReadonlyArray<TextContent | ImageContent> | undefined): string {
	const detailReport =
		details && typeof details === "object" && "report" in details && typeof details.report === "string"
			? details.report.trim()
			: "";
	if (detailReport) return detailReport;
	for (const part of content ?? []) {
		if (part.type === "text") return part.text.trim();
	}
	return "";
}

export class CheckpointRuntime {
	#state: CheckpointState | undefined;
	#pendingReport: string | undefined;
	#lastCompleted: CompletedRewindState | undefined;
	#rewoundToolResultIds = new Set<string>();

	/** The open checkpoint, `undefined` when none is open. */
	get state(): CheckpointState | undefined {
		return this.#state;
	}

	/** The rewind that last closed a checkpoint on this branch. */
	get lastCompleted(): CompletedRewindState | undefined {
		return this.#lastCompleted;
	}

	/** Whether a checkpoint is open and no `rewind` call has reported back to it. */
	get awaitingRewind(): boolean {
		return this.#state !== undefined && !this.#pendingReport;
	}

	/**
	 * Open `state`, or close the open checkpoint with `undefined`. Opening one forgets the last
	 * completed rewind; closing one drops a report that was never applied.
	 */
	set(state: CheckpointState | undefined): void {
		this.#state = state;
		if (state) {
			this.#lastCompleted = undefined;
		} else {
			this.#pendingReport = undefined;
		}
	}

	/** A `checkpoint` call succeeded: open `state` in place of whatever was open or completed. */
	begin(state: CheckpointState): void {
		this.#state = state;
		this.#pendingReport = undefined;
		this.#lastCompleted = undefined;
	}

	/** A `rewind` call succeeded: keep its report for the turn end, when a checkpoint is open. */
	recordRewindResult(details: unknown, content: ReadonlyArray<TextContent | ImageContent> | undefined): void {
		if (!this.#state) return;
		const report = rewindReportOf(details, content);
		if (report.length > 0) this.#pendingReport = report;
	}

	/**
	 * The report to rewind the open checkpoint with, taken: the one a `rewind` result reported, else
	 * the latest successful `rewind` result in `messages`. `undefined` when no checkpoint is open or
	 * no report reached it.
	 */
	takeReport(messages: readonly AgentMessage[]): string | undefined {
		if (!this.#state) return undefined;
		const pending = this.#pendingReport;
		if (pending) {
			this.#pendingReport = undefined;
			return pending;
		}
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message?.role !== "toolResult" || message.toolName !== TOOL.rewind || message.isError) continue;
			const report = rewindReportOf(message.details, message.content);
			return report.length > 0 ? report : undefined;
		}
		return undefined;
	}

	/**
	 * The branch was rewound to the open checkpoint. `completed` is the rewind a repeat call receives,
	 * and each `rewind` result in `activeMessages` is one the session skips persisting.
	 */
	markRewound(completed: CompletedRewindState, activeMessages: readonly AgentMessage[] | undefined): void {
		this.#lastCompleted = completed;
		for (const message of activeMessages ?? []) {
			if (message.role === "toolResult" && message.toolName === TOOL.rewind) {
				this.#rewoundToolResultIds.add(message.toolCallId);
			}
		}
	}

	/** The rewind finished: no checkpoint is open and no report is waiting. */
	finish(): void {
		this.#state = undefined;
		this.#pendingReport = undefined;
	}

	/** Whether `toolCallId` is a `rewind` result the rewind already accounted for; answers once. */
	consumeRewoundResult(toolCallId: string): boolean {
		return this.#rewoundToolResultIds.delete(toolCallId);
	}

	clear(): void {
		this.#state = undefined;
		this.#pendingReport = undefined;
		this.#lastCompleted = undefined;
		this.#rewoundToolResultIds.clear();
	}

	/**
	 * Rebuild from `branch`, for a resume, a reload or a tree move. The latest successful checkpoint
	 * that no rewind closed is reopened, so the next `rewind` call completes it rather than failing
	 * with "No active checkpoint". When a rewind closed the latest one, that rewind is restored, so a
	 * repeat `rewind` call receives the "checkpoint already completed" guidance.
	 */
	rehydrate(branch: Iterable<SessionEntry>): void {
		this.clear();
		let completed: CompletedRewindState | undefined;
		let pending: CheckpointState | undefined;
		let messageCount = 0;
		for (const entry of branch) {
			if (entry.type === "message") messageCount++;
			if (isSuccessfulCheckpointEntry(entry)) {
				completed = undefined;
				pending = {
					checkpointEntryId: entry.id,
					startedAt: checkpointStartedAtFromEntry(entry) ?? entry.timestamp,
					checkpointMessageCount: messageCount,
				};
				continue;
			}
			const completedFromEntry = completedRewindFromEntry(entry);
			if (completedFromEntry) {
				completed = completedFromEntry;
				pending = undefined;
			}
		}
		if (pending) {
			this.#state = pending;
			return;
		}
		this.#lastCompleted = completed;
	}

	snapshot(): CheckpointSnapshot {
		return {
			state: this.#state,
			pendingReport: this.#pendingReport,
			lastCompleted: this.#lastCompleted,
			rewoundToolResultIds: new Set(this.#rewoundToolResultIds),
		};
	}

	restore(snapshot: CheckpointSnapshot): void {
		this.#state = snapshot.state;
		this.#pendingReport = snapshot.pendingReport;
		this.#lastCompleted = snapshot.lastCompleted;
		this.#rewoundToolResultIds = new Set(snapshot.rewoundToolResultIds);
	}
}
