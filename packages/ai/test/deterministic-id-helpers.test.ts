import { describe, expect, it } from "bun:test";
import { deterministicUuid } from "../src/utils/deterministic-id";

describe("deterministicUuid", () => {
	it("returns a valid UUID format", () => {
		const result = deterministicUuid("test");
		expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
	it("returns consistent result for same seed", () => {
		expect(deterministicUuid("seed1")).toBe(deterministicUuid("seed1"));
	});
	it("returns different results for different seeds", () => {
		expect(deterministicUuid("seed1")).not.toBe(deterministicUuid("seed2"));
	});
	it("returns different result for empty string vs non-empty", () => {
		expect(deterministicUuid("")).not.toBe(deterministicUuid("test"));
	});
	it("returns consistent for empty string", () => {
		expect(deterministicUuid("")).toBe(deterministicUuid(""));
	});
	it("produces lowercase hex", () => {
		const result = deterministicUuid("test");
		expect(result).toBe(result.toLowerCase());
	});
	it("handles unicode seed", () => {
		const result = deterministicUuid("héllo🌍");
		expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
	it("handles long seed", () => {
		const result = deterministicUuid("a".repeat(1000));
		expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
});
