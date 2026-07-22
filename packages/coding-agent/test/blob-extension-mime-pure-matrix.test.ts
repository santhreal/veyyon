/**
 * blobExtensionForImageMimeType pure mapping for known image types.
 */
import { describe, expect, it } from "bun:test";
import { blobExtensionForImageMimeType } from "@veyyon/coding-agent/session/blob-store";

describe("blobExtensionForImageMimeType matrix", () => {
	const cases: Array<[string, string | undefined]> = [
		["image/png", "png"],
		["image/jpeg", "jpg"],
		["image/jpg", "jpg"],
		["image/gif", "gif"],
		["image/webp", "webp"],
		["image/svg+xml", "svg"],
		["image/unknown", "unknown"], // unknown image/* falls back to subtype
		["text/plain", undefined],
		["", undefined],
	];
	for (const [mime, ext] of cases) {
		it(`${mime} → ${ext}`, () => {
			expect(blobExtensionForImageMimeType(mime)).toBe(ext);
		});
	}

	it("undefined mime", () => {
		expect(blobExtensionForImageMimeType(undefined)).toBeUndefined();
	});

	it("image/svg+xml uses known map svg not xml", () => {
		expect(blobExtensionForImageMimeType("image/svg+xml")).toBe("svg");
	});
});
