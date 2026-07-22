import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildPluginId,
	isValidNameSegment,
	parsePluginId,
} from "@veyyon/coding-agent/extensibility/plugins/plugin-id";
// The marketplace types module re-exports the same three symbols; importing
// through it proves the re-export surface stays wired for `./types` consumers.
import {
	buildPluginId as buildPluginIdViaTypes,
	isValidNameSegment as isValidNameSegmentViaTypes,
	parsePluginId as parsePluginIdViaTypes,
} from "@veyyon/coding-agent/extensibility/plugins/marketplace/types";

/**
 * `plugin-id.ts` is the single owner of plugin/marketplace name-segment
 * validation and `"name@marketplace"` ID parsing. The marketplace registry and
 * the installed registry used to keep byte-identical private copies of
 * `NAME_RE`, `MAX_NAME_LENGTH`, `isValidNameSegment`, and `parsePluginId`; a
 * drift between them would let an ID validate in one registry and be rejected in
 * the other. These tests lock the grammar and the single-owner invariant.
 */

describe("isValidNameSegment", () => {
	it("accepts lowercase alnum with interior dots and hyphens", () => {
		expect(isValidNameSegment("a")).toBe(true);
		expect(isValidNameSegment("my-plugin")).toBe(true);
		expect(isValidNameSegment("scope.name-2")).toBe(true);
		expect(isValidNameSegment("0")).toBe(true);
	});

	it("rejects empty, uppercase, and non-alnum boundary characters", () => {
		expect(isValidNameSegment("")).toBe(false);
		expect(isValidNameSegment("MyPlugin")).toBe(false);
		expect(isValidNameSegment("-leading")).toBe(false);
		expect(isValidNameSegment("trailing-")).toBe(false);
		expect(isValidNameSegment(".dot")).toBe(false);
		expect(isValidNameSegment("has space")).toBe(false);
		expect(isValidNameSegment("under_score")).toBe(false);
	});

	it("enforces the 64-character length bound at the boundary", () => {
		expect(isValidNameSegment("a".repeat(64))).toBe(true);
		expect(isValidNameSegment("a".repeat(65))).toBe(false);
	});
});

describe("buildPluginId", () => {
	it("joins two valid segments with @", () => {
		expect(buildPluginId("plug", "market")).toBe("plug@market");
	});

	it("rejects an invalid plugin name with a name-specific message", () => {
		expect(() => buildPluginId("Bad Name", "market")).toThrow(/Invalid plugin name/);
	});

	it("rejects an invalid marketplace name with a marketplace-specific message", () => {
		expect(() => buildPluginId("plug", "Bad Market")).toThrow(/Invalid marketplace name/);
	});

	it("rejects an ID that exceeds 128 characters even when both segments are valid", () => {
		const long = "a".repeat(63);
		// 63 + 1 (@) + 63 = 127 is fine; push it over with a 64-char half.
		expect(() => buildPluginId("a".repeat(64), "a".repeat(64))).toThrow(/exceeds 128 characters/);
		expect(buildPluginId(long, long)).toBe(`${long}@${long}`);
	});
});

describe("parsePluginId", () => {
	it("splits on the last @ into name and marketplace", () => {
		expect(parsePluginId("plug@market")).toEqual({ name: "plug", marketplace: "market" });
	});

	it("returns null when there is no @, a leading @, or a trailing @", () => {
		expect(parsePluginId("noatsign")).toBeNull();
		expect(parsePluginId("@market")).toBeNull();
		expect(parsePluginId("plug@")).toBeNull();
	});

	it("returns null when either segment fails validation", () => {
		expect(parsePluginId("Bad@market")).toBeNull();
		expect(parsePluginId("plug@Bad Market")).toBeNull();
	});

	it("round-trips a built ID", () => {
		const id = buildPluginId("my-plugin", "my-market");
		expect(parsePluginId(id)).toEqual({ name: "my-plugin", marketplace: "my-market" });
	});
});

describe("marketplace/types re-export identity", () => {
	it("re-exports the exact same function references as the single owner", () => {
		expect(isValidNameSegmentViaTypes).toBe(isValidNameSegment);
		expect(buildPluginIdViaTypes).toBe(buildPluginId);
		expect(parsePluginIdViaTypes).toBe(parsePluginId);
	});
});

describe("plugin-id single-owner lock", () => {
	it("no sibling plugin module redefines the name grammar or ID parser", () => {
		const dir = join(import.meta.dir, "..", "..", "src", "extensibility", "plugins");
		const offenders: string[] = [];
		const scan = (base: string, prefix: string) => {
			for (const entry of readdirSync(base, { withFileTypes: true })) {
				if (entry.name === "plugin-id.ts") continue;
				const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					scan(join(base, entry.name), rel);
					continue;
				}
				if (!entry.name.endsWith(".ts")) continue;
				const src = readFileSync(join(base, entry.name), "utf8");
				// A reintroduced private copy would define the grammar regex or the
				// name-segment predicate locally instead of importing them.
				if (src.includes("[a-z0-9]([a-z0-9.-]*[a-z0-9])?")) {
					offenders.push(`${rel}: inline NAME_RE`);
				}
				if (/function isValidNameSegment\b/.test(src)) {
					offenders.push(`${rel}: local isValidNameSegment`);
				}
			}
		};
		scan(dir, "");
		expect(offenders).toEqual([]);
	});
});
