import { describe, expect, it } from "bun:test";
import {
	buildServiceTierByFamily,
	resolveSubagentServiceTier,
	serviceTierForAllFamilies,
	serviceTierSettingToTier,
} from "@veyyon/coding-agent/config/service-tier";

/**
 * These lock the per-family service-tier resolution: the setting values a user
 * picks are mapped to the wire ServiceTier each provider family actually realizes,
 * and a single chosen tier is BROADCAST across families CLAMPED to what each
 * family supports (OpenAI takes any tier, Anthropic realizes only `priority`,
 * Google only `flex`/`priority`). This clamp is the load-bearing, previously
 * untested contract: a silent regression would either send a family a tier it does
 * not realize (an API error or a wrong billing/latency class) or drop a tier the
 * family does support. `none`/`inherit`/empty are the omit-the-parameter sentinels
 * and must never reach the wire as a literal tier.
 */

describe("serviceTierSettingToTier", () => {
	it("maps the omit sentinels to undefined", () => {
		expect(serviceTierSettingToTier("none")).toBeUndefined();
		expect(serviceTierSettingToTier("")).toBeUndefined();
		expect(serviceTierSettingToTier("inherit")).toBeUndefined();
	});

	it("passes a concrete tier through unchanged", () => {
		expect(serviceTierSettingToTier("flex")).toBe("flex");
		expect(serviceTierSettingToTier("priority")).toBe("priority");
		expect(serviceTierSettingToTier("scale")).toBe("scale");
		expect(serviceTierSettingToTier("auto")).toBe("auto");
		expect(serviceTierSettingToTier("default")).toBe("default");
	});
});

describe("buildServiceTierByFamily", () => {
	it("assembles the three families, omitting any set to a sentinel", () => {
		expect(buildServiceTierByFamily("flex", "priority", "flex")).toEqual({
			openai: "flex",
			anthropic: "priority",
			google: "flex",
		});
	});

	it("returns an empty map when every family is 'none'", () => {
		expect(buildServiceTierByFamily("none", "none", "none")).toEqual({});
	});

	it("drops only the sentinel families and keeps concrete ones", () => {
		expect(buildServiceTierByFamily("scale", "none", "priority")).toEqual({
			openai: "scale",
			google: "priority",
		});
	});

	it("treats 'inherit' as omit at the per-family level", () => {
		expect(buildServiceTierByFamily("inherit", "priority", "inherit")).toEqual({
			anthropic: "priority",
		});
	});
});

describe("serviceTierForAllFamilies — broadcast with per-family clamp", () => {
	it("returns an empty map for no tier", () => {
		expect(serviceTierForAllFamilies(undefined)).toEqual({});
	});

	it("broadcasts 'priority' to all three families (the only tier Anthropic realizes)", () => {
		expect(serviceTierForAllFamilies("priority")).toEqual({
			openai: "priority",
			anthropic: "priority",
			google: "priority",
		});
	});

	it("clamps 'flex' to OpenAI + Google only (Anthropic does not realize flex)", () => {
		expect(serviceTierForAllFamilies("flex")).toEqual({
			openai: "flex",
			google: "flex",
		});
	});

	it("clamps 'scale' to OpenAI only", () => {
		expect(serviceTierForAllFamilies("scale")).toEqual({ openai: "scale" });
	});

	it("clamps 'auto' and 'default' to OpenAI only", () => {
		expect(serviceTierForAllFamilies("auto")).toEqual({ openai: "auto" });
		expect(serviceTierForAllFamilies("default")).toEqual({ openai: "default" });
	});
});

describe("resolveSubagentServiceTier", () => {
	it("returns the parent's live per-family map verbatim on 'inherit'", () => {
		const inherited = { openai: "flex", anthropic: "priority" } as const;
		expect(resolveSubagentServiceTier("inherit", inherited)).toBe(inherited);
	});

	it("returns the empty inherited map on 'inherit' with no live session tiers", () => {
		expect(resolveSubagentServiceTier("inherit", {})).toEqual({});
	});

	it("ignores the inherited map and broadcasts a concrete tier", () => {
		expect(resolveSubagentServiceTier("priority", { openai: "flex" })).toEqual({
			openai: "priority",
			anthropic: "priority",
			google: "priority",
		});
	});

	it("yields an empty map for 'none'", () => {
		expect(resolveSubagentServiceTier("none", { openai: "flex" })).toEqual({});
	});

	it("clamps a broadcast 'flex' to OpenAI + Google", () => {
		expect(resolveSubagentServiceTier("flex", {})).toEqual({ openai: "flex", google: "flex" });
	});
});
