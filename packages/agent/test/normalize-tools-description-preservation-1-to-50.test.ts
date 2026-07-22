/**
 * normalizeTools: descriptions of length 0..50 preserved when prune false.
 */
import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@veyyon/agent-core/agent-loop";

describe("normalizeTools description preservation 1 to 50", () => {
	for (let n = 0; n <= 50; n++) {
		it(`desc len=${n}`, () => {
			const desc = "d".repeat(n);
			const tools = [
				{
					name: "t",
					description: desc,
					parameters: { type: "object", properties: {} },
				},
			];
			const out = normalizeTools(tools as never, false);
			expect(out![0]!.description).toBe(desc);
		});
	}

	it("missing description becomes empty string", () => {
		const tools = [{ name: "t", parameters: { type: "object", properties: {} } }];
		const out = normalizeTools(tools as never, false);
		expect(out![0]!.description).toBe("");
	});
});
