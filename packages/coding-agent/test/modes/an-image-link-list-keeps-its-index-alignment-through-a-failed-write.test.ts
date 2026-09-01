// WHY: a submitted draft carries `[image #N]` markers, and the Nth marker resolves through
// position N-1 of the list this module returns. So a write that fails must leave a hole, never a
// shortened list: dropping the failure re-points every later marker at the wrong image, silently,
// with no error anywhere. The class this closes is "the returned list stops being index-aligned
// with the input images", plus the surrounding contract that a blob-store failure degrades the
// draft instead of rejecting the submission.
//
// The module ships the same logic twice, async and sync, and the recurring defect in a pair like
// that is a fix landing on one half. Every case here is swept over both, so a change to one that
// is not made to the other turns this red.
//
// Not covered: the markers themselves. The regex, the renumbering and the rendering are in
// `image-reference-markers.ts` and own their own suite; this one starts at the list they index into.

import { describe, expect, it, spyOn } from "bun:test";
import type { ImageContent } from "@veyyon/ai";
import * as logger from "@veyyon/utils/logger";
import { materializeImageReferenceLinks, materializeImageReferenceLinksSync } from "../../src/modes/image-references";
import type { BlobPutResult } from "../../src/session/blob-store";

function image(data: string, mimeType = "image/png"): ImageContent {
	return { type: "image", data: Buffer.from(data).toString("base64"), mimeType } as ImageContent;
}

function blobResult(displayPath: string): BlobPutResult {
	return {
		hash: "h",
		path: "/blobs/h",
		displayPath,
		get ref() {
			return `@${displayPath}`;
		},
	};
}

/**
 * The two exports differ only in whether `putBlob` is awaited, so every case runs against both.
 * `call` normalizes them to one async shape; `writer` wraps a plain function as the variant's
 * expected sync or async blob writer.
 */
const VARIANTS = [
	{
		name: "async",
		call: (
			images: readonly ImageContent[] | undefined,
			put: (d: Buffer, o?: { extension?: string }) => BlobPutResult,
		) => materializeImageReferenceLinks(images, async (d, o) => put(d, o)),
	},
	{
		name: "sync",
		call: (
			images: readonly ImageContent[] | undefined,
			put: (d: Buffer, o?: { extension?: string }) => BlobPutResult,
		) => Promise.resolve(materializeImageReferenceLinksSync(images, put)),
	},
] as const;

describe("an image link list keeps its index alignment through a failed write", () => {
	for (const variant of VARIANTS) {
		describe(variant.name, () => {
			it("returns undefined for no images at all", async () => {
				expect(await variant.call(undefined, () => blobResult("/a"))).toBeUndefined();
				expect(await variant.call([], () => blobResult("/a"))).toBeUndefined();
			});

			it("returns one display path per image, in order", async () => {
				let n = 0;
				const links = await variant.call([image("a"), image("b"), image("c")], () =>
					blobResult(`/blobs/${++n}.png`),
				);
				expect(links).toEqual(["/blobs/1.png", "/blobs/2.png", "/blobs/3.png"]);
			});

			it("leaves a hole at the failed index instead of shortening the list", async () => {
				// The defect this module exists to avoid: without the hole, marker #3 resolves to
				// the image that was pasted second.
				using warn = spyOn(logger, "warn").mockImplementation(() => {});
				let n = 0;
				const links = await variant.call([image("a"), image("b"), image("c")], () => {
					n += 1;
					if (n === 2) throw new Error("disk full");
					return blobResult(`/blobs/${n}.png`);
				});
				expect(links).toEqual(["/blobs/1.png", undefined, "/blobs/3.png"]);
				expect(warn.mock.calls.length).toBe(1);
			});

			it("reports the failing image by its one-based index", async () => {
				// The warning is the only trace a dropped image leaves, so the number in it has to
				// match the marker the user sees.
				using warn = spyOn(logger, "warn").mockImplementation(() => {});
				await variant.call([image("a"), image("b")], () => {
					throw new Error("disk full");
				});
				expect(warn.mock.calls.map(call => (call[1] as { index: number }).index)).toEqual([1, 2]);
			});

			it("returns undefined when every write failed", async () => {
				// A list of nothing but holes carries no links, and the caller treats undefined as
				// "this draft has no image references" rather than rendering dead markers.
				using _warn = spyOn(logger, "warn").mockImplementation(() => {});
				expect(
					await variant.call([image("a"), image("b")], () => {
						throw new Error("disk full");
					}),
				).toBeUndefined();
			});

			it("does not reject when the blob store throws", async () => {
				// A failed paste degrades the draft; it never fails the submission.
				using _warn = spyOn(logger, "warn").mockImplementation(() => {});
				const links = variant.call([image("a")], () => {
					throw new Error("disk full");
				});
				await expect(links).resolves.toBeUndefined();
			});

			it("passes the extension derived from the mime type", async () => {
				const seen: (string | undefined)[] = [];
				await variant.call([image("a", "image/jpeg"), image("b", "image/webp")], (_data, options) => {
					seen.push(options?.extension);
					return blobResult("/blobs/x");
				});
				expect(seen).toEqual(["jpg", "webp"]);
			});

			it("passes no extension for a mime type that is not an image", async () => {
				const seen: (string | undefined)[] = [];
				await variant.call([image("a", "application/pdf")], (_data, options) => {
					seen.push(options?.extension);
					return blobResult("/blobs/x");
				});
				expect(seen).toEqual([undefined]);
			});

			it("decodes the base64 payload before handing it to the store", async () => {
				// The store is handed bytes, not the transport encoding.
				let received: Buffer | undefined;
				await variant.call([image("hello")], data => {
					received = data;
					return blobResult("/blobs/x");
				});
				expect(received?.toString()).toBe("hello");
			});
		});
	}

	it("both variants agree on the same input", async () => {
		// The pair is the point: a fix to one half that misses the other shows up here even if the
		// swept cases above were only updated for one of them.
		const images = [image("a"), image("b"), image("c")];
		using _warn = spyOn(logger, "warn").mockImplementation(() => {});
		const fail = (n: number) => {
			let i = 0;
			return () => {
				i += 1;
				if (i === n) throw new Error("disk full");
				return blobResult(`/blobs/${i}.png`);
			};
		};
		const [asyncLinks, syncLinks] = await Promise.all([
			VARIANTS[0].call(images, fail(2)),
			VARIANTS[1].call(images, fail(2)),
		]);
		expect(asyncLinks).toEqual(syncLinks);
	});
});
