/**
 * isSoftToolRequirement: soft:true with reminder length 0..50 still soft.
 */
import { describe, expect, it } from "bun:test";
import { isSoftToolRequirement } from "@veyyon/agent-core/types";

describe("isSoftToolRequirement reminder length matrix", () => {
	for (let n = 0; n <= 50; n++) {
		it(`reminder len=${n}`, () => {
			expect(
				isSoftToolRequirement({
					soft: true,
					id: "x",
					toolName: "t",
					reminder: Array.from({ length: n }, (_, i) => `r${i}`),
				}),
			).toBe(true);
		});
	}

	it("soft false with long reminder still false", () => {
		expect(
			isSoftToolRequirement({
				soft: false,
				id: "x",
				toolName: "t",
				reminder: Array.from({ length: 50 }, () => "r"),
			} as never),
		).toBe(false);
	});
});
