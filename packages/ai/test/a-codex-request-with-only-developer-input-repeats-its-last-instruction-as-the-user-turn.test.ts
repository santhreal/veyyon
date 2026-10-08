/**
 * A Codex request whose input holds only developer messages ends with one user message repeating its last non-blank
 * instruction: the prompt's last non-blank developer message, else the last non-blank `input_text` of the developer
 * input (last item first, and within an item its last part first), else non-blank `instructions`. A request with any
 * other input, or with no non-blank instruction, gets no user message.
 *
 * WHY THIS SUITE EXISTS. `transformRequestBody` picks that instruction from three sources, and no suite pinned the
 * choice: reading the sources in another order, reading the input or its parts front to back, or repeating a blank
 * text passed every Codex suite.
 *
 * CLASS CLOSED. Every input of up to two items over seven item kinds (developer messages with one, two, blank, odd or
 * string content, a user message and an `item_reference`, which the transformer drops), under six prompts and four
 * `instructions` values, with Responses Lite off and on, is compared against a reference reading of the rule above.
 * The sweep counts each source the reference picks and fails when one is never picked or no case goes without a repeat.
 *
 * NOT CAUGHT. Inputs whose tool calls the pairing repair rewrites: a function call or output is not in the grammar.
 */
import { describe, expect, it } from "bun:test";
import { type InputItem, transformRequestBody } from "@veyyon/ai/providers/openai-codex/request-transformer";
import { createCodexModel } from "./helpers";

const ITEMS: Record<string, InputItem> = {
	developer: { type: "message", role: "developer", content: [{ type: "input_text", text: "from input" }] },
	"developer, two parts": {
		type: "message",
		role: "developer",
		content: [
			{ type: "input_text", text: "earlier part" },
			{ type: "input_text", text: "later part" },
		],
	},
	"developer, blank": {
		type: "message",
		role: "developer",
		content: [
			{ type: "input_text", text: "  " },
			{ type: "input_image", image_url: "data:image/png;base64,AAAA" },
		],
	},
	"developer, odd parts": {
		type: "message",
		role: "developer",
		content: [{ type: "input_text" }, { type: "output_text", text: "not an instruction" }],
	},
	"developer, string content": { type: "message", role: "developer", content: "string content" },
	user: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
	reference: { type: "item_reference", id: "rs_1" },
};

const PROMPTS: Array<string[] | undefined> = [
	undefined,
	[],
	["from prompt"],
	["from prompt", " "],
	[" ", "late prompt"],
	["  "],
];
const INSTRUCTIONS: Array<string | undefined> = [undefined, "", "  ", "from instructions"];

type Source = "prompt" | "input" | "instructions" | "none";

/** The rule in the header, read independently of the transformer. */
function expectedRepeat(
	prompt: readonly string[] | undefined,
	input: readonly InputItem[],
	instructions: string | undefined,
): { text: string | undefined; source: Source } {
	const kept = input.filter(item => item.type !== "item_reference");
	if (kept.some(item => item.role !== "developer")) return { text: undefined, source: "none" };
	for (const text of [...(prompt ?? [])].reverse()) if (text.trim()) return { text, source: "prompt" };
	for (const item of [...kept].reverse()) {
		if (!Array.isArray(item.content)) continue;
		for (const part of [...item.content].reverse() as Array<{ type?: string; text?: unknown }>) {
			if (part.type === "input_text" && typeof part.text === "string" && part.text.trim()) {
				return { text: part.text, source: "input" };
			}
		}
	}
	if (instructions?.trim()) return { text: instructions, source: "instructions" };
	return { text: undefined, source: "none" };
}

function inputs(): string[][] {
	const kinds = Object.keys(ITEMS);
	const out: string[][] = [[]];
	for (const a of kinds) {
		out.push([a]);
		for (const b of kinds) out.push([a, b]);
	}
	return out;
}

describe("a Codex request with only developer input repeats its last instruction as the user turn", () => {
	for (const responsesLite of [false, true]) {
		it(`picks the instruction the rule names with Responses Lite ${responsesLite ? "on" : "off"}`, async () => {
			const model = createCodexModel("gpt-5.6-terra");
			const picked: Record<Source, number> = { prompt: 0, input: 0, instructions: 0, none: 0 };
			for (const kinds of inputs()) {
				for (const prompt of PROMPTS) {
					for (const instructions of INSTRUCTIONS) {
						const input = kinds.map(kind => structuredClone(ITEMS[kind]));
						const label = JSON.stringify({ kinds, prompt, instructions });
						const expected = expectedRepeat(prompt, input, instructions);
						picked[expected.source]++;
						const body = await transformRequestBody(
							{ model: model.id, input, ...(instructions === undefined ? {} : { instructions }) },
							model,
							{ responsesLite },
							prompt === undefined ? undefined : { developerMessages: prompt },
						);
						const sent = body.input ?? [];
						const visible = sent.filter(item => item.role !== "developer");
						const keptVisible = input.filter(item => item.type !== "item_reference" && item.role !== "developer");
						if (expected.text === undefined) {
							expect(visible, label).toEqual(keptVisible);
						} else {
							expect(visible, label).toEqual([
								{ type: "message", role: "user", content: [{ type: "input_text", text: expected.text }] },
							]);
							expect(sent.at(-1), label).toBe(visible[0]);
						}
					}
				}
			}
			for (const source of ["prompt", "input", "instructions", "none"] as const) {
				expect(picked[source], `cases whose instruction comes from ${source}`).toBeGreaterThan(0);
			}
		});
	}
});
