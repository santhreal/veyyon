import { describe, expect, it } from "bun:test";
import {
	bareModelId,
	isAnthropicAdaptiveGenAtLeast,
	isFableOrMythos,
	parseKnownModel,
	semverEqual,
	semverGte,
} from "../src/identity/classify";

describe("bareModelId", () => {
	it("returns full string when no slash", () => {
		expect(bareModelId("gpt-4")).toBe("gpt-4");
	});

	it("strips provider prefix", () => {
		expect(bareModelId("openai/gpt-4")).toBe("gpt-4");
	});

	it("strips nested provider prefix (last slash)", () => {
		expect(bareModelId("anthropic/claude-3-opus")).toBe("claude-3-opus");
	});

	it("handles trailing slash", () => {
		expect(bareModelId("provider/")).toBe("");
	});

	it("handles multiple slashes (takes last segment)", () => {
		expect(bareModelId("a/b/c/model")).toBe("model");
	});

	it("handles empty string", () => {
		expect(bareModelId("")).toBe("");
	});

	it("handles slash-only string", () => {
		expect(bareModelId("/")).toBe("");
	});
});

describe("parseKnownModel", () => {
	it("parses gemini model", () => {
		const result = parseKnownModel("gemini-2.0-flash");
		expect(result.family).toBe("gemini");
	});

	it("parses anthropic model", () => {
		const result = parseKnownModel("claude-sonnet-4");
		expect(result.family).toBe("anthropic");
	});

	it("parses openai model", () => {
		const result = parseKnownModel("gpt-5");
		expect(result.family).toBe("openai");
	});

	it("returns unknown for unrecognized model", () => {
		const result = parseKnownModel("unknown-model");
		expect(result.family).toBe("unknown");
	});

	it("strips provider prefix before parsing", () => {
		const result = parseKnownModel("openai/gpt-5");
		expect(result.family).toBe("openai");
	});

	it("parses gemini with -preview suffix", () => {
		const result = parseKnownModel("gemini-2.0-flash-preview");
		expect(result.family).toBe("gemini");
	});
});

describe("isFableOrMythos", () => {
	it("returns true for fable", () => {
		expect(isFableOrMythos("fable")).toBe(true);
	});

	it("returns true for mythos", () => {
		expect(isFableOrMythos("mythos")).toBe(true);
	});

	it("returns false for opus", () => {
		expect(isFableOrMythos("opus")).toBe(false);
	});

	it("returns false for sonnet", () => {
		expect(isFableOrMythos("sonnet")).toBe(false);
	});
});

describe("isAnthropicAdaptiveGenAtLeast", () => {
	it("returns true for opus 4.6 against 4.6 minimum", () => {
		const parsed = parseKnownModel("claude-opus-4.6") as {
			family: string;
			kind: string;
			version: { major: number; minor: number; patch: number };
		};
		expect(isAnthropicAdaptiveGenAtLeast(parsed as never, "4.6")).toBe(true);
	});

	it("returns true for opus 4.7 against 4.6 minimum", () => {
		const parsed = parseKnownModel("claude-opus-4.7") as {
			family: string;
			kind: string;
			version: { major: number; minor: number; patch: number };
		};
		expect(isAnthropicAdaptiveGenAtLeast(parsed as never, "4.6")).toBe(true);
	});

	it("returns false for opus 4.5 against 4.6 minimum", () => {
		const parsed = parseKnownModel("claude-opus-4.5") as {
			family: string;
			kind: string;
			version: { major: number; minor: number; patch: number };
		};
		expect(isAnthropicAdaptiveGenAtLeast(parsed as never, "4.6")).toBe(false);
	});

	it("returns true for sonnet 5 against 4.6 minimum (non-opus uses 5 threshold)", () => {
		const parsed = parseKnownModel("claude-sonnet-5") as {
			family: string;
			kind: string;
			version: { major: number; minor: number; patch: number };
		};
		expect(isAnthropicAdaptiveGenAtLeast(parsed as never, "4.6")).toBe(true);
	});

	it("returns false for sonnet 4 against 4.6 minimum (non-opus uses 5 threshold)", () => {
		const parsed = parseKnownModel("claude-sonnet-4") as {
			family: string;
			kind: string;
			version: { major: number; minor: number; patch: number };
		};
		expect(isAnthropicAdaptiveGenAtLeast(parsed as never, "4.6")).toBe(false);
	});
});

describe("semverGte", () => {
	it("returns true for equal versions", () => {
		expect(semverGte("5.0", "5.0")).toBe(true);
	});

	it("returns true for greater version", () => {
		expect(semverGte("5.1", "5.0")).toBe(true);
	});

	it("returns false for lesser version", () => {
		expect(semverGte("4.9", "5.0")).toBe(false);
	});

	it("returns true for same major, greater minor", () => {
		expect(semverGte("5.2", "5.1")).toBe(true);
	});

	it("handles major-only versions", () => {
		expect(semverGte("5", "4")).toBe(true);
		expect(semverGte("4", "5")).toBe(false);
	});

	it("handles SemVer objects", () => {
		expect(semverGte({ major: 5, minor: 0, patch: 0 }, { major: 4, minor: 9, patch: 0 })).toBe(true);
	});

	it("handles mixed string and SemVer", () => {
		expect(semverGte("5.0", { major: 4, minor: 0, patch: 0 })).toBe(true);
	});

	it("handles dash separator", () => {
		expect(semverGte("5-0", "5-0")).toBe(true);
	});

	it("handles patch versions", () => {
		expect(semverGte({ major: 5, minor: 0, patch: 1 }, { major: 5, minor: 0, patch: 0 })).toBe(true);
	});
});

describe("semverEqual", () => {
	it("returns true for equal versions", () => {
		expect(semverEqual("5.0", "5.0")).toBe(true);
	});

	it("returns false for different versions", () => {
		expect(semverEqual("5.0", "5.1")).toBe(false);
	});

	it("returns true for same version with different separators", () => {
		expect(semverEqual("5.0", "5-0")).toBe(true);
	});

	it("returns true for major-only vs major.0", () => {
		expect(semverEqual("5", "5.0")).toBe(true);
	});

	it("handles SemVer objects", () => {
		expect(semverEqual({ major: 5, minor: 0, patch: 0 }, { major: 5, minor: 0, patch: 0 })).toBe(true);
	});

	it("returns false for different major", () => {
		expect(semverEqual("4.0", "5.0")).toBe(false);
	});
});
