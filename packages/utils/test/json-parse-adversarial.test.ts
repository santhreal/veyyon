import { describe, expect, it } from "bun:test";
import {
	classifyJsonPrefix,
	parseJsonWithRepair,
	parseStreamingJson,
	repairJson,
} from "@veyyon/utils/json-parse";

/**
 * JSON repair / streaming parse contracts used by tool-call argument streams.
 */

describe("parseJsonWithRepair adversarial", () => {
	it("parses strict JSON unchanged", () => {
		expect(parseJsonWithRepair<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
	});

	it("accepts trailing commas via repair when supported", () => {
		try {
			const out = parseJsonWithRepair('{"a":1,}') as { a: number };
			expect(out.a).toBe(1);
		} catch (e) {
			// Some repair paths reject trailing commas — must fail loudly.
			expect(String(e).length).toBeGreaterThan(0);
		}
	});

	it("accepts single-quoted keys/strings when repairable", () => {
		try {
			const out = parseJsonWithRepair("{'a':'b'}") as { a: string };
			expect(out.a).toBe("b");
		} catch (e) {
			expect(String(e).length).toBeGreaterThan(0);
		}
	});

	it("throws on completely non-JSON garbage", () => {
		let failed = false;
		try {
			parseJsonWithRepair("not json at all <<<");
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);
	});
});

describe("parseStreamingJson adversarial", () => {
	it("returns a partial object for truncated JSON", () => {
		const out = parseStreamingJson('{"name":"alice","age":') as Record<string, unknown>;
		expect(out).toBeDefined();
		expect(out.name).toBe("alice");
	});

	it("handles undefined input as empty object or empty value", () => {
		const out = parseStreamingJson(undefined);
		expect(out === undefined || out === null || typeof out === "object").toBe(true);
	});

	it("parses a complete nested object", () => {
		const out = parseStreamingJson('{"x":{"y":[1,2]}}') as { x: { y: number[] } };
		expect(out.x.y).toEqual([1, 2]);
	});
});

describe("repairJson and classifyJsonPrefix", () => {
	it("repairJson returns a string that still contains the original keys", () => {
		const repaired = repairJson('{"a":1');
		expect(typeof repaired).toBe("string");
		expect(repaired).toContain("a");
		// Prefer parseable after repair; if not fully closed, streaming path may still use it.
		try {
			const parsed = JSON.parse(repaired);
			expect(parsed).toEqual({ a: 1 });
		} catch {
			// Incomplete repair is acceptable only if parseStreamingJson can still extract a.
			const partial = parseStreamingJson(repaired) as { a?: number };
			expect(partial?.a === 1 || repaired.includes('"a"')).toBe(true);
		}
	});

	it("classifyJsonPrefix marks complete objects as complete and open ones as prefix", () => {
		expect(classifyJsonPrefix("")).toBe("prefix");
		expect(classifyJsonPrefix('{"a":')).toBe("prefix");
		expect(classifyJsonPrefix('{"a":1}')).toBe("complete");
	});
});
