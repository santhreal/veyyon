/**
 * Capability subsystem parity oracle: pins the capability registry, foreign
 * provider set, rule bucketing, and rule enablement contracts.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite must reproduce these exact
 * behaviors: capability definition uniqueness, provider priority ordering,
 * foreign provider gating, rule enablement levers, and bucket assignment.
 */
import { describe, expect, it } from "bun:test";
import {
	FOREIGN_PROVIDER_IDS,
	defineCapability,
	registerProvider,
} from "@veyyon/coding-agent/capability";
import {
	ruleIsEnabled,
	resolveRuleLevers,
	type EnabledRuleLevers,
} from "@veyyon/coding-agent/capability/rule-buckets";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule } from "@veyyon/coding-agent/capability/rule";

describe("FOREIGN_PROVIDER_IDS", () => {
	it("is a readonly set with the expected members", () => {
		expect(FOREIGN_PROVIDER_IDS.size).toBe(10);
		expect([...FOREIGN_PROVIDER_IDS].sort()).toEqual([
			"agents",
			"agents-md",
			"claude",
			"claude-plugins",
			"codex",
			"cursor",
			"gemini",
			"github",
			"opencode",
			"windsurf",
		]);
	});
});

describe("defineCapability", () => {
	it("creates a capability with an empty providers array", () => {
	const cap = defineCapability({ id: `test-cap-${Date.now()}`, displayName: "Test", description: "test", key: () => undefined });
		expect(cap.providers).toEqual([]);
	});

	it("throws when a capability id is already defined", () => {
		const id = `dup-cap-${Date.now()}`;
		defineCapability({ id, displayName: "First", description: "first", key: () => undefined });
		expect(() => defineCapability({ id, displayName: "Second", description: "second", key: () => undefined })).toThrow(
			`Capability "${id}" is already defined`,
		);
	});
});

describe("registerProvider", () => {
	it("throws when capability id is unknown", () => {
		expect(() =>
			registerProvider("nonexistent-cap-xyz", {
				id: "test-provider",
				displayName: "Test",
				description: "test",
				priority: 0,
				load: async () => ({ items: [] }),
			}),
		).toThrow('Unknown capability: "nonexistent-cap-xyz"');
	});
});

describe("BUILTIN_DEFAULTS_PROVIDER_ID", () => {
	it("is exactly 'builtin-defaults'", () => {
		expect(BUILTIN_DEFAULTS_PROVIDER_ID).toBe("builtin-defaults");
	});
});

describe("resolveRuleLevers", () => {
	it("defaults to includeBuiltin=true, empty disabled, empty experiments", () => {
		const levers = resolveRuleLevers({});
		expect(levers.includeBuiltin).toBe(true);
		expect(levers.disabled.size).toBe(0);
		expect(levers.enabledExperiments.size).toBe(0);
	});

	it("sets includeBuiltin=false when builtinRules is false", () => {
		const levers = resolveRuleLevers({ builtinRules: false });
		expect(levers.includeBuiltin).toBe(false);
	});

	it("trims and filters empty disabled rule names", () => {
		const levers = resolveRuleLevers({ disabledRules: ["  foo  ", "", "  ", "bar"] });
		expect([...levers.disabled].sort()).toEqual(["bar", "foo"]);
	});

	it("trims and filters empty experimental rule names", () => {
		const levers = resolveRuleLevers({ experimentalRules: ["exp1", "  ", "exp2"] });
		expect([...levers.enabledExperiments].sort()).toEqual(["exp1", "exp2"]);
	});
});

describe("ruleIsEnabled", () => {
	const baseLevers: EnabledRuleLevers = {
		includeBuiltin: true,
		disabled: new Set<string>(),
		enabledExperiments: new Set<string>(),
	};

	function makeRule(overrides: Partial<Rule> = {}): Rule {
		return {
			name: "test-rule",
			description: "a test rule",
			...overrides,
		} as Rule;
	}

	it("returns true for a standard rule with no levers active", () => {
		expect(ruleIsEnabled(makeRule(), baseLevers)).toBe(true);
	});

	it("returns false when rule name is in disabled set", () => {
		const levers = { ...baseLevers, disabled: new Set(["test-rule"]) };
		expect(ruleIsEnabled(makeRule(), levers)).toBe(false);
	});

	it("returns false for builtin-defaults provider when includeBuiltin is false", () => {
		const levers = { ...baseLevers, includeBuiltin: false };
		const rule = makeRule({ _source: { provider: BUILTIN_DEFAULTS_PROVIDER_ID } } as Partial<Rule>);
		expect(ruleIsEnabled(rule, levers)).toBe(false);
	});

	it("returns true for builtin-defaults provider when includeBuiltin is true", () => {
		const levers = { ...baseLevers, includeBuiltin: true };
		const rule = makeRule({ _source: { provider: BUILTIN_DEFAULTS_PROVIDER_ID } } as Partial<Rule>);
		expect(ruleIsEnabled(rule, levers)).toBe(true);
	});

	it("returns false for experimental rule not in enabledExperiments", () => {
		const rule = makeRule({ experimental: true });
		expect(ruleIsEnabled(rule, baseLevers)).toBe(false);
	});

	it("returns true for experimental rule in enabledExperiments", () => {
		const levers = { ...baseLevers, enabledExperiments: new Set(["test-rule"]) };
		const rule = makeRule({ experimental: true });
		expect(ruleIsEnabled(rule, levers)).toBe(true);
	});

	it("off wins: disabled takes precedence over enabledExperiments", () => {
		const levers: EnabledRuleLevers = {
			includeBuiltin: true,
			disabled: new Set(["test-rule"]),
			enabledExperiments: new Set(["test-rule"]),
		};
		const rule = makeRule({ experimental: true });
		expect(ruleIsEnabled(rule, levers)).toBe(false);
	});

	it("returns true for non-experimental rule regardless of enabledExperiments", () => {
		const levers = { ...baseLevers, enabledExperiments: new Set(["other-rule"]) };
		expect(ruleIsEnabled(makeRule(), levers)).toBe(true);
	});
});
