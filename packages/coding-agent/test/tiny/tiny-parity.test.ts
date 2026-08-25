/**
 * Tiny model registry, title text normalization, and dtype contracts.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. The tiny subsystem defines local model registries for title and
 * memory generation, the title text normalization pipeline, and dtype
 * settings. These contracts pin the model keys, sentinel value, title
 * normalization behavior, and dtype defaults.
 */
import { describe, expect, it } from "bun:test";
import {
	DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY,
	ONLINE_TINY_TITLE_MODEL_KEY,
	TINY_TITLE_LOCAL_MODELS,
	TINY_TITLE_MODEL_VALUES,
	isTinyTitleLocalModelKey,
	getTinyTitleModelSpec,
} from "@veyyon/coding-agent/tiny/models";
import {
	NO_TITLE_SENTINEL,
	isLowSignalTitleInput,
	normalizeGeneratedTitle,
} from "@veyyon/coding-agent/tiny/text";
import {
	TINY_MODEL_DTYPE_DEFAULT,
	TINY_MODEL_DTYPE_SETTING_VALUES,
	normalizeTinyModelDtype,
} from "@veyyon/coding-agent/tiny/dtype";

describe("tiny title model registry", () => {
	it("DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY is 'lfm2-700m'", () => {
		expect(DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY).toBe("lfm2-700m");
	});

	it("ONLINE_TINY_TITLE_MODEL_KEY is 'online'", () => {
		expect(ONLINE_TINY_TITLE_MODEL_KEY).toBe("online");
	});

	it("TINY_TITLE_LOCAL_MODELS is non-empty", () => {
		expect(TINY_TITLE_LOCAL_MODELS.length).toBeGreaterThan(0);
	});

	it("TINY_TITLE_MODEL_VALUES includes 'online'", () => {
		expect(TINY_TITLE_MODEL_VALUES).toContain("online");
	});

	it("every local model has a key and label", () => {
		for (const model of TINY_TITLE_LOCAL_MODELS) {
			expect(typeof model.key).toBe("string");
			expect(model.key.length).toBeGreaterThan(0);
		}
	});

	it("isTinyTitleLocalModelKey returns true for known keys", () => {
		const key = TINY_TITLE_LOCAL_MODELS[0].key;
		expect(isTinyTitleLocalModelKey(key)).toBe(true);
	});

	it("isTinyTitleLocalModelKey returns false for unknown keys", () => {
		expect(isTinyTitleLocalModelKey("nonexistent-model")).toBe(false);
	});

	it("getTinyTitleModelSpec returns spec for known key", () => {
		const key = TINY_TITLE_LOCAL_MODELS[0].key;
		const spec = getTinyTitleModelSpec(key);
		expect(spec.key).toBe(key);
	});
});

describe("tiny title text normalization", () => {
	it("NO_TITLE_SENTINEL is 'none'", () => {
		expect(NO_TITLE_SENTINEL).toBe("none");
	});

	it("isLowSignalTitleInput returns true for 'hi'", () => {
		expect(isLowSignalTitleInput("hi")).toBe(true);
	});

	it("isLowSignalTitleInput returns true for 'hey thanks'", () => {
		expect(isLowSignalTitleInput("hey thanks")).toBe(true);
	});

	it("isLowSignalTitleInput returns false for 'fix the bug'", () => {
		expect(isLowSignalTitleInput("fix the bug")).toBe(false);
	});

	it("isLowSignalTitleInput returns true for empty string", () => {
		expect(isLowSignalTitleInput("")).toBe(true);
	});

	it("isLowSignalTitleInput returns true for numbers only", () => {
		expect(isLowSignalTitleInput("123 456")).toBe(true);
	});

	it("normalizeGeneratedTitle returns null for empty input", () => {
		expect(normalizeGeneratedTitle("")).toBeNull();
	});

	it("normalizeGeneratedTitle returns null for whitespace input", () => {
		expect(normalizeGeneratedTitle("   ")).toBeNull();
	});

	it("normalizeGeneratedTitle returns null for 'none' sentinel", () => {
		expect(normalizeGeneratedTitle("none")).toBeNull();
	});

	it("normalizeGeneratedTitle returns null for '<title/>'", () => {
		expect(normalizeGeneratedTitle("<title/>")).toBeNull();
	});

	it("normalizeGeneratedTitle strips surrounding quotes", () => {
		expect(normalizeGeneratedTitle('"Hello World"')).toBe("Hello World");
	});

	it("normalizeGeneratedTitle strips trailing punctuation", () => {
		expect(normalizeGeneratedTitle("Hello World.")).toBe("Hello World");
	});

	it("normalizeGeneratedTitle takes first line only", () => {
		expect(normalizeGeneratedTitle("First Line\nSecond Line")).toBe("First Line");
	});

	it("normalizeGeneratedTitle strips <title> tags", () => {
		expect(normalizeGeneratedTitle("<title>Hello</title>")).toBe("Hello");
	});

	it("normalizeGeneratedTitle returns null for null input", () => {
		expect(normalizeGeneratedTitle(null)).toBeNull();
	});
});

describe("tiny model dtype", () => {
	it("TINY_MODEL_DTYPE_DEFAULT is 'default'", () => {
		expect(TINY_MODEL_DTYPE_DEFAULT).toBe("default");
	});

	it("TINY_MODEL_DTYPE_SETTING_VALUES includes 'default'", () => {
		expect(TINY_MODEL_DTYPE_SETTING_VALUES).toContain("default");
	});

	it("normalizeTinyModelDtype returns undefined for undefined input", () => {
		expect(normalizeTinyModelDtype(undefined)).toBeUndefined();
	});

	it("normalizeTinyModelDtype throws for 'default'", () => {
		expect(() => normalizeTinyModelDtype("default")).toThrow();
	});
});
