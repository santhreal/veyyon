import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import type {
	ExtensionAskDialogOption,
	ExtensionAskDialogQuestion,
} from "@veyyon/coding-agent/extensibility/extensions/types";
import { AskDialogComponent } from "@veyyon/coding-agent/modes/components/ask-dialog";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { setKeybindings } from "@veyyon/tui";

/**
 * WHY: the ask dialog renders its fields with no fallback, so one absent string
 * killed the process. `renderQuestionTitle` calls `replaceTabs(question.question)`
 * and the constructor reads `question.options.length`; a question arriving without
 * either threw `TypeError: undefined is not an object (evaluating 'text.replaceAll')`
 * from inside a render pass. A render-time throw is not a tool error and not a
 * notice: it is an uncaught exception, so the whole session died and took four live
 * subagents with it.
 *
 * The class is "an ask question whose shape the renderer cannot survive", not the
 * one missing field that was reported. Every producer that can carry one is
 * untyped at run time — `ExtensionUI.askDialog` is a published extension API, and
 * the collab/RPC paths hand over decoded JSON — so the dialog checks its own
 * precondition once, at construction, and refuses with a message naming the field.
 *
 * The matrix below is derived from a fixture the type system forces to stay
 * exhaustive (`AllAskQuestionKeysCovered`), so adding a field to
 * `ExtensionAskDialogQuestion` breaks `check:ts` until the fixture carries it, and
 * a fixture key with no `FIELD_POLICY` row fails this suite. What it does NOT
 * catch: a renderer that starts reading a field nobody declared, or an option
 * field added to `ExtensionAskDialogOption` without a row in `OPTION_FIELD_POLICY`
 * (the option matrix is keyed the same way but its exhaustiveness check covers
 * only the three declared fields).
 */

/** Every declared field of a question, so the matrix can delete them one at a time. */
const MAXIMAL_QUESTION = {
	id: "q1",
	question: "Which one?",
	header: "Pick",
	options: [{ label: "A", description: "first", preview: "preview text" }],
	multi: true,
	recommended: 0,
	preselected: ["A"],
} satisfies Required<ExtensionAskDialogQuestion>;

/** Compile-time exhaustiveness: a new question field fails `check:ts` here. */
type AllAskQuestionKeysCovered = Exclude<keyof ExtensionAskDialogQuestion, keyof typeof MAXIMAL_QUESTION>;
const _questionKeysCovered: AllAskQuestionKeysCovered extends never ? true : never = true;
type AllAskOptionKeysCovered = Exclude<keyof ExtensionAskDialogOption, "label" | "description" | "preview">;
const _optionKeysCovered: AllAskOptionKeysCovered extends never ? true : never = true;

/**
 * Required means the renderer reads it unconditionally; optional means absent is a
 * legal question. Both are asserted, so demoting a required field to optional (or
 * the reverse) has to be a deliberate edit to this table.
 */
const FIELD_POLICY: Record<keyof typeof MAXIMAL_QUESTION, { required: boolean; wrongType: unknown }> = {
	id: { required: true, wrongType: 7 },
	question: { required: true, wrongType: 7 },
	header: { required: false, wrongType: 7 },
	options: { required: true, wrongType: "A, B" },
	multi: { required: false, wrongType: "yes" },
	recommended: { required: false, wrongType: "0" },
	preselected: { required: false, wrongType: "A" },
};

const OPTION_FIELD_POLICY: Record<keyof ExtensionAskDialogOption, { required: boolean; wrongType: unknown }> = {
	label: { required: true, wrongType: 7 },
	description: { required: false, wrongType: 7 },
	preview: { required: false, wrongType: 7 },
};

function question(overrides: Record<string, unknown> = {}): ExtensionAskDialogQuestion {
	return { ...structuredClone(MAXIMAL_QUESTION), ...overrides } as ExtensionAskDialogQuestion;
}

function withoutField(field: string): ExtensionAskDialogQuestion {
	const shaped: Record<string, unknown> = structuredClone(MAXIMAL_QUESTION);
	delete shaped[field];
	return shaped as unknown as ExtensionAskDialogQuestion;
}

function build(questions: ExtensionAskDialogQuestion[]): AskDialogComponent {
	return new AskDialogComponent(questions, {
		onSubmit: () => {},
		onCancel: () => {},
		onPrompt: async () => undefined,
	});
}

describe("the ask dialog refuses a question it cannot render", () => {
	beforeAll(async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("Failed to load dark theme");
		setThemeInstance(dark);
	});

	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("refuses the reported shape — options and an id, no question text — instead of dying in render", () => {
		const reported = {
			id: "dest",
			header: "Skill dest",
			options: [{ label: "oss-work profile skills" }, { label: "work + oss-work profiles" }],
			multi: false,
		} as unknown as ExtensionAskDialogQuestion;

		expect(() => build([reported])).toThrow(/question 0 \(dest\) has no question text \(missing\)/);
	});

	it("names every question field the renderer requires, and accepts the ones it does not", () => {
		for (const [field, policy] of Object.entries(FIELD_POLICY)) {
			const absent = (): AskDialogComponent => build([withoutField(field)]);
			const explicitlyUndefined = (): AskDialogComponent => build([question({ [field]: undefined })]);
			const wrongType = (): AskDialogComponent => build([question({ [field]: policy.wrongType })]);

			if (policy.required) {
				expect(absent, `absent ${field}`).toThrow(new RegExp(`\\b${field}\\b|no ${field}`));
				expect(explicitlyUndefined, `undefined ${field}`).toThrow(/Ask dialog question 0/);
			} else {
				expect(absent, `absent ${field}`).not.toThrow();
				expect(explicitlyUndefined, `undefined ${field}`).not.toThrow();
			}
			expect(wrongType, `wrong-typed ${field}`).toThrow(/Ask dialog question 0/);
		}
	});

	it("names every option field the renderer requires, and accepts the ones it does not", () => {
		for (const [field, policy] of Object.entries(OPTION_FIELD_POLICY)) {
			const option: Record<string, unknown> = { label: "A", description: "d", preview: "p" };
			delete option[field];
			const absent = (): AskDialogComponent => build([question({ options: [option] })]);
			const wrongType = (): AskDialogComponent =>
				build([question({ options: [{ label: "A", description: "d", preview: "p", [field]: policy.wrongType }] })]);

			if (policy.required) expect(absent, `absent option ${field}`).toThrow(/option 0/);
			else expect(absent, `absent option ${field}`).not.toThrow();
			expect(wrongType, `wrong-typed option ${field}`).toThrow(/option 0/);
		}
	});

	it("refuses a question list that carries nothing renderable at all", () => {
		expect(() => build([])).toThrow(/non-empty array of questions/);
		expect(() => build(undefined as unknown as ExtensionAskDialogQuestion[])).toThrow(/non-empty array of questions/);
		expect(() => build([null as unknown as ExtensionAskDialogQuestion])).toThrow(/question 0 is null, not an object/);
		expect(() => build(["Which one?" as unknown as ExtensionAskDialogQuestion])).toThrow(
			/question 0 is the string "Which one\?", not an object/,
		);
	});

	it("refuses blank text where a value is required, because a blank question asks nothing", () => {
		expect(() => build([question({ question: "   " })])).toThrow(/has no question text/);
		expect(() => build([question({ id: "" })])).toThrow(/has no id/);
		expect(() => build([question({ options: [{ label: " " }] })])).toThrow(/option 0 has no label/);
	});

	it("names the offending question by index when an earlier one is fine", () => {
		const good = question({ id: "first" });
		const bad = withoutField("question");
		expect(() => build([good, { ...bad, id: "second" } as ExtensionAskDialogQuestion])).toThrow(
			/question 1 \(second\) has no question text/,
		);
	});

	it("still renders a well-formed batch, including one with only the required fields", () => {
		const minimal: ExtensionAskDialogQuestion = { id: "q1", question: "Ship it?", options: [] };
		const full = question({ id: "q2", question: "Which target?" });
		const frame = stripVTControlCharacters(build([minimal, full]).render(80).join("\n"));
		expect(frame).toContain("Ship it?");
		expect(() => build([full]).render(80)).not.toThrow();
	});

	/**
	 * The crash was a question the constructor ACCEPTED and the renderer then could
	 * not survive, so acceptance alone is not the contract: everything the check
	 * lets through has to render. Derived from the same field matrix, so a field
	 * demoted to optional is rendered rather than only constructed.
	 */
	it("renders every shape it accepts, so acceptance and renderability cannot drift apart", () => {
		for (const [field, policy] of Object.entries(FIELD_POLICY)) {
			if (policy.required) continue;
			for (const shaped of [withoutField(field), question({ [field]: undefined })]) {
				expect(() => build([shaped]).render(80), `render without ${field}`).not.toThrow();
			}
		}
		for (const field of Object.keys(OPTION_FIELD_POLICY)) {
			if (OPTION_FIELD_POLICY[field as keyof ExtensionAskDialogOption].required) continue;
			const option: Record<string, unknown> = { label: "A", description: "d", preview: "p" };
			delete option[field];
			expect(
				() => build([question({ options: [option] })]).render(80),
				`render without option ${field}`,
			).not.toThrow();
		}
	});
});
