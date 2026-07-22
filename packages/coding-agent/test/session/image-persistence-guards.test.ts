import { describe, expect, it } from "bun:test";
import { isImageBlock, isImageDataPayload } from "@veyyon/coding-agent/session/session-persistence";

/**
 * isImageBlock and isImageDataPayload gate which persisted values are externalized to the
 * blob store on save. They had no direct test. A false negative persists a large base64 image
 * inline (bloating the JSONL line); a false positive would try to externalize a non-image.
 * Pinned:
 *   - isImageBlock requires type === "image" AND a string `data`;
 *   - isImageDataPayload requires a string `data` AND either being an image block OR carrying
 *     a `mimeType` that starts with "image/" (case-insensitive); a bare {data} with no image
 *     type and no image mimeType is not a payload.
 */

describe("isImageBlock", () => {
	it("accepts an object with type 'image' and a string data field", () => {
		expect(isImageBlock({ type: "image", data: "b64" })).toBe(true);
		expect(isImageBlock({ type: "image", data: "b64", mimeType: "image/png" })).toBe(true);
	});

	it("rejects a wrong type, missing/non-string data, or a non-object", () => {
		expect(isImageBlock({ type: "text", data: "x" })).toBe(false);
		expect(isImageBlock({ type: "image" })).toBe(false);
		expect(isImageBlock({ type: "image", data: 5 })).toBe(false);
		expect(isImageBlock(null)).toBe(false);
		expect(isImageBlock("x")).toBe(false);
	});
});

describe("isImageDataPayload", () => {
	it("accepts an image block or a {data, image-mimeType} pair (mimeType case-insensitive)", () => {
		expect(isImageDataPayload({ type: "image", data: "b64" })).toBe(true);
		expect(isImageDataPayload({ data: "b64", mimeType: "image/jpeg" })).toBe(true);
		expect(isImageDataPayload({ data: "b64", mimeType: "IMAGE/PNG" })).toBe(true);
	});

	it("rejects a bare data object, a non-image mimeType, non-string data, or null", () => {
		expect(isImageDataPayload({ data: "b64" })).toBe(false);
		expect(isImageDataPayload({ data: "b64", mimeType: "text/plain" })).toBe(false);
		expect(isImageDataPayload({ data: 5, mimeType: "image/png" })).toBe(false);
		expect(isImageDataPayload(null)).toBe(false);
	});
});
