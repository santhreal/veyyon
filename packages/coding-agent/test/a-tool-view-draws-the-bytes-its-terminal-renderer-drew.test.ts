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
 * THE DEFECT CLASS THIS CLOSES. Three ways a conversion silently changes the screen:
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
import { createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import { createInitExperimentTool } from "@veyyon/coding-agent/autoresearch/tools/init-experiment";
import type { ExtensionAPI, ToolDefinition } from "@veyyon/coding-agent/extensibility/extensions";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { RegisteredToolAdapter } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import { drawSpan, drawStatusRow, drawToolViewText, toolDrawsItself } from "@veyyon/coding-agent/tui/draw-tool-view";
import { renderStatusLine } from "@veyyon/coding-agent/tui/status-line";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy, type TUI } from "@veyyon/tui";
import { truncateToWidth } from "@veyyon/utils/width";
import { replaceTabs } from "@veyyon/utils/wrap";
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

// The view members of a tool definition are pure: they receive the call arguments or the result and
// nothing else. The factory's dashboard, runtime and extension API are reachable only from
// `execute`, which this suite never calls, so the cheapest values that satisfy the parameter types
// are the honest ones here. Behaviour of `execute` is covered by `autoresearch-tools.test.ts`.
function migratedTool() {
	const runtime = createSessionRuntime();
	return createInitExperimentTool({
		dashboard: {
			clear(): void {},
			requestRender(): void {},
			showOverlay: async (): Promise<void> => {},
			updateWidget(): void {},
		},
		getRuntime: () => runtime,
		pi: {} as unknown as ExtensionAPI,
	});
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
		const view = tool.view?.renderCall?.({ name: "speed", primary_metric: "runtime_ms" });
		expect(view).toBeDefined();
		if (!view) return;

		// The expression the tool held before the migration, verbatim: title bold inside the
		// tool-title colour, one plain space, then the truncated name in the accent colour.
		const expected = `${theme.fg("toolTitle", theme.bold("init_experiment"))} ${theme.fg(
			"accent",
			truncateToWidth(replaceTabs("speed"), 100),
		)}`;
		expect(drawToolViewText(view, theme)).toBe(expected);
	});

	it("keeps the tool's own 100-column bound on the caller-supplied name", () => {
		const tool = migratedTool();
		const name = "n".repeat(400);
		const view = tool.view?.renderCall?.({ name, primary_metric: "ms" });
		expect(view).toBeDefined();
		if (!view) return;

		const truncated = truncateToWidth(replaceTabs(name), 100);
		expect(truncated.length).toBeLessThan(name.length);
		expect(drawToolViewText(view, theme)).toBe(
			`${theme.fg("toolTitle", theme.bold("init_experiment"))} ${theme.fg("accent", truncated)}`,
		);
	});

	it("draws no status glyph and no column, because the row it replaced had neither", () => {
		const tool = migratedTool();
		const view = tool.view?.renderCall?.({ name: "speed", primary_metric: "ms" });
		expect(view?.kind).toBe("textBlock");
	});
});

describe("a migrated tool's result card", () => {
	it("draws the result text with tabs expanded and no styling of its own", () => {
		const tool = migratedTool();
		const view = tool.view?.renderResult?.({
			content: [{ type: "text", text: "line one\n\tindented" }],
		});
		expect(view).toBeDefined();
		if (!view) return;

		const drawn = drawToolViewText(view, theme);
		expect(drawn).toBe(replaceTabs("line one\n\tindented"));
		expect(drawn).not.toContain("\t");
		expect(drawn).not.toContain("\u001b");
	});

	it("draws an empty string when the result carries no text block", () => {
		const tool = migratedTool();
		const view = tool.view?.renderResult?.({ content: [] });
		expect(view).toBeDefined();
		if (!view) return;
		expect(drawToolViewText(view, theme)).toBe("");
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
		const adapter = new RegisteredToolAdapter(
			{ definition, extensionPath: "autoresearch" },
			// Reachable only from `execute`, which this cell never calls.
			{} as unknown as ExtensionRunner,
		);
		expect(adapter.view?.renderCall).toBeInstanceOf(Function);
		expect(adapter.view?.renderResult).toBeInstanceOf(Function);
		expect(toolDrawsItself(adapter)).toBe(true);

		const throughAdapter = adapter.view?.renderCall?.({ name: "speed", primary_metric: "ms" });
		const throughDefinition = definition.view?.renderCall?.({ name: "speed", primary_metric: "ms" });
		expect(throughAdapter).toBeDefined();
		if (!throughAdapter || !throughDefinition) return;
		expect(drawToolViewText(throughAdapter, theme)).toBe(drawToolViewText(throughDefinition, theme));
	});

	/**
	 * The other half of the forwarding rule. A tool with no view must not acquire an object that
	 * answers undefined: `ToolExecutionComponent` reads presence, so a `view` that exists and is
	 * empty puts the tool on the tool-owned path with nothing to draw, which is the blank card the
	 * adapter's `renderCall` comment already records for the pair above it.
	 */
	it("gives a viewless tool no view at all, rather than an empty one", () => {
		const definition = migratedTool();
		const { view: _dropped, ...viewless } = definition;
		const adapter = new RegisteredToolAdapter(
			{ definition: viewless, extensionPath: "autoresearch" },
			{} as unknown as ExtensionRunner,
		);
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

	function registered(definition: ToolDefinition): AnyAgentTool {
		return new RegisteredToolAdapter({ definition, extensionPath: "autoresearch" }, {} as unknown as ExtensionRunner);
	}

	it("draws the view, not the tool-name fallback the generic card falls back to", () => {
		const definition = migratedTool();
		const { view: _dropped, ...viewless } = definition;

		const withView = card(registered(definition));
		const withoutView = card(registered(viewless));

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
