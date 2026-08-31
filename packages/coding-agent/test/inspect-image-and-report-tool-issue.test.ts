import { describe, expect, it } from "bun:test";
import {
	IMAGE_ATTACHMENT_REFERENCE_REGEX,
	inspectImageFilesystemTargets,
	parseImageAttachmentReference,
} from "../src/tools/inspect-image-helpers";
import { sanitizeAutoQaPayload } from "../src/tools/report-tool-issue";

describe("IMAGE_ATTACHMENT_REFERENCE_REGEX", () => {
	it("matches Image #N", () => {
		expect(IMAGE_ATTACHMENT_REFERENCE_REGEX.test("Image #1")).toBe(true);
		expect(IMAGE_ATTACHMENT_REFERENCE_REGEX.test("Image #42")).toBe(true);
	});

	it("matches [Image #N]", () => {
		expect(IMAGE_ATTACHMENT_REFERENCE_REGEX.test("[Image #1]")).toBe(true);
	});

	it("matches attachment://N", () => {
		expect(IMAGE_ATTACHMENT_REFERENCE_REGEX.test("attachment://1")).toBe(true);
		expect(IMAGE_ATTACHMENT_REFERENCE_REGEX.test("attachment://5")).toBe(true);
	});

	it("matches image://N", () => {
		expect(IMAGE_ATTACHMENT_REFERENCE_REGEX.test("image://3")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(IMAGE_ATTACHMENT_REFERENCE_REGEX.test("image #1")).toBe(true);
		expect(IMAGE_ATTACHMENT_REFERENCE_REGEX.test("IMAGE #1")).toBe(true);
	});

	it("matches with whitespace", () => {
		expect(IMAGE_ATTACHMENT_REFERENCE_REGEX.test("  Image #1  ")).toBe(true);
	});

	it("matches [Image #N,extra]", () => {
		expect(IMAGE_ATTACHMENT_REFERENCE_REGEX.test("[Image #1,some text]")).toBe(true);
	});

	it("does not match 0 index", () => {
		expect(IMAGE_ATTACHMENT_REFERENCE_REGEX.test("Image #0")).toBe(false);
	});

	it("does not match plain file path", () => {
		expect(IMAGE_ATTACHMENT_REFERENCE_REGEX.test("src/image.png")).toBe(false);
	});

	it("does not match empty string", () => {
		expect(IMAGE_ATTACHMENT_REFERENCE_REGEX.test("")).toBe(false);
	});
});

describe("parseImageAttachmentReference", () => {
	it("parses Image #N", () => {
		expect(parseImageAttachmentReference("Image #1")).toEqual({ index: 1 });
		expect(parseImageAttachmentReference("Image #42")).toEqual({ index: 42 });
	});

	it("parses [Image #N]", () => {
		expect(parseImageAttachmentReference("[Image #5]")).toEqual({ index: 5 });
	});

	it("parses attachment://N", () => {
		expect(parseImageAttachmentReference("attachment://3")).toEqual({ index: 3 });
	});

	it("parses image://N", () => {
		expect(parseImageAttachmentReference("image://7")).toEqual({ index: 7 });
	});

	it("returns null for plain file path", () => {
		expect(parseImageAttachmentReference("src/image.png")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseImageAttachmentReference("")).toBeNull();
	});

	it("returns null for Image #0", () => {
		expect(parseImageAttachmentReference("Image #0")).toBeNull();
	});
});

describe("inspectImageFilesystemTargets", () => {
	it("returns empty array for null args", () => {
		expect(inspectImageFilesystemTargets(null)).toEqual([]);
	});

	it("returns empty array for args without path", () => {
		expect(inspectImageFilesystemTargets({})).toEqual([]);
	});

	it("returns empty array for non-string path", () => {
		expect(inspectImageFilesystemTargets({ path: 42 })).toEqual([]);
	});

	it("returns empty array for whitespace-only path", () => {
		expect(inspectImageFilesystemTargets({ path: "   " })).toEqual([]);
	});

	it("returns path for regular file path", () => {
		expect(inspectImageFilesystemTargets({ path: "src/image.png" })).toEqual(["src/image.png"]);
	});

	it("returns empty array for Image #N reference", () => {
		expect(inspectImageFilesystemTargets({ path: "Image #1" })).toEqual([]);
	});

	it("returns empty array for attachment://N reference", () => {
		expect(inspectImageFilesystemTargets({ path: "attachment://3" })).toEqual([]);
	});

	it("returns path for absolute file path", () => {
		expect(inspectImageFilesystemTargets({ path: "/home/user/image.png" })).toEqual(["/home/user/image.png"]);
	});
});

describe("sanitizeAutoQaPayload", () => {
	it("sanitizes string values", () => {
		const result = sanitizeAutoQaPayload("hello", s => s.toUpperCase());
		expect(result).toBe("HELLO");
	});

	it("sanitizes strings in objects", () => {
		const result = sanitizeAutoQaPayload({ key: "value" }, s => s.toUpperCase());
		expect(result).toEqual({ KEY: "VALUE" });
	});

	it("sanitizes strings in arrays", () => {
		const result = sanitizeAutoQaPayload(["a", "b"], s => s.toUpperCase());
		expect(result).toEqual(["A", "B"]);
	});

	it("handles nested objects", () => {
		const result = sanitizeAutoQaPayload({ outer: { inner: "value" } }, s => s.toUpperCase());
		expect(result).toEqual({ OUTER: { INNER: "VALUE" } });
	});

	it("handles null", () => {
		expect(sanitizeAutoQaPayload(null, s => s.toUpperCase())).toBeNull();
	});

	it("handles numbers", () => {
		expect(sanitizeAutoQaPayload(42, s => s.toUpperCase())).toBe(42);
	});

	it("handles booleans", () => {
		expect(sanitizeAutoQaPayload(true, s => s.toUpperCase())).toBe(true);
	});

	it("handles undefined", () => {
		expect(sanitizeAutoQaPayload(undefined, s => s.toUpperCase())).toBeUndefined();
	});

	it("handles empty object", () => {
		const result = sanitizeAutoQaPayload({}, s => s.toUpperCase());
		expect(result).toEqual({});
	});

	it("handles empty array", () => {
		const result = sanitizeAutoQaPayload([], s => s.toUpperCase());
		expect(result).toEqual([]);
	});

	it("handles arrays of objects", () => {
		const result = sanitizeAutoQaPayload([{ key: "value" }], s => s.toUpperCase());
		expect(result).toEqual([{ KEY: "VALUE" }]);
	});

	it("handles mixed nested structures", () => {
		const result = sanitizeAutoQaPayload({ items: [{ name: "foo" }, { name: "bar" }], count: 2 }, s =>
			s.toUpperCase(),
		);
		expect(result).toEqual({ ITEMS: [{ NAME: "FOO" }, { NAME: "BAR" }], COUNT: 2 });
	});

	it("handles circular references", () => {
		const obj: Record<string, unknown> = { key: "value" };
		obj.self = obj;
		const result = sanitizeAutoQaPayload(obj, s => s.toUpperCase()) as Record<string, unknown>;
		expect(result.KEY).toBe("VALUE");
		expect(result.SELF).toBe(result); // circular ref preserved
	});

	it("sanitizes object keys", () => {
		const result = sanitizeAutoQaPayload({ secretKey: "value" }, s => s.replace(/secret/i, "REDACTED"));
		expect(result).toEqual({ REDACTEDKey: "value" });
	});

	it("handles deeply nested arrays", () => {
		const result = sanitizeAutoQaPayload([[["deep"]]], s => s.toUpperCase());
		expect(result).toEqual([[["DEEP"]]]);
	});
});
