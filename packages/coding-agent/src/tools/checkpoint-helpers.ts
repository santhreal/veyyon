import { type } from "arktype";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";

export interface CheckpointState {
	/** Number of in-memory messages at checkpoint (AFTER checkpoint tool result is appended) */
	checkpointMessageCount: number;
	/** Session entry ID at checkpoint (for session tree branching) */
	checkpointEntryId: string | null;
	/** Timestamp */
	startedAt: string;
}

export interface CompletedRewindState {
	/** Report retained after a successful rewind. */
	report: string;
	/** Timestamp for the checkpoint that was rewound. */
	startedAt: string;
	/** Timestamp when the rewind completed. */
	rewoundAt: string;
}

export const checkpointSchema = type({
	goal: type("string").describe("investigation goal"),
});

export type CheckpointParams = typeof checkpointSchema.infer;

export const rewindSchema = type({
	report: type("string").describe("investigation findings"),
});

export type RewindParams = typeof rewindSchema.infer;

export interface CheckpointToolDetails {
	goal: string;
	startedAt: string;
	meta?: OutputMeta;
}

export interface RewindToolDetails {
	report: string;
	rewound: boolean;
	meta?: OutputMeta;
}

export function isTopLevelSession(session: ToolSession): boolean {
	const depth = session.taskDepth;
	return depth === undefined || depth === 0;
}
