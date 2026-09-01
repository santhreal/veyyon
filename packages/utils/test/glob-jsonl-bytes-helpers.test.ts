import { describe, expect, it } from "bun:test";
import { parseGitignorePatterns } from "../src/glob";
import { decodeJsonlLine, parseJsonlBytes, visitJsonlBytes } from "../src/jsonl-bytes";

describe("parseGitignorePatterns", () => {
	it("ignores empty lines", () => {
		expect(parseGitignorePatterns("", "/base", "/base")).toEqual([]);
	});

	it("ignores comment lines", () => {
		expect(parseGitignorePatterns("# comment\n# another", "/base", "/base")).toEqual([]);
	});

	it("ignores negation patterns", () => {
		expect(parseGitignorePatterns("!important", "/base", "/base")).toEqual([]);
	});

	it("handles simple pattern without slash", () => {
		const result = parseGitignorePatterns("node_modules", "/base", "/base");
		expect(result).toEqual(["**/node_modules", "**/node_modules/**"]);
	});

	it("handles pattern with trailing slash", () => {
		const result = parseGitignorePatterns("dist/", "/base", "/base");
		expect(result).toEqual(["**/dist", "**/dist/**"]);
	});

	it("handles pattern with leading slash", () => {
		const result = parseGitignorePatterns("/build", "/base", "/base");
		expect(result.length).toBeGreaterThan(0);
	});

	it("handles pattern with internal slash", () => {
		const result = parseGitignorePatterns("src/temp", "/base", "/base");
		expect(result.length).toBeGreaterThan(0);
	});

	it("handles multiple patterns", () => {
		const result = parseGitignorePatterns("node_modules\ndist\n*.log", "/base", "/base");
		expect(result.length).toBe(6);
	});

	it("handles mixed comments and patterns", () => {
		const result = parseGitignorePatterns("# comment\nnode_modules\n# another\n*.log", "/base", "/base");
		expect(result).toContain("**/node_modules");
		expect(result).toContain("**/*.log");
	});
});

describe("decodeJsonlLine", () => {
	it("decodes valid JSON line", () => {
		const bytes = new TextEncoder().encode('{"key":"value"}');
		expect(decodeJsonlLine(bytes) as unknown).toEqual({ key: "value" });
	});

	it("returns undefined for empty bytes", () => {
		expect(decodeJsonlLine(new Uint8Array(0))).toBeUndefined();
	});

	it("returns undefined for invalid JSON", () => {
		const bytes = new TextEncoder().encode("not json");
		expect(decodeJsonlLine(bytes)).toBeUndefined();
	});

	it("uses custom decode function", () => {
		const bytes = new TextEncoder().encode("custom text");
		const result = decodeJsonlLine(bytes, { decode: text => text.toUpperCase() });
		expect(result).toBe("CUSTOM TEXT");
	});

	it("strips trailing CR", () => {
		const bytes = new TextEncoder().encode('{"a":1}\r');
		expect(decodeJsonlLine(bytes) as unknown).toEqual({ a: 1 });
	});
});

describe("visitJsonlBytes", () => {
	it("visits all valid JSON lines", () => {
		const bytes = new TextEncoder().encode('{"a":1}\n{"b":2}\n{"c":3}');
		const items: unknown[] = [];
		const read = visitJsonlBytes(bytes, item => items.push(item));
		expect(items).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
		expect(read).toBe(bytes.length);
	});

	it("skips invalid JSON lines", () => {
		const bytes = new TextEncoder().encode('{"a":1}\ninvalid\n{"c":3}');
		const items: unknown[] = [];
		const skips: { offset: number; length: number }[] = [];
		visitJsonlBytes(bytes, item => items.push(item), { onSkip: skip => skips.push(skip) });
		expect(items).toEqual([{ a: 1 }, { c: 3 }]);
		expect(skips).toHaveLength(1);
	});

	it("handles empty bytes", () => {
		const items: unknown[] = [];
		const read = visitJsonlBytes(new Uint8Array(0), item => items.push(item));
		expect(items).toEqual([]);
		expect(read).toBe(0);
	});

	it("handles single line without newline", () => {
		const bytes = new TextEncoder().encode('{"a":1}');
		const items: unknown[] = [];
		const read = visitJsonlBytes(bytes, item => items.push(item));
		expect(items).toEqual([{ a: 1 }]);
		expect(read).toBe(bytes.length);
	});

	it("handles CRLF line endings", () => {
		const bytes = new TextEncoder().encode('{"a":1}\r\n{"b":2}\r\n');
		const items: unknown[] = [];
		visitJsonlBytes(bytes, item => items.push(item));
		expect(items).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("handles empty lines", () => {
		const bytes = new TextEncoder().encode('{"a":1}\n\n{"b":2}');
		const items: unknown[] = [];
		visitJsonlBytes(bytes, item => items.push(item));
		expect(items).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("handles trailing newline", () => {
		const bytes = new TextEncoder().encode('{"a":1}\n');
		const items: unknown[] = [];
		const read = visitJsonlBytes(bytes, item => items.push(item));
		expect(items).toEqual([{ a: 1 }]);
		expect(read).toBe(bytes.length);
	});

	it("handles custom decode", () => {
		const bytes = new TextEncoder().encode("line1\nline2");
		const items: string[] = [];
		visitJsonlBytes(bytes, (item: string) => items.push(item), { decode: text => text });
		expect(items).toEqual(["line1", "line2"]);
	});

	it("stops on incomplete final line without newline", () => {
		const bytes = new TextEncoder().encode('{"a":1}\ninvalid');
		const items: unknown[] = [];
		const read = visitJsonlBytes(bytes, item => items.push(item));
		expect(items).toEqual([{ a: 1 }]);
		expect(read).toBe(8); // only read up to after first line's newline
	});
});

describe("parseJsonlBytes", () => {
	it("returns items and read count", () => {
		const bytes = new TextEncoder().encode('{"a":1}\n{"b":2}\n');
		const result = parseJsonlBytes(bytes);
		expect(result.items).toEqual([{ a: 1 }, { b: 2 }]);
		expect(result.read).toBe(bytes.length);
	});

	it("returns empty items for empty bytes", () => {
		const result = parseJsonlBytes(new Uint8Array(0));
		expect(result.items).toEqual([]);
		expect(result.read).toBe(0);
	});

	it("skips invalid lines", () => {
		const bytes = new TextEncoder().encode('{"a":1}\nbroken\n{"b":2}');
		const result = parseJsonlBytes(bytes);
		expect(result.items).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("handles custom decode", () => {
		const bytes = new TextEncoder().encode("hello\nworld");
		const result = parseJsonlBytes<string>(bytes, { decode: text => text.toUpperCase() });
		expect(result.items).toEqual(["HELLO", "WORLD"]);
	});
});
