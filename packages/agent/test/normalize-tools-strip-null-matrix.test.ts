/**
 * normalizeTools drops non-tools and never throws on adversarial arrays.
 */
import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@veyyon/agent-core";
import { type } from "arktype";

const schema = type({ n: "number" });

function real(name: string) {
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

describe("normalizeTools adversarial array matrix", () => {
	const garbage = [
		null,
		undefined,
		0,
		"",
		false,
		true,
		[],
		{},
		{ name: 1 },
		{ name: null },
		{ description: "no name" },
		() => {},
	];

	it("filters all garbage and keeps real tools at edges", () => {
		const tools = [real("first"), ...garbage, real("last")] as never;
		const out = normalizeTools(tools, false);
		expect(out.map(t => t.name)).toEqual(["first", "last"]);
	});

	it("all-garbage yields empty", () => {
		expect(normalizeTools(garbage as never, false)).toEqual([]);
	});

	it("interleaved garbage preserves relative order of reals", () => {
		const tools = [real("a"), null, real("b"), {}, real("c"), undefined, real("d")] as never;
		expect(normalizeTools(tools, false).map(t => t.name)).toEqual(["a", "b", "c", "d"]);
	});
});
