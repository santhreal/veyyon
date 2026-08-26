/**
 * WHY. `/guided` interviews the model for an objective and parses each turn as
 * JSON. Two things in that path raised on ordinary provider output and ended
 * the interview:
 *
 *   - `parseJsonPayload` matched the first `{` to the LAST `}` and handed the
 *     span straight to `JSON.parse`. A turn that wrapped its JSON in prose, or
 *     put a brace in the prose, produced a span that is not JSON and a raw
 *     `SyntaxError`.
 *   - `parseGuidedGoalPayload` required `kind` to be exactly `"question"` or
 *     `"ready"`, so `"Ready"` — or a payload carrying a perfectly good question
 *     under no label at all — was thrown away.
 *
 * That is why it failed "randomly": which turn died depended on how the model
 * happened to phrase that turn.
 *
 * THE CLASS THIS CLOSES. Every shape a model answers a JSON request in reaches
 * one of the two parsers, and neither raises on any of them: it either returns
 * a usable turn or the one descriptive error the caller already handles. A raw
 * `SyntaxError` escaping either parser is the defect, and no input below
 * produces one.
 *
 * WHAT THIS DOES NOT CATCH. A model that answers with valid JSON of the wrong
 * meaning — a question in the objective field, say. Parsing cannot tell, and
 * the interview's turn cap is what bounds that.
 */
import { describe, expect, it } from "bun:test";
import { parseJsonPayload } from "../src/commit/utils";
import { parseGuidedGoalPayload } from "../src/goals/guided-setup";

/** Shapes a provider actually answers a "reply in JSON" instruction with. */
const PROVIDER_SHAPES: ReadonlyArray<{ name: string; text: string }> = [
	{ name: "bare object", text: '{"kind":"ready","objective":"ship it"}' },
	{ name: "fenced block", text: '```json\n{"kind":"ready","objective":"ship it"}\n```' },
	{ name: "unlabelled fence", text: '```\n{"kind":"ready","objective":"ship it"}\n```' },
	{
		name: "prose before",
		text: 'Here is the plan:\n{"kind":"ready","objective":"ship it"}',
	},
	{
		name: "prose after",
		text: '{"kind":"ready","objective":"ship it"}\nLet me know if that works.',
	},
	{
		name: "a brace in the prose",
		text: 'I considered {a, b} first.\n{"kind":"ready","objective":"ship it"}',
	},
	{
		name: "a non-JSON brace run before the payload",
		text: '{not json at all}\n{"kind":"ready","objective":"ship it"}',
	},
	{
		name: "a brace inside a JSON string",
		text: '{"kind":"ready","objective":"ship it }"}',
	},
	{
		name: "nested objects",
		text: '{"kind":"ready","objective":"ship it","meta":{"turn":2}}',
	},
];

describe("a JSON payload surrounded by whatever the model said", () => {
	for (const shape of PROVIDER_SHAPES) {
		it(`parses ${shape.name} without raising`, () => {
			const parsed = parseJsonPayload(shape.text) as Record<string, unknown>;

			expect(parsed.kind).toBe("ready");
			expect(typeof parsed.objective).toBe("string");
		});
	}

	it("reports the one descriptive failure rather than a SyntaxError", () => {
		// Both the no-brace and the unparseable-brace path must land here: a raw
		// SyntaxError is what used to escape to the interview.
		for (const text of ["there is no payload here", "{ this looks like json but is not }"]) {
			let raised: unknown;
			try {
				parseJsonPayload(text);
			} catch (error) {
				raised = error;
			}
			expect(raised).toBeInstanceOf(Error);
			expect((raised as Error).message).toBe("No JSON payload found in response");
			expect((raised as Error).name).not.toBe("SyntaxError");
		}
	});
});

describe("a guided turn labelled however the model labelled it", () => {
	it("accepts the documented labels", () => {
		expect(parseGuidedGoalPayload({ kind: "ready", objective: "ship it" })).toEqual({
			kind: "ready",
			objective: "ship it",
		});
		expect(parseGuidedGoalPayload({ kind: "question", question: "which repo?" })).toEqual({
			kind: "question",
			question: "which repo?",
		});
	});

	it("accepts the same labels in any casing or padding", () => {
		expect(parseGuidedGoalPayload({ kind: "Ready", objective: "ship it" })).toEqual({
			kind: "ready",
			objective: "ship it",
		});
		expect(parseGuidedGoalPayload({ kind: " QUESTION ", question: "which repo?" })).toEqual({
			kind: "question",
			question: "which repo?",
		});
	});

	it("starts a turn that declared itself ready even when it echoed the question back", () => {
		// The label decides here, so it has to be read in whatever case the model
		// wrote it: unlabelled salvage would see the question and keep asking.
		expect(parseGuidedGoalPayload({ kind: "Ready", objective: "ship it", question: "which repo?" })).toEqual({
			kind: "ready",
			objective: "ship it",
		});
	});

	it("salvages a turn that carried the content under no label", () => {
		expect(parseGuidedGoalPayload({ question: "which repo?" })).toEqual({
			kind: "question",
			question: "which repo?",
		});
		expect(parseGuidedGoalPayload({ objective: "ship it" })).toEqual({
			kind: "ready",
			objective: "ship it",
		});
	});

	it("asks the question rather than settling for the draft beside it", () => {
		// A turn carrying both is still mid-interview: answering the question is
		// what turns the draft into an objective worth starting.
		expect(parseGuidedGoalPayload({ kind: "question", question: "which repo?", objective: "draft" })).toEqual({
			kind: "question",
			question: "which repo?",
			objective: "draft",
		});
	});

	it("trims what it returns so a padded answer is not started verbatim", () => {
		expect(parseGuidedGoalPayload({ kind: "ready", objective: "  ship it  " })).toEqual({
			kind: "ready",
			objective: "ship it",
		});
	});

	it("refuses a turn that carried nothing usable", () => {
		for (const payload of [
			{},
			{ kind: "ready" },
			{ kind: "ready", objective: "   " },
			{ kind: "question", question: "" },
			{ kind: "nonsense" },
			"a string",
			null,
		]) {
			expect(() => parseGuidedGoalPayload(payload)).toThrow("guided goal returned an invalid response");
		}
	});
});
