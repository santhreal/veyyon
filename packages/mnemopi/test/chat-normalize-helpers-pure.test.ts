import { describe, expect, it } from "bun:test";
import { extractionRate, normalizeBatch, normalizeChat } from "../src/core/chat-normalize";

describe("normalizeChat", () => {
	it("returns null for empty string", () => {
		expect(normalizeChat("")).toBeNull();
	});
	it("returns null for whitespace-only string", () => {
		expect(normalizeChat("   ")).toBeNull();
	});
	it("expands contractions (u -> you)", () => {
		expect(normalizeChat("u are cool")).toContain("you are cool");
	});
	it("expands contractions (ur -> your)", () => {
		expect(normalizeChat("ur code is nice")).toContain("your code is nice");
	});
	it("expands contractions (gonna -> going to)", () => {
		expect(normalizeChat("gonna do it")).toContain("going to do it");
	});
	it("expands contractions (cuz -> because)", () => {
		expect(normalizeChat("cuz i said so")).toContain("because i said so");
	});
	it("removes filler words (lol)", () => {
		const result = normalizeChat("lol that is funny");
		expect(result).not.toContain("lol");
	});
	it("removes filler words (idk)", () => {
		const result = normalizeChat("idk what to do about it");
		expect(result).not.toContain("idk");
	});
	it("returns null when only filler words remain", () => {
		expect(normalizeChat("lol omg wtf")).toBeNull();
	});
	it("returns null for single short word", () => {
		expect(normalizeChat("hi")).toBeNull();
	});
	it("returns single long word (>5 chars)", () => {
		expect(normalizeChat("building")).toBe("building");
	});
	it("returns null for single short word with filler", () => {
		expect(normalizeChat("lol")).toBeNull();
	});
	it("collapses repeated characters", () => {
		const result = normalizeChat("soooo coollll");
		expect(result).toContain("so");
		expect(result).toContain("cool");
	});
	it("replaces non-ASCII runs with spaces", () => {
		const result = normalizeChat("hello café world");
		expect(result).not.toContain("café");
	});
	it("adds implicit subject for 2-word fragment starters", () => {
		const result = normalizeChat("working now");
		expect(result).toContain("i am working now");
	});
	it("does not add implicit subject when disabled", () => {
		const result = normalizeChat("working on it", { add_implicit_subjects: false });
		expect(result).not.toContain("i am");
	});
	it("lowercases text", () => {
		const result = normalizeChat("Hello World");
		expect(result?.toLowerCase()).toBe(result);
	});
	it("preserves meaningful content", () => {
		const result = normalizeChat("please fix the bug in the parser");
		expect(result).toContain("please fix the bug in the parser");
	});
	it("handles multiple contractions", () => {
		const result = normalizeChat("u gonna gimme that?");
		expect(result).toContain("you");
		expect(result).toContain("going to");
		expect(result).toContain("give me");
	});
	it("handles edge punctuation in words", () => {
		const result = normalizeChat("...hello world...");
		expect(result).not.toBeNull();
		expect(result).toContain("hello");
		expect(result).toContain("world");
	});
});

describe("normalizeBatch", () => {
	it("normalizes multiple messages", () => {
		const results = normalizeBatch(["hello world", "lol", "fix the bug"]);
		expect(results[0]).not.toBeNull();
		expect(results[1]).toBeNull();
		expect(results[2]).not.toBeNull();
	});
	it("returns empty array for empty input", () => {
		expect(normalizeBatch([])).toEqual([]);
	});
	it("preserves order", () => {
		const results = normalizeBatch(["first message", "second message"]);
		expect(results.length).toBe(2);
		expect(results[0]).toContain("first message");
		expect(results[1]).toContain("second message");
	});
});

describe("extractionRate", () => {
	it("returns zero rate for empty input", () => {
		const rate = extractionRate([]);
		expect(rate.total).toBe(0);
		expect(rate.survived).toBe(0);
		expect(rate.dropped).toBe(0);
		expect(rate.rate).toBe(0.0);
	});
	it("counts survived and dropped correctly", () => {
		const rate = extractionRate(["hello world", "lol", "fix the bug"]);
		expect(rate.total).toBe(3);
		expect(rate.survived).toBe(2);
		expect(rate.dropped).toBe(1);
	});
	it("calculates rate correctly", () => {
		const rate = extractionRate(["hello world", "lol"]);
		expect(rate.rate).toBe(0.5);
	});
	it("collects dropped samples (max 5)", () => {
		const rate = extractionRate(["lol", "omg", "wtf", "idk", "brb", "ngl", "smh"]);
		expect(rate.dropped_samples.length).toBe(5);
	});
	it("rate is 1.0 when all survive", () => {
		const rate = extractionRate(["hello world", "fix the bug"]);
		expect(rate.rate).toBe(1.0);
	});
	it("rate is 0.0 when all dropped", () => {
		const rate = extractionRate(["lol", "omg"]);
		expect(rate.rate).toBe(0.0);
	});
});
