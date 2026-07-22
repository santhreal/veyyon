/**
 * blobExtensionForImageMimeType exact map: known table + subtype fallback + case fold.
 * Why: wrong extension corrupts on-disk blob names for image externalize.
 */
import { describe, expect, it } from "bun:test";
import { blobExtensionForImageMimeType } from "@veyyon/coding-agent/session/blob-store";

describe("blobExtensionForImageMimeType full matrix", () => {
	const cases: [string | undefined, string | undefined][] = [
		["image/png", "png"],
		["image/jpeg", "jpg"],
		["image/jpg", "jpg"],
		["image/gif", "gif"],
		["image/webp", "webp"],
		["image/svg+xml", "svg"],
		["image/bmp", "bmp"], // subtype fallback
		["text/plain", undefined],
		["application/octet-stream", undefined],
		["", undefined],
		[undefined, undefined],
		["IMAGE/PNG", "png"], // lowercased
		["image/png; charset=utf-8", "png"], // strip params then subtype
		["image/x-icon", "x-icon"],
	];

	for (const [mime, ext] of cases) {
		it(`${JSON.stringify(mime)} → ${JSON.stringify(ext)}`, () => {
			expect(blobExtensionForImageMimeType(mime)).toBe(ext);
		});
	}
});
