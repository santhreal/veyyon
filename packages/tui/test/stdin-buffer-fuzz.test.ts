/**
 * Fuzz + conservation tests for the StdinBuffer escape-sequence splitter.
 *
 * `StdinBuffer.process` runs on every byte the terminal delivers — mouse
 * reports, kitty CSU keys, OSC/DCS/APC payloads, bracketed paste, and arbitrary
 * garbage from a wedged/hostile terminal, all arriving split across chunk
 * boundaries at any offset. It must never throw, never lose or duplicate input
 * bytes, and never let its internal buffer grow past what was fed (an
 * unterminated OSC must not accumulate forever). These are the safety invariants
 * an example-based suite can't cover exhaustively.
 *
 * Deterministic LCG so a failing byte stream reproduces from the printed seed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setKittyProtocolActive } from "@veyyon/pi-tui/keys";
import { StdinBuffer } from "@veyyon/pi-tui/stdin-buffer";
import { lcg } from "./helpers/adversarial-strings";

// Byte-level fragments spanning every branch of resolveEscapeEnd: ESC intro,
// CSI/SS3, SGR + X10 mouse, OSC/DCS/APC intros and terminators, kitty CSU,
// bracketed-paste markers, high/low surrogates, control and printable bytes.
const BYTE_FRAGMENTS: readonly string[] = [
	"a",
	"Z",
	"9",
	" ",
	"\n",
	"\t",
	"\x00",
	"\x07", // BEL (OSC terminator)
	"\x1b", // ESC
	"\x1b\x1b", // double ESC
	"[",
	"<",
	"O",
	"P",
	"]",
	"_",
	"\\", // ST tail (with a preceding ESC → ESC\)
	"M", // X10 mouse final / SGR press
	"m", // SGR release
	";",
	"0",
	"35",
	"200",
	"201",
	"~",
	"u",
	"\x1b[<0;1;1M", // complete SGR mouse
	"\x1b[<0;1;1", // partial SGR mouse
	"\x1b[M!!!", // complete X10 mouse
	"\x1b[106;5u", // kitty CSU
	"\x1b[200~", // bracketed-paste start
	"\x1b[201~", // bracketed-paste end
	"\x1b]0;title\x07", // complete OSC
	"\x1b]52;", // partial OSC
	"\x1b_Ga=T\x1b\\", // complete APC (kitty graphics)
	"\x1bOP", // SS3
	"一", // wide
	"\u{1f600}", // emoji (surrogate pair)
	String.fromCharCode(0xd800), // lone high surrogate
	String.fromCharCode(0xdc00), // lone low surrogate
];

function buildStream(rand: () => number, maxFragments: number): string {
	const n = Math.floor(rand() * maxFragments);
	let out = "";
	for (let i = 0; i < n; i++) out += BYTE_FRAGMENTS[Math.floor(rand() * BYTE_FRAGMENTS.length)];
	return out;
}

// Slice `s` into random chunks so escape sequences land split at every offset —
// the exact condition the buffer exists to handle.
function chunkify(s: string, rand: () => number): string[] {
	const chunks: string[] = [];
	let i = 0;
	while (i < s.length) {
		const len = 1 + Math.floor(rand() * 5);
		chunks.push(s.slice(i, i + len));
		i += len;
	}
	return chunks;
}

describe("StdinBuffer fuzz", () => {
	let buffer: StdinBuffer;
	let emitted: string[];
	let pastes: string[];

	beforeEach(() => {
		setKittyProtocolActive(false);
		// Large timeout so the async flush timer never fires mid-fuzz; every test
		// drives completion synchronously via flush().
		buffer = new StdinBuffer({ timeout: 100_000, pasteTimeout: 100_000 });
		emitted = [];
		pastes = [];
		buffer.on("data", s => emitted.push(s));
		buffer.on("paste", s => pastes.push(s));
	});

	afterEach(() => {
		buffer.destroy();
		setKittyProtocolActive(false);
	});

	it("never throws and never buffers more than was fed, on adversarial chunked streams", () => {
		const rand = lcg(0x57d1_9b00);
		for (let iter = 0; iter < 6000; iter++) {
			emitted = [];
			pastes = [];
			buffer.clear();
			const stream = buildStream(rand, 40);
			const chunks = chunkify(stream, rand);
			let fedSoFar = 0;
			for (const chunk of chunks) {
				try {
					buffer.process(chunk);
				} catch (e) {
					throw new Error(
						`process threw on stream ${JSON.stringify(stream)} chunk ${JSON.stringify(chunk)}: ${e}`,
					);
				}
				fedSoFar += chunk.length;
				// The pending buffer can never hold more than the bytes fed so far —
				// a violation means the splitter duplicated input into its buffer.
				if (buffer.getBuffer().length > fedSoFar) {
					throw new Error(
						`buffer (${buffer.getBuffer().length}) exceeds bytes fed (${fedSoFar}) on stream ${JSON.stringify(stream)}`,
					);
				}
			}
			try {
				buffer.flush();
			} catch (e) {
				throw new Error(`flush threw on stream ${JSON.stringify(stream)}: ${e}`);
			}
		}
	});

	it("conserves plain (escape-free, marker-free) input byte-for-byte in order", () => {
		// With no ESC and no paste markers, no escape/paste/kitty-dedup path is
		// reachable, so every input code unit must be emitted exactly once, in
		// order: the concatenation of emitted sequences equals the input.
		const rand = lcg(0x1234_abcd);
		const plainPool = ["a", "Z", "9", " ", "\n", "\t", "一", "Ａ", "\u{1f600}", "0", ";", "~", "<", ">"];
		for (let iter = 0; iter < 4000; iter++) {
			emitted = [];
			buffer.clear();
			const n = Math.floor(rand() * 40);
			let stream = "";
			for (let i = 0; i < n; i++) stream += plainPool[Math.floor(rand() * plainPool.length)];
			for (const chunk of chunkify(stream, rand)) buffer.process(chunk);
			for (const seq of buffer.flush()) emitted.push(seq);
			const joined = emitted.join("");
			if (joined !== stream) {
				throw new Error(`plain conservation failed: fed ${JSON.stringify(stream)} got ${JSON.stringify(joined)}`);
			}
		}
	});

	it("keeps the buffer bounded against a long unterminated OSC payload", () => {
		// A hostile terminal streaming a never-closed OSC must not accumulate
		// unbounded memory: resolveEscapeEnd flushes the prefix at the cap.
		buffer.clear();
		const huge = `\x1b]52;${"A".repeat(2_000_000)}`;
		let fed = 0;
		for (let i = 0; i < huge.length; i += 4096) {
			buffer.process(huge.slice(i, i + 4096));
			fed += Math.min(4096, huge.length - i);
			expect(buffer.getBuffer().length).toBeLessThanOrEqual(fed);
		}
	});
});
