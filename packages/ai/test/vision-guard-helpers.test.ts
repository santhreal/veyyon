import { describe, expect, it } from "bun:test";
import {
	joinTextWithImagePlaceholder,
	NON_VISION_IMAGE_PLACEHOLDER,
	partitionVisionContent,
} from "../src/providers/vision-guard";
import type { ImageContent, TextContent } from "../src/types";

describe("NON_VISION_IMAGE_PLACEHOLDER", () => {
	it("is a non-empty string", () => {
		expect(NON_VISION_IMAGE_PLACEHOLDER.length).toBeGreaterThan(0);
	});
	it("mentions image omission", () => {
		expect(NON_VISION_IMAGE_PLACEHOLDER).toContain("image");
	});
});

describe("partitionVisionContent", () => {
	const textBlock: TextContent = { type: "text", text: "hello" };
	const imageBlock: ImageContent = { type: "image", data: "", mimeType: "image/png" };

	it("partitions text and image blocks with vision support", () => {
		const result = partitionVisionContent([textBlock, imageBlock], true);
		expect(result.textBlocks).toHaveLength(1);
		expect(result.imageBlocks).toHaveLength(1);
		expect(result.omittedImages).toBe(false);
	});
	it("omits images when no vision support", () => {
		const result = partitionVisionContent([textBlock, imageBlock], false);
		expect(result.textBlocks).toHaveLength(1);
		expect(result.imageBlocks).toHaveLength(0);
		expect(result.omittedImages).toBe(true);
	});
	it("omittedImages is false when no images present", () => {
		const result = partitionVisionContent([textBlock], false);
		expect(result.omittedImages).toBe(false);
	});
	it("omittedImages is false when no images and vision supported", () => {
		const result = partitionVisionContent([textBlock], true);
		expect(result.omittedImages).toBe(false);
	});
	it("handles empty content", () => {
		const result = partitionVisionContent([], true);
		expect(result.textBlocks).toHaveLength(0);
		expect(result.imageBlocks).toHaveLength(0);
		expect(result.omittedImages).toBe(false);
	});
	it("handles only images with vision support", () => {
		const result = partitionVisionContent([imageBlock], true);
		expect(result.textBlocks).toHaveLength(0);
		expect(result.imageBlocks).toHaveLength(1);
		expect(result.omittedImages).toBe(false);
	});
	it("handles only images without vision support", () => {
		const result = partitionVisionContent([imageBlock], false);
		expect(result.textBlocks).toHaveLength(0);
		expect(result.imageBlocks).toHaveLength(0);
		expect(result.omittedImages).toBe(true);
	});
	it("handles multiple text and image blocks", () => {
		const result = partitionVisionContent([textBlock, imageBlock, textBlock, imageBlock], true);
		expect(result.textBlocks).toHaveLength(2);
		expect(result.imageBlocks).toHaveLength(2);
	});
});

describe("joinTextWithImagePlaceholder", () => {
	it("returns empty string for empty text and no omitted images", () => {
		expect(joinTextWithImagePlaceholder("", false)).toBe("");
	});
	it("returns text when no omitted images", () => {
		expect(joinTextWithImagePlaceholder("hello", false)).toBe("hello");
	});
	it("returns placeholder only for empty text with omitted images", () => {
		expect(joinTextWithImagePlaceholder("", true)).toBe(NON_VISION_IMAGE_PLACEHOLDER);
	});
	it("joins text and placeholder with newline", () => {
		const result = joinTextWithImagePlaceholder("hello", true);
		expect(result).toBe(`hello\n${NON_VISION_IMAGE_PLACEHOLDER}`);
	});
});
