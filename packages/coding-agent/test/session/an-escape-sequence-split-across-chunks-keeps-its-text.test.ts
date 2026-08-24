/**
 * WHY. `OutputSink.push` sanitized each chunk on its own, and a reader ends a
 * chunk wherever the pipe hands it one. A chunk that stopped inside an escape
 * sequence therefore lost the sequence's head as a control fragment and let its
 * tail through as text: `printf 'x\033[31mred\033[0m\n'` reached the transcript
 * as `xred0m` in CI run 32685388682 while passing locally, because whether the
 * split happens is a property of the machine and not of the command.
 *
 * The class this closes: any escape sequence divided across two pushes, at any
 * interior offset, for the three grammars a command emits — a CSI, a string
 * sequence closed by BEL, and a string sequence closed by ST, whose terminator
 * contains an ESC of its own and so cannot be found by looking at the last ESC
 * in the chunk. The split offsets are enumerated from the payload at run time,
 * and the CSI case sweeps every PAIR of offsets, so a three-way split that
 * leaves `ESC` alone at a boundary is covered rather than assumed.
 *
 * What it does not catch: the sequences a terminal applies rather than strips
 * (a carriage return, a cursor move) — those are the native terminal
 * emulation's contract and `bash-binary-output-safety.test.ts` pins them — and
 * the SIXEL passthrough path, which deliberately preserves a DCS payload and is
 * pinned by `bash-execution-sixel.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { OutputSink } from "@veyyon/coding-agent/session/streaming-output";

/** An SGR pair around text, which is what a colouring command emits. */
const SGR_PAYLOAD = "x\u001b[31mred\u001b[0m\ntail";
const SGR_TEXT = "xred\ntail";

/** An OSC title, closed by BEL. */
const OSC_BEL_PAYLOAD = "a\u001b]0;title\u0007b";
/** The same title closed by ST (`ESC \`), whose terminator holds its own ESC. */
const OSC_ST_PAYLOAD = "a\u001b]0;title\u001b\\b";
const OSC_TEXT = "ab";

async function pushSplit(payload: string, offsets: readonly number[]): Promise<string> {
	const sink = new OutputSink();
	let previous = 0;
	for (const offset of offsets) {
		sink.push(payload.slice(previous, offset));
		previous = offset;
	}
	sink.push(payload.slice(previous));
	return (await sink.dump()).output;
}

describe("an escape sequence split across two chunks", () => {
	it("keeps the wrapped text and leaks no part of the sequence, at every split offset", async () => {
		const failures: string[] = [];
		for (let offset = 1; offset < SGR_PAYLOAD.length; offset++) {
			const output = await pushSplit(SGR_PAYLOAD, [offset]);
			if (output !== SGR_TEXT) failures.push(`${offset}:${JSON.stringify(output)}`);
		}
		expect(failures).toEqual([]);
	});

	it("survives a three-way split, including one that leaves ESC alone in a chunk", async () => {
		const failures: string[] = [];
		for (let first = 1; first < SGR_PAYLOAD.length; first++) {
			for (let second = first + 1; second < SGR_PAYLOAD.length; second++) {
				const output = await pushSplit(SGR_PAYLOAD, [first, second]);
				if (output !== SGR_TEXT) failures.push(`${first}/${second}:${JSON.stringify(output)}`);
			}
		}
		expect(failures).toEqual([]);
	});

	it("holds a BEL-terminated string sequence from its opener, at every split offset", async () => {
		const failures: string[] = [];
		for (let offset = 1; offset < OSC_BEL_PAYLOAD.length; offset++) {
			const output = await pushSplit(OSC_BEL_PAYLOAD, [offset]);
			if (output !== OSC_TEXT) failures.push(`${offset}:${JSON.stringify(output)}`);
		}
		expect(failures).toEqual([]);
	});

	it("holds an ST-terminated string sequence from its opener, not from the ESC inside its terminator", async () => {
		const failures: string[] = [];
		for (let offset = 1; offset < OSC_ST_PAYLOAD.length; offset++) {
			const output = await pushSplit(OSC_ST_PAYLOAD, [offset]);
			if (output !== OSC_TEXT) failures.push(`${offset}:${JSON.stringify(output)}`);
		}
		expect(failures).toEqual([]);
	});

	it("reports the same text to the live preview as it dumps", async () => {
		const chunks: string[] = [];
		const sink = new OutputSink({ onChunk: chunk => chunks.push(chunk) });
		sink.push("x\u001b[31mred\u001b");
		sink.push("[0m\ntail");
		const dumped = await sink.dump();

		expect(chunks.join("")).toBe(SGR_TEXT);
		expect(dumped.output).toBe(SGR_TEXT);
	});
});

describe("a sequence the stream ends inside", () => {
	it("is dropped rather than emitted as text", async () => {
		const sink = new OutputSink();
		sink.push("x\u001b[3");
		const dumped = await sink.dump();

		expect(dumped.output).toBe("x");
	});

	it("does not hold back the text that follows a payload too long to be a sequence", async () => {
		const sink = new OutputSink();
		sink.push(`\u001b]0;${"a".repeat(5000)}`);
		sink.push("tail");
		const dumped = await sink.dump();

		expect(dumped.output).toBe("tail");
	});

	it("is cleared by replace, so a later chunk is not prefixed with it", async () => {
		const sink = new OutputSink();
		sink.push("x\u001b[3");
		sink.replace("replaced");
		sink.push("1m");
		const dumped = await sink.dump();

		expect(dumped.output).toBe("replaced1m");
	});
});
