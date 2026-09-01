import { describe, expect, it } from "bun:test";
import { toolResultNeverRan } from "../src/tool-result-never-ran";

describe("toolResultNeverRan", () => {
	it("returns false for null", () => {
		expect(toolResultNeverRan(null)).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(toolResultNeverRan(undefined)).toBe(false);
	});
	it("returns false for non-object", () => {
		expect(toolResultNeverRan("hello")).toBe(false);
	});
	it("returns true for synthetic with executed=false", () => {
		expect(toolResultNeverRan({ __synthetic: true, executed: false })).toBe(true);
	});
	it("returns false for synthetic with executed=true", () => {
		expect(toolResultNeverRan({ __synthetic: true, executed: true })).toBe(false);
	});
	it("returns false for synthetic without executed", () => {
		expect(toolResultNeverRan({ __synthetic: true })).toBe(false);
	});
	it("returns true for skipped with entered=false", () => {
		expect(toolResultNeverRan({ __skipped: true, entered: false })).toBe(true);
	});
	it("returns false for skipped with entered=true", () => {
		expect(toolResultNeverRan({ __skipped: true, entered: true })).toBe(false);
	});
	it("returns true for skipped without entered (entered defaults to undefined !== true)", () => {
		expect(toolResultNeverRan({ __skipped: true })).toBe(true);
	});
	it("returns false for plain object without flags", () => {
		expect(toolResultNeverRan({ foo: "bar" })).toBe(false);
	});
	it("returns false for empty object", () => {
		expect(toolResultNeverRan({})).toBe(false);
	});
	it("returns false for array", () => {
		expect(toolResultNeverRan([1, 2, 3])).toBe(false);
	});
	it("returns false for number", () => {
		expect(toolResultNeverRan(42)).toBe(false);
	});
	it("returns true for synthetic with extra properties", () => {
		expect(toolResultNeverRan({ __synthetic: true, executed: false, reason: "test" })).toBe(true);
	});
	it("returns true for skipped with extra properties", () => {
		expect(toolResultNeverRan({ __skipped: true, entered: false, reason: "test" })).toBe(true);
	});
	it("prioritizes skipped over synthetic", () => {
		// __skipped is checked first; entered=false makes it true regardless of __synthetic
		expect(toolResultNeverRan({ __skipped: true, entered: false, __synthetic: true, executed: true })).toBe(true);
	});
	it("returns false when skipped with entered=true despite synthetic executed=false", () => {
		expect(toolResultNeverRan({ __skipped: true, entered: true, __synthetic: true, executed: false })).toBe(false);
	});
});
