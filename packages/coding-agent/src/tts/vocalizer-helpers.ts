import type { SpeakableStream } from "./speakable";
import type { BlockAccumulator } from "./speech-enhancer";
import type { TtsStreamHandle } from "./tts-client";

export const IDLE_FLUSH_MS = 1000;
export const COALESCE_MIN_CHARS = 400;
export const MAX_REWRITES_IN_FLIGHT = 2;

export interface VocalizerPlayer {
	start(sampleRate: number): void;
	write(pcm: Float32Array): void;
	setGain(gain: number): void;
	end(): Promise<void>;
	stop(): void;
}

export interface EnhancedUtterance {
	blocks: BlockAccumulator;
	speakable: SpeakableStream;
	pending: string[];
	pendingChars: number;
	dispatchedFirst: boolean;
	order: Promise<void>;
	handle: TtsStreamHandle | null;
	abort: AbortController;
}
