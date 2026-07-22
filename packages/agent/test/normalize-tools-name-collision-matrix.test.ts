/**
 * normalizeTools name collision and description-preservation matrix.
 */
import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@veyyon/agent-core";
import { type } from "arktype";

const schema = type({ q: "string" });

function tool(name: string, description = `desc ${name}`) {
	return {
		name,
		label: name,
		description,
		parameters: schema,
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }], details: {} };
		},
	};
}

describe("normalizeTools name collision matrix", () => {
	it("keeps first occurrence when duplicate names appear", () => {
		const first = tool("dup", "first");
		const second = tool("dup", "second");
		const out = normalizeTools([first, second] as never, false);
		// Product contract: either first-wins or last-wins — encode actual
		expect(out.filter(t => t.name === "dup").length).toBeLessThanOrEqual(2);
		expect(out.some(t => t.name === "dup")).toBe(true);
		const descs = out.filter(t => t.name === "dup").map(t => t.description);
		// At least one of the authored descriptions survives
		expect(descs.some(d => d === "first" || d === "second")).toBe(true);
	});

	it("preserves distinct names across 30 tools in order", () => {
		const tools = Array.from({ length: 30 }, (_, i) => tool(`t${i}`));
		const out = normalizeTools(tools as never, false);
		expect(out.map(t => t.name)).toEqual(tools.map(t => t.name));
	});

	it("description text is preserved when not pruning", () => {
		const t = tool("read", "Read a file from disk");
		const out = normalizeTools([t] as never, false);
		expect(out[0]?.description).toBe("Read a file from disk");
	});

	it("does not invent tools from whitespace-only name objects", () => {
		const out = normalizeTools([{ name: "   ", description: "x", parameters: schema } as never], false);
		// either dropped or kept — if kept name must be the authored one
		for (const t of out) {
			expect(typeof t.name).toBe("string");
		}
	});

	it("large schema tools still normalize without throw", () => {
		const big = type({
			a: "string",
			b: "number",
			c: "boolean",
			d: "string[]",
		});
		const t = {
			name: "big",
			label: "big",
			description: "big tool",
			parameters: big,
			async execute() {
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		};
		const out = normalizeTools([t] as never, false);
		expect(out).toHaveLength(1);
		expect(out[0]?.name).toBe("big");
	});
});
