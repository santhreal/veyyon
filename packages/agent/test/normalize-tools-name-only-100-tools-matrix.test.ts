/**
 * normalizeTools: 100 valid name-only tools preserve order and names.
 * Why: large registries must not drop, reorder, or invent tools.
 */
import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@veyyon/agent-core/agent-loop";

describe("normalizeTools name-only 100 tools matrix", () => {
	const tools = Array.from({ length: 100 }, (_, i) => ({
		name: `tool_${i}`,
		description: `d${i}`,
		parameters: { type: "object", properties: {} },
	}));

	it("preserves length and names order with injectIntent false", () => {
		const out = normalizeTools(tools as never, false);
		expect(out).toHaveLength(100);
		for (let i = 0; i < 100; i++) {
			expect(out![i]!.name).toBe(`tool_${i}`);
		}
	});

	it("pruneDescriptions empties description", () => {
		const out = normalizeTools(tools as never, false, undefined, true);
		expect(out).toHaveLength(100);
		for (const t of out!) {
			expect(t.description).toBe("");
		}
	});

	it("filters null slots", () => {
		const mixed = [null, tools[0], undefined, tools[1], "bad", tools[2]] as never;
		const out = normalizeTools(mixed, false);
		expect(out!.map((t) => t.name)).toEqual(["tool_0", "tool_1", "tool_2"]);
	});
});
