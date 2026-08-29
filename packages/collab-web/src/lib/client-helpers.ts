import type {
	AgentSnapshot,
	CollabUiRequest,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	WireAssistantMessage,
	WireSessionEntry,
	WireSessionHeader,
} from "@veyyon/wire";

export type ConnectionPhase = "connecting" | "waiting" | "live" | "reconnecting" | "ended";

export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	startedAt: number;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
	at: number;
}

export interface GuestSnapshot {
	phase: ConnectionPhase;
	endedReason: string | null;
	header: WireSessionHeader | null;
	entries: readonly WireSessionEntry[];
	state: SessionState | null;
	agents: readonly AgentSnapshot[];
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	stream: WireAssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	readOnly: boolean;
	uiRequest: CollabUiRequest | null;
	notices: readonly Notice[];
}

export const MAX_NOTICES = 50;

export type TranscriptResult = { kind: "rows"; text: string; newSize: number } | { kind: "error"; message: string };

export interface PendingTranscript {
	resolve: (result: TranscriptResult | null) => void;
	timer: Timer;
}
