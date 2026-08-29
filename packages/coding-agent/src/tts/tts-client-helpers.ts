import type { TtsLocalModelKey } from "./models";
import type { TtsProgressEvent } from "./tts-protocol";

export interface TtsAudio {
	pcm: Float32Array;
	sampleRate: number;
}

export interface StreamAudioSink {
	push(chunk: TtsAudioChunk): void;
	close(): void;
	fail(error: Error): void;
}

export type PendingRequest =
	| {
			kind: "synthesize";
			modelKey: TtsLocalModelKey;
			resolve: (audio: TtsAudio | null) => void;
			reject: (error: Error) => void;
	  }
	| { kind: "download"; modelKey: TtsLocalModelKey; resolve: (ok: boolean) => void }
	| { kind: "stream"; modelKey: TtsLocalModelKey; channel: StreamAudioSink };

export interface TtsSynthesizeOptions {
	voice?: string;
	signal?: AbortSignal;
}

export interface TtsDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: TtsProgressEvent) => void;
}

export interface TtsStreamOptions {
	voice?: string;
	signal?: AbortSignal;
}

export interface TtsAudioChunk {
	index: number;
	text: string;
	pcm: Float32Array;
	sampleRate: number;
}

export interface TtsStreamHandle {
	push(text: string): void;
	end(): void;
	chunks: AsyncIterableIterator<TtsAudioChunk>;
}
