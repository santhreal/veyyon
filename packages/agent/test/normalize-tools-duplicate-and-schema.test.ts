import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@veyyon/agent-core";
import { type } from "arktype";

/**
 * normalizeTools with duplicate names, mixed schemas, and large lists.
 */

const schema = type({ x: "string" });

function tool(name: string, label?: string) {
	return {
		name,
		label: label ?? name,
		description: `desc ${name}`,
		parameters: schema,
		async execute() {
			return { content: [{ type: "text" as const, text: name }], details: {} };
		},
	};
}

describe("normalizeTools scale and duplicates", () => {
	it("preserves order of 100 uniquely named tools", () => {
		const tools = Array.from({ length: 100 }, (_, i) => tool(`t${i}`));
		const out = normalizeTools(tools as never);
		expect(out.map(t => t.name)).toEqual(tools.map(t => t.name));
	});

	it("interleaved invalid entries do not shift valid order", () => {
		const a = tool("a");
		const b = tool("b");
		const c = tool("c");
		// @ts-expect-error garbage
		const out = normalizeTools([null, a, undefined, b, {}, c, null] as never, false);
		expect(out.map(t => t.name)).toEqual(["a", "b", "c"]);
	});

	it("tools with distinct labels but same name keep both or first depending on product", () => {
		const out = normalizeTools([tool("same", "L1"), tool("same", "L2")] as never);
		expect(out.every(t => t.name === "same")).toBe(true);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out.length).toBeLessThanOrEqual(2);
	});

	it("does not throw on a very large garbage-heavy list", () => {
		const mixed = Array.from({ length: 500 }, (_, i) => (i % 3 === 0 ? tool(`ok${i}`) : null));
		// @ts-expect-error garbage mix
		const out = normalizeTools(mixed as never, false);
		expect(out.length).toBeGreaterThan(100);
		expect(out.every(t => typeof t.name === "string" && t.name.startsWith("ok"))).toBe(true);
	});
});
