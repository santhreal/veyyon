import { describe, expect, it } from "bun:test";
import {
	AGENT_DIR_ENV_KEYS,
	CONFIG_DIR_ENV_KEYS,
	DIR_LOCATION_ENV_KEYS,
	DIR_OVERRIDE_ENV_KEYS,
	PROFILE_ENV_KEYS,
	SANDBOX_MARKER_ENV_KEY,
	XDG_BASE_ENV_KEYS,
} from "../src/dir-env-keys";
import {
	applyEvalPromptOverrides,
	describeUnknownPromptIds,
	PROMPT_ID_SHAPE_HINT,
	parseEvalPromptOverridesJson,
} from "../src/eval-prompt-overrides";

describe("dir-env-keys constants", () => {
	it("AGENT_DIR_ENV_KEYS contains VEYYON_CODING_AGENT_DIR", () => {
		expect(AGENT_DIR_ENV_KEYS).toContain("VEYYON_CODING_AGENT_DIR");
	});

	it("CONFIG_DIR_ENV_KEYS contains VEYYON_CONFIG_DIR", () => {
		expect(CONFIG_DIR_ENV_KEYS).toContain("VEYYON_CONFIG_DIR");
	});

	it("PROFILE_ENV_KEYS contains VEYYON_PROFILE", () => {
		expect(PROFILE_ENV_KEYS).toContain("VEYYON_PROFILE");
	});

	it("SANDBOX_MARKER_ENV_KEY is VEYYON_TEST_SANDBOX", () => {
		expect(SANDBOX_MARKER_ENV_KEY).toBe("VEYYON_TEST_SANDBOX");
	});

	it("XDG_BASE_ENV_KEYS contains XDG vars", () => {
		expect(XDG_BASE_ENV_KEYS).toContain("XDG_CONFIG_HOME");
		expect(XDG_BASE_ENV_KEYS).toContain("XDG_DATA_HOME");
		expect(XDG_BASE_ENV_KEYS).toContain("XDG_STATE_HOME");
		expect(XDG_BASE_ENV_KEYS).toContain("XDG_CACHE_HOME");
	});

	it("DIR_OVERRIDE_ENV_KEYS combines agent, profile, config keys", () => {
		expect(DIR_OVERRIDE_ENV_KEYS).toContain("VEYYON_CODING_AGENT_DIR");
		expect(DIR_OVERRIDE_ENV_KEYS).toContain("VEYYON_PROFILE");
		expect(DIR_OVERRIDE_ENV_KEYS).toContain("VEYYON_CONFIG_DIR");
	});

	it("DIR_LOCATION_ENV_KEYS combines agent, config, xdg keys", () => {
		expect(DIR_LOCATION_ENV_KEYS).toContain("VEYYON_CODING_AGENT_DIR");
		expect(DIR_LOCATION_ENV_KEYS).toContain("VEYYON_CONFIG_DIR");
		expect(DIR_LOCATION_ENV_KEYS).toContain("XDG_CONFIG_HOME");
	});

	it("DIR_OVERRIDE_ENV_KEYS does not include XDG keys", () => {
		expect(DIR_OVERRIDE_ENV_KEYS).not.toContain("XDG_CONFIG_HOME");
	});
});

describe("parseEvalPromptOverridesJson", () => {
	it("returns empty object for undefined", () => {
		expect(parseEvalPromptOverridesJson(undefined)).toEqual({});
	});

	it("returns empty object for empty string", () => {
		expect(parseEvalPromptOverridesJson("")).toEqual({});
	});

	it("returns empty object for whitespace-only string", () => {
		expect(parseEvalPromptOverridesJson("   ")).toEqual({});
	});

	it("parses valid JSON object", () => {
		expect(parseEvalPromptOverridesJson('{"id1":"text1"}')).toEqual({ id1: "text1" });
	});

	it("parses multiple entries", () => {
		expect(parseEvalPromptOverridesJson('{"a":"x","b":"y"}')).toEqual({ a: "x", b: "y" });
	});

	it("throws for invalid JSON", () => {
		expect(() => parseEvalPromptOverridesJson("not json")).toThrow();
	});

	it("throws for array", () => {
		expect(() => parseEvalPromptOverridesJson('["a","b"]')).toThrow(/array/);
	});

	it("throws for null", () => {
		expect(() => parseEvalPromptOverridesJson("null")).toThrow(/null/);
	});

	it("throws for non-string value", () => {
		expect(() => parseEvalPromptOverridesJson('{"id":42}')).toThrow(/must be a string/);
	});

	it("throws for boolean value", () => {
		expect(() => parseEvalPromptOverridesJson('{"id":true}')).toThrow(/must be a string/);
	});

	it("accepts empty object", () => {
		expect(parseEvalPromptOverridesJson("{}")).toEqual({});
	});

	it("accepts empty string value", () => {
		expect(parseEvalPromptOverridesJson('{"id":""}')).toEqual({ id: "" });
	});
});

describe("applyEvalPromptOverrides", () => {
	it("returns prompts unchanged when no overrides active", () => {
		const prompts = { a: { text: "original" } };
		const result = applyEvalPromptOverrides(prompts);
		expect(result.prompts).toBe(prompts);
		expect(result.appliedIds).toEqual([]);
	});

	it("returns prompts unchanged when override id does not match", () => {
		const prompts = { a: { text: "original" } };
		// This test relies on env not being set, which is the default
		const result = applyEvalPromptOverrides(prompts);
		expect(result.appliedIds).toEqual([]);
	});
});

describe("PROMPT_ID_SHAPE_HINT", () => {
	it("is a non-empty string", () => {
		expect(PROMPT_ID_SHAPE_HINT.length).toBeGreaterThan(0);
	});

	it("mentions .md", () => {
		expect(PROMPT_ID_SHAPE_HINT).toContain(".md");
	});

	it("mentions tools/bash as example", () => {
		expect(PROMPT_ID_SHAPE_HINT).toContain("tools/bash");
	});
});

describe("describeUnknownPromptIds", () => {
	it("returns description for each unknown id", () => {
		const result = describeUnknownPromptIds(["unknown1"], ["known1", "known2"]);
		expect(result).toContain("unknown1");
	});

	it("suggests nearest names when close match exists", () => {
		const result = describeUnknownPromptIds(["bash"], ["bash_tool", "batch", "cache"]);
		expect(result).toContain("bash");
		// Should suggest something close
		expect(result).toContain("did you mean");
	});

	it("does not suggest when no close match", () => {
		const result = describeUnknownPromptIds(["zzz"], ["aaa", "bbb"]);
		expect(result).toContain("zzz");
		expect(result).not.toContain("did you mean");
	});

	it("handles multiple unknown ids", () => {
		const result = describeUnknownPromptIds(["id1", "id2"], ["known"]);
		expect(result).toContain("id1");
		expect(result).toContain("id2");
	});

	it("handles empty unknown list", () => {
		expect(describeUnknownPromptIds([], ["known"])).toBe("");
	});
});
