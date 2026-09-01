/**
 * The machinery every converted-tool differential suite in this directory shares.
 *
 * WHY THIS EXISTS. Each suite beside it proves one claim about one tool: the card the tool describes
 * as a host-agnostic `ToolView` draws the exact terminal bytes the imperative `Component` renderer it
 * replaced drew. Proving that means driving two renderers over one matrix of calls, results, failure
 * modes and disclosure states, and the setup for that -- the theme, the ANSI policy, the disclosure
 * vocabularies, and the component-to-lines reduction -- is identical for all of them. It is defined
 * once here rather than copied into every suite, so a change to how the comparison is taken lands in
 * one file and cannot drift between tools.
 *
 * THE ORACLES. `test/oracles/*-main-renderer.ts` are frozen copies of the renderers as they stood on
 * `origin/main` at SHA `e9467ab12c976cd830eb7a61e30bfd6adc4bff1f`. They are the other arm of every
 * comparison. Hand-written expected strings would test the expectation; a frozen oracle tests the
 * equivalence, which is the claim the conversion makes.
 *
 * THE DEFECT CLASS THESE SUITES CLOSE, for every tool that has one:
 *  - Spans losing tone, bold or italic styling during view conversion.
 *  - Status glyphs or emblem icons changing, falling back, or omitting tool titles.
 *  - Result descriptions dropping truncation bounds or tab sanitation.
 *  - Disclosure states failing to reveal full output or an output-path warning.
 *  - Framed-block state reductions mapping to the wrong rail or border.
 *  - Error cards dropping sanitation, or failing outright when details are absent.
 *
 * ONE DIFFERENCE IS SHARED BY SEVERAL SUITES, and is asserted as an exception cell wherever it
 * appears rather than waived here: `main` wrapped an italic span as `italic(fg("muted", text))` and
 * `drawSpan` applies styles inside the colour, `fg("muted", italic(text))`. The two SGR orders draw
 * the same glyphs in the same colours in every standard terminal, and the visible text is identical.
 *
 * WHAT NO SUITE HERE CATCHES. Tool execution: nothing in this directory calls `execute()`, which the
 * per-tool behaviour suites own. Each file states the exceptions and blind spots of its own tool.
 */

import { afterAll, beforeAll } from "bun:test";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import type { AutoresearchToolFactoryOptions } from "@veyyon/coding-agent/autoresearch/types";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionAPI } from "@veyyon/coding-agent/extensibility/extensions";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { type AnsiPolicy, type Component, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import type { FramedBlockView, LineToolView, ToolView, ToolViewContext, ToolViewRenderer } from "@veyyon/view";

/**
 * The full set of tools converted from Component renderers to ToolViews in this PR.
 *
 * Pinned by exact equality in `every-converted-tool-has-a-differential-suite.test.ts`, which also
 * requires a suite file per entry, so a newly converted tool fails there until both exist.
 */
export const CONVERTED_TOOLS = [
	"goal",
	"init_experiment",
	"update_notes",
	"certify_arms",
	"log_experiment",
	"run_experiment",
	"set_cwd",
	"retain",
	"recall",
	"reflect",
	"read_url",
	"resolve",
	"debug",
	"ssh",
	"todo",
	"inspect_image",
	"search_tool_bm25",
	"ast_edit",
	"irc",
	"write",
	"file_search",
	"text_search",
	"structure_search",
	"launch",
	"search",
	"github",
	"browser",
	"read",
	"ask",
	"web_search",
	"vibe_spawn",
	"vibe_send",
	"vibe_wait",
	"vibe_kill",
	"vibe_list",
	"job",
] as const;

export const WIDTH = 80;

/**
 * The two disclosure states, in both vocabularies.
 *
 * A frozen oracle takes the host's `RenderResultOptions`, which carries `isPartial` as well; a view
 * renderer takes the `ToolViewContext`, which is the disclosure state and nothing else. Both are built
 * from the same boolean here so the two sides of every comparison are asked the same question.
 */
export const COLLAPSED = { expanded: false } as const;
export const EXPANDED = { expanded: true } as const;
export const HOST_COLLAPSED: RenderResultOptions = { expanded: false, isPartial: false };
export const HOST_EXPANDED: RenderResultOptions = { expanded: true, isPartial: false };

let entryPolicy: AnsiPolicy | undefined;

/**
 * The state every comparison is taken under: a loaded theme, full ANSI styling, and settings on an
 * in-memory store.
 *
 * Full styling is load-bearing rather than cosmetic. Under a reduced policy `theme.fg` returns its
 * input, so every styling difference between the two arms collapses to the same plain string and the
 * suites pass while proving nothing; `every-converted-tool-has-a-differential-suite.test.ts` asserts
 * the policy took. Settings are initialized because several cards read one -- hyperlink support, for
 * instance -- and an uninitialized singleton would answer from whatever the process last wrote.
 */
export async function setupDifferentialTheme(): Promise<void> {
	await initTheme();
	entryPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
}

export function teardownDifferentialTheme(): void {
	if (entryPolicy !== undefined) setAnsiPolicy(entryPolicy);
	resetSettingsForTest();
}

/** Installs the setup above around the calling suite. */
export function useDifferentialTheme(): void {
	beforeAll(setupDifferentialTheme);
	afterAll(teardownDifferentialTheme);
}

export function lineView(view: ToolView): LineToolView {
	if (view.kind === "framedBlock" || view.kind === "headedBlock" || view.kind === "notice") {
		throw new Error(`expected a one-line view, got ${view.kind}`);
	}
	return view;
}

/**
 * A framed-block view, or a failure.
 *
 * The kind is part of the claim: a converted tool that started returning a row where it returned a
 * panel changed the card, so this throws rather than returning early. An early return would leave the
 * cell green with nothing compared.
 */
export function framedView(view: ToolView): FramedBlockView {
	if (view.kind !== "framedBlock") throw new Error(`expected a framed block, got ${view.kind}`);
	return view;
}

export function trimLines(lines: readonly string[]): string[] {
	return lines.map(line => line.trimEnd());
}

/**
 * A component's drawn lines at one fixed width.
 *
 * Both sides are compared as components rendered at the same width, which is what the card does with
 * either renderer: `main` returned a `Component` and a view goes through `drawToolView`, whose one-line
 * form is the same zero-padded `Text`. Comparing a raw view string against a rendered component would
 * only measure that one side wraps.
 */
export function renderCompLines(comp: Component, width = WIDTH): string[] {
	return trimLines(comp.render(width));
}

export function renderCompText(comp: Component, width = WIDTH): string {
	return trimLines(comp.render(width)).join("\n").trimEnd();
}

/**
 * A tool's two view renderers, resolved once.
 *
 * `ToolViewRenderer` declares both members optional, because a tool may describe only one card. Every
 * tool compared here describes both, so a missing one is a converted tool that stopped drawing rather
 * than a case to branch on: it fails loudly at construction instead of quietly at the first cell.
 */
export function views<Args, Result>(tool: {
	view?: ToolViewRenderer<Args, Result>;
}): {
	call: (args: Args, context: ToolViewContext) => ToolView;
	result: (result: Result, context: ToolViewContext, args?: Args) => ToolView;
} {
	const call = tool.view?.renderCall;
	const result = tool.view?.renderResult;
	if (call === undefined || result === undefined) throw new Error("a converted tool declares no view renderers");
	return { call, result };
}

export function autoresearchOptions(): AutoresearchToolFactoryOptions {
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
