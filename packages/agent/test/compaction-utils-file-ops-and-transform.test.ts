import { describe, expect, it } from "bun:test";
import type { Message } from "@veyyon/ai";
import {
	computeFileLists,
	createFileOps,
	formatFileOperations,
	isUrlSchemePath,
	transformMessagesForSummary,
	truncateToolResultForSummary,
	upsertFileOperations,
} from "../src/compaction/utils";

describe("createFileOps", () => {
	it("returns empty sets for read, written, edited", () => {
		const ops = createFileOps();
		expect(ops.read.size).toBe(0);
		expect(ops.written.size).toBe(0);
		expect(ops.edited.size).toBe(0);
	});

	it("returns independent sets (not shared references)", () => {
		const a = createFileOps();
		const b = createFileOps();
		a.read.add("foo");
		expect(b.read.has("foo")).toBe(false);
	});
});

describe("isUrlSchemePath", () => {
	it("returns false for plain relative path", () => {
		expect(isUrlSchemePath("src/foo.ts")).toBe(false);
	});

	it("returns false for absolute path", () => {
		expect(isUrlSchemePath("/home/user/foo.ts")).toBe(false);
	});

	it("returns true for http:// URL", () => {
		expect(isUrlSchemePath("http://example.com")).toBe(true);
	});

	it("returns true for https:// URL", () => {
		expect(isUrlSchemePath("https://example.com")).toBe(true);
	});

	it("returns true for file:// URL", () => {
		expect(isUrlSchemePath("file:///home/user/foo.ts")).toBe(true);
	});

	it("returns true for ssh:// URL", () => {
		expect(isUrlSchemePath("ssh://host/path")).toBe(true);
	});

	it("returns false for empty string", () => {
		expect(isUrlSchemePath("")).toBe(false);
	});
});

describe("computeFileLists", () => {
	it("returns empty lists for empty file ops", () => {
		const ops = createFileOps();
		expect(computeFileLists(ops)).toEqual({ readFiles: [], modifiedFiles: [] });
	});

	it("separates read-only from modified files", () => {
		const ops = createFileOps();
		ops.read.add("a.ts");
		ops.read.add("b.ts");
		ops.edited.add("c.ts");
		ops.written.add("d.ts");
		const result = computeFileLists(ops);
		expect(result.readFiles).toEqual(["a.ts", "b.ts"]);
		expect(result.modifiedFiles).toEqual(["c.ts", "d.ts"]);
	});

	it("excludes files that are both read and modified from read-only", () => {
		const ops = createFileOps();
		ops.read.add("shared.ts");
		ops.edited.add("shared.ts");
		const result = computeFileLists(ops);
		expect(result.readFiles).toEqual([]);
		expect(result.modifiedFiles).toEqual(["shared.ts"]);
	});

	it("sorts output alphabetically", () => {
		const ops = createFileOps();
		ops.read.add("z.ts");
		ops.read.add("a.ts");
		ops.read.add("m.ts");
		const result = computeFileLists(ops);
		expect(result.readFiles).toEqual(["a.ts", "m.ts", "z.ts"]);
	});

	it("excludes URL scheme paths from read", () => {
		const ops = createFileOps();
		ops.read.add("http://example.com");
		ops.read.add("src/foo.ts");
		const result = computeFileLists(ops);
		expect(result.readFiles).toEqual(["src/foo.ts"]);
	});

	it("excludes URL scheme paths from modified", () => {
		const ops = createFileOps();
		ops.edited.add("https://example.com");
		ops.edited.add("src/foo.ts");
		const result = computeFileLists(ops);
		expect(result.modifiedFiles).toEqual(["src/foo.ts"]);
	});

	it("deduplicates modified files across written and edited", () => {
		const ops = createFileOps();
		ops.written.add("foo.ts");
		ops.edited.add("foo.ts");
		const result = computeFileLists(ops);
		expect(result.modifiedFiles).toEqual(["foo.ts"]);
	});
});

describe("truncateToolResultForSummary", () => {
	it("returns text unchanged when under limit", () => {
		expect(truncateToolResultForSummary("short text")).toBe("short text");
	});

	it("returns text unchanged at exactly the limit", () => {
		const text = "a".repeat(2000);
		expect(truncateToolResultForSummary(text)).toBe(text);
	});

	it("truncates text over the limit with head/tail preservation", () => {
		const text = "a".repeat(3000);
		const result = truncateToolResultForSummary(text);
		expect(result).toContain("[... middle omitted; tail preserved ...]");
		expect(result.length).toBeLessThan(text.length);
	});

	it("preserves head and tail of truncated text", () => {
		const head = "HEAD";
		const tail = "TAIL";
		const text = head + "x".repeat(3000) + tail;
		const result = truncateToolResultForSummary(text);
		expect(result.startsWith("HEAD")).toBe(true);
		expect(result.endsWith("TAIL")).toBe(true);
	});

	it("handles empty string", () => {
		expect(truncateToolResultForSummary("")).toBe("");
	});
});

describe("formatFileOperations", () => {
	it("returns empty string for no files", () => {
		expect(formatFileOperations([], [])).toBe("");
	});

	it("formats read files", () => {
		const result = formatFileOperations(["src/foo.ts"], []);
		expect(result).toContain("foo.ts");
		expect(result).toContain("Read");
	});

	it("formats modified files", () => {
		const result = formatFileOperations([], ["src/bar.ts"]);
		expect(result).toContain("bar.ts");
		expect(result).toContain("Write");
	});

	it("formats files that are both read and modified as RW", () => {
		const readSet = new Set(["shared.ts"]);
		const result = formatFileOperations([], ["shared.ts"], readSet);
		expect(result).toContain("RW");
	});

	it("formats mixed read and modified files", () => {
		const result = formatFileOperations(["read.ts"], ["written.ts"]);
		expect(result).toContain("read.ts");
		expect(result).toContain("written.ts");
	});

	it("elides when over 20 files", () => {
		const readFiles = Array.from({ length: 25 }, (_, i) => `file${i}.ts`);
		const result = formatFileOperations(readFiles, []);
		expect(result).toContain("elided");
	});
});

describe("upsertFileOperations", () => {
	it("returns file operations when summary is empty", () => {
		const result = upsertFileOperations("", ["foo.ts"], []);
		expect(result).toContain("foo.ts");
	});

	it("returns summary when no file operations", () => {
		const result = upsertFileOperations("existing summary", [], []);
		expect(result).toBe("existing summary");
	});

	it("appends file operations to summary", () => {
		const result = upsertFileOperations("existing summary", ["foo.ts"], []);
		expect(result).toContain("existing summary");
		expect(result).toContain("foo.ts");
	});

	it("strips existing file operation tags before re-adding", () => {
		const summaryWithTags = "some text\n<files>old data</files>\nmore text";
		const result = upsertFileOperations(summaryWithTags, ["new.ts"], []);
		expect(result).not.toContain("old data");
		expect(result).toContain("new.ts");
		expect(result).toContain("some text");
		expect(result).toContain("more text");
	});

	it("strips read-files tags", () => {
		const summaryWithTags = "text\n<read-files>old</read-files>\nmore";
		const result = upsertFileOperations(summaryWithTags, [], []);
		expect(result).not.toContain("<read-files>");
		expect(result).toContain("text");
	});

	it("strips modified-files tags", () => {
		const summaryWithTags = "text\n<modified-files>old</modified-files>\nmore";
		const result = upsertFileOperations(summaryWithTags, [], []);
		expect(result).not.toContain("<modified-files>");
		expect(result).toContain("text");
	});
});

describe("transformMessagesForSummary", () => {
	const transform = (s: string) => s.toUpperCase();

	it("transforms user message string content", () => {
		const messages = [{ role: "user", content: "hello world", timestamp: 0 }] as unknown as Message[];
		const result = transformMessagesForSummary(messages, transform);
		expect(result[0].content).toBe("HELLO WORLD");
	});

	it("transforms user message block content", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 },
		] as unknown as Message[];
		const result = transformMessagesForSummary(messages, transform);
		expect((result[0].content as Array<{ type: string; text: string }>)[0].text).toBe("HELLO");
	});

	it("transforms developer message content", () => {
		const messages = [{ role: "developer", content: "instructions", timestamp: 0 }] as unknown as Message[];
		const result = transformMessagesForSummary(messages, transform);
		expect(result[0].content).toBe("INSTRUCTIONS");
	});

	it("transforms assistant text blocks", () => {
		const messages = [{ role: "assistant", content: [{ type: "text", text: "response" }] }] as unknown as Message[];
		const result = transformMessagesForSummary(messages, transform);
		expect((result[0].content as Array<{ type: string; text: string }>)[0].text).toBe("RESPONSE");
	});

	it("transforms assistant thinking blocks", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "thinking", thinking: "thoughts" }] },
		] as unknown as Message[];
		const result = transformMessagesForSummary(messages, transform);
		expect((result[0].content as Array<{ type: string; thinking: string }>)[0].thinking).toBe("THOUGHTS");
	});

	it("transforms assistant toolCall argument string values", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call1", name: "read", arguments: { path: "src/foo.ts" } }],
			},
		] as unknown as Message[];
		const result = transformMessagesForSummary(messages, transform);
		const block = (result[0].content as Array<{ type: string; arguments: Record<string, unknown> }>)[0];
		expect(block.arguments.PATH).toBe("SRC/FOO.TS");
	});

	it("transforms assistant toolCall intent", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call1", name: "read", arguments: {}, intent: "read file" }],
			},
		] as unknown as Message[];
		const result = transformMessagesForSummary(messages, transform);
		const block = (result[0].content as Array<{ type: string; intent: string }>)[0];
		expect(block.intent).toBe("READ FILE");
	});

	it("transforms toolResult text blocks", () => {
		const messages = [
			{
				role: "toolResult",
				toolCallId: "call1",
				toolName: "read",
				content: [{ type: "text", text: "result text" }],
				isError: false,
				timestamp: 0,
			},
		] as unknown as Message[];
		const result = transformMessagesForSummary(messages, transform);
		expect((result[0].content as Array<{ type: string; text: string }>)[0].text).toBe("RESULT TEXT");
	});

	it("does not mutate original messages", () => {
		const messages = [{ role: "user", content: "hello", timestamp: 0 }] as unknown as Message[];
		transformMessagesForSummary(messages, transform);
		expect(messages[0].content).toBe("hello");
	});

	it("handles nested object arguments", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call1", name: "write", arguments: { nested: { key: "value" } } }],
			},
		] as unknown as Message[];
		const result = transformMessagesForSummary(messages, transform);
		const block = (result[0].content as Array<{ type: string; arguments: Record<string, unknown> }>)[0];
		expect((block.arguments.NESTED as Record<string, unknown>).KEY).toBe("VALUE");
	});

	it("handles array arguments", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call1", name: "search", arguments: { paths: ["a.ts", "b.ts"] } }],
			},
		] as unknown as Message[];
		const result = transformMessagesForSummary(messages, transform);
		const block = (result[0].content as Array<{ type: string; arguments: Record<string, unknown> }>)[0];
		expect((block.arguments.PATHS as unknown[])[0]).toBe("A.TS");
		expect((block.arguments.PATHS as unknown[])[1]).toBe("B.TS");
	});

	it("handles non-string argument values", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call1", name: "write", arguments: { count: 42, flag: true } }],
			},
		] as unknown as Message[];
		const result = transformMessagesForSummary(messages, transform);
		const block = (result[0].content as Array<{ type: string; arguments: Record<string, unknown> }>)[0];
		expect(block.arguments.COUNT).toBe(42);
		expect(block.arguments.FLAG).toBe(true);
	});

	it("transforms toolCall argument keys", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call1", name: "read", arguments: { path: "value" } }],
			},
		] as unknown as Message[];
		const result = transformMessagesForSummary(messages, transform);
		const block = (result[0].content as Array<{ type: string; arguments: Record<string, unknown> }>)[0];
		expect(block.arguments).toHaveProperty("PATH");
		expect(block.arguments).not.toHaveProperty("path");
	});

	it("throws on key collision after transform", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call1", name: "test", arguments: { key1: "a", KEY1: "b" } }],
			},
		] as unknown as Message[];
		expect(() => transformMessagesForSummary(messages, transform)).toThrow("colliding");
	});
});
