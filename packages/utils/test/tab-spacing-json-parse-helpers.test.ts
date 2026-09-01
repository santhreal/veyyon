import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyJsonPrefix,
	parseJsonWithRepair,
	parseStreamingJson,
	parseStreamingJsonThrottled,
	STREAMING_JSON_PARSE_MIN_GROWTH,
} from "../src/json-parse";
import { DEFAULT_TAB_WIDTH, getEditorConfigFormatting, MAX_TAB_WIDTH, MIN_TAB_WIDTH } from "../src/tab-spacing";

describe("MIN_TAB_WIDTH", () => {
	it("is 1", () => {
		expect(MIN_TAB_WIDTH).toBe(1);
	});
});

describe("MAX_TAB_WIDTH", () => {
	it("is 16", () => {
		expect(MAX_TAB_WIDTH).toBe(16);
	});
});

describe("DEFAULT_TAB_WIDTH", () => {
	it("is 3", () => {
		expect(DEFAULT_TAB_WIDTH).toBe(3);
	});
});

describe("getEditorConfigFormatting", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "editorconfig-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns empty object for undefined file", () => {
		expect(getEditorConfigFormatting(undefined, dir)).toEqual({});
	});

	it("returns empty object for null file", () => {
		expect(getEditorConfigFormatting(null, dir)).toEqual({});
	});

	it("returns empty object for empty string file", () => {
		expect(getEditorConfigFormatting("", dir)).toEqual({});
	});

	it("returns empty object when no .editorconfig exists", () => {
		expect(getEditorConfigFormatting("test.ts", dir)).toEqual({});
	});

	it("reads tab_width from .editorconfig", () => {
		writeFileSync(join(dir, ".editorconfig"), "root = true\n\n[*]\ntab_width = 8\n");
		const result = getEditorConfigFormatting("test.ts", dir);
		expect(result.tabSize).toBe(8);
	});

	it("reads indent_style = space", () => {
		writeFileSync(join(dir, ".editorconfig"), "root = true\n\n[*]\nindent_style = space\n");
		const result = getEditorConfigFormatting("test.ts", dir);
		expect(result.insertSpaces).toBe(true);
	});

	it("reads indent_style = tab", () => {
		writeFileSync(join(dir, ".editorconfig"), "root = true\n\n[*]\nindent_style = tab\n");
		const result = getEditorConfigFormatting("test.ts", dir);
		expect(result.insertSpaces).toBe(false);
	});

	it("reads indent_size as spaces", () => {
		writeFileSync(join(dir, ".editorconfig"), "root = true\n\n[*]\nindent_size = 4\n");
		const result = getEditorConfigFormatting("test.ts", dir);
		expect(result.tabSize).toBe(4);
		expect(result.insertSpaces).toBe(true);
	});

	it("clamps tab_width to max", () => {
		writeFileSync(join(dir, ".editorconfig"), "root = true\n\n[*]\ntab_width = 100\n");
		const result = getEditorConfigFormatting("test.ts", dir);
		expect(result.tabSize).toBe(MAX_TAB_WIDTH);
	});

	it("clamps tab_width to min", () => {
		writeFileSync(join(dir, ".editorconfig"), "root = true\n\n[*]\ntab_width = 0\n");
		const result = getEditorConfigFormatting("test.ts", dir);
		// tab_width = 0 is invalid, should not set tabSize
		expect(result.tabSize).toBeUndefined();
	});
});

describe("parseJsonWithRepair", () => {
	it("parses valid JSON", () => {
		expect(parseJsonWithRepair('{"a":1}') as unknown).toEqual({ a: 1 });
	});

	it("repairs trailing commas in objects", () => {
		expect(parseJsonWithRepair('{"a":1,}') as unknown).toEqual({ a: 1 });
	});

	it("repairs trailing commas in arrays", () => {
		expect(parseJsonWithRepair("[1,2,3,]") as unknown).toEqual([1, 2, 3]);
	});

	it("repairs single-quoted strings", () => {
		expect(parseJsonWithRepair("{'a':1}") as unknown).toEqual({ a: 1 });
	});

	it("repairs unquoted keys", () => {
		expect(parseJsonWithRepair("{a:1}") as unknown).toEqual({ a: 1 });
	});

	it("parses primitives", () => {
		expect(parseJsonWithRepair("42") as unknown).toBe(42);
		expect(parseJsonWithRepair("true") as unknown).toBe(true);
		expect(parseJsonWithRepair("null") as unknown).toBe(null);
	});

	it("handles comments", () => {
		expect(parseJsonWithRepair('// comment\n{"a":1}') as unknown).toEqual({ a: 1 });
	});

	it("handles block comments", () => {
		expect(parseJsonWithRepair('/* comment */\n{"a":1}') as unknown).toEqual({ a: 1 });
	});
});

describe("parseStreamingJson", () => {
	it("returns empty object for undefined", () => {
		expect(parseStreamingJson(undefined) as unknown).toEqual({});
	});

	it("returns empty object for empty string", () => {
		expect(parseStreamingJson("") as unknown).toEqual({});
	});

	it("parses complete JSON", () => {
		expect(parseStreamingJson('{"a":1}') as unknown).toEqual({ a: 1 });
	});

	it("parses partial JSON object", () => {
		const result = parseStreamingJson('{"a":1,"b":') as unknown;
		expect(typeof result).toBe("object");
	});

	it("returns empty object for invalid partial", () => {
		expect(parseStreamingJson("!!!invalid") as unknown).toEqual({});
	});

	it("returns empty object for whitespace only", () => {
		expect(parseStreamingJson("   ") as unknown).toEqual({});
	});
});

describe("STREAMING_JSON_PARSE_MIN_GROWTH", () => {
	it("is 256", () => {
		expect(STREAMING_JSON_PARSE_MIN_GROWTH).toBe(256);
	});
});

describe("parseStreamingJsonThrottled", () => {
	it("returns null for empty input", () => {
		expect(parseStreamingJsonThrottled("", 0)).toBeNull();
	});

	it("returns null for undefined input", () => {
		expect(parseStreamingJsonThrottled(undefined, 0)).toBeNull();
	});

	it("returns null when growth is below threshold", () => {
		const json = '{"a":1}';
		expect(parseStreamingJsonThrottled(json, 1, 256)).toBeNull();
	});

	it("parses when growth exceeds threshold", () => {
		const json = '{"a":1}';
		const result = parseStreamingJsonThrottled(json, 0, 1);
		expect(result).not.toBeNull();
		expect(result?.parsedLen).toBe(json.length);
	});

	it("parses on first call with lastParsedLen=0", () => {
		const json = '{"a":1}';
		const result = parseStreamingJsonThrottled(json, 0);
		expect(result).not.toBeNull();
	});

	it("uses default minGrowthBytes", () => {
		const json = "x".repeat(300);
		const result = parseStreamingJsonThrottled(json, 0);
		expect(result).not.toBeNull();
		expect(result?.parsedLen).toBe(300);
	});
});

describe("classifyJsonPrefix", () => {
	it("classifies complete object", () => {
		expect(classifyJsonPrefix('{"a":1}')).toBe("complete");
	});

	it("classifies complete array", () => {
		expect(classifyJsonPrefix("[1,2,3]")).toBe("complete");
	});

	it("classifies complete string", () => {
		expect(classifyJsonPrefix('"hello"')).toBe("complete");
	});

	it("classifies complete number", () => {
		expect(classifyJsonPrefix("42")).toBe("complete");
	});

	it("classifies complete boolean", () => {
		expect(classifyJsonPrefix("true")).toBe("complete");
		expect(classifyJsonPrefix("false")).toBe("complete");
	});

	it("classifies complete null", () => {
		expect(classifyJsonPrefix("null")).toBe("complete");
	});

	it("classifies incomplete object as prefix", () => {
		expect(classifyJsonPrefix('{"a":')).toBe("prefix");
	});

	it("classifies incomplete array as prefix", () => {
		expect(classifyJsonPrefix("[1,")).toBe("prefix");
	});

	it("classifies incomplete string as prefix", () => {
		expect(classifyJsonPrefix('"hel')).toBe("prefix");
	});

	it("classifies incomplete number as prefix", () => {
		expect(classifyJsonPrefix("12.")).toBe("prefix");
		expect(classifyJsonPrefix("12e")).toBe("prefix");
	});

	it("classifies incomplete keyword as prefix", () => {
		expect(classifyJsonPrefix("tru")).toBe("prefix");
		expect(classifyJsonPrefix("fals")).toBe("prefix");
		expect(classifyJsonPrefix("nul")).toBe("prefix");
	});

	it("classifies invalid as invalid", () => {
		expect(classifyJsonPrefix("!")).toBe("invalid");
		expect(classifyJsonPrefix("@#$")).toBe("invalid");
	});

	it("classifies empty string as prefix", () => {
		expect(classifyJsonPrefix("")).toBe("prefix");
	});

	it("classifies whitespace as prefix", () => {
		expect(classifyJsonPrefix("   ")).toBe("prefix");
	});

	it("classifies nested incomplete object", () => {
		expect(classifyJsonPrefix('{"a":{"b":')).toBe("prefix");
	});

	it("classifies nested complete object", () => {
		expect(classifyJsonPrefix('{"a":{"b":1}}')).toBe("complete");
	});

	it("classifies trailing comma as invalid", () => {
		expect(classifyJsonPrefix('{"a":1,}')).toBe("invalid");
	});

	it("classifies incomplete escape sequence as prefix", () => {
		expect(classifyJsonPrefix('"hello\\')).toBe("prefix");
	});

	it("classifies complete with whitespace", () => {
		expect(classifyJsonPrefix('  {"a":1}  ')).toBe("complete");
	});

	it("classifies incomplete array in object", () => {
		expect(classifyJsonPrefix('{"a":[1,')).toBe("prefix");
	});

	it("classifies negative number prefix", () => {
		expect(classifyJsonPrefix("-")).toBe("prefix");
		expect(classifyJsonPrefix("-1")).toBe("complete");
	});

	it("classifies empty array as complete", () => {
		expect(classifyJsonPrefix("[]")).toBe("complete");
	});

	it("classifies empty object as complete", () => {
		expect(classifyJsonPrefix("{}")).toBe("complete");
	});
});
