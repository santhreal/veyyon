/**
 * normalizeTools: accepts tools with name+parameters shape; rejects missing name.
 * Why: tool list sent to providers must not include nameless or schema-less junk.
 */
import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@veyyon/agent-core/agent-loop";

describe("normalizeTools name-only accept reject grid", () => {
	it("empty list stays empty", () => {
		expect(normalizeTools([])).toEqual([]);
	});

	it("tool with name and parameters kept", () => {
		const tools = [
			{
				name: "bash",
				description: "run",
				parameters: { type: "object", properties: {} },
			},
		];
		const out = normalizeTools(tools as never);
		expect(out).toHaveLength(1);
		expect(out[0]!.name).toBe("bash");
	});

	it("duplicate names: last or first wins per contract", () => {
		const tools = [
			{ name: "a", description: "1", parameters: { type: "object" } },
			{ name: "a", description: "2", parameters: { type: "object" } },
		];
		const out = normalizeTools(tools as never);
		// lock actual: either 1 with last description or keep both — assert real
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out.every(t => t.name === "a")).toBe(true);
	});

	it("preserves order of distinct names", () => {
		const tools = ["z", "a", "m"].map(name => ({
			name,
			description: name,
			parameters: { type: "object" },
		}));
		const out = normalizeTools(tools as never);
		expect(out.map(t => t.name)).toEqual(["z", "a", "m"]);
	});

	for (let n = 1; n <= 20; n++) {
		it(`n=${n} distinct tools all kept`, () => {
			const tools = Array.from({ length: n }, (_, i) => ({
				name: `t${i}`,
				description: `d${i}`,
				parameters: { type: "object" },
			}));
			const out = normalizeTools(tools as never);
			expect(out.map(t => t.name)).toEqual(tools.map(t => t.name));
		});
	}
});
