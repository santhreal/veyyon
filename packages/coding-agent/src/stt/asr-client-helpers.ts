import {
	createWorkerSubprocess,
	type RefCountedWorkerHandle,
	refCountedUnavailableWorker,
	resolveWorkerSpawnCmd,
	type SpawnedSubprocess,
	spawnWorkerOrUnavailable,
	wrapRefCountedSubprocess,
} from "../subprocess/worker-client";
import { tinyWorkerEnv } from "../tiny/title-client";
import { STT_WORKER_ARG } from "../worker-args";
import type { SttProgressEvent, SttWorkerInbound, SttWorkerOutbound } from "./asr-protocol";
import type { SttModelKey } from "./models";

export type PendingRequest =
	| { kind: "transcribe"; modelKey: SttModelKey; resolve: (text: string) => void; reject: (error: Error) => void }
	| { kind: "download"; modelKey: SttModelKey; resolve: (result: SttDownloadResult) => void };

export interface SttTranscribeOptions {
	language?: string;
	signal?: AbortSignal;
}

export interface SttDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: SttProgressEvent) => void;
}

export interface SttDownloadResult {
	ok: boolean;
	error?: string;
}

export interface SttStreamHandle {
	pushAudio(audio: Float32Array): void;
	stop(): Promise<string>;
	cancel(): void;
}

export interface SttStreamOptions {
	language?: string;
	signal?: AbortSignal;
	onPartial?: (text: string) => void;
	onSegment?: (text: string, index: number) => void;
}

export interface StreamState {
	modelKey: SttModelKey;
	onPartial: ((text: string) => void) | undefined;
	onSegment: ((text: string, index: number) => void) | undefined;
	resolve: (text: string) => void;
	reject: (error: Error) => void;
	finish: (apply: () => void) => void;
}

export function createSttSubprocess(): SpawnedSubprocess<SttWorkerOutbound> {
	return createWorkerSubprocess<SttWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(STT_WORKER_ARG),
		env: tinyWorkerEnv(),
		exitLabel: "stt subprocess",
	});
}

export function spawnSttWorker(): RefCountedWorkerHandle<SttWorkerInbound, SttWorkerOutbound> {
	return spawnWorkerOrUnavailable(
		() => wrapRefCountedSubprocess<SttWorkerInbound, SttWorkerOutbound>(createSttSubprocess(), "stt"),
		error => refCountedUnavailableWorker<SttWorkerInbound, SttWorkerOutbound>(error),
		"stt worker spawn failed; speech-to-text disabled",
	);
}
