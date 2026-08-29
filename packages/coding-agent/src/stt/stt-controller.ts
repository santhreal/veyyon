import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collapseWhitespace, errorMessage, isAbortError, logger, Snowflake } from "@veyyon/utils";
import { settings } from "../config/settings-instance";
import { type SttStreamHandle, sttClient } from "./asr-client";
import { downloadSttModel, isSttModelCached } from "./downloader";
import { resolveSttModelSpec } from "./models";
import {
	detectRecorder,
	ensureRecorder,
	type RecordingHandle,
	type StreamingRecordingHandle,
	startRecording,
	startStreamingRecording,
	verifyRecordingFile,
} from "./recorder";
import type { Editor, SttState, ToggleOptions } from "./stt-controller-helpers";

export * from "./stt-controller-helpers";

import { evaluateSubmitTrigger } from "./submit-trigger";
import { transcribe } from "./transcriber";

export class STTController {
	#state: SttState = "idle";
	#resolvedModelKey: string | null = null;
	#toggling = false;
	#stopAfterStart = false;
	#disposed = false;

	#recordingHandle: RecordingHandle | null = null;
	#tempFile: string | null = null;
	#transcriptionAbort: AbortController | null = null;

	#stream: SttStreamHandle | null = null;
	#streamRecorder: StreamingRecordingHandle | null = null;
	#streamEditor: Editor | null = null;
	#streamCommitted = false;
	#streamAbort: AbortController | null = null;
	#streamUtterance = "";

	get state(): SttState {
		return this.#state;
	}

	#setState(state: SttState, options: ToggleOptions): void {
		this.#state = state;
		options.onStateChange(state);
	}

	async toggle(editor: Editor, options: ToggleOptions): Promise<void> {
		if (this.#toggling) {
			if (this.#state === "idle" || this.#state === "recording") this.#stopAfterStart = true;
			return;
		}
		this.#toggling = true;
		try {
			switch (this.#state) {
				case "idle":
					await this.#start(editor, options);
					break;
				case "recording":
					await this.#stop(editor, options);
					break;
				case "transcribing":
					options.showStatus("Transcription in progress...");
					break;
			}
			if (this.#stopAfterStart && this.#state === "recording") {
				this.#stopAfterStart = false;
				await this.#stop(editor, options);
			} else if (this.#state !== "recording") {
				this.#stopAfterStart = false;
			}
		} finally {
			this.#toggling = false;
		}
	}

	async #ensureDeps(options: ToggleOptions): Promise<boolean> {
		const modelKey = resolveSttModelSpec(settings.get("stt.modelName") as string | undefined).key;
		if (this.#resolvedModelKey === modelKey) return true;
		try {
			let wroteStatus = false;
			const status = (msg: string): void => {
				wroteStatus = true;
				options.showStatus(msg);
			};
			await ensureRecorder(p => status(p.stage + (p.percent != null ? ` (${p.percent}%)` : "")));
			if (await isSttModelCached(modelKey)) {
				this.#warmModel(modelKey);
			} else {
				await downloadSttModel(modelKey, p => status(`Downloading speech model ${p.label} (${p.percent}%)`));
			}
			if (wroteStatus) options.showStatus("");
			this.#resolvedModelKey = modelKey;
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to setup STT dependencies";
			options.showWarning(msg);
			logger.error("STT dependency setup failed", { error: msg });
			return false;
		}
	}

	#warmModel(modelKey: string): void {
		void downloadSttModel(modelKey).catch(err => {
			if (!this.#disposed && this.#resolvedModelKey === modelKey) this.#resolvedModelKey = null;
			logger.debug("stt: background model warmup failed", {
				error: errorMessage(err),
			});
		});
	}

	async #start(editor: Editor, options: ToggleOptions): Promise<void> {
		if (!(await this.#ensureDeps(options))) return;
		if (this.#recorderCanStream()) {
			await this.#startStreaming(editor, options);
			return;
		}
		await this.#startBatchRecording(options);
	}

	async #stop(editor: Editor, options: ToggleOptions): Promise<void> {
		if (this.#stream) {
			await this.#stopStreaming(options);
			return;
		}
		await this.#stopBatch(editor, options);
	}

	#recorderCanStream(): boolean {
		const recorder = detectRecorder();
		return recorder !== null && recorder.tool !== "powershell";
	}

	#prefixed(text: string): string {
		const normalized = collapseWhitespace(text);
		if (!normalized) return "";
		return this.#streamCommitted ? ` ${normalized}` : normalized;
	}

	async #startStreaming(editor: Editor, options: ToggleOptions): Promise<void> {
		const modelKey = resolveSttModelSpec(settings.get("stt.modelName") as string | undefined).key;
		const language = settings.get("stt.language") as string | undefined;
		this.#streamEditor = editor;
		this.#streamCommitted = false;
		this.#streamUtterance = "";
		this.#streamAbort = new AbortController();
		const stream = sttClient.startStream(modelKey, {
			language: language || undefined,
			signal: this.#streamAbort.signal,
			onPartial: text => {
				if (this.#disposed || this.#state !== "recording") return;
				this.#streamEditor?.setVolatileText(this.#prefixed(text));
				options.requestRender?.();
			},
			onSegment: text => {
				if (this.#disposed) return;
				const prefixed = this.#prefixed(text);
				if (prefixed) {
					this.#streamEditor?.commitVolatileText(prefixed);
					this.#streamCommitted = true;
					this.#streamUtterance += prefixed;
				} else {
					this.#streamEditor?.clearVolatileText();
				}
				options.requestRender?.();
			},
		});
		this.#stream = stream;
		let recorder: StreamingRecordingHandle | null = null;
		try {
			recorder = await startStreamingRecording(samples => stream.pushAudio(samples));
		} catch (err) {
			logger.warn("STT streaming recorder failed to start; falling back to batch recording", {
				error: errorMessage(err),
			});
		}
		if (!recorder) {
			stream.cancel();
			this.#cleanupStream();
			await this.#startBatchRecording(options);
			return;
		}
		this.#streamRecorder = recorder;
		this.#setState("recording", options);
		logger.debug("STT live recording started", { modelKey });
	}

	async #stopStreaming(options: ToggleOptions): Promise<void> {
		const stream = this.#stream;
		const recorder = this.#streamRecorder;
		if (!stream) {
			this.#setState("idle", options);
			return;
		}
		this.#setState("transcribing", options);
		try {
			await recorder?.stop();
		} catch (err) {
			logger.debug("stt: streaming recorder stop failed", {
				error: errorMessage(err),
			});
		}
		this.#streamRecorder = null;

		let failed = false;
		let finalText = "";
		try {
			finalText = (await stream.stop()).trim();
		} catch (err) {
			failed = true;
			if (!this.#disposed) {
				const msg = err instanceof Error ? err.message : "Transcription failed";
				options.showWarning(msg);
				logger.error("STT live transcription failed", { error: msg });
			}
		}
		if (this.#disposed) {
			this.#cleanupStream();
			return;
		}
		if (!this.#streamCommitted && finalText) {
			const prefixed = this.#prefixed(finalText);
			this.#streamEditor?.commitVolatileText(prefixed);
			this.#streamCommitted = true;
			this.#streamUtterance = prefixed;
		} else {
			this.#streamEditor?.clearVolatileText();
		}
		options.requestRender?.();
		if (!failed) options.showStatus(this.#streamCommitted ? "" : "No speech detected.");

		if (this.#streamCommitted && !failed && this.#streamEditor) {
			const trigger = settings.get("stt.submitTrigger");
			const { submit, trimTrailing } = evaluateSubmitTrigger(this.#streamUtterance, trigger);
			if (trimTrailing > 0) {
				this.#streamEditor.deleteBeforeCursor(trimTrailing);
			}
			if (submit) {
				this.#streamEditor.submit();
			}
		}

		this.#cleanupStream();
		this.#setState("idle", options);
	}

	#cleanupStream(): void {
		this.#stream = null;
		this.#streamRecorder = null;
		this.#streamEditor = null;
		this.#streamCommitted = false;
		this.#streamAbort = null;
		this.#streamUtterance = "";
	}

	async #startBatchRecording(options: ToggleOptions): Promise<void> {
		const id = Snowflake.next();
		this.#tempFile = path.join(os.tmpdir(), `veyyon-stt-${id}.wav`);
		try {
			this.#recordingHandle = await startRecording(this.#tempFile);
			this.#setState("recording", options);
			logger.debug("STT recording started", { tempFile: this.#tempFile });
		} catch (err) {
			this.#tempFile = null;
			const msg = err instanceof Error ? err.message : "Failed to start recording";
			options.showWarning(msg);
			logger.error("STT recording failed to start", { error: msg });
		}
	}

	async #stopBatch(editor: Editor, options: ToggleOptions): Promise<void> {
		const handle = this.#recordingHandle;
		const tempFile = this.#tempFile;
		this.#recordingHandle = null;

		if (!handle || !tempFile) {
			this.#setState("idle", options);
			return;
		}

		try {
			await handle.stop();
			await verifyRecordingFile(tempFile);
			this.#setState("transcribing", options);

			const sttSettings = {
				modelName: settings.get("stt.modelName") as string | undefined,
				language: settings.get("stt.language") as string | undefined,
			};
			this.#transcriptionAbort = new AbortController();
			const text = await transcribe(tempFile, { ...sttSettings, signal: this.#transcriptionAbort.signal });
			this.#transcriptionAbort = null;
			if (this.#disposed) return;
			if (text.length > 0) {
				const trigger = settings.get("stt.submitTrigger");
				const { submit, trimTrailing } = evaluateSubmitTrigger(text, trigger);
				const textToInsert = trimTrailing > 0 ? text.slice(0, -trimTrailing) : text;
				if (textToInsert.length > 0) {
					editor.insertText(textToInsert);
				}
				options.showStatus("");
				if (submit) {
					editor.submit();
				}
			} else {
				options.showStatus("No speech detected.");
			}
			if (!this.#disposed) this.#setState("idle", options);
		} catch (err) {
			if (this.#disposed) return;
			if (isAbortError(err)) {
				this.#setState("idle", options);
				return;
			}
			const msg = err instanceof Error ? err.message : "Transcription failed";
			options.showWarning(msg);
			logger.error("STT transcription failed", { error: msg });
			this.#setState("idle", options);
		} finally {
			try {
				await fs.rm(tempFile, { force: true });
			} catch {}
			this.#tempFile = null;
		}
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#transcriptionAbort) {
			this.#transcriptionAbort.abort();
			this.#transcriptionAbort = null;
		}
		if (this.#streamAbort) {
			this.#streamAbort.abort();
			this.#streamAbort = null;
		}
		this.#stream?.cancel();
		this.#streamRecorder?.stop().catch((error: unknown) => {
			logger.warn("STT stream recorder did not stop; the microphone may stay open", {
				error: errorMessage(error),
			});
		});
		this.#cleanupStream();
		if (this.#recordingHandle) {
			this.#recordingHandle.stop().catch((error: unknown) => {
				logger.warn("STT recorder did not stop; the microphone may stay open", { error: errorMessage(error) });
			});
			this.#recordingHandle = null;
		}
		if (this.#tempFile) {
			const tempFile = this.#tempFile;
			fs.rm(tempFile, { force: true }).catch((error: unknown) => {
				logger.warn("STT temp recording could not be deleted; recorded audio is left on disk", {
					file: tempFile,
					error: errorMessage(error),
				});
			});
			this.#tempFile = null;
		}
		this.#state = "idle";
		this.#resolvedModelKey = null;
	}
}
