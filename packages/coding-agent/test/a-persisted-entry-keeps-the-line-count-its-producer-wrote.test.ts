/**
 * WHY: `prepareEntryForPersistence` rewrote a `lineCount` that sat beside a string `content` to
 * `content.split("\n").length` whenever another field of the same object changed on the way to disk:
 * a dropped `jsonlEvents`, or a sibling externalized to the blob store. A file mention's `content` is
 * the head of the file kept under the inline budget and its `lineCount` is the whole file's, so the
 * session file recorded the head's line count as the file's.
 *
 * The class: a persisted field that the pass neither externalizes nor drops differs from what its
 * producer wrote. Every case persists, loads through `resolveBlobRefsInEntries`, and compares the whole
 * entry with the producer's minus the dropped `jsonlEvents`, so a rewrite of any field fails it, not
 * only a rewrite of `lineCount`.
 *
 * Not caught: a rewrite confined to a shape none of these cases builds.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FileMentionMessage } from "@veyyon/coding-agent/session/messages";
import { generateFileMentionMessages } from "@veyyon/coding-agent/utils/file-mentions";
import { BlobStore, isTextBlobRef } from "@veyyon/kernel/session/blob-store";
import type { FileEntry } from "@veyyon/kernel/session/session-entries";
import { resolveBlobRefsInEntries } from "@veyyon/kernel/session/session-loader";
import { prepareEntryForPersistence } from "@veyyon/kernel/session/session-persistence";
import { TempDir } from "@veyyon/utils";

/** Longer than the 500,000 characters the pass keeps inline. */
const OVERSIZED = `${"q".repeat(500_001)}#tail`;

function messageEntry(message: object): FileEntry {
	return { type: "message", id: "e1", parentId: null, timestamp: new Date(0).toISOString(), message } as FileEntry;
}

/** The entry as a later session load reads it back. */
async function persistAndLoad(entry: FileEntry, blobStore: BlobStore): Promise<FileEntry> {
	const persisted = prepareEntryForPersistence(structuredClone(entry), blobStore);
	const loaded = JSON.parse(JSON.stringify(persisted)) as FileEntry;
	await resolveBlobRefsInEntries([loaded], blobStore);
	return loaded;
}

describe("a persisted entry keeps the line count its producer wrote", () => {
	it("keeps a mentioned file's whole-file line count beside the head it shows", async () => {
		using dir = TempDir.createSync("@persist-line-count-");
		const lines = 3_000;
		await fs.writeFile(
			path.join(dir.path(), "big.txt"),
			Array.from({ length: lines }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n"),
		);
		const [mention] = (await generateFileMentionMessages(["big.txt"], dir.path(), {})) as FileMentionMessage[];
		const file = mention!.files[0]!;
		// The producer's shape: a head of the file, counted as the whole file.
		expect(file.lineCount).toBe(lines);
		expect(file.content.split("\n").length).toBeLessThan(lines);

		const withLegacyField = { ...mention!, files: [{ ...file, jsonlEvents: [{ chunk: "raw" }] }] };
		const loaded = await persistAndLoad(messageEntry(withLegacyField), new BlobStore(dir.path()));

		expect(loaded).toEqual(messageEntry(mention!));
	});

	it("keeps a line count whose sibling is externalized to the blob store", async () => {
		using dir = TempDir.createSync("@persist-line-count-");
		const blobStore = new BlobStore(dir.path());
		const message = {
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "read",
			isError: false,
			timestamp: 0,
			content: "first line\nsecond line\n[2 of 900 lines shown]",
			lineCount: 900,
			details: { raw: OVERSIZED },
		};
		const persisted = prepareEntryForPersistence(messageEntry(message), blobStore) as unknown as {
			message: { details: { raw: string } };
		};
		expect(isTextBlobRef(persisted.message.details.raw)).toBe(true);

		expect(await persistAndLoad(messageEntry(message), blobStore)).toEqual(messageEntry(message));
	});

	it("keeps every field of an object whose content array changed", async () => {
		using dir = TempDir.createSync("@persist-line-count-");
		const message = {
			role: "custom",
			content: [{ type: "text", text: OVERSIZED }],
			lineCount: 40,
			display: true,
			timestamp: 0,
		};
		expect(await persistAndLoad(messageEntry(message), new BlobStore(dir.path()))).toEqual(messageEntry(message));
	});
});
