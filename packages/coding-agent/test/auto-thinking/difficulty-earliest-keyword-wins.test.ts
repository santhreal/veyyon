/**
 * `parseDifficultyLevel` / `parseDifficultyBucket` take the FIRST keyword in
 * the classifier's prose. auto-thinking-classifier.test.ts only pins isolated
 * labels (`high`, `x-high`, `trivial`). Remaining misses:
 *
 *   - `/x[\s_-]?high/` has no word boundary, so `maxhigh` is XHigh unless refused
 *   - `extremely high` is High (the `x` in extremely is not adjacent)
 *   - earliest keyword in a hedge wins, not source-order of the regex table
 *   - `\b` treats `-` as a boundary, so `hard-coded` is Hard unless refused
 *   - `nontrivial` must not match `\btrivial\b`
 */
import { describe, expect, it } from "bun:test";
import { Effort } from "@veyyon/catalog/effort";
import {
	parseDifficultyBucket,
	parseDifficultyLevel,
} from "@veyyon/coding-agent/auto-thinking/classifier";

describe("parseDifficultyLevel substring and earliest-wins", () => {
	it("does not treat maxhigh as xhigh (no separator, no leading x-token)", () => {
		expect(parseDifficultyLevel("maxhigh")).toBeUndefined();
	});

	it("does not treat the x in extremely high as an xhigh token", () => {
		expect(parseDifficultyLevel("extremely high complexity")).toBe(Effort.High);
	});

	it("does not classify highest via the high word", () => {
		expect(parseDifficultyLevel("the highest priority is docs")).toBeUndefined();
	});

	it("picks high when high appears before xhigh", () => {
		expect(parseDifficultyLevel("high, not xhigh")).toBe(Effort.High);
	});

	it("picks xhigh when xhigh appears before high", () => {
		expect(parseDifficultyLevel("xhigh rather than high")).toBe(Effort.XHigh);
	});

	it("does not match high inside a snake_case identifier that is not a label", () => {
		expect(parseDifficultyLevel("use effort_high_watermark")).toBeUndefined();
	});
});

describe("parseDifficultyBucket word-boundary traps", () => {
	it("does not classify nontrivial as trivial", () => {
		expect(parseDifficultyBucket("this is nontrivial")).toBeUndefined();
	});

	it("does not classify hardly or hardware as hard", () => {
		expect(parseDifficultyBucket("hardly any work")).toBeUndefined();
		expect(parseDifficultyBucket("hardware register map")).toBeUndefined();
	});

	it("must not treat hard-coded as the hard bucket", () => {
		expect(parseDifficultyBucket("a hard-coded constant")).toBeUndefined();
	});

	it("picks the first bucket keyword, not the last", () => {
		expect(parseDifficultyBucket("trivial, not hard")).toBe(Effort.Low);
		expect(parseDifficultyBucket("hard rather than trivial")).toBe(Effort.XHigh);
	});
});
