import { describe, expect, it } from "bun:test";
import { stripTaskResultEnvelope } from "../src/task-result";

describe("stripTaskResultEnvelope", () => {
	it("returns text unchanged when no task-result prefix", () => {
		expect(stripTaskResultEnvelope("hello world")).toBe("hello world");
	});

	it("extracts output body from task-result envelope", () => {
		const text = "<task-result><output>\nhello world\n</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("hello world");
	});

	it("extracts preview body from task-result envelope", () => {
		const text = "<task-result><preview>\npreview text\n</preview></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("preview text");
	});

	it("returns text when output body is empty", () => {
		const text = "<task-result><output>\n\n</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe(text);
	});

	it("handles output with attributes", () => {
		const text = '<task-result><output lang="en">\nhello\n</output></task-result>';
		expect(stripTaskResultEnvelope(text)).toBe("hello");
	});

	it("handles multi-line output", () => {
		const text = "<task-result><output>\nline1\nline2\nline3\n</output></task-result>";
		expect(stripTaskResultEnvelope(text)).toBe("line1\nline2\nline3");
	});

	it("returns text when starts with task-result but no output/preview body", () => {
		const text = "<task-result>raw text</task-result>";
		expect(stripTaskResultEnvelope(text)).toBe(text);
	});

	it("returns text unchanged for plain text starting with other tags", () => {
		expect(stripTaskResultEnvelope("<other>text</other>")).toBe("<other>text</other>");
	});

	it("handles empty string", () => {
		expect(stripTaskResultEnvelope("")).toBe("");
	});
});
