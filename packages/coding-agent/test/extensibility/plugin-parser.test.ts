import { describe, expect, it } from "bun:test";
import {
	extractPackageName,
	formatPluginSpec,
	type ParsedPluginSpec,
	parsePluginSpec,
} from "@veyyon/coding-agent/extensibility/plugins/parser";

/**
 * These parse a plugin specifier's feature-bracket syntax, format it back, and
 * extract the bare package name from an npm specifier. They were untested. The three
 * feature states are semantically distinct and must never collapse into each other:
 * null (use defaults), "*" (all features), and [] (explicitly no optional features).
 * A regression that confused [] with null would flip a "disable all optional
 * features" install into "restore defaults". extractPackageName feeds post-install
 * path lookups, so a wrong scope/version split would look up the wrong directory.
 *
 * These pin every documented form, the whitespace/empty-token handling, malformed
 * brackets, a parse -> format round trip, and each extractPackageName case including
 * the npm: prefix and scoped packages.
 */

describe("parsePluginSpec", () => {
	it("returns null features for a bare name (use defaults)", () => {
		expect(parsePluginSpec("my-plugin")).toEqual({ packageName: "my-plugin", features: null });
	});

	it("parses a comma list, star, and empty brackets as distinct states", () => {
		expect(parsePluginSpec("my-plugin[search,web]")).toEqual({
			packageName: "my-plugin",
			features: ["search", "web"],
		});
		expect(parsePluginSpec("my-plugin[*]")).toEqual({ packageName: "my-plugin", features: "*" });
		expect(parsePluginSpec("my-plugin[]")).toEqual({ packageName: "my-plugin", features: [] });
	});

	it("keeps a scoped name with version by using the LAST bracket pair", () => {
		expect(parsePluginSpec("@scope/plugin@1.2.3[feat]")).toEqual({
			packageName: "@scope/plugin@1.2.3",
			features: ["feat"],
		});
	});

	it("trims whitespace and drops empty tokens", () => {
		expect(parsePluginSpec("pkg[ a , , b ]")).toEqual({ packageName: "pkg", features: ["a", "b"] });
	});

	it("treats a malformed close-before-open bracket as a bare name", () => {
		expect(parsePluginSpec("pkg][")).toEqual({ packageName: "pkg][", features: null });
	});
});

describe("formatPluginSpec", () => {
	it("formats each feature state back to its bracket form", () => {
		expect(formatPluginSpec({ packageName: "pkg", features: null })).toBe("pkg");
		expect(formatPluginSpec({ packageName: "pkg", features: "*" })).toBe("pkg[*]");
		expect(formatPluginSpec({ packageName: "pkg", features: [] })).toBe("pkg[]");
		expect(formatPluginSpec({ packageName: "pkg", features: ["a", "b"] })).toBe("pkg[a,b]");
	});

	it("round-trips parse -> format for every canonical form", () => {
		for (const spec of [
			"my-plugin",
			"my-plugin[search,web]",
			"my-plugin[*]",
			"my-plugin[]",
			"@scope/pkg@1.2.3[feat]",
		]) {
			const parsed: ParsedPluginSpec = parsePluginSpec(spec);
			expect(formatPluginSpec(parsed)).toBe(spec);
		}
	});
});

describe("extractPackageName", () => {
	it("strips the version from unscoped and scoped specifiers and honors the npm: prefix", () => {
		expect(extractPackageName("lodash@4.17.21")).toBe("lodash");
		expect(extractPackageName("lodash")).toBe("lodash");
		expect(extractPackageName("@scope/pkg@1.0.0")).toBe("@scope/pkg");
		expect(extractPackageName("@scope/pkg")).toBe("@scope/pkg");
		expect(extractPackageName("npm:lodash")).toBe("lodash");
		expect(extractPackageName("npm:@scope/pkg@2.0.0")).toBe("@scope/pkg");
	});
});
