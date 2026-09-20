/**
 * What one streamed delta costs the GUI host.
 *
 * `StreamingChanged` carries the whole accumulating entry, not the delta, so
 * every frame converts the reply so far into wire blocks and serialises it.
 * One frame per provider delta therefore costs the square of the reply length
 * in both passes, and the window redraws at the display's rate regardless.
 *
 * The arms are the same reply at different coalescing widths: `k` deltas per
 * frame, where `k = 1` is one frame per delta. At a 16 ms frame, `k` is the
 * provider's delta rate divided by 62 -- a reply arriving at 500 deltas a
 * second coalesces 8 into each frame, one at 125 coalesces 2, and one slower
 * than 62 coalesces none and pays what it paid before.
 *
 *   bun packages/coding-agent/bench/gui-streaming-frames.bench.ts
 */
import type { AssistantMessage } from "@veyyon/ai";
import { PresentationLedger } from "../src/gui-host/presentation";
import { agentMessageToTranscriptEntry } from "../src/gui-host/transcript-conversion";

/** Deltas in the reply. */
const DELTAS = 1_600;
/** Characters each delta adds, so the reply ends at ~40 KB. */
const DELTA_TEXT = "another clause of the reply ";
const WARMUP_RUNS = 1;
const MEASURE_RUNS = 3;
const WIDTHS = [1, 2, 4, 8, 16];

/** The accumulating assistant message after each delta of the reply. */
function messages(): AssistantMessage[] {
	let text = "";
	const built: AssistantMessage[] = [];
	for (let delta = 0; delta < DELTAS; delta++) {
		text += DELTA_TEXT;
		built.push({
			role: "assistant",
			content: [
				{ type: "text", text },
				{
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: { path: "crates/bench/src/lib.rs" },
				},
			],
			api: "openai-chat",
			provider: "openai",
			model: "gpt-4o-mini",
			stopReason: "stop",
			usage: {
				input: 10,
				output: delta,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 10 + delta,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1_700_000_000_000,
		});
	}
	return built;
}

interface Arm {
	frames: number;
	bytes: number;
	ms: number;
}

/** Converts and serialises one frame every `width` deltas, as the host does. */
function replay(built: AssistantMessage[], width: number): Arm {
	const ledger = new PresentationLedger();
	let frames = 0;
	let bytes = 0;
	const started = performance.now();
	for (const [delta, held] of built.entries()) {
		// A held delta costs a field assignment; only the frame converts.
		if ((delta + 1) % width !== 0 && delta + 1 !== built.length) continue;
		const accumulating = agentMessageToTranscriptEntry(held, 1, "stream-1", { ledger, isStreaming: true });
		bytes += Buffer.byteLength(
			`${JSON.stringify({ StreamingChanged: { entry: "stream-1", tool: null, accumulating, revision: 1 } })}\n`,
			"utf8",
		);
		frames += 1;
	}
	return { frames, bytes, ms: performance.now() - started };
}

const built = messages();
for (const width of WIDTHS) {
	for (let run = 0; run < WARMUP_RUNS; run++) replay(built, width);
}

const results = new Map<number, Arm>();
for (const width of WIDTHS) {
	let frames = 0;
	let bytes = 0;
	let ms = 0;
	for (let run = 0; run < MEASURE_RUNS; run++) {
		const arm = replay(built, width);
		frames = arm.frames;
		bytes = arm.bytes;
		ms += arm.ms;
	}
	results.set(width, { frames, bytes, ms: ms / MEASURE_RUNS });
}

const baseline = results.get(1) ?? { frames: 0, bytes: 0, ms: 0 };
const finalBytes = Buffer.byteLength(DELTA_TEXT.repeat(DELTAS), "utf8");
console.log(`reply: ${DELTAS} deltas, ${(finalBytes / 1024).toFixed(1)} KiB of text when it finishes`);
console.log("deltas/frame  provider rate  frames  bytes written        host ms");
for (const width of WIDTHS) {
	const arm = results.get(width) ?? { frames: 0, bytes: 0, ms: 0 };
	const rate = `${(width * 62).toString().padStart(4)}/s`;
	const mib = (arm.bytes / 1024 / 1024).toFixed(1).padStart(6);
	console.log(
		`${width.toString().padStart(12)}  ${rate.padStart(13)}  ${arm.frames.toString().padStart(6)}  ${mib} MiB` +
			`  ${arm.ms.toFixed(1).padStart(8)} ms`,
	);
	console.log(
		`METRIC stream_frames_w${width}=${arm.frames} stream_bytes_w${width}=${arm.bytes} stream_ms_w${width}=${arm.ms.toFixed(2)}`,
	);
}
console.log(
	`one frame per delta writes ${(baseline.bytes / 1024 / 1024).toFixed(1)} MiB for a ` +
		`${(finalBytes / 1024).toFixed(1)} KiB reply, which is what the square costs`,
);
