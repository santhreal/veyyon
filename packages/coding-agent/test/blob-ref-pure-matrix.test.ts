/**
 * Blob ref pure predicates: image blob:sha256: vs text blobtext:sha256: are
 * disjoint; parse returns the hash suffix only for matching prefixes.
 */
import { describe, expect, it } from "bun:test";
import {
	isBlobRef,
	isImageDataUrl,
	isTextBlobRef,
	parseBlobRef,
	parseTextBlobRef,
} from "@veyyon/coding-agent/session/blob-store";

const HASH = "a".repeat(64);

describe("blob ref pure matrix", () => {
	it("isBlobRef true only for blob:sha256: prefix", () => {
		expect(isBlobRef(`blob:sha256:${HASH}`)).toBe(true);
		expect(isBlobRef("blob:sha256:")).toBe(true);
		expect(isBlobRef(`blobtext:sha256:${HASH}`)).toBe(false);
		expect(isBlobRef("blob:md5:abc")).toBe(false);
		expect(isBlobRef("")).toBe(false);
		expect(isBlobRef("sha256:abc")).toBe(false);
	});

	it("isTextBlobRef true only for blobtext:sha256: prefix", () => {
		expect(isTextBlobRef(`blobtext:sha256:${HASH}`)).toBe(true);
		expect(isTextBlobRef(`blob:sha256:${HASH}`)).toBe(false);
		expect(isTextBlobRef("blobtext:")).toBe(false);
		expect(isTextBlobRef("")).toBe(false);
	});

	it("prefixes are disjoint", () => {
		const image = `blob:sha256:${HASH}`;
		const text = `blobtext:sha256:${HASH}`;
		expect(isBlobRef(image) && !isTextBlobRef(image)).toBe(true);
		expect(isTextBlobRef(text) && !isBlobRef(text)).toBe(true);
	});

	it("parseBlobRef returns suffix after prefix", () => {
		expect(parseBlobRef(`blob:sha256:${HASH}`)).toBe(HASH);
		expect(parseBlobRef("blob:sha256:dead")).toBe("dead");
		expect(parseBlobRef("blob:sha256:")).toBe("");
		expect(parseBlobRef(`blobtext:sha256:${HASH}`)).toBeNull();
		expect(parseBlobRef("nope")).toBeNull();
	});

	it("parseTextBlobRef returns suffix after text prefix", () => {
		expect(parseTextBlobRef(`blobtext:sha256:${HASH}`)).toBe(HASH);
		expect(parseTextBlobRef("blobtext:sha256:xx")).toBe("xx");
		expect(parseTextBlobRef(`blob:sha256:${HASH}`)).toBeNull();
		expect(parseTextBlobRef("blobtext:")).toBeNull();
	});

	it("isImageDataUrl requires data:image/ and ;base64,", () => {
		expect(isImageDataUrl("data:image/png;base64,AAA")).toBe(true);
		expect(isImageDataUrl("data:image/jpeg;base64,")).toBe(true);
		expect(isImageDataUrl("data:image/png;charset=utf-8,AAA")).toBe(false);
		expect(isImageDataUrl("data:text/plain;base64,AAA")).toBe(false);
		expect(isImageDataUrl("data:image/png,AAA")).toBe(false);
		expect(isImageDataUrl("")).toBe(false);
	});
});
