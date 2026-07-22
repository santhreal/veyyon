/**
 * normalizeTools with pruneDescriptions false keeps full description text.
 */
import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@veyyon/agent-core";
import { type } from "arktype";

const schema = type({ path: "string" });

describe("normalizeTools description preservation", () => {
	it("keeps multi-paragraph description when not pruning", () => {
		const desc = "Line one.\n\nLine two with details about the tool.";
		const tool = {
			name: "read",
			label: "Read",
			description: desc,
			parameters: schema,
			async execute() {
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		};
		const out = normalizeTools([tool] as never, false);
		expect(out).toHaveLength(1);
		expect(out[0]?.description).toBe(desc);
	});

	it("keeps empty description string as empty", () => {
		const tool = {
			name: "x",
			label: "x",
			description: "",
			parameters: schema,
			async execute() {
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		};
		const out = normalizeTools([tool] as never, false);
		expect(out[0]?.description).toBe("");
	});
});
