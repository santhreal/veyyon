import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batched } from "../src/array";
import { AsyncDrain } from "../src/async";
import { isProbablyBinary, isProbablyBinaryHeader, isProbablyBinarySync } from "../src/binary";
import { asStrictBytes } from "../src/bytes";
import { parseJsonOrYamlByExtension } from "../src/config-parse";
import { stringifyJson, stringifyJsonSafe, structuredCloneJSON, tryParseJson } from "../src/json";
import { decodeJwtPayload } from "../src/jwt";
import { splitTextLines } from "../src/lines";
import { clamp, clamp01, clampLow } from "../src/math";
import { extractMermaidBlocks, renderMermaidAsciiSafe } from "../src/mermaid-ascii";
import { SIGNAL_EXIT_BASE, signalName, signalNumber } from "../src/signal-exit";
import { sleepSync } from "../src/sleep";
import { escapeLike, sqlPlaceholders, tableExists } from "../src/sqlite";
import { firstNonEmpty, nonEmptyTrimmed } from "../src/strings";
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS, WEEK_MS } from "../src/time";

describe("firstNonEmpty", () => {
	it("returns first non-empty trimmed string", () => {
		expect(firstNonEmpty("", "  ", "hello", "world")).toBe("hello");
	});

	it("returns null when all empty", () => {
		expect(firstNonEmpty("", "  ", undefined, null)).toBeNull();
	});

	it("returns null for no arguments", () => {
		expect(firstNonEmpty()).toBeNull();
	});

	it("handles undefined and null", () => {
		expect(firstNonEmpty(undefined, null, "value")).toBe("value");
	});

	it("trims whitespace", () => {
		expect(firstNonEmpty("  trimmed  ")).toBe("trimmed");
	});

	it("skips whitespace-only strings", () => {
		expect(firstNonEmpty("   ", "\t", "found")).toBe("found");
	});
});

describe("nonEmptyTrimmed", () => {
	it("filters empty and trims values", () => {
		expect(nonEmptyTrimmed(["hello", "", "  world  ", undefined, null])).toEqual(["hello", "world"]);
	});

	it("returns empty array for all empty", () => {
		expect(nonEmptyTrimmed(["", "  ", undefined])).toEqual([]);
	});

	it("returns empty array for empty input", () => {
		expect(nonEmptyTrimmed([])).toEqual([]);
	});

	it("handles single value", () => {
		expect(nonEmptyTrimmed(["only"])).toEqual(["only"]);
	});
});

describe("clamp", () => {
	it("clamps below min", () => {
		expect(clamp(-5, 0, 10)).toBe(0);
	});

	it("clamps above max", () => {
		expect(clamp(15, 0, 10)).toBe(10);
	});

	it("returns value within range", () => {
		expect(clamp(5, 0, 10)).toBe(5);
	});

	it("returns min for NaN", () => {
		expect(clamp(NaN, 0, 10)).toBe(0);
	});

	it("returns min for non-finite values", () => {
		expect(clamp(Infinity, 0, 10)).toBe(0);
		expect(clamp(-Infinity, 0, 10)).toBe(0);
	});
});

describe("clamp01", () => {
	it("clamps below 0", () => {
		expect(clamp01(-0.5)).toBe(0);
	});

	it("clamps above 1", () => {
		expect(clamp01(1.5)).toBe(1);
	});

	it("returns value within range", () => {
		expect(clamp01(0.5)).toBe(0.5);
	});

	it("returns 0 for NaN", () => {
		expect(clamp01(NaN)).toBe(0);
	});
});

describe("clampLow", () => {
	it("clamps below low", () => {
		expect(clampLow(-5, 0, 10)).toBe(0);
	});

	it("clamps above high", () => {
		expect(clampLow(15, 0, 10)).toBe(10);
	});

	it("returns value within range", () => {
		expect(clampLow(5, 0, 10)).toBe(5);
	});

	it("returns low for NaN", () => {
		expect(clampLow(NaN, 0, 10)).toBe(0);
	});
});

describe("splitTextLines", () => {
	it("splits text by newlines", () => {
		expect(splitTextLines("a\nb\nc")).toEqual(["a", "b", "c"]);
	});

	it("filters trailing empty line", () => {
		expect(splitTextLines("a\nb\n")).toEqual(["a", "b"]);
	});

	it("handles single line", () => {
		expect(splitTextLines("hello")).toEqual(["hello"]);
	});

	it("handles empty string", () => {
		expect(splitTextLines("")).toEqual([]);
	});

	it("handles only newlines", () => {
		expect(splitTextLines("\n\n\n")).toEqual(["", "", ""]);
	});

	it("preserves internal empty lines", () => {
		expect(splitTextLines("a\n\nb")).toEqual(["a", "", "b"]);
	});
});

describe("tryParseJson", () => {
	it("parses valid JSON", () => {
		expect(tryParseJson('{"key":"value"}') as unknown).toEqual({ key: "value" });
	});

	it("returns null for invalid JSON", () => {
		expect(tryParseJson("{invalid}")).toBeNull();
	});

	it("parses arrays", () => {
		expect(tryParseJson("[1,2,3]") as unknown).toEqual([1, 2, 3]);
	});

	it("parses primitives", () => {
		expect(tryParseJson("42") as unknown).toBe(42);
		expect(tryParseJson('"hello"') as unknown).toBe("hello");
		expect(tryParseJson("true") as unknown).toBe(true);
		expect(tryParseJson("null") as unknown).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(tryParseJson("")).toBeNull();
	});
});

describe("stringifyJson", () => {
	it("stringifies objects", () => {
		expect(stringifyJson({ a: 1 })).toBe('{"a":1}');
	});

	it("stringifies bigint as string", () => {
		expect(stringifyJson({ big: 42n })).toBe('{"big":"42"}');
	});

	it("stringifies with spacing", () => {
		expect(stringifyJson({ a: 1 }, 2)).toBe('{\n  "a": 1\n}');
	});

	it("stringifies arrays", () => {
		expect(stringifyJson([1, 2, 3])).toBe("[1,2,3]");
	});
});

describe("stringifyJsonSafe", () => {
	it("stringifies normal objects", () => {
		expect(stringifyJsonSafe({ a: 1 })).toBe('{"a":1}');
	});

	it("handles bigint with n suffix", () => {
		expect(stringifyJsonSafe({ big: 42n })).toBe('{"big":"42n"}');
	});

	it("handles functions", () => {
		const fn = function myFunc(): void {};
		const result = stringifyJsonSafe({ fn });
		expect(result).toContain("[Function: myFunc]");
	});

	it("handles symbols", () => {
		const result = stringifyJsonSafe({ sym: Symbol("test") });
		expect(result).toContain("Symbol(test)");
	});

	it("handles circular references", () => {
		const obj: Record<string, unknown> = {};
		obj.self = obj;
		const result = stringifyJsonSafe(obj);
		expect(result).toContain("[Circular]");
	});

	it("handles null", () => {
		expect(stringifyJsonSafe(null)).toBe("null");
	});

	it("handles undefined as unserializable", () => {
		expect(stringifyJsonSafe(undefined)).toBe("[unserializable undefined]");
	});
});

describe("structuredCloneJSON", () => {
	it("clones objects", () => {
		const obj = { a: 1, b: { c: 2 } };
		const clone = structuredCloneJSON(obj);
		expect(clone).toEqual(obj);
		expect(clone).not.toBe(obj);
		expect(clone.b).not.toBe(obj.b);
	});

	it("returns primitives unchanged", () => {
		expect(structuredCloneJSON(42)).toBe(42);
		expect(structuredCloneJSON("hello")).toBe("hello");
		expect(structuredCloneJSON(null)).toBe(null);
		expect(structuredCloneJSON(undefined)).toBe(undefined);
	});

	it("clones arrays", () => {
		const arr = [1, [2, 3]];
		const clone = structuredCloneJSON(arr);
		expect(clone).toEqual(arr);
		expect(clone).not.toBe(arr);
	});

	it("returns falsy non-object unchanged", () => {
		expect(structuredCloneJSON(0)).toBe(0);
		expect(structuredCloneJSON("")).toBe("");
	});
});

describe("isProbablyBinaryHeader", () => {
	it("returns false for ASCII text", () => {
		expect(isProbablyBinaryHeader(new TextEncoder().encode("hello world"))).toBe(false);
	});

	it("returns true for content with null bytes", () => {
		const data = new Uint8Array([0x68, 0x00, 0x65]);
		expect(isProbablyBinaryHeader(data)).toBe(true);
	});

	it("returns false for empty header", () => {
		expect(isProbablyBinaryHeader(new Uint8Array(0))).toBe(false);
	});

	it("returns false for valid UTF-8", () => {
		expect(isProbablyBinaryHeader(new TextEncoder().encode("valid utf-8 text"))).toBe(false);
	});

	it("returns true for invalid UTF-8 sequences", () => {
		const data = new Uint8Array([0xff, 0xfe, 0xfd]);
		expect(isProbablyBinaryHeader(data)).toBe(true);
	});
});

describe("isProbablyBinary", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "binary-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns false for text file", async () => {
		const file = join(dir, "text.txt");
		writeFileSync(file, "hello world");
		expect(await isProbablyBinary(file)).toBe(false);
	});

	it("returns true for binary file", async () => {
		const file = join(dir, "binary.bin");
		writeFileSync(file, new Uint8Array([0, 1, 2, 3]));
		expect(await isProbablyBinary(file)).toBe(true);
	});

	it("isProbablyBinarySync returns false for text file", () => {
		const file = join(dir, "text.txt");
		writeFileSync(file, "hello world");
		expect(isProbablyBinarySync(file)).toBe(false);
	});

	it("isProbablyBinarySync returns true for binary file", () => {
		const file = join(dir, "binary.bin");
		writeFileSync(file, new Uint8Array([0, 1, 2, 3]));
		expect(isProbablyBinarySync(file)).toBe(true);
	});
});

describe("asStrictBytes", () => {
	it("returns same reference when already strict", () => {
		const buf = new Uint8Array([1, 2, 3]);
		expect(asStrictBytes(buf)).toBe(buf);
	});

	it("copies when byteOffset is non-zero", () => {
		const buf = new Uint8Array([1, 2, 3, 4]);
		const sub = buf.subarray(1, 3);
		const result = asStrictBytes(sub);
		expect(result).not.toBe(sub);
		expect(Array.from(result)).toEqual([2, 3]);
	});

	it("copies when using SharedArrayBuffer", () => {
		const shared = new SharedArrayBuffer(4);
		const buf = new Uint8Array(shared);
		buf[0] = 42;
		const result = asStrictBytes(buf);
		expect(result).not.toBe(buf);
		expect(result[0]).toBe(42);
	});
});

describe("batched", () => {
	it("yields batches of specified size", () => {
		const result = [...batched([1, 2, 3, 4, 5], 2)];
		expect(result).toEqual([[1, 2], [3, 4], [5]]);
	});

	it("yields single batch when items fit", () => {
		expect([...batched([1, 2, 3], 10)]).toEqual([[1, 2, 3]]);
	});

	it("yields nothing for empty array", () => {
		expect([...batched([], 2)]).toEqual([]);
	});

	it("throws for zero size", () => {
		expect(() => [...batched([1], 0)]).toThrow(RangeError);
	});

	it("throws for negative size", () => {
		expect(() => [...batched([1], -1)]).toThrow(RangeError);
	});

	it("throws for non-integer size", () => {
		expect(() => [...batched([1], 1.5)]).toThrow(RangeError);
	});

	it("handles size equal to length", () => {
		expect([...batched([1, 2, 3], 3)]).toEqual([[1, 2, 3]]);
	});

	it("handles size larger than length", () => {
		expect([...batched([1, 2], 5)]).toEqual([[1, 2]]);
	});
});

describe("AsyncDrain", () => {
	it("drains values with handler", async () => {
		const drain = new AsyncDrain<number>(0);
		const collected: number[] = [];
		await drain.push(1, async vals => {
			collected.push(...vals);
		});
		expect(collected).toEqual([1]);
	});

	it("batches multiple pushes", async () => {
		const drain = new AsyncDrain<number>(0);
		const collected: number[] = [];
		const p1 = drain.push(1, async vals => {
			collected.push(...vals);
		});
		const p2 = drain.push(2, async vals => {
			collected.push(...vals);
		});
		await Promise.all([p1, p2]);
		expect(collected).toEqual([1, 2]);
	});

	it("propagates handler errors", async () => {
		const drain = new AsyncDrain<number>(0);
		await expect(
			drain.push(1, async () => {
				throw new Error("handler error");
			}),
		).rejects.toThrow("handler error");
	});
});

describe("parseJsonOrYamlByExtension", () => {
	it("parses JSON for .json extension", () => {
		expect(parseJsonOrYamlByExtension('{"a":1}', "config.json")).toEqual({ a: 1 });
	});

	it("parses YAML for .yaml extension", () => {
		expect(parseJsonOrYamlByExtension("a: 1", "config.yaml")).toEqual({ a: 1 });
	});

	it("parses YAML for .yml extension", () => {
		expect(parseJsonOrYamlByExtension("a: 1", "config.yml")).toEqual({ a: 1 });
	});

	it("parses JSON for unknown extension", () => {
		expect(parseJsonOrYamlByExtension('{"a":1}', "config.txt")).toEqual({ a: 1 });
	});

	it("is case-insensitive for extension", () => {
		expect(parseJsonOrYamlByExtension("a: 1", "config.YAML")).toEqual({ a: 1 });
	});
});

describe("time constants", () => {
	it("SECOND_MS is 1000", () => {
		expect(SECOND_MS).toBe(1000);
	});

	it("MINUTE_MS is 60000", () => {
		expect(MINUTE_MS).toBe(60000);
	});

	it("HOUR_MS is 3600000", () => {
		expect(HOUR_MS).toBe(3600000);
	});

	it("DAY_MS is 86400000", () => {
		expect(DAY_MS).toBe(86400000);
	});

	it("WEEK_MS is 604800000", () => {
		expect(WEEK_MS).toBe(604800000);
	});
});

describe("sqlPlaceholders", () => {
	it("generates placeholders", () => {
		expect(sqlPlaceholders(3)).toBe("?, ?, ?");
	});

	it("generates single placeholder", () => {
		expect(sqlPlaceholders(1)).toBe("?");
	});

	it("generates empty string for 0", () => {
		expect(sqlPlaceholders(0)).toBe("");
	});

	it("throws for negative count", () => {
		expect(() => sqlPlaceholders(-1)).toThrow(RangeError);
	});

	it("throws for non-integer", () => {
		expect(() => sqlPlaceholders(1.5)).toThrow(RangeError);
	});
});

describe("escapeLike", () => {
	it("escapes percent", () => {
		expect(escapeLike("50%")).toBe("50\\%");
	});

	it("escapes underscore", () => {
		expect(escapeLike("my_value")).toBe("my\\_value");
	});

	it("escapes backslash", () => {
		expect(escapeLike("path\\to")).toBe("path\\\\to");
	});

	it("does not escape other characters", () => {
		expect(escapeLike("hello")).toBe("hello");
	});

	it("handles empty string", () => {
		expect(escapeLike("")).toBe("");
	});

	it("escapes all special characters", () => {
		expect(escapeLike("a\\b%c_d")).toBe("a\\\\b\\%c\\_d");
	});
});

describe("tableExists", () => {
	it("returns true for existing table", () => {
		const db = new Database(":memory:");
		db.run("CREATE TABLE test (id INTEGER)");
		expect(tableExists(db, "test")).toBe(true);
		db.close();
	});

	it("returns false for non-existing table", () => {
		const db = new Database(":memory:");
		expect(tableExists(db, "nonexistent")).toBe(false);
		db.close();
	});

	it("returns true for existing view", () => {
		const db = new Database(":memory:");
		db.run("CREATE TABLE base (id INTEGER)");
		db.run("CREATE VIEW test_view AS SELECT * FROM base");
		expect(tableExists(db, "test_view")).toBe(true);
		db.close();
	});
});

describe("decodeJwtPayload", () => {
	it("decodes valid JWT payload", () => {
		const payload = { sub: "user123", name: "Test" };
		const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
		const token = `header.${encoded}.signature`;
		expect(decodeJwtPayload(token) as unknown).toEqual(payload);
	});

	it("returns null for invalid token (not 3 parts)", () => {
		expect(decodeJwtPayload("invalid.token")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(decodeJwtPayload("")).toBeNull();
	});

	it("returns null for invalid base64 payload", () => {
		expect(decodeJwtPayload("a.@@@.b")).toEqual(null);
	});

	it("returns null for non-JSON payload", () => {
		const encoded = Buffer.from("not json").toString("base64url");
		const token = `header.${encoded}.signature`;
		expect(decodeJwtPayload(token)).toBeNull();
	});
});

describe("sleepSync", () => {
	it("does not throw for positive ms", () => {
		expect(() => sleepSync(1)).not.toThrow();
	});

	it("returns immediately for 0", () => {
		expect(() => sleepSync(0)).not.toThrow();
	});

	it("returns immediately for negative", () => {
		expect(() => sleepSync(-1)).not.toThrow();
	});
});

describe("extractMermaidBlocks", () => {
	it("extracts mermaid blocks from markdown", () => {
		const md = "```mermaid\ngraph TD\nA-->B\n```\n\ntext\n";
		const blocks = extractMermaidBlocks(md);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].source).toBe("graph TD\nA-->B");
	});

	it("extracts multiple blocks", () => {
		const md = "```mermaid\ngraph TD\nA-->B\n```\n\n```mermaid\ngraph LR\nC-->D\n```";
		const blocks = extractMermaidBlocks(md);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].source).toContain("A-->B");
		expect(blocks[1].source).toContain("C-->D");
	});

	it("returns empty array for no blocks", () => {
		expect(extractMermaidBlocks("just text")).toEqual([]);
	});

	it("returns empty array for empty string", () => {
		expect(extractMermaidBlocks("")).toEqual([]);
	});

	it("includes hash for each block", () => {
		const md = "```mermaid\ngraph TD\n```";
		const blocks = extractMermaidBlocks(md);
		expect(blocks[0].hash).toBeDefined();
	});
});

describe("renderMermaidAsciiSafe", () => {
	it("returns string or null for invalid mermaid without throwing", () => {
		const result = renderMermaidAsciiSafe("!!!invalid syntax!!!");
		expect(result === null || typeof result === "string").toBe(true);
	});

	it("returns string for valid mermaid", () => {
		const result = renderMermaidAsciiSafe("graph TD\nA-->B");
		expect(typeof result).toBe("string");
	});
});

describe("SIGNAL_EXIT_BASE", () => {
	it("is 128", () => {
		expect(SIGNAL_EXIT_BASE).toBe(128);
	});
});

describe("signalNumber", () => {
	it("returns number for SIGINT", () => {
		expect(signalNumber("SIGINT")).toBeDefined();
		expect(typeof signalNumber("SIGINT")).toBe("number");
	});

	it("returns number for INT without SIG prefix", () => {
		expect(signalNumber("INT")).toBe(signalNumber("SIGINT"));
	});

	it("is case-insensitive", () => {
		expect(signalNumber("sigint")).toBe(signalNumber("SIGINT"));
	});

	it("returns undefined for empty string", () => {
		expect(signalNumber("")).toBeUndefined();
	});

	it("returns undefined for unknown signal", () => {
		expect(signalNumber("NOSUCHSIGNAL")).toBeUndefined();
	});

	it("trims whitespace", () => {
		expect(signalNumber("  SIGINT  ")).toBe(signalNumber("SIGINT"));
	});
});

describe("signalName", () => {
	it("returns name for known signal number", () => {
		const num = signalNumber("SIGINT");
		expect(num).toBeDefined();
		expect(signalName(num as number)).toBe("SIGINT");
	});

	it("returns undefined for unknown number", () => {
		expect(signalName(99999)).toBeUndefined();
	});
});
