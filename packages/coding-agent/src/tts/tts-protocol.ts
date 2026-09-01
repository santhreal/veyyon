import type { TtsLocalModelKey } from "./models";

export type TtsProgressStatus = "initiate" | "download" | "progress" | "progress_total" | "done" | "ready" | "error";

export interface TtsProgressFileState {
	loaded: number;
	total: number;
}

export interface TtsProgressEvent {
	modelKey: TtsLocalModelKey;
	status: TtsProgressStatus;
	name?: string;
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
	files?: Record<string, TtsProgressFileState>;
	task?: string;
	model?: string;
}

export type TtsWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "synthesize"; id: string; modelKey: TtsLocalModelKey; text: string; voice?: string }
	| { type: "download"; id: string; modelKey: TtsLocalModelKey }
	// Streaming synthesis: a session is opened with `stream-start`, fed complete speakable segments with `stream-push` (the parent's SpeakableStream does all
	| { type: "stream-start"; id: string; modelKey: TtsLocalModelKey; voice?: string }
	| { type: "stream-push"; id: string; text: string }
	| { type: "stream-end"; id: string }
	| { type: "stream-cancel"; id: string };

export type TtsWorkerOutbound =
	| { type: "pong"; id: string }
	| { type: "audio"; id: string; pcm: Float32Array; sampleRate: number }
	| { type: "downloaded"; id: string }
	| { type: "error"; id: string; error: string }
	| { type: "progress"; id: string; event: TtsProgressEvent }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> }
	// One synthesized segment of a streaming session, in emission order, followed
	// by a single `stream-done` once the input stream is closed and drained.
	| { type: "audio-chunk"; id: string; index: number; text: string; pcm: Float32Array; sampleRate: number }
	| { type: "stream-done"; id: string };

/** Wire transport between the parent (`TtsClient`) and the local TTS subprocess. The parent owns the subprocess lifecycle (graceful work, hard SIGKILL on */
export interface TtsTransport {
	send(message: TtsWorkerOutbound): void;
	/** Send and resolve once the message has drained into the IPC channel. Streaming synthesis awaits this per audio chunk: ONNX inference blocks */
	sendAndFlush(message: TtsWorkerOutbound): Promise<void>;
	onMessage(handler: (message: TtsWorkerInbound) => void): () => void;
}
