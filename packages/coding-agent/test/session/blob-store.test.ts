import { describe, expect, it } from "bun:test";
import {
	BlobStore,
	blobExtensionForImageMimeType,
	externalizeImageData,
	externalizeTextSync,
	isBlobRef,
	isTextBlobRef,
	parseBlobRef,
	parseTextBlobRef,
	resolveImageData,
	resolveTextBlobRef,
	resolveTextBlobRefSync,
} from "@veyyon/coding-agent/session/blob-store";
import { TempDir } from "@veyyon/utils";

describe("BlobStore image display paths", () => {
	it("creates an extension-bearing sidecar for image blobs while keeping canonical refs extensionless", async () => {
		using tempDir = TempDir.createSync("@veyyon-blob-store-image-link-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from("image-bytes");

		const result = await store.put(data, { extension: "png" });
		expect(result.path.endsWith(result.hash)).toBe(true);
		expect(result.displayPath).toBe(`${result.path}.png`);
		expect(result.ref).toBe(`blob:sha256:${result.hash}`);
		expect(await Bun.file(result.path).bytes()).toEqual(new Uint8Array(data));
		expect(await Bun.file(result.displayPath).bytes()).toEqual(new Uint8Array(data));
	});

	it("externalizes image data with a mime-derived display extension", async () => {
		using tempDir = TempDir.createSync("@veyyon-blob-store-image-link-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from("image-bytes");

		const ref = await externalizeImageData(store, data.toString("base64"), "image/webp");
		const hash = parseBlobRef(ref);

		expect(hash).toBeTruthy();
		expect(await Bun.file(`${tempDir.path()}/${hash}.webp`).bytes()).toEqual(new Uint8Array(data));
		expect(await resolveImageData(store, ref)).toBe(data.toString("base64"));
	});

	it("maps common image mime types to clickable file extensions", () => {
		expect(blobExtensionForImageMimeType("image/jpeg")).toBe("jpg");
		expect(blobExtensionForImageMimeType("image/png")).toBe("png");
		expect(blobExtensionForImageMimeType("text/plain")).toBeUndefined();
	});
});

/**
 * Unit coverage for the externalized-text blob primitives added for DATALOSS-2.
 * These back the persistence layer's "externalize large text instead of
 * truncating" behavior. The image and text ref namespaces must stay disjoint, and
 * text must round-trip through the store as UTF-8, not base64 (the image path).
 */
describe("BlobStore externalized text refs", () => {
	it("recognizes text refs and keeps them disjoint from image refs", () => {
		// WHY: a `blobtext:` string and a `blob:` string both start with "blob"; if the
		// predicates overlapped, the load path would decode text as base64 (or vice
		// versa) and silently corrupt content. This pins the two namespaces apart.
		const textRef = `blobtext:sha256:${"a".repeat(64)}`;
		const imageRef = `blob:sha256:${"a".repeat(64)}`;
		expect(isTextBlobRef(textRef)).toBe(true);
		expect(isTextBlobRef(imageRef)).toBe(false);
		expect(isBlobRef(imageRef)).toBe(true);
		expect(isBlobRef(textRef)).toBe(false);
		expect(isTextBlobRef("just some content")).toBe(false);
	});

	it("parses the hash out of a text ref and rejects non-refs", () => {
		// WHY: resolution keys on the parsed hash; a wrong parse means a wrong (or
		// missing) blob lookup. Non-refs must parse to null so plain strings pass
		// through resolution untouched.
		const hash = "b".repeat(64);
		expect(parseTextBlobRef(`blobtext:sha256:${hash}`)).toBe(hash);
		expect(parseTextBlobRef(`blob:sha256:${hash}`)).toBeNull();
		expect(parseTextBlobRef("not a ref")).toBeNull();
	});

	it("externalizes text as UTF-8 and resolves it back exactly (async and sync)", async () => {
		// WHY: the core round-trip. Text stored must come back byte-identical through
		// both the async load path and the sync path used on hot persistence rewrites.
		using tempDir = TempDir.createSync("@veyyon-blob-store-text-");
		const store = new BlobStore(tempDir.path());
		const original = 'a multiline\n\ttool result with unicode 🌊 and "quotes"';

		const ref = externalizeTextSync(store, original);
		expect(isTextBlobRef(ref)).toBe(true);
		// The blob is the raw UTF-8 bytes, addressable by its hash directly.
		const hash = parseTextBlobRef(ref) ?? "";
		expect((await store.get(hash))?.toString("utf8")).toBe(original);

		expect(await resolveTextBlobRef(store, ref)).toBe(original);
		expect(resolveTextBlobRefSync(store, ref)).toBe(original);
	});

	it("is idempotent and content-addressed", () => {
		// WHY: re-externalizing an existing ref must be a no-op (never a blob of a ref),
		// and identical inputs must yield one ref so repeated large outputs dedupe.
		using tempDir = TempDir.createSync("@veyyon-blob-store-text-");
		const store = new BlobStore(tempDir.path());
		const original = "x".repeat(10_000);

		const ref1 = externalizeTextSync(store, original);
		const ref2 = externalizeTextSync(store, original);
		expect(ref1).toBe(ref2);
		expect(externalizeTextSync(store, ref1)).toBe(ref1);
	});

	it("passes non-refs through resolution unchanged", async () => {
		// WHY: most strings are not refs; resolution must not touch them or hit the
		// store. A plain string returns itself with no blob lookup.
		using tempDir = TempDir.createSync("@veyyon-blob-store-text-");
		const store = new BlobStore(tempDir.path());
		expect(await resolveTextBlobRef(store, "plain content")).toBe("plain content");
		expect(resolveTextBlobRefSync(store, "plain content")).toBe("plain content");
	});

	it("returns the ref unchanged when the blob is missing", async () => {
		// WHY: a dangling ref (blob dir not copied) must not crash the load; resolution
		// logs and returns the ref so the rest of the session still opens.
		using tempDir = TempDir.createSync("@veyyon-blob-store-text-");
		const store = new BlobStore(tempDir.path());
		const missing = `blobtext:sha256:${"0".repeat(64)}`;
		expect(await resolveTextBlobRef(store, missing)).toBe(missing);
		expect(resolveTextBlobRefSync(store, missing)).toBe(missing);
	});
});
