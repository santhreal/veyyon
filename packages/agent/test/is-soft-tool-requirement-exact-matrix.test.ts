/**
 * isSoftToolRequirement: only objects with soft:true (strict boolean).
 * Why: soft tool choice must not misfire on mode strings or soft:"true" coercion.
 */
import { describe, expect, it } from "bun:test";
import type { SoftToolRequirement } from "@veyyon/agent-core/types";
import { isSoftToolRequirement } from "@veyyon/agent-core/types";

function soft(id: string, toolName = "resolve"): SoftToolRequirement {
	return { soft: true, id, toolName, reminder: [] };
}

describe("isSoftToolRequirement exact matrix", () => {
	it("accepts soft:true with full shape", () => {
		expect(isSoftToolRequirement(soft("preview-1"))).toBe(true);
		expect(isSoftToolRequirement(soft("a", "bash"))).toBe(true);
	});

	it("accepts soft:true with empty reminder", () => {
		expect(isSoftToolRequirement({ soft: true, id: "x", toolName: "t", reminder: [] })).toBe(true);
	});

	it("soft:true alone is soft (discriminator-only)", () => {
		expect(isSoftToolRequirement({ soft: true } as never)).toBe(true);
	});

	it("rejects hard choice strings", () => {
		for (const c of ["auto", "none", "required"] as const) {
			expect(isSoftToolRequirement(c as never)).toBe(false);
		}
	});

	it("rejects soft:false and soft non-boolean", () => {
		expect(isSoftToolRequirement({ soft: false, id: "x" } as never)).toBe(false);
		expect(isSoftToolRequirement({ soft: "true" } as never)).toBe(false);
		expect(isSoftToolRequirement({ soft: 1 } as never)).toBe(false);
	});

	it("rejects mode:soft shape (wrong contract)", () => {
		expect(isSoftToolRequirement({ mode: "soft", tools: ["bash"] } as never)).toBe(false);
	});

	it("rejects null/undefined/primitives/array", () => {
		expect(isSoftToolRequirement(undefined)).toBe(false);
		expect(isSoftToolRequirement(null as never)).toBe(false);
		expect(isSoftToolRequirement(42 as never)).toBe(false);
		expect(isSoftToolRequirement(true as never)).toBe(false);
		expect(isSoftToolRequirement([] as never)).toBe(false);
	});

	it("rejects object missing soft", () => {
		expect(isSoftToolRequirement({ id: "x", toolName: "resolve", reminder: [] } as never)).toBe(false);
	});
});
