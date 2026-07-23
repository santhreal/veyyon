import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@veyyon/agent-core";
import { type } from "arktype";

const schema = type({ x: "string" });

function tool(name: string) {
	return {
		name,
		label: name,
		description: name,
		parameters: schema,
		async execute() {
			return { content: [{ type: "text" as const, text: name }], details: {} };
		},
	};
}

describe("normalizeTools empty and large", () => {
	it("empty and undefined-like lists", () => {
		expect(normalizeTools([])).toEqual([]);
		// @ts-expect-error garbage
		expect(normalizeTools([null, undefined] as never, false)).toEqual([]);
	});

	it("preserves 500 unique names in order", () => {
		const tools = Array.from({ length: 500 }, (_, i) => tool(`tool_${i}`));
		const out = normalizeTools(tools as never);
		expect(out.map(t => t.name)).toEqual(tools.map(t => t.name));
	});

	it("filters every-other null without reordering valids", () => {
		const mixed: unknown[] = [];
		for (let i = 0; i < 100; i++) {
			mixed.push(i % 2 === 0 ? tool(`ok${i}`) : null);
		}
		// @ts-expect-error garbage
		const out = normalizeTools(mixed as never, false);
		expect(out.map(t => t.name)).toEqual(Array.from({ length: 50 }, (_, i) => `ok${i * 2}`));
	});
});
