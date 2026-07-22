/**
 * normalizeTools with empty/whitespace descriptions.
 */
import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@veyyon/agent-core";
import { type } from "arktype";

const schema = type({ n: "number" });

function tool(name: string, description: string) {
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

describe("normalizeTools description edges", () => {
	it("empty description kept", () => {
		const out = normalizeTools([tool("a", "")] as never, false);
		expect(out[0]?.description).toBe("");
	});

	it("whitespace description kept as authored", () => {
		const out = normalizeTools([tool("a", "   ")] as never, false);
		expect(out[0]?.description).toBe("   ");
	});

	it("multiline kept", () => {
		const d = "one\ntwo\nthree";
		const out = normalizeTools([tool("a", d)] as never, false);
		expect(out[0]?.description).toBe(d);
	});
});
