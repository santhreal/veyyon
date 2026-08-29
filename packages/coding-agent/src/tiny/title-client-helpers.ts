import { $env } from "@veyyon/utils/env";
import { settings } from "../config/settings-instance";
import {
	createWorkerSubprocess,
	type RefCountedWorkerHandle,
	refCountedUnavailableWorker,
	resolveWorkerSpawnCmd,
	type SpawnedSubprocess,
	spawnWorkerOrUnavailable,
	workerEnvFromParent,
	wrapRefCountedSubprocess,
} from "../subprocess/worker-client";
import { TINY_WORKER_ARG } from "../worker-args";
import { tinyModelDeviceSettingToEnv } from "./device";
import { tinyModelDtypeSettingToEnv } from "./dtype";
import type { TinyLocalModelKey, TinyMemoryLocalModelKey, TinyTitleLocalModelKey } from "./models";
import type { TinyTitleProgressEvent, TinyTitleWorkerInbound, TinyTitleWorkerOutbound } from "./title-protocol";

export type PendingRequest =
	| { kind: "generate"; modelKey: TinyTitleLocalModelKey; resolve: (title: string | null) => void }
	| { kind: "complete"; modelKey: TinyMemoryLocalModelKey; resolve: (text: string | null) => void }
	| { kind: "download"; modelKey: TinyLocalModelKey; resolve: (result: TinyTitleDownloadResult) => void };

export interface TinyTitleDownloadResult {
	ok: boolean;
	error?: string;
}

export interface TinyTitleDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: TinyTitleProgressEvent) => void;
}

export interface TinyTitleGenerateOptions {
	signal?: AbortSignal;
	systemPrompt?: string;
}

export function normalizeTinyTitleGenerateOptions(
	options: AbortSignal | TinyTitleGenerateOptions | undefined,
): TinyTitleGenerateOptions {
	if (!options) return {};
	if ("aborted" in options && "addEventListener" in options) return { signal: options };
	return options;
}

function readTinyModelSetting(
	path: "providers.tinyModelDevice" | "providers.tinyModelDtype",
): string | undefined {
	try {
		const value = settings.get(path);
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

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

export function tinyWorkerEnv(): Record<string, string> {
	return workerEnvFromParent(
		tinyWorkerEnvOverlay(
			$env,
			readTinyModelSetting("providers.tinyModelDevice"),
			readTinyModelSetting("providers.tinyModelDtype"),
		),
	);
}

export function createTinyTitleSubprocess(): SpawnedSubprocess<TinyTitleWorkerOutbound> {
	return createWorkerSubprocess<TinyTitleWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(TINY_WORKER_ARG),
		env: tinyWorkerEnv(),
		exitLabel: "tiny model subprocess",
	});
}

export function spawnTinyTitleWorker(): RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> {
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
