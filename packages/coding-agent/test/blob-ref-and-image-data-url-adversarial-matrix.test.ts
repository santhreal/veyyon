/**
 * isBlobRef / parseBlobRef / isImageDataUrl / isTextBlobRef adversarial matrix.
 * Why: session externalization must not misclassify paths or data URLs.
 * Prefixes: blob:sha256: and blobtext:sha256: (disjoint).
 */
import { describe, expect, it } from "bun:test";
import {
	blobExtensionForImageMimeType,
	isBlobRef,
	isImageDataUrl,
	isTextBlobRef,
	parseBlobRef,
} from "../src/session/blob-store";

const SHA = "a".repeat(64);
const BLOB = `blob:sha256:${SHA}`;
const TEXT_BLOB = `blobtext:sha256:${SHA}`;

describe("blob ref and image data url adversarial matrix", () => {
	it("isBlobRef exact prefix blob:sha256:", () => {
		expect(isBlobRef(BLOB)).toBe(true);
		expect(isBlobRef(`blob:sha256:`)).toBe(true);
		expect(isBlobRef(`blob:${SHA}`)).toBe(false);
		expect(isBlobRef("Blob:sha256:x")).toBe(false);
		expect(isBlobRef(" blob:sha256:x")).toBe(false);
		expect(isBlobRef("")).toBe(false);
		expect(isBlobRef("data:image/png;base64,xx")).toBe(false);
		expect(isBlobRef(TEXT_BLOB)).toBe(false);
	});

	it("parseBlobRef strips blob:sha256: prefix only", () => {
		expect(parseBlobRef(BLOB)).toBe(SHA);
		expect(parseBlobRef("blob:sha256:")).toBe("");
		expect(parseBlobRef("not-blob")).toBeNull();
		expect(parseBlobRef("")).toBeNull();
		expect(parseBlobRef(`blob:${SHA}`)).toBeNull();
		expect(parseBlobRef("BLOB:sha256:x")).toBeNull();
	});

	it("isImageDataUrl requires data:image/ and ;base64,", () => {
		expect(isImageDataUrl("data:image/png;base64,abc")).toBe(true);
		expect(isImageDataUrl("data:image/jpeg;base64,")).toBe(true);
		expect(isImageDataUrl("data:image/png;base64")).toBe(false);
		expect(isImageDataUrl("data:text/plain;base64,abc")).toBe(false);
		expect(isImageDataUrl("data:image/png,abc")).toBe(false);
		expect(isImageDataUrl("")).toBe(false);
	});

	it("isTextBlobRef prefix only", () => {
		expect(isTextBlobRef(TEXT_BLOB)).toBe(true);
		expect(isTextBlobRef("blobtext:sha256:")).toBe(true);
		expect(isTextBlobRef(BLOB)).toBe(false);
		expect(isTextBlobRef("")).toBe(false);
	});

	const mimes: Array<[string | undefined, string | undefined]> = [
		[undefined, undefined],
		["", undefined],
		["image/png", "png"],
		["IMAGE/PNG", "png"],
		["image/jpeg", "jpg"],
		["image/jpg", "jpg"],
		["image/gif", "gif"],
		["image/webp", "webp"],
		["image/svg+xml", "svg"],
		["image/x-icon", "x-icon"],
		["image/vnd.microsoft.icon", "vnd.microsoft.icon"],
		["image/bmp", "bmp"],
		["image/tiff", "tiff"],
		["image/avif", "avif"],
		["image/heic", "heic"],
		["image/custom+xml", "custom"],
		["image/FOO", "foo"],
		["text/plain", undefined],
		["application/octet-stream", undefined],
	];
	for (const [mime, ext] of mimes) {
		it(`mime ${JSON.stringify(mime)} → ${ext}`, () => {
			expect(blobExtensionForImageMimeType(mime)).toBe(ext);
		});
	}
});
