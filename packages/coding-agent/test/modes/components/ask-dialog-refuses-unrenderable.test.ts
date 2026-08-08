import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
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
 * the collab and RPC paths hand over decoded JSON — so the dialog checks its own
 * precondition once, at construction, and refuses with a message naming the field.
 *
 * WHAT MAKES THIS FAIL BY DEFAULT. The field matrix is not written down here. It
 * is derived at run time from the running renderer, twice over:
 *
 *  1. `observedFieldReads()` drives a full render and interaction pass through a
 *     recording proxy and reports every key the dialog and its renderers actually
 *     dereferenced. A key with no `FIELD_POLICY` row fails the suite, so a
 *     renderer that starts reading a field nobody declared is caught.
 *  2. `rendererCannotSurviveWithout()` deletes one field from the question the
 *     dialog is already holding and re-renders. A field whose absence throws is
 *     load-bearing for the renderer and MUST be refused by the guard, whatever
 *     the policy table says it is. That is the exact shape of the crash, measured
 *     rather than assumed.
 *
 * `MAXIMAL_QUESTION satisfies Required<ExtensionAskDialogQuestion>` adds the
 * compile-time half: a new declared field fails `check:ts` until the fixture
 * carries it, and then fails this suite until the policy records it.
 *
 * WHAT IT DOES NOT CATCH. The guard is deliberately stricter than the renderer
 * for `id`: the renderer falls back to `Q1` in the tab chip, but a question with
 * no id produces a result nobody can match to a question, so the guard refuses
 * it. That direction (guard stricter than renderer) is recorded in
 * `RENDERER_TOLERATES` rather than derived. And this file covers the component;
 * the entry points that hand it a question are covered by
 * `test/modes/an-unrenderable-ask-question-is-refused-by-every-caller.test.ts`.
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
 * Required means the guard refuses the question when the field is absent;
 * optional means absent is a legal question. Both directions are asserted
 * against the running renderer below, so demoting a required field to optional
 * (or the reverse) fails here rather than shipping.
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

/**
 * Fields the guard refuses even though the renderer has a fallback for them.
 * Pinned by exact equality: widening the guard without recording why fails here,
 * and so does narrowing it.
 */
const RENDERER_TOLERATES: readonly string[] = ["id"];

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

const ARROW_DOWN = "\x1b[B";
const ARROW_UP = "\x1b[A";

/**
 * Drive the dialog the way a user does: render at a narrow, an ordinary and a
 * wide terminal (the wide one is what turns the preview pane on), move the
 * cursor, toggle an option, open a note prompt, and switch to the submit tab.
 * Every renderer in the file is reached, which is what makes the field reads
 * below a measurement rather than a guess.
 */
async function exercise(dialog: AskDialogComponent): Promise<void> {
	for (const width of [40, 80, 200]) dialog.render(width);
	for (const key of [ARROW_DOWN, " ", ARROW_UP, " ", "n", "\t", ARROW_DOWN, "\t"]) {
		dialog.handleInput(key);
		// The note prompt is async; let it settle before the next key, which the
		// dialog would otherwise swallow while a prompt is active.
		await sleep(0);
		for (const width of [40, 200]) dialog.render(width);
	}
}

interface RecordedReads {
	questions: ExtensionAskDialogQuestion[];
	questionKeys: Set<string>;
	optionKeys: Set<string>;
}

/** A question whose every property read is recorded, options included. */
function recordingQuestion(reads: RecordedReads, overrides: Record<string, unknown> = {}): ExtensionAskDialogQuestion {
	const shaped = { ...structuredClone(MAXIMAL_QUESTION), ...overrides } as Record<string, unknown>;
	const options = (shaped.options as ExtensionAskDialogOption[]).map(
		option =>
			new Proxy(option, {
				get(target, key: string | symbol) {
					if (typeof key === "string") reads.optionKeys.add(key);
					return Reflect.get(target, key);
				},
			}),
	);
	shaped.options = options;
	return new Proxy(shaped, {
		get(target, key: string | symbol) {
			if (typeof key === "string") reads.questionKeys.add(key);
			return Reflect.get(target, key);
		},
	}) as unknown as ExtensionAskDialogQuestion;
}

/**
 * Every question and option key the dialog dereferenced during a full pass.
 * Two questions, one multi and one single, so the tab bar, the submit review
 * and both input branches are all exercised.
 */
async function observedFieldReads(): Promise<RecordedReads> {
	const reads: RecordedReads = { questions: [], questionKeys: new Set(), optionKeys: new Set() };
	reads.questions = [
		recordingQuestion(reads, { id: "multi" }),
		recordingQuestion(reads, { id: "single", multi: false, preselected: [] }),
	];
	const dialog = build(reads.questions);
	await exercise(dialog);
	dialog.dispose();
	return reads;
}

/**
 * Does the renderer itself need this field? Delete it from the object the
 * dialog is already holding — past the guard, exactly where the crash happened
 * — and drive a full pass. A throw means the field is load-bearing.
 */
async function rendererCannotSurviveWithout(target: "question" | "option", field: string): Promise<boolean> {
	const shaped = structuredClone(MAXIMAL_QUESTION) as Record<string, unknown>;
	const dialog = build([shaped as unknown as ExtensionAskDialogQuestion]);
	if (target === "question") delete shaped[field];
	else delete (shaped.options as Record<string, unknown>[])[0]?.[field];
	try {
		await exercise(dialog);
		return false;
	} catch {
		return true;
	} finally {
		dialog.dispose();
	}
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

	/**
	 * The field matrix has to come from the code, not from this file. A renderer
	 * that begins reading `question.footnote` adds a key here, and a key with no
	 * policy row fails: nobody has decided whether the guard must require it.
	 */
	it("has a policy row for every field the running renderer reads", async () => {
		const reads = await observedFieldReads();
		const questionFields = [...reads.questionKeys].filter(key => !key.startsWith("__")).sort();
		const optionFields = [...reads.optionKeys].filter(key => !key.startsWith("__")).sort();

		expect(questionFields.length).toBeGreaterThan(0);
		expect(optionFields.length).toBeGreaterThan(0);
		expect(questionFields.filter(key => !(key in FIELD_POLICY))).toEqual([]);
		expect(optionFields.filter(key => !(key in OPTION_FIELD_POLICY))).toEqual([]);
		// The pass has to be wide enough to reach the fields that carry the crash,
		// or "no unknown reads" is green because nothing was read.
		expect(questionFields).toContain("question");
		expect(questionFields).toContain("options");
		expect(optionFields).toContain("label");
		expect(optionFields).toContain("preview");
	});

	/**
	 * The crash was a field the renderer dereferences with no fallback. Measure
	 * that directly — delete the field behind the guard's back and render — and
	 * require the guard to refuse exactly what the renderer cannot survive.
	 */
	it("refuses every field the renderer cannot survive without, measured against the renderer", async () => {
		const guardStricterThanRenderer: string[] = [];
		for (const [field, policy] of Object.entries(FIELD_POLICY)) {
			const loadBearing = await rendererCannotSurviveWithout("question", field);
			if (loadBearing) {
				expect(policy.required, `renderer needs question.${field}, so the guard must refuse it`).toBe(true);
			} else if (policy.required) {
				guardStricterThanRenderer.push(field);
			}
		}
		for (const [field, policy] of Object.entries(OPTION_FIELD_POLICY)) {
			const loadBearing = await rendererCannotSurviveWithout("option", field);
			if (loadBearing) {
				expect(policy.required, `renderer needs option.${field}, so the guard must refuse it`).toBe(true);
			} else if (policy.required) {
				guardStricterThanRenderer.push(`option.${field}`);
			}
		}
		expect(guardStricterThanRenderer).toEqual([...RENDERER_TOLERATES]);
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
		expect(() => build(null as unknown as ExtensionAskDialogQuestion[])).toThrow(/non-empty array of questions/);
		expect(() => build({ id: "q" } as unknown as ExtensionAskDialogQuestion[])).toThrow(
			/non-empty array of questions/,
		);
		expect(() => build([null as unknown as ExtensionAskDialogQuestion])).toThrow(/question 0 is null, not an object/);
		expect(() => build(["Which one?" as unknown as ExtensionAskDialogQuestion])).toThrow(
			/question 0 is the string "Which one\?", not an object/,
		);
		expect(() => build([7 as unknown as ExtensionAskDialogQuestion])).toThrow(/question 0 is the number 7/);
		expect(() => build([[] as unknown as ExtensionAskDialogQuestion])).toThrow(/question 0 is an array/);
	});

	/**
	 * Decoded JSON is the shape these paths really carry, so the adversarial
	 * cases are the ones a hand-written or model-written payload produces: a
	 * null where an object belongs, a scalar where a list belongs, a nested
	 * null inside a list that passed its own type check.
	 */
	it("refuses adversarial nesting rather than dereferencing it", () => {
		expect(() => build([question({ options: null })])).toThrow(/options that are null, not an array/);
		expect(() => build([question({ options: "A, B" })])).toThrow(/options that are the string "A, B", not an array/);
		expect(() => build([question({ options: [null] })])).toThrow(/option 0 is null, not an object/);
		expect(() => build([question({ options: [{ label: "A" }, null] })])).toThrow(/option 1 is null, not an object/);
		expect(() => build([question({ options: ["A"] })])).toThrow(/option 0 is the string "A", not an object/);
		expect(() => build([question({ options: [["A"]] })])).toThrow(/option 0 is an array, not an object/);
		expect(() => build([question({ options: [{ label: null }] })])).toThrow(/option 0 has no label \(null\)/);
		expect(() => build([question({ question: null })])).toThrow(/has no question text \(null\)/);
		expect(() => build([question({ question: { text: "hi" } })])).toThrow(/has no question text \(an object\)/);
		expect(() => build([question({ preselected: [7] })])).toThrow(/preselected label that is the number 7/);
		expect(() => build([question({ preselected: [null] })])).toThrow(/preselected label that is null/);
	});

	it("refuses blank text where a value is required, because a blank question asks nothing", () => {
		expect(() => build([question({ question: "   " })])).toThrow(/has no question text/);
		expect(() => build([question({ question: "" })])).toThrow(/has no question text \(the string ""\)/);
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
	 * lets through has to survive a full pass, not just one `render(80)`. An empty
	 * option list is the interesting one — it is legal, and it leaves the cursor on
	 * a row that has no option behind it.
	 */
	it("survives a full render and input pass for every shape it accepts", async () => {
		const accepted: ExtensionAskDialogQuestion[] = [
			{ id: "q1", question: "Ship it?", options: [] },
			question({ multi: false }),
			question({ recommended: 99 }),
			question({ preselected: ["nope"] }),
			question({ header: "" }),
			question({ question: "a".repeat(500) }),
			question({ options: [{ label: "A" }, { label: "B", description: "d" }, { label: "C", preview: "p" }] }),
		];
		for (const [field, policy] of Object.entries(FIELD_POLICY)) {
			if (policy.required) continue;
			accepted.push(withoutField(field), question({ [field]: undefined }));
		}
		for (const [field, policy] of Object.entries(OPTION_FIELD_POLICY)) {
			if (policy.required) continue;
			const option: Record<string, unknown> = { label: "A", description: "d", preview: "p" };
			delete option[field];
			accepted.push(question({ options: [option] }));
		}

		const survived: string[] = [];
		const crashed: string[] = [];
		for (const [index, shaped] of accepted.entries()) {
			const dialog = build([shaped]);
			try {
				await exercise(dialog);
				survived.push(String(index));
			} catch (error) {
				crashed.push(`${index}: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				dialog.dispose();
			}
		}
		expect(crashed).toEqual([]);
		expect(survived).toHaveLength(accepted.length);
	});
});
