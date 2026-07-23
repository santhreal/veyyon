/**
 * isSoftToolRequirement discriminates soft:true objects from hard ToolChoice
 * and non-objects. Fail-closed: soft:false / missing soft / primitives are not soft.
 */
import { describe, expect, it } from "bun:test";
import type { SoftToolRequirement } from "@veyyon/agent-core/types";
import { isSoftToolRequirement } from "@veyyon/agent-core/types";

function soft(id: string): SoftToolRequirement {
	return {
		soft: true,
		id,
		toolName: "resolve",
		reminder: [],
	};
}

describe("isSoftToolRequirement pure matrix", () => {
	it("true for soft:true requirement", () => {
		expect(isSoftToolRequirement(soft("preview-1"))).toBe(true);
	});

	it("false for undefined", () => {
		expect(isSoftToolRequirement(undefined)).toBe(false);
	});

	const hardChoices = ["auto", "none", "required"] as const;
	for (const c of hardChoices) {
		it(`false for hard choice string ${c}`, () => {
			expect(isSoftToolRequirement(c as never)).toBe(false);
		});
	}

	it("false for soft:false object", () => {
		expect(isSoftToolRequirement({ soft: false, id: "x" } as never)).toBe(false);
	});

	it("false for object missing soft", () => {
		expect(isSoftToolRequirement({ id: "x", toolName: "resolve" } as never)).toBe(false);
	});

	it("false for null", () => {
		expect(isSoftToolRequirement(null as never)).toBe(false);
	});

	it("false for number / boolean / array", () => {
		expect(isSoftToolRequirement(1 as never)).toBe(false);
		expect(isSoftToolRequirement(true as never)).toBe(false);
		expect(isSoftToolRequirement([] as never)).toBe(false);
	});

	it("true only when soft property is strictly true", () => {
		expect(isSoftToolRequirement({ soft: "true" } as never)).toBe(false);
		expect(isSoftToolRequirement({ soft: 1 } as never)).toBe(false);
	});
});
