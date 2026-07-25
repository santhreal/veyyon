import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

/**
 * TOOLE-3: bytes that are not text must be handled EXPLICITLY, never mangled
 * into text.
 *
 * Reading a file is the agent's most-used operation, and the tool's job is to
 * hand back a faithful string. When the bytes are not UTF-8 text there is no
 * faithful string to hand back: a naive decode turns NULs into terminal control
 * characters and invalid sequences into runs of U+FFFD, so the model reasons
 * over mojibake, the terminal renders garbage, and a large binary burns the
 * context window doing it. Refusing is the correct answer, and it must be a
 * stated refusal the agent can act on, not an empty result.
 *
 * Three things are pinned here, all by exact bytes:
 *
 *  - WHICH files are refused: NUL-containing, invalid UTF-8, and UTF-16 (whose
 *    ASCII range is NUL-padded, so it looks like binary to any byte sniff).
 *  - WHICH are not: valid UTF-8 is text no matter how exotic, including
 *    multibyte sequences that straddle the sniff window's edge, control
 *    characters that are legitimately text (tab, CR, ESC), and an empty file.
 *  - That the refusal carries the ESCAPE HATCH and the machine-readable marker,
 *    so `:raw` still reaches the bytes and the `veyyon read` CLI can exit
 *    non-zero instead of reporting the refusal as success.
 *
 * The sniff reads a bounded header (8192 bytes, matching git's scan), so a file
 * whose only NUL sits past that window reads as text. That is a deliberate
 * bound, not an oversight, and it is pinned below so the boundary is a decision
 * on record rather than a surprise someone rediscovers from a corrupted
 * terminal.
 */
describe("reading bytes that are not text", () => {
	let tmpDir = "";

	/** The sniff window, mirrored from `packages/utils/src/binary.ts`. */
	const SNIFF_BYTES = 8192;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-binary-"));
	});

	afterEach(async () => {
		if (tmpDir) {
			await removeWithRetries(tmpDir);
			tmpDir = "";
		}
	});

	function session(): ToolSession {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "read.summarize.enabled": false }),
		});
	}

	/** Write exact bytes and return the absolute path. */
	async function writeBytes(name: string, bytes: Uint8Array | string): Promise<string> {
		const file = path.join(tmpDir, name);
		await fs.writeFile(file, bytes);
		return file;
	}

	/** Read through the real tool and return its text plus the unavailability marker. */
	async function read(target: string): Promise<{ text: string; reason: string | undefined }> {
		const result = await new ReadTool(session()).execute("r1", { path: target });
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n");
		const details = result.details as { contentUnavailable?: { reason: string } } | undefined;
		return { text, reason: details?.contentUnavailable?.reason };
	}

	describe("refuses, and says why", () => {
		it("a file containing a NUL byte", async () => {
			// The defining case. A NUL is not representable in the text the agent gets
			// back, and it is what every true binary (object file, font, packed blob)
			// has in its first bytes.
			const file = await writeBytes("has-nul.bin", new Uint8Array([0x68, 0x69, 0x00, 0x74, 0x68, 0x65, 0x72, 0x65]));

			const { text, reason } = await read(file);

			expect(reason).toBe("binary");
			expect(text).toContain("Cannot read binary file");
			expect(text).toContain("has-nul.bin");
		});

		it("a file that is not valid UTF-8", async () => {
			// No NUL, still not text: a lone 0xFF can never begin a UTF-8 sequence. A
			// NUL-only check would let this through and hand back U+FFFD mojibake.
			const file = await writeBytes("invalid-utf8.bin", new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0x68, 0x69]));

			const { text, reason } = await read(file);

			expect(reason).toBe("binary");
			expect(text).toContain("not valid UTF-8 text");
		});

		it("a UTF-16 text file, because its ASCII range is NUL-padded", async () => {
			// Genuinely text to a human, indistinguishable from binary to a byte sniff,
			// and decoded as UTF-8 it is every other character interleaved with NULs.
			// Refusing is right; silently mangling it would be worse than either.
			const file = await writeBytes("utf16.txt", Buffer.from("hello world", "utf16le"));

			const { reason } = await read(file);

			expect(reason).toBe("binary");
		});

		it("names `:raw` so the agent has a next step", async () => {
			// A refusal with no route forward turns into a retry loop or a giving-up.
			// The escape hatch has to be in the message the model actually reads.
			const file = await writeBytes("guidance.bin", new Uint8Array([0x00, 0x01, 0x02]));

			const { text } = await read(file);

			expect(text).toContain(":raw");
		});

		it("reports the file's size, so a big blob is recognisable as one", async () => {
			const file = await writeBytes("sized.bin", new Uint8Array(4096));

			const { text } = await read(file);

			expect(text).toMatch(/\b4(\.0+)?\s?KB\b/i);
		});
	});

	describe("reads as text, because it IS text", () => {
		it("plain ASCII", async () => {
			// The control. Everything above is satisfied by a tool that refuses every
			// file, which would be a considerably worse defect.
			const file = await writeBytes("plain.txt", "hello\nworld\n");

			const { text, reason } = await read(file);

			expect(reason).toBeUndefined();
			expect(text).toContain("hello");
			expect(text).toContain("world");
		});

		it("multibyte UTF-8, byte-for-byte", async () => {
			// Emoji and CJK are ordinary text. A sniff that mistook high bytes for
			// binary would refuse a large share of real source files and documents.
			const file = await writeBytes("unicode.txt", "日本語 · café · 🇯🇵🧑‍🚀\n");

			const { text, reason } = await read(file);

			expect(reason).toBeUndefined();
			expect(text).toContain("日本語");
			expect(text).toContain("café");
			expect(text).toContain("🧑‍🚀");
		});

		it("a multibyte sequence STRADDLING the end of the sniff window", async () => {
			// The subtle one. The sniff sees a truncated sequence at the boundary, and
			// a strict (non-streaming) decode would call that invalid and refuse a
			// perfectly good file for the sole reason that a character landed on byte
			// 8192. This is why the header decode runs in streaming mode.
			// Short lines, not one long one: the read tool elides an over-long line,
			// which would hide the character being asserted on and make this pass for
			// the wrong reason. 102 lines of 80 bytes is 8160, plus 30 more, puts the
			// first byte of `日` at offset 8191 — inside the window, its continuation
			// bytes outside it.
			const line = `${"a".repeat(79)}\n`;
			const filler = line.repeat(102) + "a".repeat(SNIFF_BYTES - 102 * 80 - 1);
			const file = await writeBytes("boundary.txt", `${filler}日本語\n`);
			expect(Buffer.byteLength(filler)).toBe(SNIFF_BYTES - 1);

			const { text, reason } = await read(file);

			expect(reason).toBeUndefined();
			expect(text).toContain("日本語");
		});

		it("text containing tabs, carriage returns and an ESC sequence", async () => {
			// Control characters are not binary. Tabs and CRLF are everywhere, and an
			// ESC byte is normal in a recorded terminal log or a fixture of ANSI
			// output. Only NUL and invalid UTF-8 make a file unreadable as text.
			const file = await writeBytes("controls.txt", "col1\tcol2\r\n[31mred[0m\n");

			const { text, reason } = await read(file);

			expect(reason).toBeUndefined();
			expect(text).toContain("col1");
			expect(text).toContain("red");
		});

		it("an empty file", async () => {
			// Zero bytes contain no NUL and decode cleanly. Classifying emptiness as
			// binary would refuse every freshly-created file.
			const file = await writeBytes("empty.txt", "");

			const { reason } = await read(file);

			expect(reason).toBeUndefined();
		});
	});

	describe("the sniff window is bounded, and that bound is a decision", () => {
		it("a NUL past the sniff window is NOT detected", async () => {
			// Pinned as measured behaviour, not endorsed as ideal. Sniffing the whole
			// file would mean reading every byte of every file twice, so the bound is
			// deliberate and matches git's. What matters is that the limit is written
			// down: someone seeing control characters in a read result should find
			// this test rather than conclude the guard is broken.
			const file = await writeBytes(
				"late-nul.txt",
				Buffer.concat([Buffer.from("a".repeat(SNIFF_BYTES + 64)), Buffer.from([0x00]), Buffer.from("tail\n")]),
			);

			const { reason } = await read(file);

			expect(reason).toBeUndefined();
		});

		it("a NUL on the LAST byte of the window is still detected", async () => {
			// The inclusive edge of the bound above. Off by one here would shrink the
			// guard by a byte on every file and nobody would notice.
			const file = await writeBytes(
				"edge-nul.txt",
				Buffer.concat([Buffer.from("a".repeat(SNIFF_BYTES - 1)), Buffer.from([0x00])]),
			);

			const { reason } = await read(file);

			expect(reason).toBe("binary");
		});
	});

	describe("the `:raw` escape hatch", () => {
		it("reaches the bytes the refusal was protecting the agent from", async () => {
			// The refusal is only acceptable because this exists. If `:raw` also
			// refused, a binary file would be unreadable by any route and the guidance
			// in the message would be a dead end.
			const file = await writeBytes("raw-me.bin", new Uint8Array([0x68, 0x69, 0x00, 0x21]));

			const { reason } = await read(`${file}:raw`);

			expect(reason).toBeUndefined();
		});
	});
});
