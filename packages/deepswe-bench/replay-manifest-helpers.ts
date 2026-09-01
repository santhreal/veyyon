import type { COMPARISON_MODEL } from "./system-comparison";

export interface ReplayUserTurn {
	id: string;
	content: string;
}

export interface ReplayManifest {
	schema_version: 1;
	model: typeof COMPARISON_MODEL;
	source_session_id: string;
	source_session_artifacts: string[];
	repository_checkpoint: string;
	repository_checkpoint_sha256: string;
	compaction_checkpoint: {
		/** 1-based turn count: compact immediately after this user turn finishes. */
		after_user_turn: number;
		source_boundary_id: string;
		source_threshold_tokens: number;
		source_context_tokens: number;
	};
	/** Ordered source USER turns only. Assistant/tool messages are never imported. */
	user_turns: ReplayUserTurn[];
	/** Exactly one original-session continuation, withheld from prefix replay. */
	held_out_continuation: ReplayUserTurn;
}

export interface LoadedReplayManifest {
	path: string;
	bytes: Uint8Array;
	sha256: string;
	manifest: ReplayManifest;
}
