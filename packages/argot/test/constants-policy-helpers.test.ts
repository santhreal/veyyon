import { describe, expect, it } from "bun:test";
import {
	ARGOT_LOAD_TOOL,
	ARGOT_UNLOAD_TOOL,
	DEFAULT_OUTPUT_TO_INPUT_PRICE_RATIO,
	DEFAULT_SAVINGS_COVERAGE,
	DEFAULT_SIGIL,
	DEFAULT_TOKEN_BUDGET,
	DEFAULT_TOOL_CALL_STRUCTURE_SHARE,
	DICT_FILENAME,
	GENERATOR_REVISION,
	HANDLE_NAME_CHAR_RE,
	HANDLE_NAME_RE,
	MAX_EXPANSION_BYTES,
	SIGIL_FORBIDDEN_RE,
	SUPPORTED_VERSION,
} from "../src/constants";
import { EMPTY_GATE, makeGate, modelAllowed, modelIdSegment, shouldEncode } from "../src/policy";

describe("constants", () => {
	it("SUPPORTED_VERSION is 1", () => {
		expect(SUPPORTED_VERSION).toBe(1);
	});

	it("DEFAULT_SIGIL is §", () => {
		expect(DEFAULT_SIGIL).toBe("§");
	});

	it("DEFAULT_TOKEN_BUDGET is 1000", () => {
		expect(DEFAULT_TOKEN_BUDGET).toBe(1000);
	});

	it("DEFAULT_SAVINGS_COVERAGE is 0.9", () => {
		expect(DEFAULT_SAVINGS_COVERAGE).toBe(0.9);
	});

	it("GENERATOR_REVISION is 3", () => {
		expect(GENERATOR_REVISION).toBe(3);
	});

	it("DEFAULT_TOOL_CALL_STRUCTURE_SHARE is 0.4176", () => {
		expect(DEFAULT_TOOL_CALL_STRUCTURE_SHARE).toBe(0.4176);
	});

	it("DEFAULT_OUTPUT_TO_INPUT_PRICE_RATIO is 5", () => {
		expect(DEFAULT_OUTPUT_TO_INPUT_PRICE_RATIO).toBe(5);
	});

	it("DICT_FILENAME is AGENTS.dict", () => {
		expect(DICT_FILENAME).toBe("AGENTS.dict");
	});

	it("ARGOT_LOAD_TOOL is argot_load", () => {
		expect(ARGOT_LOAD_TOOL).toBe("argot_load");
	});

	it("ARGOT_UNLOAD_TOOL is argot_unload", () => {
		expect(ARGOT_UNLOAD_TOOL).toBe("argot_unload");
	});

	it("MAX_EXPANSION_BYTES is 8192", () => {
		expect(MAX_EXPANSION_BYTES).toBe(8192);
	});
});

describe("HANDLE_NAME_RE", () => {
	it("matches lowercase alphanumeric and underscore", () => {
		expect(HANDLE_NAME_RE.test("hello")).toBe(true);
		expect(HANDLE_NAME_RE.test("hello123")).toBe(true);
		expect(HANDLE_NAME_RE.test("hello_world")).toBe(true);
		expect(HANDLE_NAME_RE.test("_private")).toBe(true);
	});

	it("does not match uppercase", () => {
		expect(HANDLE_NAME_RE.test("Hello")).toBe(false);
	});

	it("does not match hyphens", () => {
		expect(HANDLE_NAME_RE.test("hello-world")).toBe(false);
	});

	it("does not match empty string", () => {
		expect(HANDLE_NAME_RE.test("")).toBe(false);
	});

	it("does not match special characters", () => {
		expect(HANDLE_NAME_RE.test("hello$world")).toBe(false);
	});
});

describe("HANDLE_NAME_CHAR_RE", () => {
	it("matches lowercase letters", () => {
		expect(HANDLE_NAME_CHAR_RE.test("a")).toBe(true);
	});

	it("matches digits", () => {
		expect(HANDLE_NAME_CHAR_RE.test("1")).toBe(true);
	});

	it("matches underscore", () => {
		expect(HANDLE_NAME_CHAR_RE.test("_")).toBe(true);
	});

	it("does not match uppercase", () => {
		expect(HANDLE_NAME_CHAR_RE.test("A")).toBe(false);
	});

	it("does not match hyphen", () => {
		expect(HANDLE_NAME_CHAR_RE.test("-")).toBe(false);
	});
});

describe("SIGIL_FORBIDDEN_RE", () => {
	it("matches lowercase letters", () => {
		expect(SIGIL_FORBIDDEN_RE.test("a")).toBe(true);
	});

	it("matches digits", () => {
		expect(SIGIL_FORBIDDEN_RE.test("1")).toBe(true);
	});

	it("matches underscore", () => {
		expect(SIGIL_FORBIDDEN_RE.test("_")).toBe(true);
	});

	it("matches whitespace", () => {
		expect(SIGIL_FORBIDDEN_RE.test(" ")).toBe(true);
	});

	it("does not match §", () => {
		expect(SIGIL_FORBIDDEN_RE.test("§")).toBe(false);
	});

	it("does not match other special chars", () => {
		expect(SIGIL_FORBIDDEN_RE.test("@")).toBe(false);
	});
});

describe("EMPTY_GATE", () => {
	it("has empty models array", () => {
		expect(EMPTY_GATE.models).toEqual([]);
	});

	it("has disableAboveTokens 0", () => {
		expect(EMPTY_GATE.disableAboveTokens).toBe(0);
	});
});

describe("makeGate", () => {
	it("returns EMPTY_GATE when disabled", () => {
		expect(makeGate(false)).toBe(EMPTY_GATE);
	});

	it("returns gate with models when enabled", () => {
		const gate = makeGate(true, { models: ["claude-sonnet"] });
		expect(gate.models).toEqual(["claude-sonnet"]);
	});

	it("returns gate with disableAboveTokens when enabled", () => {
		const gate = makeGate(true, { disableAboveTokens: 100000 });
		expect(gate.disableAboveTokens).toBe(100000);
	});

	it("defaults to empty models when enabled", () => {
		const gate = makeGate(true);
		expect(gate.models).toEqual([]);
	});

	it("defaults to 0 disableAboveTokens when enabled", () => {
		const gate = makeGate(true);
		expect(gate.disableAboveTokens).toBe(0);
	});
});

describe("shouldEncode", () => {
	it("returns false when no models in gate", () => {
		expect(shouldEncode({ models: [], disableAboveTokens: 0 }, { model: "test", contextTokens: 100 })).toBe(false);
	});

	it("returns false when model not in gate", () => {
		expect(
			shouldEncode({ models: ["other-model"], disableAboveTokens: 0 }, { model: "test-model", contextTokens: 100 }),
		).toBe(false);
	});

	it("returns true when model matches and under token limit", () => {
		expect(
			shouldEncode(
				{ models: ["test-model"], disableAboveTokens: 100000 },
				{ model: "test-model", contextTokens: 100 },
			),
		).toBe(true);
	});

	it("returns false when context tokens exceed limit", () => {
		expect(
			shouldEncode({ models: ["test-model"], disableAboveTokens: 100 }, { model: "test-model", contextTokens: 200 }),
		).toBe(false);
	});

	it("returns false at exact token limit", () => {
		expect(
			shouldEncode({ models: ["test-model"], disableAboveTokens: 100 }, { model: "test-model", contextTokens: 100 }),
		).toBe(false);
	});

	it("returns true when disableAboveTokens is 0", () => {
		expect(
			shouldEncode(
				{ models: ["test-model"], disableAboveTokens: 0 },
				{ model: "test-model", contextTokens: 999999 },
			),
		).toBe(true);
	});
});

describe("modelAllowed", () => {
	it("matches exact model with slash", () => {
		expect(modelAllowed("provider/model", "provider/model")).toBe(true);
	});

	it("does not match different model with slash", () => {
		expect(modelAllowed("provider/model", "provider/other")).toBe(false);
	});

	it("matches model id segment without slash", () => {
		expect(modelAllowed("model", "provider/model")).toBe(true);
	});

	it("does not match different segment", () => {
		expect(modelAllowed("model", "provider/other")).toBe(false);
	});

	it("matches bare model without slash", () => {
		expect(modelAllowed("model", "model")).toBe(true);
	});
});

describe("modelIdSegment", () => {
	it("returns segment after last slash", () => {
		expect(modelIdSegment("provider/model")).toBe("model");
	});

	it("returns segment after multiple slashes", () => {
		expect(modelIdSegment("a/b/c")).toBe("c");
	});

	it("returns whole string when no slash", () => {
		expect(modelIdSegment("model")).toBe("model");
	});

	it("handles empty string", () => {
		expect(modelIdSegment("")).toBe("");
	});

	it("handles trailing slash", () => {
		expect(modelIdSegment("provider/")).toBe("");
	});
});
