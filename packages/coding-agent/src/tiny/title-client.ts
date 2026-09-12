import { $env, errorMessage, logger } from "@veyyon/utils";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import { settings } from "../config/settings-instance";
import {
	createWorkerSubprocess,
	type RefCountedWorkerHandle,
	refCountedUnavailableWorker,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	type SpawnedSubprocess,
	smokeTestWorker,
	spawnWorkerOrUnavailable,
	workerEnvFromParent,
	wrapRefCountedSubprocess,
} from "../subprocess/worker-client";
import {
	type WorkerDownloadOptions,
	type WorkerDownloadResult,
	WorkerRequestClient,
	type WorkerRoutedOutbound,
} from "../subprocess/worker-request-client";
import { TINY_WORKER_ARG } from "../worker-args";
import { tinyModelDeviceSettingToEnv } from "./device";
import { tinyModelDtypeSettingToEnv } from "./dtype";
import {
	isTinyLocalModelKey,
	isTinyMemoryLocalModelKey,
	isTinyTitleLocalModelKey,
	type TinyLocalModelKey,
	type TinyMemoryLocalModelKey,
	type TinyTitleLocalModelKey,
} from "./models";
import type { TinyTitleWorkerInbound, TinyTitleWorkerOutbound } from "./title-protocol";

type PendingRequest =
	| { kind: "generate"; modelKey: TinyTitleLocalModelKey; resolve: (title: string | null) => void }
	| { kind: "complete"; modelKey: TinyMemoryLocalModelKey; resolve: (text: string | null) => void }
	| { kind: "download"; modelKey: TinyLocalModelKey; resolve: (result: TinyTitleDownloadResult) => void };

type RoutedMessage = WorkerRoutedOutbound<TinyTitleWorkerOutbound, TinyLocalModelKey>;

export type TinyTitleDownloadResult = WorkerDownloadResult;

export type TinyTitleDownloadOptions = WorkerDownloadOptions<TinyLocalModelKey>;

/**
 * Per-request controls for {@link TinyTitleClient.generate}.
 *
 * Carries the optional abort signal and title-system-prompt override used by
 * callers that customize automatic session-title generation.
 */
export interface TinyTitleGenerateOptions {
	signal?: AbortSignal;
	systemPrompt?: string;
}

function normalizeTinyTitleGenerateOptions(
	options: AbortSignal | TinyTitleGenerateOptions | undefined,
): TinyTitleGenerateOptions {
	if (!options) return {};
	if ("aborted" in options && "addEventListener" in options) return { signal: options };
	return options;
}

/**
 * Hidden subcommand on the main CLI that boots the tiny-model worker in the
 * spawned subprocess. Kept in sync with the dispatch in `cli.ts`.
 */

function readTinyModelSetting(path: "providers.tinyModelDevice" | "providers.tinyModelDtype"): string | undefined {
	try {
		const value = settings.get(path);
		return typeof value === "string" ? value : undefined;
	} catch {
		// Settings may be uninitialized (e.g. `veyyon --smoke-test`); fall back to env/default.
		return undefined;
	}
}

/**
 * Decide which tiny device/dtype env vars (`VEYYON_TINY_*`) to overlay onto the worker
 * env. A present env var wins (left untouched); otherwise the mapped persisted
 * setting is used. Returns only the keys to add — never the default sentinel.
 * Pure for testability; see {@link tinyWorkerEnv} for the spawn-time glue.
 * @internal
 */
export function tinyWorkerEnvOverlay(
	env: Record<string, string | undefined>,
	deviceSetting: string | undefined,
	dtypeSetting: string | undefined,
): Record<string, string> {
	const overlay: Record<string, string> = {};
	if (!env.VEYYON_TINY_DEVICE) {
		const device = tinyModelDeviceSettingToEnv(deviceSetting);
		if (device) {
			overlay.VEYYON_TINY_DEVICE = device;
		}
	}
	if (!env.VEYYON_TINY_DTYPE) {
		const dtype = tinyModelDtypeSettingToEnv(dtypeSetting);
		if (dtype) {
			overlay.VEYYON_TINY_DTYPE = dtype;
		}
	}
	return overlay;
}

/**
 * Env handed to the tiny-model subprocess — and reused verbatim by the STT and
 * TTS workers, which share the same device/dtype resolution. The
 * `VEYYON_TINY_DEVICE` / `VEYYON_TINY_DTYPE` env vars win; otherwise the persisted
 * `providers.tinyModelDevice` / `providers.tinyModelDtype` settings are mapped
 * onto those vars so the subprocess's env-based resolution picks them up.
 * Resolved once at spawn (pipelines are cached for the lifetime of the
 * subprocess).
 */
export function tinyWorkerEnv(): Record<string, string> {
	return workerEnvFromParent(
		tinyWorkerEnvOverlay(
			$env,
			readTinyModelSetting("providers.tinyModelDevice"),
			readTinyModelSetting("providers.tinyModelDtype"),
		),
	);
}

/**
 * Spawn the tiny-model worker as a subprocess. Exported for tests and the
 * smoke probe; production callers go through {@link spawnTinyTitleWorker}.
 */
export function createTinyTitleSubprocess(): SpawnedSubprocess<TinyTitleWorkerOutbound> {
	return createWorkerSubprocess<TinyTitleWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(TINY_WORKER_ARG),
		env: tinyWorkerEnv(),
		exitLabel: "tiny model subprocess",
	});
}

function spawnTinyTitleWorker(): RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> {
	return spawnWorkerOrUnavailable(
		() =>
			wrapRefCountedSubprocess<TinyTitleWorkerInbound, TinyTitleWorkerOutbound>(
				createTinyTitleSubprocess(),
				"tiny-title",
			),
		error => refCountedUnavailableWorker<TinyTitleWorkerInbound, TinyTitleWorkerOutbound>(error),
		"Tiny title worker spawn failed; local titles disabled",
	);
}

export class TinyTitleClient extends WorkerRequestClient<
	TinyTitleWorkerInbound,
	RoutedMessage,
	TinyLocalModelKey,
	PendingRequest
> {
	#failedModels = new Set<TinyLocalModelKey>();

	constructor(
		spawnWorker: () => RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> = spawnTinyTitleWorker,
	) {
		super("tiny-title", spawnWorker);
	}

	async generate(modelKey: string, message: string, signal?: AbortSignal): Promise<string | null>;
	async generate(modelKey: string, message: string, options?: TinyTitleGenerateOptions): Promise<string | null>;
	async generate(
		modelKey: string,
		message: string,
		optionsOrSignal?: AbortSignal | TinyTitleGenerateOptions,
	): Promise<string | null> {
		const options = normalizeTinyTitleGenerateOptions(optionsOrSignal);
		if (!isTinyTitleLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted || this.#failedModels.has(modelKey)) return null;

		try {
			return await this.request<string | null>({
				signal: options.signal,
				message: id =>
					options.systemPrompt
						? { type: "generate", id, modelKey, message, systemPrompt: options.systemPrompt }
						: { type: "generate", id, modelKey, message },
				pending: resolve => ({ kind: "generate", modelKey, resolve }),
				onAbort: resolve => resolve(null),
			});
		} catch (error) {
			logger.debug("tiny-title: local generation failed", {
				modelKey,
				error: errorMessage(error),
			});
			return null;
		}
	}

	async complete(
		modelKey: string,
		prompt: string,
		options: { maxTokens?: number; signal?: AbortSignal } = {},
	): Promise<string | null> {
		if (!isTinyMemoryLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted || this.#failedModels.has(modelKey)) return null;

		try {
			return await this.request<string | null>({
				signal: options.signal,
				message: id => ({ type: "complete", id, modelKey, prompt, maxTokens: options.maxTokens }),
				pending: resolve => ({ kind: "complete", modelKey, resolve }),
				onAbort: resolve => resolve(null),
			});
		} catch (error) {
			logger.debug("tiny-model: local completion failed", {
				modelKey,
				error: errorMessage(error),
			});
			return null;
		}
	}

	async downloadModel(modelKey: string, options: TinyTitleDownloadOptions = {}): Promise<TinyTitleDownloadResult> {
		if (!isTinyLocalModelKey(modelKey)) return { ok: false };
		return this.download<TinyTitleDownloadResult>(modelKey, options, {
			message: id => ({ type: "download", id, modelKey }),
			pending: resolve => ({ kind: "download", modelKey, resolve }),
			aborted: { ok: false },
			failed: error => ({ ok: false, error }),
		});
	}

	settlePending(pending: PendingRequest, error: Error | undefined): void {
		if (pending.kind === "download") pending.resolve(error ? { ok: false, error: error.message } : { ok: false });
		else pending.resolve(null);
	}

	handleMessage(message: RoutedMessage): void {
		const pending = this.getPending(message.id);
		if (!pending) return;
		this.deletePending(message.id);
		if (message.type === "title") {
			if (pending.kind === "generate") pending.resolve(message.title);
			return;
		}
		if (message.type === "downloaded") {
			if (pending.kind === "download") pending.resolve({ ok: true });
			return;
		}
		if (message.type === "completion") {
			if (pending.kind === "complete") pending.resolve(message.text);
			return;
		}
		logger.debug("tiny-title: worker returned error", { error: message.error });
		this.#markFailedModel(pending);
		this.failProgress(pending.modelKey);
		if (pending.kind === "download") pending.resolve({ ok: false, error: message.error });
		else pending.resolve(null);
		void this.terminate();
	}

	#markFailedModel(pending: PendingRequest): void {
		if (pending.kind === "generate" || pending.kind === "complete") this.#failedModels.add(pending.modelKey);
	}
}

export const tinyTitleClient = new TinyTitleClient();

/** Alias for the shared tiny-model worker client (titles + memory completions). */
export const tinyModelClient = tinyTitleClient;

export async function shutdownTinyTitleClient(): Promise<void> {
	await tinyTitleClient.terminate();
}

export async function smokeTestTinyTitleWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(
		wrapRefCountedSubprocess<TinyTitleWorkerInbound, TinyTitleWorkerOutbound>(
			createTinyTitleSubprocess(),
			"tiny-title",
		),
		"tiny title worker",
		timeoutMs,
	);
}
