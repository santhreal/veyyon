import { describe, expect, it } from "bun:test";
import { prefetch, withTimeout } from "../src/async-helpers";
import { collapseWhitespace } from "../src/collapse-whitespace";
import { parseJsonOrYamlByExtension } from "../src/config-parse";

describe("collapseWhitespace", () => {
	it("collapses multiple spaces to single space", () => {
		expect(collapseWhitespace("hello    world")).toBe("hello world");
	});

	it("collapses tabs to single space", () => {
		expect(collapseWhitespace("hello\t\tworld")).toBe("hello world");
	});

	it("collapses mixed whitespace to single space", () => {
		expect(collapseWhitespace("hello \t world  \t foo")).toBe("hello world foo");
	});

	it("collapses newlines to single space", () => {
		expect(collapseWhitespace("hello\n\nworld")).toBe("hello world");
	});

	it("trims leading whitespace", () => {
		expect(collapseWhitespace("   hello")).toBe("hello");
	});

	it("trims trailing whitespace", () => {
		expect(collapseWhitespace("hello   ")).toBe("hello");
	});

	it("trims both leading and trailing whitespace", () => {
		expect(collapseWhitespace("  hello  ")).toBe("hello");
	});

	it("handles null input", () => {
		expect(collapseWhitespace(null)).toBe("");
	});

	it("handles undefined input", () => {
		expect(collapseWhitespace(undefined)).toBe("");
	});

	it("handles empty string", () => {
		expect(collapseWhitespace("")).toBe("");
	});

	it("handles all-whitespace string", () => {
		expect(collapseWhitespace("   \t\n  ")).toBe("");
	});

	it("handles single word", () => {
		expect(collapseWhitespace("hello")).toBe("hello");
	});

	it("handles carriage returns", () => {
		expect(collapseWhitespace("hello\r\nworld")).toBe("hello world");
	});

	it("preserves single spaces between words", () => {
		expect(collapseWhitespace("hello world foo")).toBe("hello world foo");
	});
});

describe("withTimeout", () => {
	it("resolves with value when promise completes before timeout", async () => {
		const result = await withTimeout(Promise.resolve(42), 1000, "timeout");
		expect(result).toBe(42);
	});

	it("rejects with timeout error when promise is too slow", async () => {
		const slow = new Promise(resolve => setTimeout(resolve, 200));
		await expect(withTimeout(slow, 10, "timed out")).rejects.toThrow("timed out");
	});

	it("propagates promise rejection", async () => {
		const rejecting = Promise.reject(new Error("custom error"));
		await expect(withTimeout(rejecting, 1000, "timeout")).rejects.toThrow("custom error");
	});

	it("resolves with undefined for promise resolving undefined", async () => {
		const result = await withTimeout(Promise.resolve(undefined), 1000, "timeout");
		expect(result).toBeUndefined();
	});

	it("handles zero timeout", async () => {
		const slow = new Promise(resolve => setTimeout(resolve, 100));
		await expect(withTimeout(slow, 0, "immediate timeout")).rejects.toThrow("immediate timeout");
	});
});

describe("prefetch", () => {
	it("returns the same promise", () => {
		const p = Promise.resolve(42);
		expect(prefetch(p)).toBe(p);
	});

	it("swallows rejection errors", async () => {
		const p = Promise.reject(new Error("boom"));
		const prefetched = prefetch(p);
		// Should not throw unhandled rejection
		await expect(prefetched).rejects.toThrow("boom");
	});

	it("preserves resolved value", async () => {
		const p = Promise.resolve("hello");
		const prefetched = prefetch(p);
		expect(await prefetched).toBe("hello");
	});

	it("does not alter the promise behavior", async () => {
		const p = new Promise(resolve => setTimeout(() => resolve(42), 10));
		const prefetched = prefetch(p);
		expect(await prefetched).toBe(42);
	});
});

describe("parseJsonOrYamlByExtension", () => {
	it("parses JSON for .json extension", () => {
		const result = parseJsonOrYamlByExtension('{"key": "value"}', "config.json");
		expect(result).toEqual({ key: "value" });
	});

	it("parses YAML for .yaml extension", () => {
		const result = parseJsonOrYamlByExtension("key: value", "config.yaml");
		expect(result).toEqual({ key: "value" });
	});

	it("parses YAML for .yml extension", () => {
		const result = parseJsonOrYamlByExtension("a: 1\nb: 2", "config.yml");
		expect(result).toEqual({ a: 1, b: 2 });
	});

	it("parses JSON for unknown extension", () => {
		const result = parseJsonOrYamlByExtension("[1, 2, 3]", "config.txt");
		expect(result).toEqual([1, 2, 3]);
	});

	it("parses JSON for no extension", () => {
		const result = parseJsonOrYamlByExtension('{"x": 1}', "config");
		expect(result).toEqual({ x: 1 });
	});

	it("parses YAML with nested structures", () => {
		const yaml = "outer:\n  inner: value\n  num: 42";
		const result = parseJsonOrYamlByExtension(yaml, "nested.yaml");
		expect(result).toEqual({ outer: { inner: "value", num: 42 } });
	});

	it("handles uppercase extensions", () => {
		const result = parseJsonOrYamlByExtension("key: value", "config.YAML");
		expect(result).toEqual({ key: "value" });
	});

	it("handles JSON arrays", () => {
		const result = parseJsonOrYamlByExtension("[1, 2, 3]", "data.json");
		expect(result).toEqual([1, 2, 3]);
	});

	it("handles JSON primitives", () => {
		expect(parseJsonOrYamlByExtension("42", "num.json")).toBe(42);
		expect(parseJsonOrYamlByExtension('"hello"', "str.json")).toBe("hello");
		expect(parseJsonOrYamlByExtension("true", "bool.json")).toBe(true);
		expect(parseJsonOrYamlByExtension("null", "null.json")).toBe(null);
	});

	it("handles YAML arrays", () => {
		const result = parseJsonOrYamlByExtension("- a\n- b\n- c", "list.yaml");
		expect(result).toEqual(["a", "b", "c"]);
	});
});
