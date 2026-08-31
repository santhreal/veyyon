/**
 * WHY THIS EXISTS. `modes/image-references.ts` was split out of the composer so the launch path
 * stops paying for the blob store, `fs` and the logger, and the half that survived the split — the
 * one that turns a pasted image into a path a marker can link to — shipped with no test naming it.
 * Its return shape is the load-bearing part: a caller reads `undefined` as "this draft has no image
 * links", and a per-image `undefined` as "this one image could not be written", so a collapsed
 * array and an array with a hole in it mean different things to the composer that renders them.
 *
 * THE CLASS THIS CLOSES. Not "the async arm returns a path" but "either arm disagrees with the other
 * about order, extension, a partial failure or a total failure". Both exported entry points run the
 * same table, driving a real `BlobStore` over a scratch directory, and the export sweep turns this
 * red when the module grows a third entry point the table does not cover.
 *
 * WHAT IT DOES NOT CATCH. Nothing about the marker text itself — the regex, the renumbering and the
 * rendering live in `image-reference-markers.ts` and are covered beside it. It also says nothing
 * about which callers pass a bound `put` and which pass a `putSync`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@veyyon/ai";
import * as imageReferences from "@veyyon/coding-agent/modes/image-references";
import { type BlobPutResult, BlobStore } from "@veyyon/coding-agent/session/blob-store";

const scratchDirs: string[] = [];

/** A blob directory that does not exist yet, so "nothing was written" is observable on disk. */
function blobDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-image-references-"));
	scratchDirs.push(root);
	return path.join(root, "blobs");
}

afterEach(() => {
	for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function image(text: string, mimeType = "image/png"): ImageContent {
	return { type: "image", data: Buffer.from(text).toString("base64"), mimeType };
}

type BlobOptions = { extension?: string } | undefined;
type Writer = (data: Buffer, options: BlobOptions) => BlobPutResult | Promise<BlobPutResult>;

/**
 * The two exported entry points, each driven through the writer shape its own callers pass. `run`
 * awaits the sync arm's plain return as well, so one table covers both without a branch per case.
 * The writer forwards the options it is handed, because the extension a link ends in is chosen by
 * the module under test and passed through this seam.
 */
const ARMS = [
	{
		name: "materializeImageReferenceLinks",
		run: (images: readonly ImageContent[] | undefined, write: Writer) =>
			imageReferences.materializeImageReferenceLinks(images, async (data, options) => await write(data, options)),
		writer:
			(store: BlobStore): Writer =>
			(data, options) =>
				store.put(data, options),
	},
	{
		name: "materializeImageReferenceLinksSync",
		run: async (images: readonly ImageContent[] | undefined, write: Writer) =>
			imageReferences.materializeImageReferenceLinksSync(
				images,
				(data, options) => write(data, options) as BlobPutResult,
			),
		writer:
			(store: BlobStore): Writer =>
			(data, options) =>
				store.putSync(data, options),
	},
] as const;

describe("a submitted draft turns each image into a blob path", () => {
	for (const arm of ARMS) {
		describe(arm.name, () => {
			it("writes every image in order and names each blob for its own mime type", async () => {
				const store = new BlobStore(blobDir());
				const links = await arm.run(
					[image("first", "image/png"), image("second", "image/jpeg")],
					arm.writer(store),
				);

				expect(links).toHaveLength(2);
				expect(links?.[0]).toEndWith(".png");
				expect(links?.[1]).toEndWith(".jpg");
				expect(fs.readFileSync(links?.[0] as string, "utf8")).toBe("first");
				expect(fs.readFileSync(links?.[1] as string, "utf8")).toBe("second");
			});

			it("leaves the extension off a payload whose mime type names no image format", async () => {
				const store = new BlobStore(blobDir());
				const links = await arm.run([image("bytes", "application/octet-stream")], arm.writer(store));

				expect(links).toHaveLength(1);
				expect(path.extname(links?.[0] as string)).toBe("");
				expect(fs.readFileSync(links?.[0] as string, "utf8")).toBe("bytes");
			});

			it("reports no links at all for a draft that carries no image", async () => {
				const store = new BlobStore(blobDir());

				expect(await arm.run(undefined, arm.writer(store))).toBeUndefined();
				expect(await arm.run([], arm.writer(store))).toBeUndefined();
				expect(fs.existsSync(store.dir)).toBe(false);
			});

			it("keeps the images it could write and holds a place for the one it could not", async () => {
				const store = new BlobStore(blobDir());
				const real = arm.writer(store);
				const links = await arm.run([image("kept"), image("lost"), image("also kept")], (data, options) => {
					if (data.toString("utf8") === "lost") throw new Error("blob store is full");
					return real(data, options);
				});

				expect(links).toHaveLength(3);
				expect(links?.[0]).toEndWith(".png");
				expect(links?.[1]).toBeUndefined();
				expect(links?.[2]).toEndWith(".png");
			});

			it("collapses to no links when not one image could be written", async () => {
				const links = await arm.run([image("one"), image("two")], () => {
					throw new Error("blob store is read-only");
				});

				expect(links).toBeUndefined();
			});
		});
	}

	/**
	 * Pinned by exact equality, so a third entry point is a decision recorded in the table above
	 * rather than an export nothing drives.
	 */
	it("drives every entry point the module exports", () => {
		expect(Object.keys(imageReferences).sort()).toEqual(ARMS.map(arm => arm.name).sort());
	});
});
