import { describe, expect, it } from "bun:test";
import { stripTaskResultEnvelope } from "../src/task-result";

describe("stripTaskResultEnvelope", () => {
	it("returns text unchanged when no task-result prefix", () => {
		expect(stripTaskResultEnvelope("hello world")).toBe("hello world");
	});
	it("returns text unchanged for plain text", () => {
		expect(stripTaskResultEnvelope("just some text")).toBe("just some text");
	});
	it("returns empty string unchanged", () => {
		expect(stripTaskResultEnvelope("")).toBe("");
	});
	it("strips output envelope", () => {
		const text = "<task-result><output>\nHello world\n</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("Hello world");
	});
	it("strips preview envelope", () => {
		const text = "<task-result><preview>\nPreview text\n</preview></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("Preview text");
	});
	it("strips output envelope with attributes", () => {
		const text = '<task-result><output lang="en">\nContent here\n</output></task-result>';
		expect(stripTaskResultEnvelope(text)).toBe("Content here");
	});
	it("strips preview envelope with attributes", () => {
		const text = '<task-result><preview type="summary">\nSummary\n</preview></task-result>';
		expect(stripTaskResultEnvelope(text)).toBe("Summary");
	});
	it("handles multiline content", () => {
		const text = "<task-result><output>\nLine 1\nLine 2\nLine 3\n</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("Line 1\nLine 2\nLine 3");
	});
	it("handles content with no leading newline", () => {
		const text = "<task-result><output>Hello\n</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("Hello");
	});
	it("handles content with no trailing newline", () => {
		const text = "<task-result><output>\nHello</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("Hello");
	});
	it("handles content with no newlines", () => {
		const text = "<task-result><output>Hello</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("Hello");
	});
	it("returns original when regex does not match", () => {
		const text = "<task-result>no tags here</task-result>";
		expect(stripTaskResultEnvelope(text)).toBe(text);
	});
	it("returns original for empty output body (falsy fallback)", () => {
		const text = "<task-result><output>\n\n</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe(text);
	});
	it("returns original for whitespace-only body (falsy fallback)", () => {
		const text = "<task-result><output>\n   \n  \n</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe(text);
	});
	it("handles task-result with attributes", () => {
		const text = '<task-result id="123"><output>\nContent\n</output></task-result>';
		expect(stripTaskResultEnvelope(text)).toBe("Content");
	});
});
