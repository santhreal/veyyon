/**
 * WHY THIS SUITE EXISTS (EVERY-EFFORT-SURFACE-NARROWS-TO-THE-MODEL — THE WHOLE CLASS).
 *
 * The defect: a surface that offers effort levels shipped a FIXED ladder instead of asking the model
 * in scope which levels it declares. It shipped three times in three different shapes — the Subagent
 * Effort row printed the whole vocabulary, Model → Default Effort headed a one-row list "Valid effort
 * variants for <model>" with no explanation, and RPC `set_thinking_level` accepted any level and
 * answered success while the session clamped it. Each was fixed where it was found.
 *
 * The class is: ANY surface that lets someone choose or send an effort must offer exactly the levels
 * the model in scope declares, and nothing else. Closing it needs three run-time enumerations, because
 * every hardcoded list in a test is a list that goes stale in silence:
 *
 *  1. THE VOCABULARY OWNER'S EXPORTS. `src/thinking.ts` is the one module that knows the ladder, so a
 *     surface either reads a narrowing export of it or invents a second opinion. Every export is probed
 *     at run time against models with different ladders. An export that yields effort levels and does
 *     NOT change with the model is a fixed ladder, and it must be recorded in FIXED_VOCABULARY_EXPORTS
 *     by exact equality. An export that DOES narrow must be consumed by a surface in SURFACES, also by
 *     exact equality. So `export function effortRows() { return CONFIGURED_THINKING_LEVELS }` turns this
 *     RED the day it lands, and so does a new narrowing helper nobody wired a surface test to.
 *  2. THE SETTINGS ROWS. Derived from `SETTINGS_SCHEMA`, classified as effort pickers by BEHAVIOUR (the
 *     rows they render are the levels the model declares) rather than by name, with the non-effort
 *     runtime rows recorded by exact set equality so a removed record fails too.
 *  3. THE MODEL CORPUS. Four ladder SHAPES chosen from the bundled catalog at run time: a model that
 *     declares nothing, one that declares a strict subset, one that declares the whole vocabulary, and
 *     a reasoning model whose ladder excludes plain low/medium/high. A shape the catalog cannot supply
 *     is a hole in the sweep, so each one is asserted non-empty rather than skipped.
 *
 * Every case drives the real component: the real `SettingsSelectorComponent` opened to the real row,
 * the real `renderEffortStep` into a real `Container`, the real `ThinkingSelectorComponent`, the real
 * RPC refusal. Nothing here asserts that a helper was called.
 *
 * WHAT THIS DOES NOT CATCH. A surface that hand-rolls its list without touching `src/thinking.ts` at
 * all is invisible to enumeration 1, and if it is not a settings row it is invisible to enumeration 2.
 * The model hub's role strip and the advisor editor's effort picker are driven only indirectly, through
 * the `configuredThinkingLevelOptions` / `configuredThinkingLevelsForModel` contract they share with the
 * surfaces below; a hub that swapped that call for the fixed vocabulary would not be caught here.
 * ACP's `thought_level` is covered in `test/acp-agent.test.ts`, which owns a live session.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, Model } from "@veyyon/ai";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import { ANY_MODEL_EFFORT_KEY } from "@veyyon/coding-agent/config/effort-resolver";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { getUi, isSettingPath, SETTINGS_SCHEMA, type SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { renderEffortStep } from "@veyyon/coding-agent/modes/components/effort-picker";
import { ModelHubComponent } from "@veyyon/coding-agent/modes/components/model-hub";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { ThinkingSelectorComponent } from "@veyyon/coding-agent/modes/components/thinking-selector";
import { rpcThinkingLevelRefusal } from "@veyyon/coding-agent/modes/rpc/rpc-mode";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import * as thinking from "@veyyon/coding-agent/thinking";
import type { TUI } from "@veyyon/tui";
import { Container } from "@veyyon/tui";
import { stubStdoutGeometry } from "./helpers/stdout-geometry";

/** The whole configuration vocabulary, as plain words, read from its owner. */
const VOCABULARY: readonly string[] = thinking.CONFIGURED_THINKING_LEVELS.map(String);

/** The inherit-row label each surface uses. The notice has to name a row the user can see. */
const SETTINGS_INHERIT_LABEL = "Inherit";
const MODEL_STEP_INHERIT_LABEL = "Model default";

const ENTER = "\n";

/**
 * Panel width. The settings screen wraps its right column, so at a narrow width one sentence arrives
 * split across rows with the tab list interleaved and the assertions become assertions about layout.
 */
const PANEL_WIDTH = 160;

const modelRegistry = {
	isKeylessProvider: () => false,
	hasConfiguredAuth: () => true,
	authStorage: { hasAuth: () => true },
} as unknown as ModelRegistry;

let geometryStub: { restore(): void } | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry({ columns: 220, rows: 60 });
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

/**
 * Effort words present in a rendered frame, matched on word boundaries.
 *
 * Boundaries matter in both directions: `xhigh` contains `high`, so a substring check reports a level
 * the surface never offered, and "Follow the session's effort" contains neither.
 */
function effortWordsIn(text: string): string[] {
	return VOCABULARY.filter(word => new RegExp(`\\b${word}\\b`).test(text));
}

function selectorOf(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enumeration 3: the model corpus, by ladder SHAPE, chosen from the catalog.
// ─────────────────────────────────────────────────────────────────────────────

function bundledModels(): Model<Api>[] {
	return (getBundledProviders() as GeneratedProvider[]).flatMap(provider => getBundledModels(provider));
}

/**
 * Shapes an effort ladder can take. Named by what makes each one a distinct test, not by a model id:
 * a catalog refresh moves ids around, and a suite pinned to `cursor/composer-1.5` stops testing the
 * shape the moment that row changes.
 */
type LadderShape =
	| "declares-nothing"
	| "declares-a-strict-subset"
	| "declares-the-whole-vocabulary"
	| "reasons-without-plain-levels";

const LADDER_SHAPES: Readonly<Record<LadderShape, (model: Model<Api>) => boolean>> = {
	"declares-nothing": model => thinking.configuredThinkingLevelsForModel(model).length === 0,
	"declares-a-strict-subset": model => {
		const declared = thinking.configuredThinkingLevelsForModel(model).length;
		return declared > 0 && declared < VOCABULARY.length;
	},
	"declares-the-whole-vocabulary": model =>
		thinking.configuredThinkingLevelsForModel(model).length === VOCABULARY.length,
	/**
	 * The shape a fixed `low/medium/high` selector gets wrong most loudly: a reasoning model whose only
	 * real choice is `max`. A ladder-aware surface offers exactly that; a hardcoded one offers three
	 * levels the provider has no wire field for.
	 */
	"reasons-without-plain-levels": model => {
		const declared = thinking.configuredThinkingLevelsForModel(model).map(String);
		return (
			declared.length > 0 &&
			model.reasoning === true &&
			!declared.includes("low") &&
			!declared.includes("medium") &&
			!declared.includes("high")
		);
	},
};

/**
 * One representative per shape, chosen deterministically.
 *
 * Models whose `provider/id` contains an effort word are skipped: a surface prints the selector next to
 * the rows, so such a model makes the word-boundary reader see a level that is not on offer, and the
 * case would fail for a reason that has nothing to do with narrowing.
 */
function representatives(): { chosen: Partial<Record<LadderShape, Model<Api>>>; missing: LadderShape[] } {
	const models = bundledModels()
		.filter(model => effortWordsIn(selectorOf(model)).length === 0)
		.sort((a, b) => selectorOf(a).localeCompare(selectorOf(b)));
	const chosen: Partial<Record<LadderShape, Model<Api>>> = {};
	const missing: LadderShape[] = [];
	for (const [shape, matches] of Object.entries(LADDER_SHAPES) as Array<[LadderShape, (m: Model<Api>) => boolean]>) {
		const model = models.find(matches);
		if (model) chosen[shape] = model;
		else missing.push(shape);
	}
	return { chosen, missing };
}

const { chosen: SHAPE_MODELS, missing: MISSING_SHAPES } = representatives();

/** Every representative the corpus could supply. Fewer than four is a hole, asserted below. */
const PRESENT_SHAPE_MODELS: Model<Api>[] = Object.values(SHAPE_MODELS).filter(
	(model): model is Model<Api> => model !== undefined,
);

/**
 * A shape the corpus cannot supply is a HOLE, not a pass: the sweeps below would quietly stop
 * exercising it. Reading it throws with the shape named, so the cases that need it fail individually
 * and the ones that do not still report, and `the corpus supplies a model for every ladder shape`
 * below names the hole once.
 */
function shapeModel(name: LadderShape): Model<Api> {
	const model = SHAPE_MODELS[name];
	if (!model) throw new Error(`the bundled catalog supplies no model that ${name.replace(/-/g, " ")}`);
	return model;
}

describe("the model corpus", () => {
	it("supplies a model for every ladder shape", () => {
		expect(MISSING_SHAPES).toEqual([]);
	});
});

/** The levels this model declares, as plain words. The expected answer for every surface. */
function declaredWords(model: Model<Api>): string[] {
	return thinking.configuredThinkingLevelsForModel(model).map(String);
}

// ─────────────────────────────────────────────────────────────────────────────
// Enumeration 1: the vocabulary owner's exports.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A probe result we are willing to read effort levels out of: a string, or a list of levels, or a list
 * of picker rows. Anything else (a `Model`, a metadata record, a boolean) is a value the probe fed
 * nonsense to, and reading levels out of a `Model`'s own catalog metadata would classify half the
 * module as an effort producer.
 */
function ladderTextOf(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	const parts: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			parts.push(entry);
			continue;
		}
		if (entry && typeof entry === "object" && "value" in entry && typeof entry.value === "string") {
			parts.push(entry.value);
			continue;
		}
		return undefined;
	}
	return parts.join(" ");
}

/**
 * How the probe hands a model to an export. The module uses both spellings —
 * `configuredThinkingLevelsForModel(model)` positionally and
 * `configuredThinkingLevelOptions({ model })` in an options bag — and an export judged only on the
 * wrong one looks like a fixed ladder, because ignoring an argument it does not understand is exactly
 * what a correct narrowing helper does with it.
 */
const CALLING_CONVENTIONS = ["value", "positional", "options-bag"] as const;

type CallingConvention = (typeof CALLING_CONVENTIONS)[number];

/**
 * The levels one export yields for one model, per calling convention. `undefined` means that
 * convention produced nothing this probe is willing to read levels out of.
 */
function probeExport(value: unknown, model: Model<Api>): Record<CallingConvention, string | undefined> {
	const answers: Record<CallingConvention, string | undefined> = {
		value: undefined,
		positional: undefined,
		"options-bag": undefined,
	};
	if (typeof value !== "function") {
		const text = ladderTextOf(value);
		answers.value = text === undefined ? undefined : effortWordsIn(text).join(",");
		return answers;
	}
	for (const [convention, argument] of [
		["positional", model],
		["options-bag", { model }],
	] as Array<[CallingConvention, unknown]>) {
		try {
			const text = ladderTextOf(value(argument));
			if (text !== undefined) answers[convention] = effortWordsIn(text).join(",");
		} catch {
			// An export this probe cannot call with a model is not an effort producer by this test's
			// definition; the surface sweep below is what covers the ones that are.
		}
	}
	return answers;
}

interface ExportClassification {
	/** Yields two or more effort levels for at least one model, so it is describing a ladder. */
	producer: boolean;
	/** Yields a DIFFERENT ladder for models with different ladders, under some calling convention. */
	narrows: boolean;
}

function classifyExport(value: unknown): ExportClassification {
	const perShape = PRESENT_SHAPE_MODELS.map(model => probeExport(value, model));
	const producer = perShape.some(answers =>
		CALLING_CONVENTIONS.some(convention => (answers[convention]?.split(",").filter(Boolean).length ?? 0) >= 2),
	);
	if (!producer) return { producer: false, narrows: false };
	// Per convention, because a helper that narrows when called correctly narrows, full stop. Judging
	// on the widest answer across conventions marks every options-bag helper as a fixed ladder.
	const narrows = CALLING_CONVENTIONS.some(
		convention => new Set(perShape.map(answers => answers[convention])).size > 1,
	);
	return { producer: true, narrows };
}

/**
 * Exports that name the vocabulary itself rather than one model's offer.
 *
 * Recorded by exact equality, not by `hasOwn`: removing a recording has to fail too, or the record
 * decays into a list nobody maintains. Both are legitimate — they ARE the ladder every narrowing helper
 * narrows FROM, and the `--thinking` CLI flag has no model in scope at parse time — but neither may be
 * handed to a picker as its option list.
 */
const FIXED_VOCABULARY_EXPORTS: readonly string[] = ["CLI_THINKING_LEVELS", "CONFIGURED_THINKING_LEVELS"];

function classifiedExports(): { producers: string[]; narrowing: string[]; fixed: string[] } {
	const producers: string[] = [];
	const narrowing: string[] = [];
	const fixed: string[] = [];
	for (const name of Object.keys(thinking).sort()) {
		const classification = classifyExport(Reflect.get(thinking, name));
		if (!classification.producer) continue;
		producers.push(name);
		(classification.narrows ? narrowing : fixed).push(name);
	}
	return { producers, narrowing, fixed };
}

// ─────────────────────────────────────────────────────────────────────────────
// The surfaces, each driven for real.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `scope` is the session's catalog. It defaults to the one model in scope, which is what every
 * per-model case wants; a blanket row (`subagent.thinkingLevel`, Default Effort's `*`) reads it
 * instead of a model, so those cases pass a corpus explicitly.
 */
function buildSelector(model: Model<Api> | undefined, scope?: ReadonlyArray<Model<Api>>): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			model,
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark", "light"],
			availablePersonalities: ["default"],
			providers: model ? [model.provider] : [],
			cwd: process.cwd(),
			modelRegistry,
			availableModels: scope ?? (model ? [model] : []),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
}

/**
 * A rendered frame as one line of prose, sidebar removed.
 *
 * A settings frame is TWO columns on every physical line: `│ Rules │ exposes no selectable effort…`.
 * A sentence long enough to wrap therefore has a tab name and two box rules spliced into the middle
 * of it, so matching the sentence against the raw frame fails on a screen that is displaying it
 * perfectly. Taking the pane column and collapsing whitespace reads what the user reads.
 */
function paneText(frame: string): string {
	return frame
		.split("\n")
		.map(line => {
			// A bare container (the model-selector effort step) has no sidebar and no box at all.
			const columns = line.split("│");
			return columns.length >= 4 ? columns[2]! : line;
		})
		.join(" ")
		.replace(/\s+/g, " ");
}

/** Open one settings row's submenu with `model` (and optionally a wider catalog) in scope. */
function openSettingsRow(path: SettingPath, model: Model<Api> | undefined, scope?: ReadonlyArray<Model<Api>>): string {
	const tab = getUi(path)?.tab;
	if (!tab) throw new Error(`${path} declares no tab, so no screen can reach it`);
	const component = buildSelector(model, scope);
	component.openTab(tab);
	expect(component.selectSetting(path)).toBe(true);
	component.handleInput(ENTER);
	return stripVTControlCharacters(component.render(PANEL_WIDTH).join("\n"));
}

/** Open Settings → Model → Default Effort on a row already stored for `model`. */
function openDefaultEffortRow(model: Model<Api>): string {
	settings.set("defaultEffort", { [selectorOf(model)]: "high" });
	const component = buildSelector(model);
	component.openTab("model");
	expect(component.selectSetting("defaultEffort")).toBe(true);
	component.handleInput(ENTER);
	component.handleInput(ENTER);
	return stripVTControlCharacters(component.render(PANEL_WIDTH).join("\n"));
}

/** The model-selector effort step, rendered into a real container. */
function openEffortStep(model: Model<Api>): string {
	const container = new Container();
	renderEffortStep(
		container,
		selectorOf(model),
		model,
		() => {},
		() => {},
	);
	return stripVTControlCharacters(container.render(PANEL_WIDTH).join("\n"));
}

/** The `/thinking` modal. */
function openThinkingModal(model: Model<Api>): string {
	const component = new ThinkingSelectorComponent(
		undefined,
		model,
		() => {},
		() => {},
	);
	return stripVTControlCharacters(component.render(PANEL_WIDTH).join("\n"));
}

/**
 * The Models hub's thinking strip, reached the way a user reaches it: pick the model, press Enter to
 * open the role strip, assign a role, and the effort strip opens on the model just assigned.
 *
 * Driven rather than skipped because the hub builds its own ladder in a private method. A private
 * method is not out of reach, it is only out of reach of a unit test, and a surface nobody drives is
 * exactly where a hardcoded ladder survives: this one did, through an earlier version of this file.
 */
function openModelHubEffortStrip(model: Model<Api>): string {
	const ui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
	const hub = new ModelHubComponent(ui, settings, modelRegistry, [{ model }], {
		onAssign: () => {},
		onUnassign: () => {},
		onLoginRequest: () => {},
		onFallbackChainChange: () => {},
		onCancel: () => {},
	});
	// Enter on the model opens the role strip; Enter again assigns the highlighted role, and the
	// effort strip follows immediately.
	hub.handleInput(ENTER);
	hub.handleInput(ENTER);
	return stripVTControlCharacters(hub.render(PANEL_WIDTH).join("\n"));
}

/** Levels RPC `set_thinking_level` accepts, minus `inherit`, which is how a client clears its choice. */
function rpcAccepted(model: Model<Api>): string[] {
	return Object.values(ThinkingLevel)
		.filter(level => level !== ThinkingLevel.Inherit)
		.filter(level => rpcThinkingLevelRefusal(model, level) === undefined)
		.map(String);
}

interface EffortSurface {
	readonly id: string;
	/** The narrowing export from the vocabulary owner this surface reads. Ties SURFACES to enumeration 1. */
	readonly reads: string;
	/** The levels this surface offers for `model`. */
	offered(model: Model<Api>): string[];
	/**
	 * The levels this surface COULD offer at all. RPC speaks `ThinkingLevel`, which has no `auto`
	 * sentinel, so its expected answer is the declared ladder intersected with what it can express.
	 */
	readonly expressible?: readonly string[];
	/** The sentence this surface owes a user when it has narrowed to nothing. */
	readonly emptyNotice?: string;
	/** The full frame this surface draws, for surfaces that draw one. Only rendered surfaces owe a notice. */
	render?(model: Model<Api>): string;
}

const RPC_EXPRESSIBLE: readonly string[] = Object.values(ThinkingLevel).map(String);

const SURFACES: readonly EffortSurface[] = [
	{
		id: "settings row Subagents → Subagent Effort",
		reads: "configuredThinkingLevelOptions",
		offered: model => effortWordsIn(openSettingsRow("subagent.thinkingLevel", model)),
		emptyNotice: thinking.noSelectableEffortNotice(SETTINGS_INHERIT_LABEL),
		render: model => openSettingsRow("subagent.thinkingLevel", model),
	},
	{
		id: "settings row Model → Default Effort, per-model row",
		reads: "configuredThinkingLevelOptions",
		offered: model => effortWordsIn(openDefaultEffortRow(model)),
		emptyNotice: thinking.noSelectableEffortNotice(MODEL_STEP_INHERIT_LABEL),
		render: openDefaultEffortRow,
	},
	{
		id: "model selector effort step",
		reads: "configuredThinkingLevelOptions",
		offered: model => effortWordsIn(openEffortStep(model)),
		emptyNotice: thinking.noSelectableEffortNotice(MODEL_STEP_INHERIT_LABEL),
		render: openEffortStep,
	},
	{
		id: "/thinking modal",
		reads: "configuredThinkingLevelOptions",
		offered: model => effortWordsIn(openThinkingModal(model)),
	},
	{
		id: "Models hub effort strip",
		reads: "configuredThinkingLevelsForModel",
		offered: model => effortWordsIn(openModelHubEffortStrip(model)),
	},
	{
		id: "RPC set_thinking_level",
		reads: "configuredThinkingLevelsForModel",
		offered: rpcAccepted,
		expressible: RPC_EXPRESSIBLE,
	},
	{
		id: "/effort argument hint",
		reads: "thinkingLevelArgHint",
		offered: model => effortWordsIn(thinking.thinkingLevelArgHint(model) ?? ""),
	},
];

/** What `surface` should offer for `model`: the declared ladder, minus anything it cannot express. */
function expectedFor(surface: EffortSurface, model: Model<Api>): string[] {
	const declared = declaredWords(model);
	return surface.expressible ? declared.filter(level => surface.expressible?.includes(level)) : declared;
}

describe("the vocabulary owner's exports are all accounted for", () => {
	/**
	 * The ratchet. Every export of `src/thinking.ts` that describes a ladder either narrows to the model
	 * or is recorded as the vocabulary itself, and every narrowing one has a surface below driving it.
	 *
	 * This is what makes a NEW effort surface fail by default. The tempting refactor — a picker that
	 * reads the default ladder instead of the model's, spelled as a new helper here — lands in the
	 * "does not narrow" bucket and is not in the recorded set, so it fails on the first run.
	 */
	it("records every fixed ladder and drives every narrowing one", () => {
		const { producers, narrowing, fixed } = classifiedExports();

		// Green-by-luck guard: a probe that classifies nothing would satisfy both assertions below.
		expect(producers.length).toBeGreaterThan(0);
		expect(fixed.sort()).toEqual([...FIXED_VOCABULARY_EXPORTS].sort());
		expect(narrowing.sort()).toEqual([...new Set(SURFACES.map(surface => surface.reads))].sort());
	});

	/**
	 * The classifier's own positive and negative controls. Without them the ratchet passes on a
	 * classifier that recognizes nothing, which is exactly how a fixed ladder ships unnoticed.
	 */
	it("recognizes a fixed ladder, a narrowing one, and neither in an unrelated export", () => {
		expect(classifyExport(thinking.CONFIGURED_THINKING_LEVELS)).toEqual({ producer: true, narrows: false });
		expect(classifyExport(thinking.configuredThinkingLevelsForModel)).toEqual({ producer: true, narrows: true });
		// The shape a reintroduced defect takes: a new helper handing a picker the whole vocabulary.
		expect(classifyExport(() => thinking.CONFIGURED_THINKING_LEVELS)).toEqual({ producer: true, narrows: false });
		expect(classifyExport(thinking.noSelectableEffortNotice)).toEqual({ producer: false, narrows: false });
	});
});

describe("every settings row that leaves its options to the runtime is an effort picker or is recorded", () => {
	const runtimeRows: SettingPath[] = Object.keys(SETTINGS_SCHEMA)
		.filter(isSettingPath)
		.filter(path => getUi(path)?.options === "runtime");

	/**
	 * Runtime rows that are deliberately NOT effort pickers, recorded by exact equality so that both a
	 * new row and a stale record fail. Recorded rather than inferred: a new runtime row must not slip
	 * through as "probably a theme".
	 */
	const NON_EFFORT_RUNTIME_ROWS: readonly string[] = ["personality", "theme.dark", "theme.light"];

	/** A row is an effort picker when the rows it renders ARE the levels the model in scope declares. */
	function isEffortPicker(path: SettingPath): boolean {
		const model = shapeModel("declares-a-strict-subset");
		const rendered = openSettingsRow(path, model);
		return effortWordsIn(rendered).join(",") === declaredWords(model).join(",");
	}

	it("classifies every runtime row, and the non-effort ones are recorded exactly", () => {
		const effortRows = runtimeRows.filter(isEffortPicker);
		const others = runtimeRows.filter(path => !effortRows.includes(path));

		expect(others.map(String).sort()).toEqual([...NON_EFFORT_RUNTIME_ROWS].sort());
		expect(effortRows).toEqual(["subagent.thinkingLevel"]);
	});

	/**
	 * No settings row may ship a static effort ladder either. The detector reads option VALUES, so a row
	 * named anything at all is caught, and `low`/`medium`/`high` alone do not qualify because
	 * `textVerbosity` is a different axis with the same three words.
	 */
	it("leaves no static effort ladder anywhere in the schema", () => {
		const effortValues = new Set<string>([
			thinking.INHERIT_EFFORT_OPTION_VALUE,
			...VOCABULARY,
			thinking.AUTO_THINKING,
		]);
		const effortOnlyValues = new Set([...effortValues].filter(value => !["low", "medium", "high"].includes(value)));
		const isEffortLadder = (values: readonly string[]): boolean =>
			values.length > 0 &&
			values.every(value => effortValues.has(value)) &&
			values.some(value => effortOnlyValues.has(value));

		const staticLadders = Object.keys(SETTINGS_SCHEMA)
			.filter(isSettingPath)
			.filter(path => {
				const options = getUi(path)?.options;
				return Array.isArray(options) && isEffortLadder(options.map(option => String(option.value)));
			});

		expect(staticLadders).toEqual([]);
		// The detector's positive control, so the emptiness above is a finding and not a blind spot.
		expect(isEffortLadder(VOCABULARY)).toBe(true);
		expect(isEffortLadder(["low", "medium", "high"])).toBe(false);
		expect(isEffortLadder(["dark", "light"])).toBe(false);
	});
});

describe("every effort surface offers exactly the levels the model declares", () => {
	for (const shape of Object.keys(LADDER_SHAPES) as LadderShape[]) {
		for (const surface of SURFACES) {
			it(`${surface.id} · a model that ${shape.replace(/-/g, " ")}`, () => {
				const model = shapeModel(shape);
				const expected = expectedFor(surface, model);

				expect(surface.offered(model).sort()).toEqual([...expected].sort());
			});
		}
	}

	/**
	 * The sweep above passes on a surface that offers nothing to anybody IF every shape declared
	 * nothing. It does not: this pins that the four shapes really are four different ladders, so each
	 * case is discriminating rather than agreeing with an empty set.
	 */
	it("exercises four genuinely different ladders", () => {
		const ladders = PRESENT_SHAPE_MODELS.map(model => declaredWords(model).join(","));

		expect(new Set(ladders).size).toBe(4);
		expect(ladders).toContain("");
		expect(ladders).toContain(VOCABULARY.join(","));
	});
});

describe("a surface that has narrowed to nothing says why", () => {
	for (const surface of SURFACES) {
		const { emptyNotice, render } = surface;
		if (emptyNotice === undefined || render === undefined) continue;
		it(`${surface.id} explains its one-row list`, () => {
			const rendered = paneText(render(shapeModel("declares-nothing")));

			expect(rendered).toContain(emptyNotice);
			// The heading a one-row list must NOT carry: it reads as a truncated list.
			expect(rendered).not.toContain("Valid effort variants");
		});
	}

	/**
	 * Every surface that draws a frame owes the notice. Without this, deleting `emptyNotice` from a
	 * surface row would delete its case and leave the file green.
	 */
	it("covers every surface that draws a frame", () => {
		const drawn = SURFACES.filter(candidate => candidate.render !== undefined).map(candidate => candidate.id);
		const explaining = SURFACES.filter(candidate => candidate.emptyNotice !== undefined).map(
			candidate => candidate.id,
		);

		expect(explaining).toEqual(drawn);
		expect(drawn).toEqual([
			"settings row Subagents → Subagent Effort",
			"settings row Model → Default Effort, per-model row",
			"model selector effort step",
		]);
	});

	/**
	 * The other half. A surface that explains itself for every model and offers nothing to anyone is the
	 * failure a narrowing change introduces most often, and it would satisfy every case above.
	 */
	it("says nothing of the kind for a model that has a ladder", () => {
		const withLadder = shapeModel("declares-a-strict-subset");

		expect(openSettingsRow("subagent.thinkingLevel", withLadder)).not.toContain(
			thinking.noSelectableEffortNotice(SETTINGS_INHERIT_LABEL),
		);
		expect(openEffortStep(withLadder)).toContain("Valid effort variants");
		expect(openEffortStep(withLadder)).not.toContain(thinking.noSelectableEffortNotice(MODEL_STEP_INHERIT_LABEL));
	});

	/**
	 * The sentence has ONE owner and takes the visible row's name as a parameter. Two literals would
	 * drift, and the same model would then read as differently broken on each screen, which is the
	 * complaint that started this.
	 */
	it("names the row the user can see on each surface", () => {
		for (const label of [SETTINGS_INHERIT_LABEL, MODEL_STEP_INHERIT_LABEL]) {
			expect(thinking.noSelectableEffortNotice(label)).toContain(label);
			expect(thinking.noSelectableEffortNotice(label)).toContain("no selectable effort");
		}
		expect(thinking.noSelectableEffortNotice()).toBe(thinking.noSelectableEffortNotice(SETTINGS_INHERIT_LABEL));
		expect(thinking.noSelectableEffortNotice(MODEL_STEP_INHERIT_LABEL)).not.toBe(thinking.noSelectableEffortNotice());
	});

	/**
	 * The `/thinking` modal has no notice because it never opens on a model with no ladder: the
	 * controller refuses first. That gate and the picker must agree for every bundled model, or the
	 * modal opens onto a one-row list with nothing to explain it — the same defect, one layer up.
	 */
	it("gates the /thinking modal on exactly the models whose ladder is non-empty", () => {
		const disagreements = bundledModels().filter(
			candidate =>
				thinking.hasConfigurableThinkingEffort(candidate) !==
				thinking.configuredThinkingLevelsForModel(candidate).length > 0,
		);

		expect(disagreements.map(selectorOf)).toEqual([]);
		expect(thinking.hasConfigurableThinkingEffort(shapeModel("declares-nothing"))).toBe(false);
		expect(thinking.hasConfigurableThinkingEffort(shapeModel("declares-a-strict-subset"))).toBe(true);
	});
});

describe("a row with no single model offers the union its catalog declares, and never more", () => {
	/**
	 * `subagent.thinkingLevel` and `defaultEffort`'s any-model row store a level clamped later against
	 * whatever model runs, so neither can narrow to one model. They used to answer with the whole
	 * vocabulary instead, which is how `minimal` reached a session whose every model declares
	 * `low, high, max`. The honest answer is the UNION of what the session's catalog declares: every
	 * row is addressable on something the operator can actually select, and nothing is invented.
	 */
	const BLANKET_SCOPE: Model<Api>[] = [shapeModel("reasons-without-plain-levels"), shapeModel("declares-nothing")];
	const UNION: string[] = thinking.configuredThinkingLevelsInScope(BLANKET_SCOPE).map(String);

	/**
	 * A strict, non-empty subset. Without both bounds these cases pass on a build that publishes the
	 * whole vocabulary and on one that publishes nothing.
	 */
	it("draws a union that is a strict subset of the vocabulary", () => {
		expect(UNION.length).toBeGreaterThan(0);
		expect(UNION.length).toBeLessThan(VOCABULARY.length);
	});

	it("offers the catalog's union on the subagent effort row with no session model", () => {
		expect(effortWordsIn(openSettingsRow("subagent.thinkingLevel", undefined, BLANKET_SCOPE)).sort()).toEqual(
			[...UNION].sort(),
		);
	});

	it("offers the catalog's union on the any-model default-effort row", () => {
		settings.set("defaultEffort", { [ANY_MODEL_EFFORT_KEY]: "high" });
		const component = buildSelector(shapeModel("declares-nothing"), BLANKET_SCOPE);
		component.openTab("model");
		expect(component.selectSetting("defaultEffort")).toBe(true);
		component.handleInput(ENTER);
		component.handleInput(ENTER);
		const rendered = stripVTControlCharacters(component.render(PANEL_WIDTH).join("\n"));

		expect(effortWordsIn(rendered).sort()).toEqual([...UNION].sort());
		// There IS no model here, so the model-shaped notice would be a lie even though the session
		// model declares nothing.
		expect(rendered).not.toContain(thinking.noSelectableEffortNotice(MODEL_STEP_INHERIT_LABEL));
	});

	/**
	 * A catalog that declares nothing yields nothing. The blanket rows are the only surfaces allowed to
	 * answer without a model, and that licence is to read the catalog — not to fall back to a constant.
	 */
	it("offers no level at all when nothing in the catalog declares one", () => {
		const barren = [shapeModel("declares-nothing")];
		expect(thinking.configuredThinkingLevelsInScope(barren)).toEqual([]);
		expect(effortWordsIn(openSettingsRow("subagent.thinkingLevel", undefined, barren))).toEqual([]);
	});

	it("refuses nothing over RPC when there is no model to narrow against", () => {
		for (const level of Object.values(ThinkingLevel)) {
			expect(rpcThinkingLevelRefusal(undefined, level), level).toBeUndefined();
		}
	});

	it("offers no argument hint at all when there is no model", () => {
		expect(thinking.thinkingLevelArgHint(undefined)).toBeUndefined();
	});
});
