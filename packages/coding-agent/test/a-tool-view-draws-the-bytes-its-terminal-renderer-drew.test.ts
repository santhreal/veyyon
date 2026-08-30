/**
 * A tool that describes a host-agnostic view draws the same terminal bytes its own renderer drew.
 *
 * WHY THIS SUITE EXISTS. Every tool renderer in this repository took a `Theme` and returned a
 * terminal `Component`, so a tool could only ever run under the terminal. `@veyyon/view` is the
 * other half: a tool returns data naming what its output MEANS, and each host draws that data its
 * own way. The migration only holds if converting a renderer is invisible — the terminal has to emit
 * the identical bytes, or a UI capture that passed yesterday is a false failure today and every
 * conversion after it is unprovable.
 *
 * THE DEFECT CLASS THIS CLOSES. Four ways a conversion silently changes the screen:
 *
 *  - The COMPOSITION changes. `theme.fg(tone, theme.bold(text))` and `theme.bold(theme.fg(tone,
 *    text))` are different byte strings that look the same in most terminals and differ in some. The
 *    span cells pin the order, not the appearance.
 *  - The tool DROPS OFF its own card. The terminal decides whether a tool draws itself by looking for
 *    `renderCall`/`renderResult`; a tool that ships only a `view` has neither, so a predicate that
 *    was not widened routes it to the generic registry card instead, losing its output entirely. The
 *    `toolDrawsItself` cells pin every combination, including the empty tool.
 *  - The tool GAINS decoration it never had. A one-line header rendered as a status row acquires the
 *    host's status glyph and column; the migrated call view is a text block for exactly that reason,
 *    and the byte-identity cell is what says so.
 *  - The DISCLOSURE STATE stops arriving. A view renderer receives one thing from the host, whether
 *    the card is expanded, and `run_experiment` shows five lines collapsed against its whole output
 *    expanded. A context dropped anywhere between the component and the renderer draws the collapsed
 *    row in both states, which reads as a card that simply refuses to open, so the two states are
 *    compared against each other as well as against their bytes.
 *
 * MUTATIONS OBSERVED RED. Each of these was re-injected and the suite failed: `toolDrawsItself`
 * ignoring a view; emphasis moved outside the colour; an untoned span given a default tone; a status
 * row building its own layout instead of calling `renderStatusLine`; the migrated call view returning
 * a status row; the call view dropping its width bound; the adapter dropping the view forwarding; the
 * component asking only for a terminal renderer; the call branch ignoring the view renderer; and the
 * migrated tool importing `@veyyon/tui` again.
 *
 * WHAT IT DOES NOT CATCH. It compares strings, not pixels: nothing here proves how a tone looks, only
 * that the same theme call produces it. It does not enumerate `ViewTone` or `ViewStatus` at run time,
 * because a TypeScript union has no run-time members — that totality is held by
 * `TONE_COLORS: Record<ViewTone, ThemeColor>` and `STATUS_ICONS: Record<ViewStatus, ToolUIStatus>` in
 * `tui/draw-tool-view.ts`, which fail `check:ts` when either union grows a member. And it says nothing
 * about the streamed preview: `exposesRawPartialJson` in `controllers/event-controller.ts` counts a
 * `view.renderCall` so a conversion does not narrow what the live preview is handed, and that
 * predicate is private to a controller this suite does not drive.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AnyAgentTool } from "@veyyon/agent-core";
import { createExperimentState, createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import { createCertifyArmsTool } from "@veyyon/coding-agent/autoresearch/tools/certify-arms";
import {
	createInitExperimentTool,
	DEFAULT_HARNESS_COMMAND,
} from "@veyyon/coding-agent/autoresearch/tools/init-experiment";
import { createLogExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/log-experiment";
import { createRunExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/run-experiment";
import { createUpdateNotesTool } from "@veyyon/coding-agent/autoresearch/tools/update-notes";
import type {
	AutoresearchToolFactoryOptions,
	ExperimentResult,
	ExperimentStatus,
	LogDetails,
	RunDetails,
} from "@veyyon/coding-agent/autoresearch/types";
import type { ExtensionAPI, ToolDefinition } from "@veyyon/coding-agent/extensibility/extensions";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { RegisteredToolAdapter } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import type { ThemeColor } from "@veyyon/coding-agent/theme/color";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import { drawSpan, drawStatusRow, drawToolViewText, toolDrawsItself } from "@veyyon/coding-agent/tui/draw-tool-view";
import { renderStatusLine } from "@veyyon/coding-agent/tui/status-line";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy, type TUI } from "@veyyon/tui";
import { truncateToWidth } from "@veyyon/utils/width";
import { replaceTabs } from "@veyyon/utils/wrap";
import type { LineToolView, ToolView } from "@veyyon/view";
import { createToolExecution } from "./helpers/tool-execution";

// `theme` is a live module binding the engine assigns, so it is undefined until a theme loads. Every
// cell below reads it at the point of use rather than capturing it, which is what that binding
// requires.
//
// Colour is forced on for the same reason the suite exists. Under the policy a piped run detects,
// `fg` and `bold` are both the identity, so `fg(tone, bold(text))` and `bold(fg(tone, text))` are
// one string and every byte-identity claim below would pass on nothing. It goes through the one
// owner of that decision rather than through the environment, and is restored after.
let entryPolicy: AnsiPolicy;

beforeAll(async () => {
	await initTheme();
	entryPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
});

afterAll(() => {
	setAnsiPolicy(entryPolicy);
});

/**
 * The view a one-line renderer returns, refusing a framed block.
 *
 * `drawToolViewText` draws the kinds that are one line of text; a block is drawn as a container at a
 * width. A renderer that changes kind therefore fails here, loudly, instead of being handed to a
 * drawer that cannot lay it out.
 */
function lineView(view: ToolView): LineToolView {
	if (view.kind === "framedBlock") throw new Error(`expected a one-line view, got ${view.kind}`);
	return view;
}

/** The disclosure state a collapsed card reports, which is every card until the reader expands it. */
const COLLAPSED = { expanded: false } as const;
const EXPANDED = { expanded: true } as const;

// The view members of a tool definition are pure: they receive the call arguments, the result and the
// disclosure state, and nothing else. The factory's dashboard, runtime and extension API are
// reachable only from `execute`, which this suite never calls, so the cheapest values that satisfy
// the parameter types are the honest ones here. Behaviour of `execute` is covered by
// `autoresearch-tools.test.ts`.
function autoresearchOptions(): AutoresearchToolFactoryOptions {
	const runtime = createSessionRuntime();
	return {
		dashboard: {
			clear(): void {},
			requestRender(): void {},
			showOverlay: async (): Promise<void> => {},
			updateWidget(): void {},
		},
		getRuntime: () => runtime,
		pi: {} as unknown as ExtensionAPI,
	};
}

function migratedTool() {
	return createInitExperimentTool(autoresearchOptions());
}

/**
 * The adapter a registered tool becomes, built the way a registered tool reaches it in production.
 *
 * `RegisteredToolAdapter` takes a `RegisteredTool`, whose `definition` is
 * `ToolDefinition<TSchema, unknown>` -- a schema-agnostic shape a concrete definition is not
 * assignable to, because `renderCall` receives the parsed arguments and a function parameter is
 * contravariant. Production does not perform that assignment either: `Extension.tools` is declared
 * `Map<string, RegisteredTool<any, any>>`, so the widening happens through `any` there, and this
 * parameter is declared the same way rather than dressed up as something safer than the code under
 * test. Everything the cells then read -- the forwarded `view`, the drawn bytes -- is the real object.
 */
function adapterFor(definition: ToolDefinition<any, any>): RegisteredToolAdapter {
	return new RegisteredToolAdapter(
		{ definition, extensionPath: "autoresearch" },
		// Reachable only from `execute`, which no cell here calls.
		{} as unknown as ExtensionRunner,
	);
}

describe("the measurement itself", () => {
	/**
	 * Anti-vacuity for every cell below. A theme with colour and attributes off returns its input
	 * from `fg` and `bold`, which makes each byte-identity comparison a comparison of plain text and
	 * makes the ordering cell in particular pass for the wrong reason.
	 */
	it("runs with colour and attributes on, or nothing below compares bytes", () => {
		expect(theme.fg("accent", "x")).not.toBe("x");
		expect(theme.bold("x")).not.toBe("x");
		expect(theme.italic("x")).not.toBe("x");
	});
});

describe("a migrated tool's call card", () => {
	it("draws the exact string its deleted renderCall drew", () => {
		const tool = migratedTool();
		const view = tool.view?.renderCall?.({ name: "speed", primary_metric: "runtime_ms" }, COLLAPSED);
		expect(view).toBeDefined();
		if (!view) return;

		// The expression the tool held before the migration, verbatim: title bold inside the
		// tool-title colour, one plain space, then the truncated name in the accent colour.
		const expected = `${theme.fg("toolTitle", theme.bold("init_experiment"))} ${theme.fg(
			"accent",
			truncateToWidth(replaceTabs("speed"), 100),
		)}`;
		expect(drawToolViewText(lineView(view), theme)).toBe(expected);
	});

	it("keeps the tool's own 100-column bound on the caller-supplied name", () => {
		const tool = migratedTool();
		const name = "n".repeat(400);
		const view = tool.view?.renderCall?.({ name, primary_metric: "ms" }, COLLAPSED);
		expect(view).toBeDefined();
		if (!view) return;

		const truncated = truncateToWidth(replaceTabs(name), 100);
		expect(truncated.length).toBeLessThan(name.length);
		expect(drawToolViewText(lineView(view), theme)).toBe(
			`${theme.fg("toolTitle", theme.bold("init_experiment"))} ${theme.fg("accent", truncated)}`,
		);
	});

	it("draws no status glyph and no column, because the row it replaced had neither", () => {
		const tool = migratedTool();
		const view = tool.view?.renderCall?.({ name: "speed", primary_metric: "ms" }, COLLAPSED);
		expect(view?.kind).toBe("textBlock");
	});
});

describe("a migrated tool's result card", () => {
	it("draws the result text with tabs expanded and no styling of its own", () => {
		const tool = migratedTool();
		const view = tool.view?.renderResult?.({ content: [{ type: "text", text: "line one\n\tindented" }] }, COLLAPSED);
		expect(view).toBeDefined();
		if (!view) return;

		const drawn = drawToolViewText(lineView(view), theme);
		expect(drawn).toBe(replaceTabs("line one\n\tindented"));
		expect(drawn).not.toContain("\t");
		expect(drawn).not.toContain("\u001b");
	});

	it("draws an empty string when the result carries no text block", () => {
		const tool = migratedTool();
		const view = tool.view?.renderResult?.({ content: [] }, COLLAPSED);
		expect(view).toBeDefined();
		if (!view) return;
		expect(drawToolViewText(lineView(view), theme)).toBe("");
	});
});

describe("the migration itself", () => {
	it("left the tool with a view and no terminal renderer", () => {
		const tool = migratedTool();
		expect(tool.view?.renderCall).toBeInstanceOf(Function);
		expect(tool.view?.renderResult).toBeInstanceOf(Function);
		expect(tool.renderCall).toBeUndefined();
		expect(tool.renderResult).toBeUndefined();
	});

	it("still counts as a tool that draws its own card", () => {
		expect(toolDrawsItself(migratedTool())).toBe(true);
	});

	/**
	 * The production path, not the definition. `api.registerTool(definition)` reaches the terminal as
	 * a `RegisteredToolAdapter`, and the adapter forwards `renderCall`/`renderResult` by explicit
	 * assignment rather than through `applyToolProxy`, because the class emits those fields and the
	 * proxy skips a key the wrapper already has. A `view` forwarded by neither route is declared,
	 * type-checked, and invisible: the tool's card silently becomes the generic one. So the adapter is
	 * asserted to carry it, and to draw the same bytes the definition does.
	 */
	it("reaches the host through the adapter a registered tool becomes", () => {
		const definition = migratedTool();
		const adapter = adapterFor(definition);
		expect(adapter.view?.renderCall).toBeInstanceOf(Function);
		expect(adapter.view?.renderResult).toBeInstanceOf(Function);
		expect(toolDrawsItself(adapter)).toBe(true);

		const throughAdapter = adapter.view?.renderCall?.({ name: "speed", primary_metric: "ms" }, COLLAPSED);
		const throughDefinition = definition.view?.renderCall?.({ name: "speed", primary_metric: "ms" }, COLLAPSED);
		expect(throughAdapter).toBeDefined();
		if (!throughAdapter || !throughDefinition) return;
		expect(drawToolViewText(lineView(throughAdapter), theme)).toBe(
			drawToolViewText(lineView(throughDefinition), theme),
		);
	});

	/**
	 * The other half of the forwarding rule. A tool with no view must not acquire an object that
	 * answers undefined: `ToolExecutionComponent` reads presence, so a `view` that exists and is
	 * empty puts the tool on the tool-owned path with nothing to draw, which is the blank card the
	 * adapter's `renderCall` comment already records for the pair above it.
	 */
	it("gives a viewless tool no view at all, rather than an empty one", () => {
		const { view: _dropped, ...viewless } = migratedTool();
		const adapter = adapterFor(viewless);
		expect(adapter.view).toBeUndefined();
		expect(toolDrawsItself(adapter)).toBe(false);
	});
});

/**
 * The rendered card, through `ToolExecutionComponent` itself.
 *
 * This is the cell that closes the defect class. Everything above proves the view is present and
 * draws the right string; only the component decides whether that string reaches the screen. It
 * chooses between a tool-owned branch and the shared registry by asking whether the tool draws
 * itself, and a tool that ships only a `view` has neither `renderCall` nor `renderResult` -- so a
 * predicate that was not widened sends it to the generic card and its output disappears. Comparing a
 * view-only tool's rows against a viewless one's is what makes that visible: the fallback row is the
 * bold tool LABEL alone, and the view row is the tool name plus its subject.
 */
describe("the terminal card of a tool that only describes a view", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	function rows(component: { render(width: number): readonly string[] }): string[] {
		return component
			.render(80)
			.map(line => stripVTControlCharacters(line).replace(/\s+$/, ""))
			.filter(line => line.length > 0);
	}

	function card(tool: AnyAgentTool | undefined): string[] {
		const block = createToolExecution("init_experiment", { name: "speed", primary_metric: "ms" }, {}, tool, ui);
		block.setArgsComplete();
		return rows(block);
	}

	it("draws the view, not the tool-name fallback the generic card falls back to", () => {
		const definition = migratedTool();
		const { view: _dropped, ...viewless } = definition;

		const withView = card(adapterFor(definition));
		const withoutView = card(adapterFor(viewless));

		// The two branches are told apart by what each one actually prints. The view branch prints the
		// tool's own row: the wire name and its subject. The generic registry card prints the tool's
		// human LABEL and an inline argument dump, which is exactly the card a view that never
		// reached the host would silently fall back to.
		expect(withView).not.toEqual(withoutView);
		expect(withView.join("\n")).toContain("init_experiment speed");
		expect(withView.join("\n")).not.toContain("Init Experiment");
		expect(withoutView.join("\n")).toContain("Init Experiment");
		expect(withoutView.join("\n")).not.toContain("init_experiment speed");
	});
});

/**
 * The disclosure state, through `ToolExecutionComponent` itself.
 *
 * The cells above call a view renderer directly, so every one of them passes a context by hand and
 * none of them proves the component supplies one. The component is where it can be lost: it holds the
 * expanded flag, and a draw site that passed a literal `false` -- or read the wrong field -- would
 * leave every converted tool permanently collapsed while every direct-call cell stayed green. So this
 * drives the real card, expands it the way a keypress does, and reads the rows back.
 */
describe("the disclosure state a converted tool is handed", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	function runCard(expanded: boolean): string {
		const details = {
			runNumber: 1,
			runDirectory: "/repo/.autoresearch/run-1",
			benchmarkLogPath: "/repo/.autoresearch/run-1/log",
			command: DEFAULT_HARNESS_COMMAND,
			exitCode: 0,
			durationSeconds: 1.5,
			passed: true,
			crashed: false,
			timedOut: false,
			tailOutput: Array.from({ length: 9 }, (_unused, index) => `line ${index + 1}`).join("\n"),
			parsedMetrics: null,
			parsedPrimary: null,
			parsedAsi: null,
			metricName: "runtime",
			metricUnit: "ms",
			preRunDirtyPaths: [],
			abandonedPriorRun: null,
		};
		const block = createToolExecution(
			"run_experiment",
			{},
			{},
			adapterFor(createRunExperimentTool(autoresearchOptions())),
			ui,
		);
		block.setArgsComplete();
		block.updateResult({ content: [{ type: "text", text: "" }], details });
		block.setExpanded(expanded);
		return block
			.render(80)
			.map(line => stripVTControlCharacters(line).replace(/\s+$/, ""))
			.join("\n");
	}

	it("reaches the tool from the component, so expanding the card lengthens its output", () => {
		const collapsed = runCard(false);
		const expanded = runCard(true);

		expect(collapsed).toContain("PASS 1.5s");
		expect(expanded).toContain("PASS 1.5s");
		// Nine lines of output: the collapsed card keeps the last five, so `line 1` through `line 4`
		// appear only once the reader opens it.
		expect(collapsed).toContain("line 9");
		expect(collapsed).not.toContain("line 1");
		expect(expanded).toContain("line 1");
		expect(expanded).toContain("line 9");
	});
});

describe("a span", () => {
	it("puts emphasis inside the colour, not around it", () => {
		expect(drawSpan({ text: "x", tone: "error", bold: true }, theme)).toBe(theme.fg("error", theme.bold("x")));
		expect(drawSpan({ text: "x", tone: "error", bold: true }, theme)).not.toBe(theme.bold(theme.fg("error", "x")));
	});

	it("draws italic inside the colour too, and both together", () => {
		expect(drawSpan({ text: "x", tone: "muted", italic: true }, theme)).toBe(theme.fg("muted", theme.italic("x")));
		expect(drawSpan({ text: "x", tone: "title", bold: true, italic: true }, theme)).toBe(
			theme.fg("toolTitle", theme.italic(theme.bold("x"))),
		);
	});

	it("draws an untoned span as raw text, so a separator stays unstyled", () => {
		expect(drawSpan({ text: " -> " }, theme)).toBe(" -> ");
		expect(drawSpan({ text: " -> ", bold: true }, theme)).toBe(theme.bold(" -> "));
	});
});

describe("a status row", () => {
	it("routes through the host's status line rather than inventing a second layout", () => {
		const drawn = drawStatusRow(
			{ kind: "statusRow", status: "error", title: "review", description: "two findings" },
			theme,
		);
		expect(drawn).toBe(renderStatusLine({ icon: "error", title: "review", description: "two findings" }, theme));
	});

	it("draws no icon when the tool reported no status", () => {
		const drawn = drawStatusRow({ kind: "statusRow", title: "review" }, theme);
		expect(drawn).toBe(renderStatusLine({ title: "review" }, theme));
	});

	it("maps a tone to a theme colour for the title, the badge and the metadata", () => {
		const drawn = drawStatusRow(
			{
				kind: "statusRow",
				status: "success",
				title: "review",
				titleTone: "title",
				badge: { label: "strict", tone: "warning" },
				meta: [{ text: "12 files", tone: "muted" }],
			},
			theme,
		);
		expect(drawn).toBe(
			renderStatusLine(
				{
					icon: "success",
					title: "review",
					titleColor: "toolTitle",
					badge: { label: "strict", color: "warning" },
					meta: [theme.fg("muted", "12 files")],
				},
				theme,
			),
		);
	});
});

describe("whether a tool draws its own card", () => {
	it("is true for a terminal renderer, a view, or both, and false for neither", () => {
		const draw = () => ({ kind: "textBlock" as const, spans: [] });
		expect(toolDrawsItself({ renderCall: draw })).toBe(true);
		expect(toolDrawsItself({ renderResult: draw })).toBe(true);
		expect(toolDrawsItself({ view: { renderCall: draw } })).toBe(true);
		expect(toolDrawsItself({ view: { renderResult: draw } })).toBe(true);
		expect(toolDrawsItself({ renderCall: draw, view: { renderResult: draw } })).toBe(true);
		expect(toolDrawsItself({})).toBe(false);
		expect(toolDrawsItself({ view: {} })).toBe(false);
		expect(toolDrawsItself(undefined)).toBe(false);
	});
});

/**
 * The other four experiment tools, each against the exact expression its deleted renderer held.
 *
 * These are not repetitions of the `init_experiment` cells. Each of the four carries a shape that
 * one does not: a preview that falls back to a slice of another argument, a summary whose colour is
 * chosen from the run's outcome, a row built by conditional concatenation, and a result whose length
 * depends on the disclosure state. A single cell per tool would prove the happy path and leave every
 * branch that decides the bytes unmeasured, so each branch is its own cell.
 */
describe("update_notes", () => {
	const tool = () => createUpdateNotesTool(autoresearchOptions());

	function expected(preview: string): string {
		return `${theme.fg("toolTitle", theme.bold("update_notes"))} ${theme.fg(
			"muted",
			truncateToWidth(replaceTabs(preview), 100),
		)}`;
	}

	it("previews the appended idea when there is one", () => {
		const view = tool().view?.renderCall?.({ body: "the whole body", append_idea: "one idea" }, COLLAPSED);
		expect(view).toBeDefined();
		if (!view) return;
		expect(drawToolViewText(lineView(view), theme)).toBe(expected("one idea"));
	});

	/**
	 * The other branch of the preview: with no idea to append, the row shows the body.
	 *
	 * The deleted expression sliced the body to 100 CHARACTERS and then bounded the muted span to 100
	 * COLUMNS. Those two limits are in different units but they coincide for every input where the
	 * first hundred characters are at least a hundred columns wide, which is every realistic body, so
	 * this pins the composition rather than claiming to tell the limits apart. What it does catch is
	 * the branch itself and the bound: a preview that ignored the body, or one that stopped bounding
	 * it, draws a different string.
	 */
	it("falls back to the head of the body when no idea was appended", () => {
		const short = tool().view?.renderCall?.({ body: "the whole body" }, COLLAPSED);
		expect(short).toBeDefined();
		if (!short) return;
		expect(drawToolViewText(lineView(short), theme)).toBe(expected("the whole body"));

		const body = "b".repeat(300);
		const long = tool().view?.renderCall?.({ body }, COLLAPSED);
		expect(long).toBeDefined();
		if (!long) return;
		const drawn = drawToolViewText(lineView(long), theme);
		expect(drawn).toBe(expected(body.slice(0, 100)));
		expect(stripVTControlCharacters(drawn).length).toBeLessThan(body.length);
	});

	it("draws its result muted, tabs expanded", () => {
		const view = tool().view?.renderResult?.(
			{ content: [{ type: "text", text: "Notes updated\t(12 chars)." }] },
			COLLAPSED,
		);
		expect(view).toBeDefined();
		if (!view) return;
		expect(drawToolViewText(lineView(view), theme)).toBe(
			theme.fg("muted", replaceTabs("Notes updated\t(12 chars).")),
		);
	});
});

describe("certify_arms", () => {
	const tool = () => createCertifyArmsTool(autoresearchOptions());

	function expected(summary: string): string {
		return `${theme.fg("toolTitle", theme.bold("certify_arms"))} ${theme.fg(
			"muted",
			truncateToWidth(replaceTabs(summary), 100),
		)}`;
	}

	function arm(label: string) {
		return { arm: label, hypothesis: `${label} is faster`, diff: "", modified_paths: [] };
	}

	it("says how many arms it is triaging when no verdicts were supplied", () => {
		const view = tool().view?.renderCall?.({ arms: [arm("a"), arm("b"), arm("c")] }, COLLAPSED);
		expect(view).toBeDefined();
		if (!view) return;
		expect(drawToolViewText(lineView(view), theme)).toBe(expected("triage 3 arms"));
	});

	it("counts the verdicts instead once they are supplied", () => {
		const view = tool().view?.renderCall?.(
			{
				arms: [arm("a"), arm("b"), arm("c")],
				verdicts: [{ arm: "a", certified_by: "reviewer", flagged: false }],
			},
			COLLAPSED,
		);
		expect(view).toBeDefined();
		if (!view) return;
		expect(drawToolViewText(lineView(view), theme)).toBe(expected("verdicts for 1 arms"));
	});

	it("draws its result muted", () => {
		const view = tool().view?.renderResult?.({ content: [{ type: "text", text: "Triaged 3 arms." }] }, COLLAPSED);
		expect(view).toBeDefined();
		if (!view) return;
		expect(drawToolViewText(lineView(view), theme)).toBe(theme.fg("muted", "Triaged 3 arms."));
	});
});

describe("log_experiment", () => {
	const tool = () => createLogExperimentTool(autoresearchOptions());

	function experiment(overrides: Partial<ExperimentResult> = {}): ExperimentResult {
		return {
			runNumber: 1,
			commit: "0".repeat(40),
			metric: 12,
			metrics: {},
			status: "keep",
			description: "made it faster",
			timestamp: 0,
			segment: 0,
			confidence: null,
			modifiedPaths: [],
			scopeDeviations: [],
			justification: null,
			flagged: false,
			flaggedReason: null,
			...overrides,
		};
	}

	function details(overrides: Partial<LogDetails> = {}): LogDetails {
		return {
			experiment: experiment(),
			state: { ...createExperimentState(), metricName: "runtime", metricUnit: "ms" },
			wallClockSeconds: null,
			scopeDeviations: [],
			justification: null,
			flaggedRuns: [],
			...overrides,
		};
	}

	/**
	 * Every status, not a sample. Three of the four choose a different colour and the fourth shares the
	 * third's, so a `statusTone` that collapsed to one colour would still satisfy any single case.
	 *
	 * The expectation is a total `Record<ExperimentStatus, ThemeColor>`, so a fifth status fails
	 * `check:ts` here until someone records the colour it draws -- the compile-time half of failing by
	 * default on a new member, which a TypeScript union cannot give at run time.
	 */
	it("colours the status the way the deleted renderer did, for every status", () => {
		const expectedColor: Record<ExperimentStatus, ThemeColor> = {
			keep: "success",
			discard: "warning",
			crash: "error",
			checks_failed: "error",
		};
		const statuses: readonly ExperimentStatus[] = ["keep", "discard", "crash", "checks_failed"];
		expect(Object.keys(expectedColor)).toEqual([...statuses]);

		for (const status of statuses) {
			const view = tool().view?.renderCall?.({ metric: 1, status, description: "why" }, COLLAPSED);
			expect(view).toBeDefined();
			if (!view) continue;
			expect(drawToolViewText(lineView(view), theme)).toBe(
				`${theme.fg("toolTitle", theme.bold("log_experiment"))} ${theme.fg(expectedColor[status], status)} ${theme.fg(
					"muted",
					truncateToWidth(replaceTabs("why"), 100),
				)}`,
			);
		}
	});

	it("draws the plain result text, unstyled, when the run recorded no details", () => {
		const view = tool().view?.renderResult?.({ content: [{ type: "text", text: "logged\trun 1" }] }, COLLAPSED);
		expect(view).toBeDefined();
		if (!view) return;
		const drawn = drawToolViewText(lineView(view), theme);
		expect(drawn).toBe(replaceTabs("logged\trun 1"));
		expect(drawn).not.toContain("\u001b");
	});

	it("draws the summary without a baseline, a confidence or a deviation count when there is none", () => {
		const view = tool().view?.renderResult?.({ content: [], details: details() }, COLLAPSED);
		expect(view).toBeDefined();
		if (!view) return;
		expect(drawToolViewText(lineView(view), theme)).toBe(
			`${theme.fg("success", "KEEP")} ${theme.fg("muted", "made it faster")} ${theme.fg("accent", "runtime=12ms")}`,
		);
	});

	/**
	 * The three optional trailers, all present. Each was a separate `+=` in the deleted function and
	 * each is now a conditional pair of spans, so this is where an ordering or separator change shows.
	 */
	it("appends the baseline, the confidence and the deviation count in that order", () => {
		const view = tool().view?.renderResult?.(
			{
				content: [],
				details: details({
					experiment: experiment({ status: "discard", metric: 20 }),
					state: {
						...createExperimentState(),
						metricName: "runtime",
						metricUnit: "ms",
						bestMetric: 12,
						confidence: 2.5,
					},
					scopeDeviations: ["touched src/other.ts"],
				}),
			},
			COLLAPSED,
		);
		expect(view).toBeDefined();
		if (!view) return;
		expect(drawToolViewText(lineView(view), theme)).toBe(
			[
				theme.fg("warning", "DISCARD"),
				theme.fg("muted", "made it faster"),
				theme.fg("accent", "runtime=20ms"),
				theme.fg("dim", "baseline 12ms"),
				theme.fg("dim", "conf 2.5x"),
				theme.fg("warning", "deviations:1"),
			].join(" "),
		);
	});
});

describe("run_experiment", () => {
	const tool = () => createRunExperimentTool(autoresearchOptions());

	function run(overrides: Partial<RunDetails> = {}): RunDetails {
		return {
			runNumber: 1,
			runDirectory: "/repo/.autoresearch/run-1",
			benchmarkLogPath: "/repo/.autoresearch/run-1/log",
			command: DEFAULT_HARNESS_COMMAND,
			exitCode: 0,
			durationSeconds: 1.5,
			passed: true,
			crashed: false,
			timedOut: false,
			tailOutput: "",
			parsedMetrics: null,
			parsedPrimary: null,
			parsedAsi: null,
			metricName: "runtime",
			metricUnit: "ms",
			preRunDirtyPaths: [],
			abandonedPriorRun: null,
			...overrides,
		};
	}

	it("names the harness command it is about to run", () => {
		const view = tool().view?.renderCall?.({}, COLLAPSED);
		expect(view).toBeDefined();
		if (!view) return;
		expect(drawToolViewText(lineView(view), theme)).toBe(
			`${theme.fg("toolTitle", theme.bold("run_experiment"))} ${theme.fg("muted", DEFAULT_HARNESS_COMMAND)}`,
		);
	});

	it("draws the elapsed header alone while a run has produced no output yet", () => {
		const view = tool().view?.renderResult?.(
			{ content: [{ type: "text", text: "" }], details: { phase: "running", elapsed: "3s" } },
			COLLAPSED,
		);
		expect(view).toBeDefined();
		if (!view) return;
		expect(drawToolViewText(lineView(view), theme)).toBe(theme.fg("warning", "Running 3s..."));
	});

	it("puts a running run's output under its header, dimmed", () => {
		const view = tool().view?.renderResult?.(
			{ content: [{ type: "text", text: "compiling\tunit" }], details: { phase: "running", elapsed: "3s" } },
			COLLAPSED,
		);
		expect(view).toBeDefined();
		if (!view) return;
		expect(drawToolViewText(lineView(view), theme)).toBe(
			`${theme.fg("warning", "Running 3s...")}\n${theme.fg("dim", replaceTabs("compiling\tunit"))}`,
		);
	});

	it("draws each terminal outcome the way the deleted status helper drew it", () => {
		const timedOut = tool().view?.renderResult?.({ content: [], details: run({ timedOut: true }) }, COLLAPSED);
		const failed = tool().view?.renderResult?.({ content: [], details: run({ exitCode: 2 }) }, COLLAPSED);
		const passed = tool().view?.renderResult?.({ content: [], details: run({ parsedPrimary: 42 }) }, COLLAPSED);
		expect(timedOut && failed && passed).toBeTruthy();
		if (!timedOut || !failed || !passed) return;
		expect(drawToolViewText(lineView(timedOut), theme)).toBe(theme.fg("error", "TIMEOUT 1.5s"));
		expect(drawToolViewText(lineView(failed), theme)).toBe(theme.fg("error", "FAIL exit=2 1.5s"));
		expect(drawToolViewText(lineView(passed), theme)).toBe(theme.fg("success", "PASS 1.5s runtime=42ms"));
	});

	/**
	 * The disclosure state, which is the one thing a view renderer receives from the host and the
	 * reason `ToolViewContext` exists. Collapsed shows the last five lines; expanded shows all of them
	 * and, when the output was truncated to a file, says where the rest is. A contract that dropped the
	 * context would draw the collapsed row in both states, so the two are compared against each other
	 * as well as against their expected bytes.
	 */
	it("shows the last five lines collapsed and everything expanded", () => {
		const tailOutput = Array.from({ length: 9 }, (_unused, index) => `line ${index + 1}`).join("\n");
		const details = run({ tailOutput });
		const collapsed = tool().view?.renderResult?.({ content: [], details }, COLLAPSED);
		const expanded = tool().view?.renderResult?.({ content: [], details }, EXPANDED);
		expect(collapsed && expanded).toBeTruthy();
		if (!collapsed || !expanded) return;

		const status = theme.fg("success", "PASS 1.5s");
		expect(drawToolViewText(lineView(collapsed), theme)).toBe(
			`${status}\n${theme.fg("dim", "line 5\nline 6\nline 7\nline 8\nline 9")}`,
		);
		expect(drawToolViewText(lineView(expanded), theme)).toBe(`${status}\n${theme.fg("dim", tailOutput)}`);
		expect(drawToolViewText(lineView(collapsed), theme)).not.toBe(drawToolViewText(lineView(expanded), theme));
	});

	it("names the full output file only when the card is expanded and the output was truncated", () => {
		const details = run({
			tailOutput: "tail",
			truncation: { content: "tail", truncated: true, totalLines: 900, totalBytes: 90_000 },
			fullOutputPath: "/repo/.autoresearch/run-1/full.log",
		});
		const collapsed = tool().view?.renderResult?.({ content: [], details }, COLLAPSED);
		const expanded = tool().view?.renderResult?.({ content: [], details }, EXPANDED);
		expect(collapsed && expanded).toBeTruthy();
		if (!collapsed || !expanded) return;
		expect(drawToolViewText(lineView(collapsed), theme)).not.toContain("Full output:");
		expect(drawToolViewText(lineView(expanded), theme)).toBe(
			`${theme.fg("success", "PASS 1.5s")}\n${theme.fg("dim", "tail")}\n${theme.fg(
				"warning",
				"Full output: /repo/.autoresearch/run-1/full.log",
			)}`,
		);
	});

	it("draws the status alone when a collapsed card has nothing but whitespace to preview", () => {
		const view = tool().view?.renderResult?.({ content: [], details: run({ tailOutput: "  \n\t" }) }, COLLAPSED);
		expect(view).toBeDefined();
		if (!view) return;
		expect(drawToolViewText(lineView(view), theme)).toBe(theme.fg("success", "PASS 1.5s"));
	});
});

/**
 * Every conversion, as one claim rather than five.
 *
 * A tool that keeps a terminal renderer beside its view still draws through the terminal, so the
 * conversion did nothing; a tool whose view is missing a member falls back to the generic card for
 * that half. Sweeping the five factories is what makes a sixth conversion that forgot one of the two
 * members fail here rather than pass unnoticed.
 */
describe("every converted experiment tool", () => {
	it("carries both view members and no terminal renderer", () => {
		const options = autoresearchOptions();
		const tools = [
			createInitExperimentTool(options),
			createUpdateNotesTool(options),
			createCertifyArmsTool(options),
			createLogExperimentTool(options),
			createRunExperimentTool(options),
		];
		for (const tool of tools) {
			expect(tool.view?.renderCall).toBeInstanceOf(Function);
			expect(tool.view?.renderResult).toBeInstanceOf(Function);
			expect(tool.renderCall).toBeUndefined();
			expect(tool.renderResult).toBeUndefined();
			expect(toolDrawsItself(tool)).toBe(true);
		}
	});
});
