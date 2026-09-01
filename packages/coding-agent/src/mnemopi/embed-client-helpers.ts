import {
	createUnavailableWorker,
	createWorkerHandle,
	createWorkerSubprocess,
	resolveWorkerSpawnCmd,
	type SpawnedSubprocess,
	spawnWorkerOrUnavailable,
	type WorkerHandle,
	workerEnvFromParent,
} from "../subprocess/worker-client";
import { MNEMOPI_EMBED_WORKER_ARG } from "../worker-args";
import type { MnemopiEmbedModelId, MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "./embed-protocol";

export type MnemopiEmbedWorkerHandle = WorkerHandle<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>;

export type PendingRequest =
	| { kind: "init"; model: MnemopiEmbedModelId; resolve: (ok: boolean) => void }
	| { kind: "embed"; model: MnemopiEmbedModelId; resolve: (vectors: number[][] | Error) => void };

export function createMnemopiEmbedSubprocess(): SpawnedSubprocess<MnemopiEmbedWorkerOutbound> {
	return createWorkerSubprocess<MnemopiEmbedWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(MNEMOPI_EMBED_WORKER_ARG),
		env: workerEnvFromParent(),
		exitLabel: "mnemopi embed subprocess",
	});
}

export function wrapSubprocess(spawned: SpawnedSubprocess<MnemopiEmbedWorkerOutbound>): MnemopiEmbedWorkerHandle {
	const { proc } = spawned;
	return createWorkerHandle<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>(spawned, message => {
		proc.send(message);
	});
}

export function spawnMnemopiEmbedWorker(): MnemopiEmbedWorkerHandle {
	return spawnWorkerOrUnavailable(
		() => wrapSubprocess(createMnemopiEmbedSubprocess()),
		createUnavailableWorker<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>,
		"mnemopi embed worker spawn failed; local embeddings disabled",
	);
}

export interface MnemopiSubprocessEmbeddingModel {
	embed(texts: string[], batchSize?: number): AsyncIterable<number[][]>;
}
