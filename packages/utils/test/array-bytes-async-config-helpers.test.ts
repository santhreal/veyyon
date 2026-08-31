import { describe, expect, it } from "bun:test";
import { batched } from "../src/array";
import { prefetch, withTimeout } from "../src/async-helpers";
import { asStrictBytes } from "../src/bytes";
import { parseJsonOrYamlByExtension } from "../src/config-parse";

describe("batched", () => {
	it("yields batches of the specified size", () => {
		const result = [...batched([1, 2, 3, 4, 5], 2)];
		expect(result).toEqual([[1, 2], [3, 4], [5]]);
	});

	it("yields single batch when items fit in one batch", () => {
		expect([...batched([1, 2, 3], 5)]).toEqual([[1, 2, 3]]);
	});

	it("yields nothing for empty array", () => {
		expect([...batched([], 3)]).toEqual([]);
	});

	it("yields single item batches when size is 1", () => {
		expect([...batched([1, 2, 3], 1)]).toEqual([[1], [2], [3]]);
	});

	it("throws RangeError for size 0", () => {
		expect(() => [...batched([1, 2], 0)]).toThrow(RangeError);
	});

	it("throws RangeError for negative size", () => {
		expect(() => [...batched([1, 2], -1)]).toThrow(RangeError);
	});

	it("throws RangeError for non-integer size", () => {
		expect(() => [...batched([1, 2], 2.5)]).toThrow(RangeError);
	});

	it("handles size larger than array length", () => {
		expect([...batched([1, 2], 10)]).toEqual([[1, 2]]);
	});

	it("preserves item order across batches", () => {
		const result = [...batched([1, 2, 3, 4, 5, 6], 3)];
		expect(result).toEqual([
			[1, 2, 3],
			[4, 5, 6],
		]);
	});

	it("handles single element array", () => {
		expect([...batched([42], 1)]).toEqual([[42]]);
	});

	it("error message includes the invalid size", () => {
		try {
			[...batched([1], 0)];
			expect.unreachable();
		} catch (error) {
			expect((error as Error).message).toContain("0");
		}
	});
});

describe("asStrictBytes", () => {
	it("returns same reference for a Uint8Array backed by a full ArrayBuffer", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		expect(asStrictBytes(bytes)).toBe(bytes);
	});

	it("copies a subarray view", () => {
		const buffer = new ArrayBuffer(10);
		const view = new Uint8Array(buffer, 2, 3);
		view.set([10, 20, 30]);
		const result = asStrictBytes(view);
		expect(result).not.toBe(view);
		expect(result.byteLength).toBe(3);
		expect([...result]).toEqual([10, 20, 30]);
	});

	it("copies a Uint8Array with non-zero byteOffset", () => {
		const buffer = new ArrayBuffer(6);
		const full = new Uint8Array(buffer);
		full.set([1, 2, 3, 4, 5, 6]);
		const view = new Uint8Array(buffer, 2, 3);
		const result = asStrictBytes(view);
		expect(result).not.toBe(view);
		expect([...result]).toEqual([3, 4, 5]);
	});

	it("copies when byteLength is less than buffer byteLength", () => {
		const buffer = new ArrayBuffer(10);
		const view = new Uint8Array(buffer, 0, 3);
		view.set([1, 2, 3]);
		const result = asStrictBytes(view);
		expect(result).not.toBe(view);
		expect([...result]).toEqual([1, 2, 3]);
	});

	it("returns same reference for empty Uint8Array with its own buffer", () => {
		const bytes = new Uint8Array(0);
		expect(asStrictBytes(bytes)).toBe(bytes);
	});

	it("produces a copy that does not share memory with the original", () => {
		const buffer = new ArrayBuffer(10);
		const view = new Uint8Array(buffer, 0, 3);
		view.set([1, 2, 3]);
		const result = asStrictBytes(view);
		result[0] = 99;
		expect(view[0]).toBe(1);
	});
});

describe("prefetch", () => {
	it("returns the same promise", () => {
		const { promise } = Promise.withResolvers<number>();
		expect(prefetch(promise)).toBe(promise);
	});

	it("swallows rejection of the original promise", async () => {
		const { promise, reject } = Promise.withResolvers<number>();
		reject(new Error("fail"));
		// prefetch attaches a .catch handler, so the unhandled rejection is consumed
		prefetch(promise);
		// Wait a microtask for the catch to run
		await Promise.resolve();
		// If we get here without an unhandled rejection crash, the test passes
		expect(true).toBe(true);
	});

	it("does not affect resolved promises", async () => {
		const promise = Promise.resolve(42);
		const result = prefetch(promise);
		expect(await result).toBe(42);
	});
});

describe("withTimeout", () => {
	it("resolves when promise resolves before timeout", async () => {
		const promise = Promise.resolve("result");
		const result = await withTimeout(promise, 1000, "timed out");
		expect(result).toBe("result");
	});

	it("rejects with timeout message when promise is too slow", async () => {
		const { promise } = Promise.withResolvers<string>();
		// Don't resolve the promise - let it hang
		// Use a very short timeout
		try {
			await withTimeout(promise, 1, "timed out");
			expect.unreachable();
		} catch (error) {
			expect((error as Error).message).toBe("timed out");
		}
	});
});

describe("parseJsonOrYamlByExtension", () => {
	it("parses JSON for .json extension", () => {
		expect(parseJsonOrYamlByExtension('{"a":1}', "config.json")).toEqual({ a: 1 });
	});

	it("parses YAML for .yaml extension", () => {
		expect(parseJsonOrYamlByExtension("a: 1\nb: 2", "config.yaml")).toEqual({ a: 1, b: 2 });
	});

	it("parses YAML for .yml extension", () => {
		expect(parseJsonOrYamlByExtension("a: 1", "config.yml")).toEqual({ a: 1 });
	});

	it("parses JSON for unknown extension", () => {
		expect(parseJsonOrYamlByExtension('{"x":1}', "config.txt")).toEqual({ x: 1 });
	});

	it("parses JSON for no extension", () => {
		expect(parseJsonOrYamlByExtension('{"x":1}', "config")).toEqual({ x: 1 });
	});

	it("is case-insensitive for extension", () => {
		expect(parseJsonOrYamlByExtension("a: 1", "config.YAML")).toEqual({ a: 1 });
		expect(parseJsonOrYamlByExtension("a: 1", "config.YML")).toEqual({ a: 1 });
	});

	it("throws for invalid JSON", () => {
		expect(() => parseJsonOrYamlByExtension("not json", "config.json")).toThrow();
	});

	it("throws for invalid YAML", () => {
		expect(() => parseJsonOrYamlByExtension(":\n  - a: b:", "bad.yaml")).toThrow();
	});

	it("parses YAML array", () => {
		expect(parseJsonOrYamlByExtension("- a\n- b\n- c", "list.yaml")).toEqual(["a", "b", "c"]);
	});

	it("parses JSON array", () => {
		expect(parseJsonOrYamlByExtension("[1, 2, 3]", "list.json")).toEqual([1, 2, 3]);
	});
});
