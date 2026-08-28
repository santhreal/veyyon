import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTinyModelsCacheDir } from "@veyyon/utils";
import { sttClient } from "./asr-client";
import type { SttProgressStatus } from "./asr-protocol";
import { resolveSttModelSpec } from "./models";

export interface DownloadProgress {
	stage: string;
	percent?: number;
}

export interface SttDownloadProgress {
	status: SttProgressStatus;
	percent: number;
	loaded: number;
	total: number;
	file?: string;
	repo: string;
	label: string;
}

export async function isSttModelCached(key: string): Promise<boolean> {
	const spec = resolveSttModelSpec(key);
	const repoDir = path.join(getTinyModelsCacheDir(), spec.repo);
	if (spec.engine === "sherpa") {
		try {
			const root = new Set(await fs.readdir(repoDir));
			for (const role in spec.files) {
				if (!root.has(spec.files[role as keyof typeof spec.files])) return false;
			}
			return true;
		} catch {
			return false;
		}
	}
	try {
		const root = await fs.readdir(repoDir);
		if (!root.includes("config.json")) return false;
		const onnxFiles = await fs.readdir(path.join(repoDir, "onnx")).catch(() => [] as string[]);
		const hasEncoder = onnxFiles.some(file => file.startsWith("encoder") && file.endsWith(".onnx"));
		const hasDecoder = onnxFiles.some(file => file.startsWith("decoder") && file.endsWith(".onnx"));
		return hasEncoder && hasDecoder;
	} catch {
		return false;
	}
}

export async function downloadSttModel(
	key: string,
	onProgress?: (progress: SttDownloadProgress) => void,
	options?: { signal?: AbortSignal },
): Promise<void> {
	const spec = resolveSttModelSpec(key);
	const files = new Map<string, { loaded: number; total: number }>();
	const result = await sttClient.downloadModel(spec.key, {
		signal: options?.signal,
		onProgress: event => {
			if ((event.status === "progress" || event.status === "progress_total") && event.file) {
				if (typeof event.loaded === "number" && typeof event.total === "number" && event.total > 0) {
					files.set(event.file, { loaded: event.loaded, total: event.total });
				}
			}
			let loaded = 0;
			let total = 0;
			for (const file of files.values()) {
				loaded += file.loaded;
				total += file.total;
			}
			const settled = event.status === "ready" || event.status === "done";
			const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : settled ? 100 : 0;
			onProgress?.({
				status: event.status,
				percent,
				loaded,
				total,
				file: event.file,
				repo: spec.repo,
				label: spec.label,
			});
		},
	});
	if (!result.ok) {
		const detail = result.error ? `: ${result.error}` : ". Check your network connection.";
		throw new Error(`Failed to download speech model (${spec.repo})${detail}`);
	}
	if (!(await isSttModelCached(spec.key))) {
		throw new Error(`Speech model download finished without required files (${spec.repo}).`);
	}
}
