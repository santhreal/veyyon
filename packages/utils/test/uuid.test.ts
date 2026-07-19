import { describe, expect, it } from "bun:test";
import { isUuid, UUID_RE } from "../src/regex";

// `isUuid` / `UUID_RE` is the single owner for canonical-UUID matching. main.ts
// (session-id arg), typebox.ts (schema "uuid" format), and dirs.ts (UUID-named
// dirs) all re-point here. Version-specific patterns (UUID v7) stay separate.
describe("isUuid", () => {
	it("accepts a canonical lowercase UUID", () => {
		expect(isUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isUuid("123E4567-E89B-12D3-A456-426614174000")).toBe(true);
	});

	it("rejects non-UUID strings", () => {
		expect(isUuid("")).toBe(false);
		expect(isUuid("not-a-uuid")).toBe(false);
		expect(isUuid("123e4567e89b12d3a456426614174000")).toBe(false); // no hyphens
		expect(isUuid("123e4567-e89b-12d3-a456-42661417400")).toBe(false); // 11 in last group
		expect(isUuid("g23e4567-e89b-12d3-a456-426614174000")).toBe(false); // non-hex
	});

	it("is anchored — rejects a UUID embedded in surrounding text", () => {
		expect(isUuid("id=123e4567-e89b-12d3-a456-426614174000!")).toBe(false);
	});

	it("stays stateless across repeated calls (no global flag / lastIndex drift)", () => {
		const uuid = "123e4567-e89b-12d3-a456-426614174000";
		expect(UUID_RE.global).toBe(false);
		expect(isUuid(uuid)).toBe(true);
		expect(isUuid(uuid)).toBe(true);
	});
});
