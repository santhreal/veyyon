import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which, errorMessage, logger, removeTempPath, Snowflake } from "@veyyon/utils";
import type { FileSink, Subprocess } from "bun";
import { adoptIntoPrimarySessionCpuBudget } from "../session/cpu-limit";
import { getToolPath } from "../utils/tools-manager";
import { type PlayerCommand, playAudioFile } from "./player";
import { encodeWav } from "./wav";

const DEFAULT_SAMPLE_RATE = 24_000;
const LEAD_SECONDS = 0.6;
export const DUCK_GAIN = 0.25;

export interface StreamingPlayerLookup {
	which?: (bin: string) => string | null;
	ffmpeg?: () => string | null;
}

export function streamingPlayerCommandsFor(
	platform: NodeJS.Platform,
	sampleRate: number,
	lookup: StreamingPlayerLookup = {},
): PlayerCommand[] {
	const which = lookup.which ?? $which;
	const ffmpeg = lookup.ffmpeg ?? ((): string | null => getToolPath("ffmpeg"));
	const rate = String(sampleRate > 0 ? sampleRate : DEFAULT_SAMPLE_RATE);
	const input = ["-loglevel", "error", "-nostdin", "-f", "f32le", "-ar", rate, "-ac", "1", "-i", "pipe:0"];

	if (platform === "darwin") {
		const commands: PlayerCommand[] = [];
		const ffmpegBin = ffmpeg();
		if (ffmpegBin) commands.push({ cmd: ffmpegBin, args: input.concat(["-f", "audiotoolbox", "default"]) });
		const play = which("play");
		if (play) {
			commands.push({
				cmd: play,
				args: ["-q", "-t", "raw", "-e", "floating-point", "-b", "32", "-r", rate, "-c", "1", "-"],
			});
		}
		return commands;
	}
	if (platform === "win32") {
		return [];
	}

	const commands: PlayerCommand[] = [];
	const ffmpegBin = ffmpeg();
	if (ffmpegBin) {
		commands.push({ cmd: ffmpegBin, args: input.concat(["-f", "pulse", "default"]) });
		commands.push({ cmd: ffmpegBin, args: input.concat(["-f", "alsa", "default"]) });
	}
	const paplay = which("paplay");
	if (paplay) commands.push({ cmd: paplay, args: ["--raw", `--rate=${rate}`, "--format=float32le", "--channels=1"] });
	const aplay = which("aplay");
	if (aplay) commands.push({ cmd: aplay, args: ["-q", "-f", "FLOAT_LE", "-r", rate, "-c", "1", "-"] });
	return commands;
}

export class StreamingAudioPlayer {
	#queue: Float32Array[] = [];
	#sampleRate = DEFAULT_SAMPLE_RATE;
	#gain = 1;
	#mode: "stream" | "file" = "file";
	#proc: Subprocess<"pipe", "ignore", "ignore"> | null = null;
	#sink: FileSink | null = null;
	#candidates: PlayerCommand[] | null = null;
	#writtenSec = 0;
	#startedAt = 0;
	#started = false;
	#inputClosed = false;
	#stopped = false;
	#abortController = new AbortController();
	#wake: (() => void) | null = null;
	#drain: Promise<void> = Promise.resolve();

	start(sampleRate: number): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		this.#sampleRate = sampleRate > 0 ? sampleRate : DEFAULT_SAMPLE_RATE;
		this.#mode = this.#spawnStream() ? "stream" : "file";
		this.#startedAt = performance.now();
		this.#drain = this.#drainLoop();
	}

	write(pcm: Float32Array): void {
		if (this.#stopped) return;
		this.#queue.push(pcm);
		this.#signal();
	}

	setGain(gain: number): void {
		this.#gain = gain < 0 ? 0 : gain;
	}

	async end(): Promise<void> {
		this.#inputClosed = true;
		this.#signal();
		await this.#drain;
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#queue.length = 0;
		this.#abortController.abort();
		this.#signal();
		try {
			void Promise.resolve(this.#sink?.end()).catch(() => {});
		} catch {}
		try {
			this.#proc?.kill("SIGKILL");
		} catch {}
	}

	#spawnStream(): boolean {
		this.#candidates ??= streamingPlayerCommandsFor(process.platform, this.#sampleRate);
		for (let command = this.#candidates.shift(); command; command = this.#candidates.shift()) {
			const { cmd, args } = command;
			try {
				const proc = Bun.spawn([cmd, ...args], {
					stdin: "pipe",
					stdout: "ignore",
					stderr: "ignore",
				});
				adoptIntoPrimarySessionCpuBudget(proc.pid);
				this.#proc = proc;
				this.#sink = proc.stdin;
				void proc.exited.then(code => {
					if (this.#proc !== proc || this.#stopped || this.#inputClosed) return;
					logger.debug("tts: streaming backend exited early; trying next backend", { cmd, code });
					this.#proc = null;
					this.#sink = null;
					this.#mode = this.#spawnStream() ? "stream" : "file";
				});
				return true;
			} catch (error) {
				logger.debug("tts: streaming player spawn failed", {
					cmd,
					error: errorMessage(error),
				});
			}
		}
		return false;
	}

	#signal(): void {
		const wake = this.#wake;
		this.#wake = null;
		wake?.();
	}

	async #drainLoop(): Promise<void> {
		try {
			while (!this.#stopped) {
				const chunk = this.#queue.shift();
				if (!chunk) {
					if (this.#inputClosed) break;
					await this.#waitForWork();
					continue;
				}
				if (this.#mode === "stream") {
					const ahead = this.#writtenSec - (performance.now() - this.#startedAt) / 1000;
					if (ahead > LEAD_SECONDS) {
						await Bun.sleep((ahead - LEAD_SECONDS) * 1000);
						if (this.#stopped) return;
					}
					if (await this.#writeStream(chunk)) {
						this.#writtenSec += chunk.length / this.#sampleRate;
						continue;
					}
					this.#mode = this.#spawnStream() ? "stream" : "file";
					if (this.#mode === "stream" && (await this.#writeStream(chunk))) {
						this.#writtenSec += chunk.length / this.#sampleRate;
					} else {
						this.#mode = "file";
						await this.#playFile(chunk);
					}
				} else {
					await this.#playFile(chunk);
				}
			}
			if (!this.#stopped && this.#mode === "stream") {
				try {
					await this.#sink?.end();
				} catch {}
				if (this.#proc) {
					try {
						await this.#proc.exited;
					} catch {}
				}
			}
		} catch (error) {
			logger.warn("tts: playback stopped early because the streaming player failed", {
				error: errorMessage(error),
			});
		}
	}

	#waitForWork(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#wake = resolve;
		if (this.#queue.length > 0 || this.#inputClosed || this.#stopped) {
			this.#wake = null;
			resolve();
		}
		return promise;
	}

	async #writeStream(pcm: Float32Array): Promise<boolean> {
		const sink = this.#sink;
		if (!sink) return false;
		try {
			sink.write(this.#bytes(pcm));
			await sink.flush();
			return true;
		} catch (error) {
			logger.debug("tts: streaming write failed", {
				error: errorMessage(error),
			});
			return false;
		}
	}

	async #playFile(pcm: Float32Array): Promise<void> {
		const wavPath = path.join(os.tmpdir(), `veyyon-speech-${Snowflake.next()}.wav`);
		try {
			await fs.writeFile(wavPath, encodeWav(this.#scaled(pcm), this.#sampleRate));
			if (!this.#stopped) await playAudioFile(wavPath, { signal: this.#abortController.signal });
		} catch (error) {
			logger.debug("tts: file playback failed", {
				error: errorMessage(error),
			});
		} finally {
			await removeTempPath(wavPath, "tts-playback-finished");
		}
	}

	#bytes(pcm: Float32Array): Uint8Array {
		if (this.#gain === 1) return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
		return new Uint8Array(this.#scaled(pcm).buffer);
	}

	#scaled(pcm: Float32Array): Float32Array {
		if (this.#gain === 1) return pcm;
		const out = new Float32Array(pcm.length);
		for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) * this.#gain;
		return out;
	}
}

export function createStreamingPlayer(): StreamingAudioPlayer {
	return new StreamingAudioPlayer();
}
