/** Compaction error types. */

export class CompactionCancelledError extends Error {
	readonly name = "CompactionCancelledError" as const;

	constructor(message = "Compaction cancelled") {
		super(message);
	}
}

/** Outcome of a compaction attempt, surfaced by `CommandController.executeCompaction` */
export type CompactionOutcome = "ok" | "cancelled" | "failed";
