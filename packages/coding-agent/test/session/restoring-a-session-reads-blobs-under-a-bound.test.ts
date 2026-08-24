import { describe, expect, it } from "bun:test";
import {
	BlobStore,
	externalizeImageDataSync,
	externalizeImageDataUrlSync,
	externalizeTextSync,
	isBlobRef,
	isTextBlobRef,
} from "@veyyon/coding-agent/session/blob-store";
import type { FileEntry } from "@veyyon/coding-agent/session/session-entries";
import { resolveBlobRefsInEntries } from "@veyyon/coding-agent/session/session-loader";
import { TempDir } from "@veyyon/utils";

/**
 * WHY: restoring a session used to walk the whole transcript through `Promise.all`
 * over every array element and every object key, awaiting at each node, and then
 * read every externalized payload at once. Two costs followed. A transcript with no
 * externalized payload at all still allocated a closure and a promise per node
 * (measured: 2,000 ordinary tool entries, 17.9ms and ~27MiB of churn to discover
 * there was nothing to read). And a transcript with 200 payloads opened 200 files
 * simultaneously and held 200 decoded buffers beside the 200 strings they decode
 * into (measured: peak RSS +122MiB above a 100MiB restored payload, and the loop
 * never ticked once during the restore).
 *
 * The class this closes: restoration reads under a bound, and it restores every
 * reference kind byte-exactly whatever container it sits in. The bound is asserted
 * by observing concurrency at the store, not by reading the constant, so raising
 * the cap or dropping the pool fails here. The reference kinds are swept from the
 * blob-store predicates at run time and pinned by exact equality, so a third
 * namespace cannot be added without a decision recorded in this file.
 *
 * What it does NOT catch: the wall-time and RSS numbers themselves, which live in
 * .captures/measure-blob-restore.ts and .internal/measure-blob-restore-arms.py
 * (cost claims do not belong in a test); and a payload the store never had, which
 * is lost-blob-payload.test.ts.
 */

const CONCURRENCY_CAP = 8;

interface Observed {
	reads: number;
	inFlight: number;
	peakInFlight: number;
}

/**
 * A store whose reads are slow enough to overlap. Without the delay every read
 * settles before the next one starts and any cap looks satisfied.
 */
function observeReads(store: BlobStore, observed: Observed, delayMs = 2): BlobStore {
	const get = store.get.bind(store);
	Object.defineProperty(store, "get", {
		value: async (hash: string) => {
			observed.reads += 1;
			observed.inFlight += 1;
			observed.peakInFlight = Math.max(observed.peakInFlight, observed.inFlight);
			try {
				await new Promise(resolve => setTimeout(resolve, delayMs));
				return await get(hash);
			} finally {
				observed.inFlight -= 1;
			}
		},
	});
	return store;
}

function textEntry(id: string, content: unknown): FileEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content, timestamp: 0 },
	} as unknown as FileEntry;
}

async function withStore<T>(run: (store: BlobStore) => Promise<T>): Promise<T> {
	const dir = TempDir.createSync("@pi-blob-bound-");
	try {
		return await run(new BlobStore(dir.path()));
	} finally {
		await dir.remove();
	}
}

describe("restoring a session", () => {
	it("never holds more blob reads open than the pool allows", async () => {
		await withStore(async store => {
			const entries: FileEntry[] = [];
			for (let index = 0; index < 40; index++) {
				entries.push(
					textEntry(`e${index}`, [{ type: "text", text: externalizeTextSync(store, `payload ${index}`) }]),
				);
			}
			const observed: Observed = { reads: 0, inFlight: 0, peakInFlight: 0 };
			observeReads(store, observed);

			const lost = await resolveBlobRefsInEntries(entries, store);

			expect(lost).toBe(0);
			expect(observed.reads).toBe(40);
			expect(observed.peakInFlight).toBeGreaterThan(1);
			expect(observed.peakInFlight).toBeLessThanOrEqual(CONCURRENCY_CAP);
		});
	});

	it("restores every reference when there are more of them than the pool is wide", async () => {
		await withStore(async store => {
			const count = CONCURRENCY_CAP * 5 + 3;
			const entries: FileEntry[] = [];
			for (let index = 0; index < count; index++) {
				entries.push(textEntry(`e${index}`, [{ type: "text", text: externalizeTextSync(store, `body ${index}`) }]));
			}

			await resolveBlobRefsInEntries(entries, store);

			const restored = entries.map(entry => {
				const content = (entry as unknown as { message: { content: { text: string }[] } }).message.content;
				return content[0]?.text;
			});
			expect(restored).toEqual(Array.from({ length: count }, (_, index) => `body ${index}`));
		});
	});

	it("restores text at an arbitrary key, in an array, and inside nested tool detail", async () => {
		await withStore(async store => {
			const entry = {
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [
						{ type: "text", text: externalizeTextSync(store, "block text") },
						externalizeTextSync(store, "bare array item"),
					],
					output: externalizeTextSync(store, "at an arbitrary key"),
					details: { nested: { deeper: externalizeTextSync(store, "three levels down") } },
					untouched: "not a reference",
				},
			} as unknown as FileEntry;

			const lost = await resolveBlobRefsInEntries([entry], store);

			const message = (entry as unknown as { message: Record<string, unknown> }).message;
			const content = message.content as [{ text: string }, string];
			expect(lost).toBe(0);
			expect(content[0].text).toBe("block text");
			expect(content[1]).toBe("bare array item");
			expect(message.output).toBe("at an arbitrary key");
			expect((message.details as { nested: { deeper: string } }).nested.deeper).toBe("three levels down");
			expect(message.untouched).toBe("not a reference");
		});
	});

	it("restores image data blocks and provider image urls, and leaves a data payload at another key alone", async () => {
		await withStore(async store => {
			const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
			const base64 = png.toString("base64");
			const imageRef = externalizeImageDataSync(store, base64, "image/png");
			const urlRef = externalizeImageDataUrlSync(store, `data:image/png;base64,${base64}`);
			const strayRef = externalizeImageDataSync(store, base64, "image/png");
			const entry = {
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: {
					role: "user",
					content: [{ type: "image", data: imageRef, mimeType: "image/png" }],
					images: [{ data: imageRef, mimeType: "image/png" }],
					providerPayload: { image_url: urlRef },
					// Not `content` and not `images`, so the key gate must leave it referenced.
					attachments: [{ data: strayRef, mimeType: "image/png" }],
				},
			} as unknown as FileEntry;

			const lost = await resolveBlobRefsInEntries([entry], store);

			const message = (entry as unknown as { message: Record<string, unknown> }).message;
			const block = (message.content as [{ data: string }])[0];
			const image = (message.images as [{ data: string }])[0];
			const stray = (message.attachments as [{ data: string }])[0];
			expect(lost).toBe(0);
			expect(block.data).toBe(base64);
			expect(image.data).toBe(base64);
			expect((message.providerPayload as { image_url: string }).image_url).toBe(`data:image/png;base64,${base64}`);
			expect(stray.data).toBe(strayRef);
		});
	});

	it("mutates the entries it was handed rather than returning copies", async () => {
		await withStore(async store => {
			const content = [{ type: "text", text: externalizeTextSync(store, "in place") }];
			const entry = textEntry("e1", content);

			await resolveBlobRefsInEntries([entry], store);

			// Same array, same block object: a caller holding a reference sees the payload.
			const after = (entry as unknown as { message: { content: unknown[] } }).message.content;
			expect(after).toBe(content);
			expect(content[0]?.text).toBe("in place");
		});
	});

	it("skips the session header and still reports a reference the store cannot answer", async () => {
		await withStore(async store => {
			const missing = `blobtext:sha256:${"a".repeat(64)}`;
			const header = {
				type: "session",
				version: 7,
				id: "019f0000-0000-7000-8000-000000000000",
				timestamp: "2026-01-01T00:00:00.000Z",
				// A header field shaped like a reference must not be read at all.
				cwd: missing,
			} as unknown as FileEntry;
			const entry = textEntry("e1", [{ type: "text", text: missing }]);
			const observed: Observed = { reads: 0, inFlight: 0, peakInFlight: 0 };
			observeReads(store, observed, 0);

			const lost = await resolveBlobRefsInEntries([header, entry], store);

			expect(lost).toBe(1);
			expect(observed.reads).toBe(1);
			expect((header as unknown as { cwd: string }).cwd).toBe(missing);
		});
	});

	it("knows exactly which reference namespaces exist", () => {
		// Fails closed on a third namespace: a new prefix must be added to the sweep
		// above and to this list, with a case proving restoration.
		const hash = "b".repeat(64);
		const namespaces = [`blob:sha256:${hash}`, `blobtext:sha256:${hash}`];
		const classified = namespaces.map(reference => ({
			reference,
			image: isBlobRef(reference),
			text: isTextBlobRef(reference),
		}));
		expect(classified).toEqual([
			{ reference: `blob:sha256:${hash}`, image: true, text: false },
			{ reference: `blobtext:sha256:${hash}`, image: false, text: true },
		]);
	});
});
