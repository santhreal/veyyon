import { describe, expect, it } from "bun:test";
import { quarantinePathFor } from "../src/quarantine-file";
import {
	READ_SELECTOR_RANGE_CHUNK_SRC,
	READ_SELECTOR_RANGE_LIST_SRC,
	splitReadSelector,
	stripReadSelector,
} from "../src/read-selector";

describe("splitReadSelector", () => {
	it("returns path without selector when no colon", () => {
		expect(splitReadSelector("foo.ts")).toEqual({ path: "foo.ts" });
	});

	it("returns path without selector when colon at start", () => {
		expect(splitReadSelector(":foo")).toEqual({ path: ":foo" });
	});

	it("splits line number selector", () => {
		expect(splitReadSelector("foo.ts:42")).toEqual({ path: "foo.ts", sel: "42" });
	});

	it("splits range selector", () => {
		expect(splitReadSelector("foo.ts:10-20")).toEqual({ path: "foo.ts", sel: "10-20" });
	});

	it("splits raw selector", () => {
		expect(splitReadSelector("foo.ts:raw")).toEqual({ path: "foo.ts", sel: "raw" });
	});

	it("splits conflicts selector", () => {
		expect(splitReadSelector("foo.ts:conflicts")).toEqual({ path: "foo.ts", sel: "conflicts" });
	});

	it("splits comma-separated ranges", () => {
		expect(splitReadSelector("foo.ts:1,5,10-20")).toEqual({ path: "foo.ts", sel: "1,5,10-20" });
	});

	it("splits L-prefixed line numbers", () => {
		expect(splitReadSelector("foo.ts:L42")).toEqual({ path: "foo.ts", sel: "L42" });
	});

	it("splits L-prefixed ranges", () => {
		expect(splitReadSelector("foo.ts:L10-L20")).toEqual({ path: "foo.ts", sel: "L10-L20" });
	});

	it("splits dot-dot ranges", () => {
		expect(splitReadSelector("foo.ts:10..20")).toEqual({ path: "foo.ts", sel: "10..20" });
	});

	it("splits plus offset ranges", () => {
		expect(splitReadSelector("foo.ts:10+5")).toEqual({ path: "foo.ts", sel: "10+5" });
	});

	it("splits dash-only range", () => {
		expect(splitReadSelector("foo.ts:10-")).toEqual({ path: "foo.ts", sel: "10-" });
	});

	it("returns path unchanged when selector is invalid", () => {
		expect(splitReadSelector("foo.ts:invalid")).toEqual({ path: "foo.ts:invalid" });
	});

	it("handles path with directory containing colon", () => {
		// Windows-style path or URL with port - colon in path but selector at end
		expect(splitReadSelector("http://example.com:8080/foo.ts:42")).toEqual({
			path: "http://example.com:8080/foo.ts",
			sel: "42",
		});
	});

	it("combines raw:range selectors", () => {
		const result = splitReadSelector("foo.ts:raw:10-20");
		expect(result.path).toBe("foo.ts");
		expect(result.sel).toBe("raw:10-20");
	});

	it("combines range:raw selectors", () => {
		const result = splitReadSelector("foo.ts:10-20:raw");
		expect(result.path).toBe("foo.ts");
		expect(result.sel).toBe("10-20:raw");
	});

	it("handles empty selector after colon", () => {
		expect(splitReadSelector("foo.ts:")).toEqual({ path: "foo.ts:" });
	});
});

describe("stripReadSelector", () => {
	it("returns path without selector", () => {
		expect(stripReadSelector("foo.ts:42")).toBe("foo.ts");
	});

	it("returns path unchanged when no selector", () => {
		expect(stripReadSelector("foo.ts")).toBe("foo.ts");
	});

	it("returns path unchanged for invalid selector", () => {
		expect(stripReadSelector("foo.ts:invalid")).toBe("foo.ts:invalid");
	});

	it("strips raw selector", () => {
		expect(stripReadSelector("foo.ts:raw")).toBe("foo.ts");
	});

	it("strips combined raw:range selector", () => {
		expect(stripReadSelector("foo.ts:raw:10-20")).toBe("foo.ts");
	});
});

describe("READ_SELECTOR_RANGE_CHUNK_SRC", () => {
	it("is a non-empty string", () => {
		expect(READ_SELECTOR_RANGE_CHUNK_SRC.length).toBeGreaterThan(0);
	});
});

describe("READ_SELECTOR_RANGE_LIST_SRC", () => {
	it("is a non-empty string", () => {
		expect(READ_SELECTOR_RANGE_LIST_SRC.length).toBeGreaterThan(0);
	});

	it("contains the chunk source", () => {
		expect(READ_SELECTOR_RANGE_LIST_SRC).toContain(READ_SELECTOR_RANGE_CHUNK_SRC);
	});
});

describe("quarantinePathFor", () => {
	it("appends .corrupt to file path", () => {
		expect(quarantinePathFor("/path/to/file.json")).toBe("/path/to/file.json.corrupt");
	});

	it("handles relative path", () => {
		expect(quarantinePathFor("config.yaml")).toBe("config.yaml.corrupt");
	});

	it("handles empty string", () => {
		expect(quarantinePathFor("")).toBe(".corrupt");
	});

	it("handles path with extension", () => {
		expect(quarantinePathFor("data.sqlite3")).toBe("data.sqlite3.corrupt");
	});
});
