/**
 * WHY. A submitted draft can carry several images, and each one is written to the blob store on its
 * own. The failure mode is partial: one write fails and the whole batch is dropped, so a message
 * that carried three pictures arrives with none of them and no error anybody sees, because the
 * writer swallows the throw by design (a picture is worth less than the turn).
 *
 * THE CLASS THIS CLOSES. A per-item side effect whose batch result is all-or-nothing. Both the async
 * and the sync entry point are swept, because the composer reaches one and the paste path the other,
 * and a fix applied to one of them is the defect this suite exists to catch. The positional contract
 * is asserted too: a caller lines links up with markers by index, so a failed slot has to stay in
 * place rather than compacting the array.
 *
 * WHAT IT DOES NOT CATCH. Whether the blob store itself writes correct bytes, which is its own
 * suite's subject, and whether the marker text that quotes these links renumbers correctly, which
 * `image-reference-markers.test.ts` owns.
 */

import { describe, expect, it } from "bun:test";
import type { ImageContent } from "@veyyon/ai";
import {
	materializeImageReferenceLinks,
	materializeImageReferenceLinksSync,
} from "@veyyon/coding-agent/modes/terminal/image-references";
import type { BlobPutResult } from "@veyyon/kernel/session/blob-store";

function image(mimeType: string, data = "AAAA"): ImageContent {
	return { type: "image", data, mimeType };
}

function result(displayPath: string): BlobPutResult {
	const hash = "0".repeat(64);
	return { hash, path: `/blobs/${hash}`, displayPath, get ref() {
		return `blob:sha256:${hash}`;
	} };
}

/** Records what each call was handed, so the extension the writer derives is observable. */
function recordingWriter(fail: (index: number) => boolean): {
	put: (data: Buffer, options?: { extension?: string }) => BlobPutResult;
	seen: { bytes: string; extension: string | undefined }[];
} {
	const seen: { bytes: string; extension: string | undefined }[] = [];
	return {
		put: (data, options) => {
			const index = seen.length;
			seen.push({ bytes: data.toString("utf-8"), extension: options?.extension });
			if (fail(index)) throw new Error("blob store is full");
			return result(`image-${index}.out`);
		},
		seen,
	};
}

describe("a failed image write keeps the links that worked", () => {
	it("returns one link per image, in order, when every write lands", async () => {
		const writer = recordingWriter(() => false);
		const links = await materializeImageReferenceLinks(
			[image("image/png"), image("image/jpeg"), image("image/webp")],
			async (data, options) => writer.put(data, options),
		);
		expect(links).toEqual(["image-0.out", "image-1.out", "image-2.out"]);
	});

	it("keeps a failed write's slot so a caller's indexes still line up", async () => {
		const writer = recordingWriter(index => index === 1);
		const links = await materializeImageReferenceLinks(
			[image("image/png"), image("image/png"), image("image/png")],
			async (data, options) => writer.put(data, options),
		);
		expect(links).toEqual(["image-0.out", undefined, "image-2.out"]);
	});

	it("reports nothing when every write fails, rather than an array of holes", async () => {
		const writer = recordingWriter(() => true);
		const links = await materializeImageReferenceLinks([image("image/png"), image("image/png")], async (data, options) =>
			writer.put(data, options),
		);
		expect(links).toBeUndefined();
	});

	it("names the extension the image's own mime type resolves to", async () => {
		const writer = recordingWriter(() => false);
		await materializeImageReferenceLinks(
			[image("image/jpeg"), image("image/svg+xml"), image("application/pdf")],
			async (data, options) => writer.put(data, options),
		);
		expect(writer.seen.map(call => call.extension)).toEqual(["jpg", "svg", undefined]);
	});

	it("decodes the base64 payload once, per image", async () => {
		const writer = recordingWriter(() => false);
		await materializeImageReferenceLinks([image("image/png", "aGVsbG8=")], async (data, options) =>
			writer.put(data, options),
		);
		expect(writer.seen).toEqual([{ bytes: "hello", extension: "png" }]);
	});

	it("reports nothing for an absent or empty image list without touching the store", async () => {
		const writer = recordingWriter(() => false);
		const write = async (data: Buffer, options?: { extension?: string }): Promise<BlobPutResult> =>
			writer.put(data, options);
		expect(await materializeImageReferenceLinks(undefined, write)).toBeUndefined();
		expect(await materializeImageReferenceLinks([], write)).toBeUndefined();
		expect(writer.seen).toEqual([]);
	});

	/**
	 * The sync path, asserted separately rather than through a shared loop: it is the one a paste
	 * reaches, it has its own copy of the try/catch, and a divergence between the two is exactly what
	 * this suite is for.
	 */
	it("holds the same contract on the sync path a paste reaches", () => {
		const writer = recordingWriter(index => index === 0);
		expect(
			materializeImageReferenceLinksSync([image("image/png"), image("image/gif")], (data, options) =>
				writer.put(data, options),
			),
		).toEqual([undefined, "image-1.out"]);
		expect(writer.seen.map(call => call.extension)).toEqual(["png", "gif"]);
		expect(materializeImageReferenceLinksSync(undefined, (data, options) => writer.put(data, options))).toBeUndefined();
		expect(
			materializeImageReferenceLinksSync([image("image/png")], () => {
				throw new Error("blob store is full");
			}),
		).toBeUndefined();
	});
});
