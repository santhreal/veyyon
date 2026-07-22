/**
 * normalizeTools keeps only valid tools from mixed arrays of size 20.
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

describe("normalizeTools mixed valid/invalid", () => {
	it("keeps every other real tool", () => {
		const arr: unknown[] = [];
		const expected: string[] = [];
		for (let i = 0; i < 20; i++) {
			if (i % 2 === 0) {
				arr.push(tool(`t${i}`));
				expected.push(`t${i}`);
			} else {
				arr.push(null, undefined, {}, { name: 1 }, "x");
			}
		}
		const out = normalizeTools(arr as never, false);
		expect(out.map(t => t.name)).toEqual(expected);
	});
});
