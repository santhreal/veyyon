/**
 * WHY THIS SUITE EXISTS:
 * An `@path` mention is recorded as its own session message whose files live
 * under `files`, not under `content`. The GUI host's converter read `content`
 * for every role, so a mention converted to an empty entry: the prompt named a
 * path, the reply described what was in it, and the desktop transcript drew
 * neither. Nothing in the window stated that a file had been read at all.
 *
 * THE CLASS THIS CLOSES:
 * 1. A message whose payload is not `content` converting to nothing.
 * 2. A file whose body was withheld arriving as one the desktop can open. The
 *    skip reasons are keyed off the message type by `MENTION_UNAVAILABLE`, so
 *    a new `skippedReason` variant fails `check:ts` at the converter and fails
 *    the exhaustive table here.
 * 3. A read file arriving without the line count or byte size the collapsed
 *    artifact row states.
 *
 * WHAT IT DOES NOT CATCH:
 * Which turn the block draws on, and whether the artifact row paints, which is
 * `crates/veyyon-desktop/tests/a-file-the-prompt-named-is-drawn-on-the-turn-that-named-it.rs`
 * and the surface crate's artifact suites. A live turn's socket frames are
 * covered by `a-prompt-submitted-from-the-desktop-runs-a-real-turn.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import { TempDir } from "@veyyon/utils";
import { agentMessageToTranscriptEntry } from "../../src/gui-host/transcript-conversion";
import type { ContentBlock } from "../../src/gui-host/wire";
import type { FileMentionMessage } from "../../src/session/messages";
import { extractFileMentions, generateFileMentionMessages } from "../../src/utils/file-mentions";

type MentionFile = FileMentionMessage["files"][number];

/** A 1x1 PNG, so the image arm decodes to real dimensions on the desktop. */
const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

/**
 * The words the transcript shows for a body that was not read, keyed by the
 * union the session message declares. A third skip reason fails to compile.
 */
const EXPECTED_REASON: Record<NonNullable<MentionFile["skippedReason"]>, string> = {
	tooLarge: "too large to read",
	binary: "binary file",
};

function mentionMessage(files: MentionFile[]): FileMentionMessage {
	return { role: "fileMention", files, timestamp: 1_700_000_000_000 };
}

function blocksOf(message: FileMentionMessage): ContentBlock[] {
	const entry = agentMessageToTranscriptEntry(message as AgentMessage, 7, "m-1");
	expect(entry.role).toBe("FileMention");
	return entry.content;
}

function mentionOf(block: ContentBlock | undefined): Extract<ContentBlock, { FileMention: unknown }>["FileMention"] {
	if (!block || !("FileMention" in block))
		throw new Error(`expected a FileMention block, got ${JSON.stringify(block)}`);
	return block.FileMention;
}

describe("a mention the session recorded reaches the desktop as blocks", () => {
	test("the files a real prompt read arrive with what the row states", async () => {
		await using dir = await TempDir.create();
		const cwd = dir.path();
		await writeFile(join(cwd, "notes.md"), "one\ntwo\nthree\n");
		await writeFile(join(cwd, "empty.txt"), "");
		await writeFile(join(cwd, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 0, 7, 0]));
		await writeFile(join(cwd, "pixel.png"), Buffer.from(ONE_PIXEL_PNG, "base64"));
		await mkdir(join(cwd, "pkg"));
		await writeFile(join(cwd, "pkg", "a.ts"), "export const a = 1;\n");

		const mentioned = extractFileMentions("read @notes.md @empty.txt @blob.bin @pixel.png @pkg and report");
		expect(mentioned).toEqual(["notes.md", "empty.txt", "blob.bin", "pixel.png", "pkg"]);

		const produced = await generateFileMentionMessages(mentioned, cwd, {});
		expect(produced).toHaveLength(1);
		const message = produced[0] as FileMentionMessage;
		const blocks = blocksOf(message);

		// Nothing the reader measured is dropped on the way to the row, and the
		// order the prompt named the paths in is the order they draw in.
		expect(blocks).toHaveLength(message.files.length);
		for (const [ix, file] of message.files.entries()) {
			const block = mentionOf(blocks[ix]);
			expect(block.path).toBe(file.path);
			expect(block.lines).toBe(file.lineCount ?? null);
			expect(block.bytes).toBe(file.byteSize ?? null);
		}

		const byPath = new Map(blocks.map(block => [mentionOf(block).path, mentionOf(block)]));
		expect([...byPath.keys()].sort()).toEqual(["blob.bin", "empty.txt", "notes.md", "pixel.png", "pkg"]);

		const notes = byPath.get("notes.md");
		expect(notes?.has_content).toBe(true);
		expect(notes?.lines).toBeGreaterThan(0);
		expect(notes?.unavailable_reason).toBeNull();
		expect(notes?.image).toBeNull();

		// A file that really was empty is not one the desktop offers to open,
		// and it states no reason, because nothing was withheld.
		const empty = byPath.get("empty.txt");
		expect(empty?.has_content).toBe(false);
		expect(empty?.unavailable_reason).toBeNull();

		const binary = byPath.get("blob.bin");
		expect(binary?.has_content).toBe(false);
		expect(binary?.unavailable_reason).toBe(EXPECTED_REASON.binary);
		expect(binary?.bytes).toBe(8);

		// The image travels as bytes the desktop decodes for its dimensions,
		// never as the base64 the session holds.
		const image = byPath.get("pixel.png");
		expect(image?.image?.slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);

		const listing = byPath.get("pkg");
		expect(listing?.has_content).toBe(true);
		expect(listing?.lines).toBeGreaterThan(0);
	});

	test("every reason a body was withheld is stated in words and closes the body", () => {
		for (const [reason, words] of Object.entries(EXPECTED_REASON)) {
			const skippedReason = reason as NonNullable<MentionFile["skippedReason"]>;
			const blocks = blocksOf(
				mentionMessage([
					{
						path: "big.log",
						content: "(skipped auto-read: too large, 9.0 MB)",
						byteSize: 9_000_000,
						skippedReason,
					},
				]),
			);
			const file = mentionOf(blocks[0]);
			expect(file.unavailable_reason).toBe(words);
			expect(file.has_content).toBe(false);
			expect(file.bytes).toBe(9_000_000);
		}
	});

	test("a body a collab replica never received is not drawn as an empty file", () => {
		const withheld = mentionOf(
			blocksOf(mentionMessage([{ path: "src/app.ts", content: "", contentNotReplicated: true, lineCount: 40 }]))[0],
		);
		expect(withheld.unavailable_reason).toBe("content not replicated");
		expect(withheld.has_content).toBe(false);
		expect(withheld.lines).toBe(40);

		// The same empty string with the flag off is a file that was read and
		// had nothing in it, which states no reason at all.
		const genuinely = mentionOf(
			blocksOf(mentionMessage([{ path: "src/app.ts", content: "", contentNotReplicated: false, lineCount: 0 }]))[0],
		);
		expect(genuinely.unavailable_reason).toBeNull();
		expect(genuinely.has_content).toBe(false);
	});

	test("a mention that read nothing converts to no blocks", () => {
		expect(blocksOf(mentionMessage([]))).toEqual([]);
	});
});
