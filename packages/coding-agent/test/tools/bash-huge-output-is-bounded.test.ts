/**
 * Enormous command output is bounded before it reaches the model, and nothing is
 * lost in the process.
 *
 * WHY THIS SUITE EXISTS (EXEC-1). `cat` on a log, a build with verbose logging,
 * `seq` with a typo: any of them produces tens of megabytes, and there are two
 * distinct ways that goes wrong. The output can exhaust memory and take the
 * process down, or it can be inlined into the conversation and blow the context
 * window in a single tool result, which costs the session just as surely and
 * costs money on the way.
 *
 * The design that prevents both is worth stating, because the tests below are
 * organized around it: the inline text is capped at
 * {@link DEFAULT_MAX_BYTES}, the middle is elided rather than the tail, and the
 * COMPLETE raw stream is written to an artifact on disk that the result points
 * at. Keeping both ends matters more than it sounds: a command's first lines
 * carry the invocation and its last lines carry the error, so tail-only
 * truncation throws away the half that says what ran and head-only throws away
 * the half that says what went wrong.
 *
 * Two things every test here insists on, because a cap alone is easy and useless:
 *
 *   - the elision is REPORTED, with exact byte and line counts, so neither the
 *     model nor the operator can mistake a truncated result for a complete one,
 *   - nothing is DISCARDED, so the artifact holds the full stream byte for byte
 *     and the elided middle remains recoverable.
 *
 * A cap that silently dropped the middle would pass a naive size assertion and
 * would be a data-loss bug.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_MAX_BYTES } from "@veyyon/coding-agent/session/streaming-output";
import { BashTool } from "@veyyon/coding-agent/tools/bash";
// The real shape the tool emits. A local all-optional copy used to stand here,
// which let every assertion in this file read a field the type said might not
// exist, so nothing could prove one was actually populated.
import type { TruncationMeta } from "@veyyon/coding-agent/tools/output-meta";
import { removeWithRetries } from "@veyyon/utils";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { makeToolSession } from "../helpers/tool-session";

useIsolatedGlobalSettings();

let tmpDir: string;
/** Every artifact path handed out, so a test can read back what was preserved. */
let artifactPaths: string[];

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-huge-output-"));
	artifactPaths = [];
});

afterEach(async () => {
	await removeWithRetries(tmpDir);
});

function bashTool(): BashTool {
	return new BashTool(
		makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			getSessionId: () => "bash-huge-output",
			allocateOutputArtifact: async (kind: string) => {
				const file = path.join(tmpDir, `${kind}-${artifactPaths.length}.txt`);
				artifactPaths.push(file);
				return { id: `${kind}-${artifactPaths.length}`, path: file };
			},
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
}

async function run(
	id: string,
	command: string,
): Promise<{ text: string; bytes: number; truncation: TruncationMeta | undefined }> {
	const result = await bashTool().execute(id, { command, timeout: 180 });
	const text = (result.content ?? [])
		.filter(block => block.type === "text")
		.map(block => (block as { text: string }).text)
		.join("");
	const details = result.details as { meta?: { truncation?: TruncationMeta } } | undefined;
	return { text, bytes: Buffer.byteLength(text, "utf-8"), truncation: details?.meta?.truncation };
}

/** A generous ceiling on the inline result: the cap plus room for the wall-time
 * and artifact-reference lines the tool appends. Deliberately not exact, so the
 * test asserts the BOUND rather than re-deriving the formatter's arithmetic. */
const INLINE_CEILING = DEFAULT_MAX_BYTES * 2;

describe("a multi-megabyte stream is capped, not inlined", () => {
	/**
	 * 400k lines, about 2.7MB. Far past anything that belongs in a context window,
	 * and the inline result must come back a tiny fraction of it.
	 */
	it("returns kilobytes inline for a 2.7MB stream", async () => {
		const { bytes, truncation } = await run("many-lines", "seq 1 400000");

		expect(truncation?.totalBytes).toBeGreaterThan(2_000_000);
		expect(bytes).toBeLessThan(INLINE_CEILING);
	});

	/**
	 * ~47MB, the scale this row was actually filed about. Kept in the suite despite
	 * its size because it costs well under a second: the point of the design is
	 * that cost does not scale with output, and a test that only ever ran at 2MB
	 * could not tell that from a cap that happened to work at small sizes.
	 */
	it("returns kilobytes inline for a 47MB stream", async () => {
		const { bytes, truncation } = await run("huge", "seq 1 6000000");

		expect(truncation?.totalBytes).toBeGreaterThan(40_000_000);
		expect(bytes).toBeLessThan(INLINE_CEILING);
	});

	/**
	 * The adversarial shape: 20MB with no newline anywhere. Truncation trims to
	 * line boundaries, and a single line offers none, so a naive implementation
	 * either keeps everything (defeating the cap) or keeps nothing.
	 */
	it("bounds a 20MB single line that offers no line boundary to trim to", async () => {
		const { bytes, truncation } = await run("one-line", "head -c 20000000 /dev/zero | tr '\\0' 'x'");

		expect(truncation?.totalBytes).toBe(20_000_000);
		expect(bytes).toBeLessThan(INLINE_CEILING);
	});
});

describe("both ends survive, because each answers a different question", () => {
	/**
	 * The head is the first line of output, not the 5,000th. Losing it means losing
	 * what the command was doing, which is usually the only context for the error
	 * at the other end.
	 */
	it("keeps the very first line", async () => {
		const { text, truncation } = await run("head", "seq 1 400000");

		expect(text.startsWith("1\n2\n3\n")).toBe(true);
		expect(truncation?.headRange?.start).toBe(1);
	});

	/**
	 * The tail is the last line, which for a failing command is the error. A cap
	 * that kept only the head would be worse than useless here: it would return
	 * 50KB of preamble and drop the one line that mattered.
	 */
	it("keeps the very last line", async () => {
		const { text, truncation } = await run("tail", "seq 1 400000");

		expect(text).toContain("\n400000\n");
		expect(truncation?.tailRange?.end).toBe(400_001);
	});

	/** The middle is what goes, and the metadata says so explicitly rather than
	 * leaving the direction to be inferred from the ranges. */
	it("elides the middle rather than either end", async () => {
		const { truncation } = await run("middle", "seq 1 400000");

		expect(truncation?.direction).toBe("middle");
		expect(truncation?.truncatedBy).toBe("middle");
	});
});

describe("the elision is reported, never silent", () => {
	/**
	 * THE assertion that separates this from a silent truncation bug. A result that
	 * is quietly missing 388,000 lines reads as complete, and the model draws a
	 * confident conclusion from a fraction of the evidence: `grep` finds nothing
	 * because the matches were in the elided middle, and the answer comes back
	 * "there are no matches".
	 *
	 * Exact counts, not just a flag, because "output was truncated" does not tell
	 * anyone whether they lost 3 lines or 400,000.
	 */
	it("reports exact elided byte and line counts", async () => {
		const { truncation } = await run("counts", "seq 1 400000");

		expect(truncation?.totalLines).toBe(400_001);
		expect(truncation?.elidedLines).toBeGreaterThan(300_000);
		expect(truncation?.elidedBytes).toBeGreaterThan(2_000_000);
	});

	/**
	 * The counts RECONCILE against the whole stream, which is what makes them
	 * evidence rather than decoration. A metadata block that does not add up cannot
	 * be used to judge how much was lost.
	 *
	 * The two fields are measured against different things, and the arithmetic here
	 * is written to say so rather than to paper over it. `elidedBytes` counts bytes
	 * of the ORIGINAL that were dropped, while `outputBytes` counts bytes of the
	 * COMPOSED result, which additionally contains the elision marker and the two
	 * newlines around it. So they overshoot the total by exactly the marker, and
	 * that exact overshoot is the assertion. Demanding a plain sum instead fails by
	 * a couple of dozen bytes and looks like a real accounting bug, which is how
	 * this test was first written.
	 */
	it("reconciles kept plus elided against the total, to the byte", async () => {
		const { text, truncation } = await run("reconcile", "seq 1 400000");

		const marker = /\[…[^\]]*elided…\]/.exec(text)?.[0];
		expect(marker).toBeTruthy();

		const overshoot = (truncation?.elidedBytes ?? 0) + (truncation?.outputBytes ?? 0) - (truncation?.totalBytes ?? 0);
		expect(overshoot).toBe(Buffer.byteLength(marker as string, "utf-8") + 2);
	});

	/** A visible marker in the text itself, since the model reads the text and not
	 * the details object. */
	it("marks the elision inline where the model will see it", async () => {
		const { text } = await run("marker", "seq 1 400000");

		expect(text).toMatch(/elided/i);
	});

	/** And a pointer to the full stream, so the elision is recoverable rather than
	 * merely announced. */
	it("points at the artifact holding the raw output", async () => {
		const { text, truncation } = await run("ref", "seq 1 400000");

		expect(text).toContain("artifact://");
		expect(truncation?.artifactId).toBeTruthy();
	});
});

describe("nothing is discarded: the artifact holds the complete stream", () => {
	/**
	 * The claim that makes the cap acceptable rather than lossy. Asserted by
	 * reading the file off disk and checking its SIZE against the reported total
	 * and its CONTENT at both ends, because a file that exists proves nothing about
	 * whether the middle survived.
	 *
	 * Without this, every other test in this file is satisfied by an implementation
	 * that throws the middle away.
	 */
	it("writes every byte of a 2.7MB stream to disk, including the elided middle", async () => {
		const { truncation } = await run("artifact", "seq 1 400000");

		// Establish the total before it is used to pick the artifact. Reaching the
		// lookup with `undefined` would search for a size no file has and fail on
		// the missing file, blaming the artifact for a truncation that never ran.
		if (truncation === undefined)
			throw new Error("the 2.7MB stream was not truncated, so there is no artifact to check");
		const totalBytes = truncation.totalBytes;
		expect(totalBytes).toBeGreaterThan(2_000_000);

		const sizes = await Promise.all(
			artifactPaths.map(async file => {
				try {
					return (await fs.stat(file)).size;
				} catch {
					return 0;
				}
			}),
		);
		expect(sizes).toContain(totalBytes);

		const full = artifactPaths[sizes.indexOf(totalBytes)];
		const content = await fs.readFile(full as string, "utf-8");
		expect(content.startsWith("1\n2\n3\n")).toBe(true);
		expect(content.endsWith("400000\n")).toBe(true);
		// A line from the elided middle, the one place a lossy implementation would
		// differ from a correct one.
		expect(content).toContain("\n200000\n");
	});
});

describe("small output is left completely alone", () => {
	/**
	 * The false-positive half. Every assertion above would also hold for a tool
	 * that truncated everything, and a cap that fired on ordinary output would be a
	 * far worse bug than the one this row is about, because it would corrupt the
	 * results the agent relies on all day.
	 */
	it("returns short output verbatim with no truncation metadata", async () => {
		const { text, truncation } = await run("small", "seq 1 20");

		expect(text.startsWith("1\n2\n3\n")).toBe(true);
		expect(text).toContain("\n20\n");
		expect(text).not.toMatch(/elided/i);
		expect(truncation).toBeUndefined();
	});

	/** The boundary itself: output just under the cap must survive intact, or the
	 * cap is firing early. */
	it("leaves output just under the cap untouched", async () => {
		const lines = Math.floor((DEFAULT_MAX_BYTES * 0.5) / 5);
		const { text, truncation } = await run("under-cap", `seq 1 ${lines}`);

		expect(truncation).toBeUndefined();
		expect(text).toContain(`\n${lines}\n`);
	});
});
