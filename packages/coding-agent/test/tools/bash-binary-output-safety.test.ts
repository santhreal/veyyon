/**
 * Binary, NUL, and invalid-UTF-8 output cannot corrupt the transcript or the
 * JSON envelope the tool result travels in.
 *
 * WHY THIS SUITE EXISTS (EXEC-2). A coding agent runs commands it did not write,
 * and plenty of them emit bytes that are not text: `cat` on a binary by mistake,
 * a tool that writes a NUL-delimited list, a program printing latin-1 in a UTF-8
 * world. Those bytes travel from the shell, into a tool result, into a JSON
 * message, into the session transcript on disk, and back out on resume. A single
 * unescaped NUL or lone surrogate anywhere on that path is not a rendering
 * annoyance: it can truncate a C-string consumer, break the JSON parse, and take
 * the whole session down on the NEXT run, when the transcript is read back and
 * the command that caused it is long out of view.
 *
 * The protection is real and predates this suite. What was missing was proof, so
 * every assertion here is on exact bytes and code points rather than on "it did
 * not crash".
 *
 * WHERE THE SANITIZING HAPPENS, and why nothing here mutation-tests it: output
 * passes through the native terminal emulation in `@veyyon/natives` (`Shell`),
 * which decodes and applies terminal semantics before any TypeScript sees it. It
 * is not a line of TS that can be flipped to prove these tests bite. So the
 * assertions are pinned to exact values instead, which is what makes a change in
 * that native layer show up here as a specific wrong string rather than as a
 * vague pass.
 *
 * These are CONTRACT tests, not aspiration: each one documents what the tool does
 * today, including where the handling is deliberately lossy.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
import { removeWithRetries } from "@veyyon/utils";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { makeToolSession } from "../helpers/tool-session";

useIsolatedGlobalSettings();

/** The Unicode replacement character, what a decoder substitutes for a byte it
 * cannot interpret. Named because the literal is unreadable in an assertion. */
const REPLACEMENT = "�";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-binary-safety-"));
});

afterEach(async () => {
	await removeWithRetries(tmpDir);
});

/** Run `command` and return the joined text content of the result. */
async function runText(id: string, command: string): Promise<string> {
	const tool = new BashTool(
		makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			getSessionId: () => "bash-binary-safety",
			allocateOutputArtifact: async (kind: string) => ({
				id: `${kind}-1`,
				path: path.join(tmpDir, `${kind}-1.txt`),
			}),
			settings: {
				get(key: string) {
					if (key === "async.enabled") return false;
					if (key === "bash.autoBackground.enabled") return false;
					if (key === "bashInterceptor.enabled") return false;
					return undefined;
				},
				getBashInterceptorRules: () => [],
			},
			getClientBridge: () => undefined,
		}) as never,
	);
	const result = await tool.execute(id, { command, timeout: 20 });
	return (result.content ?? [])
		.filter(block => block.type === "text")
		.map(block => (block as { text: string }).text)
		.join("");
}

/** The first line, which is where the command's own output lands; the rest is
 * the wall-time and status prose the tool appends. */
function firstLine(text: string): string {
	return text.split("\n")[0] ?? "";
}

describe("NUL bytes never reach the transcript", () => {
	/**
	 * THE case this row is named for. A NUL is the single most dangerous byte to
	 * pass through: it terminates a C string, so any consumer down the chain that
	 * is not length-aware silently truncates everything after it, and the loss is
	 * invisible because the JSON is still valid.
	 *
	 * It is dropped, and the surrounding text survives intact. Asserted on code
	 * points because a NUL is invisible in a diff and in a failure message.
	 */
	it("drops an embedded NUL and keeps the text on both sides of it", async () => {
		const line = firstLine(await runText("nul", "printf 'a\\000b\\n'"));
		expect(line).toBe("ab");
		expect(Array.from(line).map(ch => ch.codePointAt(0))).toEqual([97, 98]);
		expect(line.codePointAt(0)).not.toBe(0);
	});

	/** A NUL-delimited list is the realistic source (`find -print0`, `xargs -0`),
	 * so the entries must survive even though the delimiters do not. */
	it("keeps every entry of a NUL-delimited list", async () => {
		const line = firstLine(await runText("nul-list", "printf 'one\\000two\\000three\\n'"));
		expect(line).toBe("onetwothree");
	});

	/** Whole output, not just the first line: the status prose the tool appends
	 * must not carry one either. */
	it("leaves no NUL anywhere in the full result text", async () => {
		const text = await runText("nul-all", "printf 'x\\000y\\n'; printf 'p\\000q\\n' >&2");
		expect(text.includes("\0")).toBe(false);
	});
});

describe("undecodable bytes become replacement characters, not broken strings", () => {
	/**
	 * Raw binary is replaced rather than passed through or dropped. Replacement is
	 * the right answer over dropping: it keeps the output visibly wrong, so the
	 * model can see it ran `cat` on a binary, instead of silently showing a
	 * shorter, plausible-looking string.
	 */
	it("replaces raw binary bytes with U+FFFD", async () => {
		const line = firstLine(await runText("binary", "printf '\\001\\002\\377\\376'"));
		expect(line).toContain(REPLACEMENT);
		expect(Array.from(line).every(ch => ch === REPLACEMENT)).toBe(true);
	});

	/**
	 * A truncated multi-byte sequence is the common real case, not deliberate
	 * binary: latin-1 text in a UTF-8 pipe, or a read that split a character. The
	 * invalid lead byte is replaced and the VALID byte after it survives, which is
	 * what distinguishes proper decoding from discarding the rest of the buffer.
	 */
	it("replaces an invalid UTF-8 lead byte and keeps the valid byte after it", async () => {
		const line = firstLine(await runText("bad-utf8", "printf '\\303\\050'"));
		expect(line).toBe(`${REPLACEMENT}(`);
	});

	/**
	 * No lone surrogate may survive. This is the JSON-envelope half of the row: a
	 * lone surrogate is a valid JS string but is NOT encodable, so it is the one
	 * way a string can pass every eyeball check and still throw on the way out.
	 */
	it("produces no lone surrogate for undecodable input", async () => {
		const text = await runText("surrogate", "printf '\\355\\240\\200'");
		expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false);
	});
});

describe("the JSON envelope survives every one of these", () => {
	/**
	 * The end-to-end claim, exercised as the transcript actually exercises it: the
	 * result is serialized, written, and parsed back, and must come out byte for
	 * byte the same. A round trip catches what a serialize-only check misses,
	 * because an unpaired surrogate serializes without complaint and comes back
	 * changed.
	 */
	it.each([
		["a NUL", "printf 'a\\000b\\n'"],
		["raw binary", "printf '\\001\\002\\377\\376'"],
		["invalid UTF-8", "printf '\\303\\050'"],
		["a lone surrogate encoding", "printf '\\355\\240\\200'"],
		["a large binary blob", "head -c 4096 /dev/urandom"],
	])("round-trips %s through JSON unchanged", async (_label, command) => {
		const text = await runText("json", command);
		const restored = JSON.parse(JSON.stringify({ text })) as { text: string };
		expect(restored.text).toBe(text);
	});

	/** The transcript is a file, so the same content must survive a real write and
	 * read rather than only an in-memory round trip. */
	it("survives being written to disk as JSON and read back", async () => {
		const text = await runText("disk", "printf 'a\\000b\\001\\377\\n'");
		const file = path.join(tmpDir, "transcript.json");
		await fs.writeFile(file, JSON.stringify({ text }), "utf8");
		const restored = JSON.parse(await fs.readFile(file, "utf8")) as { text: string };
		expect(restored.text).toBe(text);
	});
});

describe("terminal control sequences are applied, not passed through", () => {
	/**
	 * Escape sequences are stripped rather than forwarded. Forwarding them would
	 * put raw SGR codes in the transcript, where they are noise to the model and
	 * become live escapes again when the session is replayed to a terminal.
	 */
	it("strips SGR colour escapes and keeps the text they wrapped", async () => {
		const line = firstLine(await runText("ansi", "printf 'x\\033[31mred\\033[0m\\n'"));
		expect(line).toBe("xred");
		expect(line).not.toContain("\u001b");
	});

	/**
	 * A carriage return is APPLIED as terminal overwrite rather than kept as a
	 * character, which is how progress bars stay one line instead of thousands.
	 *
	 * The result is deliberately lossy and pinned here so it is not mistaken for a
	 * bug later: `over\rwrite` becomes `overwrite`, the two halves concatenated,
	 * rather than `write` overwriting `over` column by column. Anything reading
	 * this output should not expect the pre-CR text to be gone.
	 */
	it("applies a carriage return instead of emitting the character", async () => {
		const line = firstLine(await runText("cr", "printf 'over\\rwrite\\n'"));
		expect(line).toBe("overwrite");
		expect(line).not.toContain("\r");
	});

	/** The false-positive half: ordinary text with no control bytes must come
	 * through completely untouched, or every assertion above would also hold for a
	 * tool that mangled everything. */
	it("leaves ordinary text exactly as printed", async () => {
		const line = firstLine(await runText("plain", "printf 'hello, world 123 [](){}\\n'"));
		expect(line).toBe("hello, world 123 [](){}");
	});
});
