import type { SttModelKey } from "./models";

export type SttProgressStatus = "initiate" | "download" | "progress" | "progress_total" | "done" | "ready" | "error";

export interface SttProgressFileState {
	loaded: number;
	total: number;
}

export interface SttProgressEvent {
	modelKey: SttModelKey;
	status: SttProgressStatus;
	name?: string;
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
	files?: Record<string, SttProgressFileState>;
	task?: string;
	model?: string;
}

export type SttWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "transcribe"; id: string; modelKey: SttModelKey; audio: Float32Array; language?: string }
	| { type: "download"; id: string; modelKey: SttModelKey }
	// ── Live streaming session ── `stream_start` warms the model and opens a session; `stream_audio` feeds
	| { type: "stream_start"; id: string; modelKey: SttModelKey; language?: string }
	| { type: "stream_audio"; id: string; audio: Float32Array }
	| { type: "stream_stop"; id: string }
	| { type: "stream_cancel"; id: string };

export type SttWorkerOutbound =
	| { type: "pong"; id: string }
	| { type: "transcription"; id: string; text: string }
	| { type: "downloaded"; id: string }
	| { type: "error"; id: string; error: string }
	| { type: "progress"; id: string; event: SttProgressEvent }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> }
	// ── Live streaming session ── `partial` is the volatile transcript of the in-progress speech segment
	| { type: "partial"; id: string; text: string }
	| { type: "segment"; id: string; index: number; text: string }
	| { type: "stream_done"; id: string; text: string };

/** Wire transport between the parent (`SttClient`) and the speech-recognition subprocess. The parent owns the subprocess lifecycle (graceful work, hard */
export interface SttTransport {
	send(message: SttWorkerOutbound): void;
	onMessage(handler: (message: SttWorkerInbound) => void): () => void;
}
