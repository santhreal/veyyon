/**
 * Synthesize text with the local TTS engine and play it (or save it with --out).
 *
 * Text comes from the argument or --file. Input is segmented into
 * sentence-sized chunks ({@link SpeakableStream}) and synthesized through the
 * streaming TTS worker, so arbitrarily long text plays gaplessly instead of
 * hitting Kokoro's single-call ~510-phoneme truncation. --out concatenates the
 * streamed segments into one WAV. The first run downloads the configured local
 * model into the worker's cache.
 */
import { errorMessage, getProjectDir } from "@veyyon/utils";
import { Args, Command, Flags } from "@veyyon/utils/cli";
import chalk from "chalk";
import { makeCoarseStepPrinter } from "../cli/progress-line";
import { Settings, settings } from "../config/settings";
import { TTS_LOCAL_MODEL_VALUES, TTS_LOCAL_MODELS, TTS_LOCAL_VOICE_VALUES } from "../tts/models";
import { SpeakableStream } from "../tts/speakable";
import { StreamingAudioPlayer } from "../tts/streaming-player";
import { shutdownTtsClient, ttsClient } from "../tts/tts-client";
import { encodeWav } from "../tts/wav";

export default class Say extends Command {
	static description = "Synthesize text with the local TTS engine and play it through the speakers";

	static args = {
		text: Args.string({ description: "Text to speak (or use --file, or pipe on stdin)" }),
	};

	static flags = {
		voice: Flags.string({ description: "Voice id (see --voices)", options: TTS_LOCAL_VOICE_VALUES }),
		model: Flags.string({ description: "Local TTS model key", options: TTS_LOCAL_MODEL_VALUES }),
		file: Flags.string({ char: "f", description: "Read the text to speak from this file" }),
		out: Flags.string({ char: "o", description: "Write WAV to this path instead of playing" }),
		voices: Flags.boolean({ description: "List available models and voices, then exit" }),
	};

	static examples = [
		'veyyon say "hello world"',
		"veyyon say --file notes.md --voice bm_fable",
		'veyyon say "hello world" --out /tmp/hello.wav',
		"git log -1 --format=%s | veyyon say",
		"veyyon say --voices",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Say);
		if (args.text && flags.file) {
			process.stderr.write(chalk.red("error: pass either text or --file, not both\n"));
			process.exit(1);
		}

		await Settings.init({ cwd: getProjectDir() });
		const model = flags.model ?? settings.get("tts.localModel");
		const voice = flags.voice ?? settings.get("tts.localVoice");

		if (flags.voices) {
			for (const spec of TTS_LOCAL_MODELS) {
				const modelMark = spec.key === model ? chalk.green(" (current)") : "";
				process.stdout.write(`${chalk.bold(spec.key)}${modelMark}  ${chalk.dim(spec.description)}\n`);
				for (const v of spec.voices) {
					const voiceMark = spec.key === model && v.id === voice ? chalk.green(" (current)") : "";
					process.stdout.write(`  ${v.id.padEnd(12)} ${chalk.dim(v.label)}${voiceMark}\n`);
				}
			}
			return;
		}

		let exitCode = 0;
		const progressTty = process.stderr.isTTY === true;
		const stepPrinter = makeCoarseStepPrinter(line => process.stderr.write(`${line}\n`));
		const unsubscribe = ttsClient.onProgress(event => {
			if (event.status === "progress" && typeof event.progress === "number") {
				const file = event.file ?? model;
				if (progressTty) {
					process.stderr.write(`\r${chalk.dim(`downloading ${file}: ${Math.round(event.progress)}%`)}`);
				} else {
					stepPrinter(`downloading ${file}`, event.progress);
				}
			} else if (event.status === "done" || event.status === "ready") {
				// Clear the progress line once the download finishes.
				if (progressTty) process.stderr.write("\r\x1b[K");
			}
		});

		try {
			let text: string;
			if (flags.file) {
				try {
					text = await Bun.file(flags.file).text();
				} catch {
					process.stderr.write(
						chalk.red(`error: cannot read --file "${flags.file}": file not found or unreadable\n`),
					);
					exitCode = 1;
					return;
				}
			} else if (args.text !== undefined) {
				text = args.text;
			} else if (!process.stdin.isTTY) {
				text = await new Response(process.stdin).text();
			} else {
				text = "";
			}
			const splitter = new SpeakableStream();
			const segments = [...splitter.push(text), ...splitter.flush()];
			if (segments.length === 0) {
				process.stderr.write(chalk.red("error: nothing speakable in the input\n"));
				exitCode = 1;
				return;
			}

			const stream = ttsClient.synthesizeStream(model, { voice });
			for (const segment of segments) stream.push(segment);
			stream.end();

			if (flags.out) {
				const pcms: Float32Array[] = [];
				let total = 0;
				let sampleRate = 0;
				for await (const chunk of stream.chunks) {
					pcms.push(chunk.pcm);
					total += chunk.pcm.length;
					sampleRate = chunk.sampleRate;
				}
				if (total === 0) {
					this.#synthesisFailed(model);
					exitCode = 1;
					return;
				}
				const pcm = new Float32Array(total);
				let offset = 0;
				for (const part of pcms) {
					pcm.set(part, offset);
					offset += part.length;
				}
				const wav = encodeWav(pcm, sampleRate);
				await Bun.write(flags.out, wav);
				const durationSec = total / sampleRate;
				process.stdout.write(
					`${chalk.green("saved")} ${flags.out} ` +
						`${chalk.dim(`(${voice}, ${model}, ${durationSec.toFixed(1)}s, ${wav.byteLength} bytes)`)}\n`,
				);
				return;
			}

			const player = new StreamingAudioPlayer();
			let spoken = 0;
			let seconds = 0;
			for await (const chunk of stream.chunks) {
				player.start(chunk.sampleRate);
				player.write(chunk.pcm);
				spoken++;
				seconds += chunk.pcm.length / chunk.sampleRate;
			}
			if (spoken === 0) {
				player.stop();
				this.#synthesisFailed(model);
				exitCode = 1;
				return;
			}
			await player.end();
			process.stdout.write(
				`${chalk.green("spoke")} ${chalk.dim(`(${voice}, ${model}, ${seconds.toFixed(1)}s, ${spoken} segments)`)}\n`,
			);
		} catch (err) {
			process.stderr.write(chalk.red(`error: ${errorMessage(err)}\n`));
			exitCode = 1;
		} finally {
			unsubscribe();
			await shutdownTtsClient();
			// In the finally so early `return`s on error paths can't skip it.
			if (exitCode !== 0) process.exit(exitCode);
		}
	}

	#synthesisFailed(model: string): void {
		process.stderr.write(
			chalk.red(
				`error: could not synthesize with local TTS model "${model}". Run \`veyyon setup speech\` to install it.\n`,
			),
		);
	}
}
