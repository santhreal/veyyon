import { describe, expect, it } from "bun:test";
import {
	classifyJsonPrefix,
	parseJsonWithRepair,
	parseStreamingJson,
	parseStreamingJsonThrottled,
	STREAMING_JSON_PARSE_MIN_GROWTH,
} from "../src/json-parse";
import { repairJson } from "../src/json-parse-helpers";

describe("parseJsonWithRepair", () => {
	it("parses valid JSON object", () => {
		expect(parseJsonWithRepair<Record<string, string>>('{"key":"value"}')).toEqual({ key: "value" });
	});
	it("parses valid JSON array", () => {
		expect(parseJsonWithRepair<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
	});
	it("parses valid JSON string", () => {
		expect(parseJsonWithRepair<string>('"hello"')).toBe("hello");
	});
	it("parses valid JSON number", () => {
		expect(parseJsonWithRepair<number>("42")).toBe(42);
	});
	it("parses valid JSON boolean", () => {
		expect(parseJsonWithRepair<boolean>("true")).toBe(true);
	});
	it("parses valid JSON null", () => {
		expect(parseJsonWithRepair<null>("null")).toBe(null);
	});
	it("repairs trailing comma in object", () => {
		expect(parseJsonWithRepair<Record<string, string>>('{"key":"value",}')).toEqual({ key: "value" });
	});
	it("repairs trailing comma in array", () => {
		expect(parseJsonWithRepair<number[]>("[1,2,3,]")).toEqual([1, 2, 3]);
	});
	it("repairs unquoted keys", () => {
		expect(parseJsonWithRepair<Record<string, string>>("{key:value}")).toEqual({ key: "value" });
	});
	it("repairs single-quoted strings", () => {
		expect(parseJsonWithRepair<Record<string, string>>("{'key':'value'}")).toEqual({ key: "value" });
	});
	it("handles empty object", () => {
		expect(parseJsonWithRepair<Record<string, unknown>>("{}")).toEqual({});
	});
	it("handles empty array", () => {
		expect(parseJsonWithRepair<unknown[]>("[]")).toEqual([]);
	});
	it("handles nested structures", () => {
		expect(parseJsonWithRepair<Record<string, Record<string, number[]>>>('{"a":{"b":[1,2]}}')).toEqual({ a: { b: [1, 2] } });
	});
});

describe("parseStreamingJson", () => {
	it("returns empty object for undefined input", () => {
		expect(parseStreamingJson(undefined) as Record<string, unknown>).toEqual({});
	});
	it("returns empty object for empty string", () => {
		expect(parseStreamingJson("") as Record<string, unknown>).toEqual({});
	});
	it("returns empty object for whitespace-only string", () => {
		expect(parseStreamingJson("   ") as Record<string, unknown>).toEqual({});
	});
	it("parses complete JSON object", () => {
		expect(parseStreamingJson('{"key":"value"}') as Record<string, unknown>).toEqual({ key: "value" });
	});
	it("parses partial JSON object with closing brace", () => {
		const result = parseStreamingJson('{"key":"value"');
		expect(result).toHaveProperty("key", "value");
	});
	it("parses partial JSON with missing closing brace", () => {
		const result = parseStreamingJson('{"key":"value"');
		expect(result).toBeDefined();
	});
	it("returns empty object for unparseable input", () => {
		expect(parseStreamingJson("@#$%") as Record<string, unknown>).toEqual({});
	});
	it("parses partial array", () => {
		const result = parseStreamingJson("[1,2,3");
		expect(Array.isArray(result)).toBe(true);
	});
});

describe("parseStreamingJsonThrottled", () => {
	it("returns null for undefined input", () => {
		expect(parseStreamingJsonThrottled(undefined, 0)).toBeNull();
	});
	it("returns null for empty string", () => {
		expect(parseStreamingJsonThrottled("", 0)).toBeNull();
	});
	it("returns result for first parse (lastParsedLen=0)", () => {
		const result = parseStreamingJsonThrottled('{"key":"value"}', 0);
		expect(result).not.toBeNull();
		expect(result?.value).toEqual({ key: "value" });
		expect(result?.parsedLen).toBe(15);
	});
	it("returns null when growth below minGrowthBytes", () => {
		const json = '{"key":"value"}';
		const result = parseStreamingJsonThrottled(json, 10, 256);
		expect(result).toBeNull();
	});
	it("returns result when growth exceeds minGrowthBytes", () => {
		const json = '{"key":"value"}';
		const result = parseStreamingJsonThrottled(json, 0, 1);
		expect(result).not.toBeNull();
	});
	it("uses default minGrowthBytes of 256", () => {
		expect(STREAMING_JSON_PARSE_MIN_GROWTH).toBe(256);
	});
	it("returns result when lastParsedLen is 0 regardless of size", () => {
		const result = parseStreamingJsonThrottled("{}", 0);
		expect(result).not.toBeNull();
	});
	it("returns null when len equals lastParsedLen", () => {
		const json = '{"key":"value"}';
		const result = parseStreamingJsonThrottled(json, json.length, 1);
		expect(result).toBeNull();
	});
});

describe("classifyJsonPrefix", () => {
	it("classifies complete object as 'complete'", () => {
		expect(classifyJsonPrefix('{"key":"value"}')).toBe("complete");
	});
	it("classifies complete array as 'complete'", () => {
		expect(classifyJsonPrefix("[1,2,3]")).toBe("complete");
	});
	it("classifies complete string as 'complete'", () => {
		expect(classifyJsonPrefix('"hello"')).toBe("complete");
	});
	it("classifies complete number as 'complete'", () => {
		expect(classifyJsonPrefix("42")).toBe("complete");
	});
	it("classifies incomplete object as 'prefix'", () => {
		expect(classifyJsonPrefix('{"key":"value"')).toBe("prefix");
	});
	it("classifies incomplete array as 'prefix'", () => {
		expect(classifyJsonPrefix("[1,2,3")).toBe("prefix");
	});
	it("classifies incomplete string as 'prefix'", () => {
		expect(classifyJsonPrefix('"hello')).toBe("prefix");
	});
	it("classifies empty string as 'prefix'", () => {
		expect(classifyJsonPrefix("")).toBe("prefix");
	});
	it("classifies garbage as 'invalid'", () => {
		expect(classifyJsonPrefix("@#$%")).toBe("invalid");
	});
	it("classifies complete boolean as 'complete'", () => {
		expect(classifyJsonPrefix("true")).toBe("complete");
	});
	it("classifies complete null as 'complete'", () => {
		expect(classifyJsonPrefix("null")).toBe("complete");
	});
	it("classifies incomplete object with key as 'prefix'", () => {
		expect(classifyJsonPrefix('{"key":')).toBe("prefix");
	});
});

describe("repairJson", () => {
	it("passes through valid JSON unchanged", () => {
		const json = '{"key":"value"}';
		expect(repairJson(json)).toBe(json);
	});
	it("passes through valid JSON with numbers", () => {
		const json = '{"a":1,"b":2}';
		expect(repairJson(json)).toBe(json);
	});
	it("passes through valid JSON with nested objects", () => {
		const json = '{"a":{"b":"c"}}';
		expect(repairJson(json)).toBe(json);
	});
	it("passes through valid JSON with arrays", () => {
		const json = '{"a":[1,2,3]}';
		expect(repairJson(json)).toBe(json);
	});
	it("escapes trailing backslash in string", () => {
		const json = '{"key":"value\\';
		const repaired = repairJson(json);
		expect(repaired).toContain("\\\\");
	});
	it("handles empty string input", () => {
		expect(repairJson("")).toBe("");
	});
	it("handles string with no quotes", () => {
		expect(repairJson("12345")).toBe("12345");
	});
	it("handles string with control characters", () => {
		const json = '{"key":"val\x01ue"}';
		const repaired = repairJson(json);
		expect(repaired).not.toBe(json);
	});
	it("handles valid JSON with escaped quotes", () => {
		const json = '{"key":"val\\"ue"}';
		expect(repairJson(json)).toBe(json);
	});
	it("handles valid JSON with backslash escapes", () => {
		const json = '{"key":"val\\nue"}';
		expect(repairJson(json)).toBe(json);
	});
});
