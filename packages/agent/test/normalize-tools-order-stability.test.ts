/**
 * normalizeTools preserves order for 1..40 distinct tools.
 */
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
			return { content: [{ type: "text" as const, text: "ok" }], details: {} };
		},
	};
}

describe("normalizeTools order stability", () => {
	for (const n of [1, 2, 5, 10, 20, 40]) {
		it(`n=${n}`, () => {
			const tools = Array.from({ length: n }, (_, i) => tool(`t${i}`));
			const out = normalizeTools(tools as never, false);
			expect(out.map(t => t.name)).toEqual(tools.map(t => t.name));
		});
	}
});
