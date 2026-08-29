import type { BusChannel, CollabUiResponseValue } from "@veyyon/wire";
import type { InteractiveModeContext } from "../modes/types";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task/types";

export const STATE_TRIGGER_EVENTS: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	message_end: true,
	tool_execution_end: true,
	thinking_level_changed: true,
	auto_compaction_end: true,
};

export const STATE_DEBOUNCE_MS = 100;
export const AGENTS_DEBOUNCE_MS = 100;
export const STREAMING_STATE_INTERVAL_MS = 2000;
export const WELCOME_IMAGE_STRIP_THRESHOLD = 24 * 1024 * 1024;
export const COLLAB_BUS_CHANNELS = [
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
] as const satisfies readonly BusChannel[];

export const RELAY_CONNECT_TIMEOUT_MS = 15_000;
export const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024;
export const TRANSCRIPT_ENTRY_TOO_LARGE_ERROR = `transcript entry exceeds transcript fetch cap (${TRANSCRIPT_READ_CAP} bytes)`;
export const SNAPSHOT_CHUNK_BYTES = 512 * 1024;
export type CollabGuestUiResult = { kind: "answered"; value: CollabUiResponseValue } | { kind: "unavailable" };

export type CollabHostContext = Pick<
	InteractiveModeContext,
	| "collabHost"
	| "eventBus"
	| "session"
	| "sessionManager"
	| "settings"
	| "showStatus"
	| "statusLine"
	| "ui"
	| "updatePendingMessagesDisplay"
>;
