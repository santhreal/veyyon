import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { guardDestructivePath } from "../../../utils/test/helpers/destructive-guard";
import { createIntegrationWorkspace, type IntegrationWorkspace } from "../helpers/integration-workspace";

/**
 * Path-containment and file-integrity contracts, exercised end to end: a scripted
 * model issues real tool calls and the assertions read the real bytes back off
 * disk.
 *
 * Two classes of failure are covered, and both are the kind only a real
 * filesystem can prove:
 *
 *  1. CONTAINMENT — where a tool call actually lands for each way a path can be
 *     spelled (`../`, an absolute path elsewhere, a path that walks out and back
 *     in). NOTE: the write tool performs NO cwd containment today; these tests
 *     pin that real behavior rather than a wished-for one, so adding containment
 *     later is a visible, deliberate change. A mocked fs cannot show an escape.
 *  2. CORRUPTION — content that survives a round trip must survive it EXACTLY.
 *     The classic silent corruptions are truncation residue (overwriting a long
 *     file with a short one leaving the old tail behind), newline rewriting
 *     (CRLF silently normalised to LF), a trailing newline being added or
 *     dropped, and non-ASCII being mangled by an encoding assumption.
 */
describe("file writes stay inside the workspace and preserve bytes exactly", () => {
	let workspace: IntegrationWorkspace | undefined;

	afterEach(() => {
		workspace?.dispose();
		workspace = undefined;
	});

	/** Script a single write and run it. */
	async function write(filePath: string, content: string): Promise<IntegrationWorkspace> {
		const ws = await createIntegrationWorkspace({
			script: [
				{ content: [{ type: "toolCall", name: "write", arguments: { path: filePath, content } }] },
				{ content: ["ok"] },
			],
		});
		workspace = ws;
		await ws.send("write it");
		return ws;
	}

	describe("path containment", () => {
		/**
		 * PINS ACTUAL BEHAVIOR, NOT A WISH: the write tool performs NO cwd
		 * containment. `write.ts` has no path check at all, so a `../` path really
		 * does land outside the workspace root. That is a deliberate property of an
		 * agent that must sometimes write outside the project, and containment is
		 * expected to come from the approval layer ABOVE the tool (which this harness
		 * bypasses, since it drives tools directly with no approval hook).
		 *
		 * This test therefore documents the real contract so a future change is a
		 * visible decision rather than a silent one: if containment is ever added at
		 * the tool layer, this test SHOULD fail and be rewritten to assert refusal.
		 * See the ARG/INTEG ledger row on tool-layer path containment.
		 */
		test("a `../` traversal is not blocked at the tool layer (no cwd containment)", async () => {
			const ws = await write("../escaped.txt", "escaped");

			// Prove the target is disposable before asserting on (and deleting) it: this
			// test deliberately writes OUTSIDE its workspace, so the guard is what keeps
			// that from ever reaching real user data.
			const escaped = guardDestructivePath(path.join(path.dirname(ws.cwd), "escaped.txt"), "path containment");
			try {
				expect(fs.existsSync(escaped)).toBe(true);
				expect(fs.readFileSync(escaped, "utf8")).toBe("escaped");
			} finally {
				fs.rmSync(escaped, { force: true });
			}
		});

		test("a traversal that walks out and back in still resolves inside the workspace", async () => {
			const ws = await write("sub/../ok.txt", "fine");
			// Normalises to `ok.txt` INSIDE the workspace — containment is about the
			// resolved path, not the spelling, so this one is legitimately allowed.
			expect(ws.exists("ok.txt")).toBe(true);
			expect(ws.read("ok.txt")).toBe("fine");
		});

		/** Same actual-contract pin as above, for an absolute path outside the workspace. */
		test("an absolute path outside the workspace is not blocked at the tool layer", async () => {
			const outside = guardDestructivePath(
				path.join(os.tmpdir(), `veyyon-escape-${process.pid}-${Date.now()}.txt`),
				"path containment",
			);
			try {
				await write(outside, "outside");
				expect(fs.existsSync(outside)).toBe(true);
			} finally {
				fs.rmSync(outside, { force: true });
			}
		});

		test("a nested path creates its parent directories", async () => {
			const ws = await write("a/b/c/deep.txt", "deep\n");
			expect(ws.read("a/b/c/deep.txt")).toBe("deep\n");
		});
	});

	describe("byte fidelity", () => {
		test("overwriting a long file with a short one leaves NO residue of the old content", async () => {
			const long = `${"X".repeat(5000)}\nTAIL-MARKER\n`;
			const ws = await createIntegrationWorkspace({
				script: [
					{ content: [{ type: "toolCall", name: "write", arguments: { path: "f.txt", content: long } }] },
					{ content: [{ type: "toolCall", name: "write", arguments: { path: "f.txt", content: "short\n" } }] },
					{ content: ["ok"] },
				],
			});
			workspace = ws;
			await ws.send("truncate it");

			// A truncation bug (write without O_TRUNC / partial overwrite) leaves the
			// old tail behind — the exact-equality assertion is what catches it.
			expect(ws.read("f.txt")).toBe("short\n");
			expect(ws.read("f.txt")).not.toContain("TAIL-MARKER");
		});

		test("unicode, emoji and CJK survive the round trip byte for byte", async () => {
			const content = "héllo wörld — naïve café\n日本語テキスト\n🙂🚀👩‍💻\nΩ≈ç√∫\n";
			const ws = await write("unicode.txt", content);
			expect(ws.read("unicode.txt")).toBe(content);
		});

		test("CRLF line endings are preserved, not silently normalised to LF", async () => {
			const content = "line one\r\nline two\r\nline three\r\n";
			const ws = await write("crlf.txt", content);
			// Rewriting these to LF corrupts files on Windows checkouts and shows up as
			// a whole-file diff in review.
			expect(ws.read("crlf.txt")).toBe(content);
		});

		test("a file with no trailing newline does not gain one", async () => {
			const ws = await write("no-newline.txt", "no trailing newline");
			expect(ws.read("no-newline.txt")).toBe("no trailing newline");
		});

		test("an empty file is written as genuinely empty", async () => {
			const ws = await write("empty.txt", "");
			expect(ws.exists("empty.txt")).toBe(true);
			expect(ws.read("empty.txt")).toBe("");
		});

		test("content with embedded quotes, backslashes and braces is not re-escaped", async () => {
			// These are exactly the characters a JSON-transported tool argument can
			// double-escape somewhere along the path.
			const content = 'const re = /\\d+/g;\nconst s = "he said \\"hi\\"";\nconst o = { a: 1 };\n';
			const ws = await write("escapes.ts", content);
			expect(ws.read("escapes.ts")).toBe(content);
		});

		test("a large file round-trips exactly", async () => {
			const line = "the quick brown fox jumps over the lazy dog\n";
			const content = line.repeat(20_000); // ~880 KB
			const ws = await write("large.txt", content);
			const readBack = ws.read("large.txt");
			// Assert length AND content: a truncating write can still match a prefix check.
			expect(readBack.length).toBe(content.length);
			expect(readBack).toBe(content);
		});
	});
});
