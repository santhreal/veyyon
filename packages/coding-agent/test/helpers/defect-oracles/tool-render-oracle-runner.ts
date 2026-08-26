/**
 * Tool-render oracle scenario runner.
 *
 * Drives a registered tool renderer the way `ToolExecutionComponent` does: `renderCall` with the
 * arguments a call carries, `renderResult` with the result shape a tool returns, then `render(width)`
 * on the component that comes back. The rows it returns are what the frame paints, so they are what
 * the oracles judge.
 *
 * The renderers are read out of `toolRenderers` at run time rather than listed here. The table is the
 * registry, one of its entries is a lazy getter that breaks an import cycle, and a hand-written list
 * of tool names goes stale the day somebody registers the next tool: the sweep sweeps what is
 * registered.
 *
 * The fixtures are hostile on purpose. A tool renderer receives model output and file content, which
 * carry tabs, 400-column lines, absolute home paths, half-written escape sequences and NUL bytes. A
 * renderer that forwards one of those into a cell is the defect class this family exists for, and a
 * fixture of well-formed short strings would find none of them.
 */

import type { Component } from "@veyyon/tui";
import type { RenderResultOptions } from "../../../src/extensibility/custom-tools/types";
import {
	evaluateAllToolRenderOracles,
	plainRowOf,
	type ToolRenderEvaluationResult,
	type ToolRenderOracleFrameState,
	type ToolRenderSnapshot,
	type ToolRenderSurface,
} from "../../../src/modes/components/defect-oracles";
import type { Theme } from "../../../src/modes/theme/theme";
import { toolRenderers } from "../../../src/tools/renderers";

/** The home directory the path fixtures are built from, and the prefix a render must not print. */
export const TOOL_RENDER_FIXTURE_HOME = "/home/oracle-operator";

/**
 * One hostile payload, and the strings a renderer might read it out of.
 *
 * The keys are the argument names the built-in tools use, so a renderer picks up whichever one it
 * knows and ignores the rest: the fixture does not have to model 34 argument schemas to reach the
 * string each renderer decides to paint.
 */
export interface RenderFixture {
	name: string;
	/** What the fixture is trying to smuggle into a cell, for a failure message to name. */
	hostile: string;
	/**
	 * Argument fields the hostile string is placed in. Every field by default.
	 *
	 * The home-path fixture narrows to the path-shaped fields, because an absolute path inside a shell
	 * command or a block of tool output is content a renderer is right to print verbatim, and only a
	 * path argument is the thing `shortenPath` exists for. A fixture that blasted the path into every
	 * field would report a defect for printing a command exactly as it was run.
	 */
	keys?: readonly string[];
	/** Whether the result content carries the hostile string. True by default. */
	inResultText?: boolean;
	/** Extra argument fields beyond the hostile string, for renderers that need a shape. */
	extra?: Record<string, unknown>;
}

const ARG_KEYS = [
	"command",
	"path",
	"paths",
	"file_path",
	"pattern",
	"query",
	"content",
	"text",
	"message",
	"description",
	"prompt",
	"code",
	"url",
	"name",
	"label",
	"i",
] as const;

/** Fields that name a file, which is the only place a home prefix should have become `~`. */
const PATH_KEYS = ["path", "paths", "file_path"] as const;

/**
 * Control sequences the injection fixture smuggles in, and the ones a row must not carry.
 *
 * A screen clear and a window-title set: both are executed by the terminal rather than painted, and
 * neither is a sequence any renderer here has a reason to emit, so a row that carries one forwarded
 * it from the content.
 */
export const INJECTED_SEQUENCES = ["\x1b[2J", "\x1b]0;renamed\x07"] as const;

export const RENDER_FIXTURES: readonly RenderFixture[] = [
	{ name: "tabs", hostile: "src\tindex.ts\tchanged\ttwice" },
	{
		name: "long line",
		hostile: `${"the quick brown fox jumps over the lazy dog ".repeat(12)}end`,
	},
	{ name: "wide glyphs", hostile: "漢字テスト".repeat(40) },
	{
		name: "home path",
		hostile: `${TOOL_RENDER_FIXTURE_HOME}/projects/veyyon/packages/coding-agent/src/index.ts`,
		keys: PATH_KEYS,
		inResultText: false,
	},
	{ name: "escape injection", hostile: `before${INJECTED_SEQUENCES.join("")}after` },
	{ name: "control bytes", hostile: "before\x00middle\x07after\bend\vtail\fdone" },
	{ name: "embedded newline", hostile: "first line\nsecond line\r\nthird line" },
	{ name: "empty", hostile: "" },
];

/**
 * Argument object a fixture is fed to a renderer as.
 *
 * Every field carries the same hostile string. A renderer reads the one or two it knows; the rest are
 * inert. `extra` is merged last so a fixture can supply a shape a renderer needs before it paints.
 */
function argsFor(fixture: RenderFixture): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	const keys = fixture.keys ?? ARG_KEYS;
	for (const key of keys) args[key] = key === "paths" ? [fixture.hostile] : fixture.hostile;
	return { ...args, ...fixture.extra };
}

function resultFor(
	fixture: RenderFixture,
	isError: boolean,
): {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
} {
	const text = fixture.inResultText === false ? "tool output with nothing hostile in it" : fixture.hostile;
	return { content: [{ type: "text", text }], isError };
}

/**
 * Whether a render transmits an image rather than text.
 *
 * A Kitty graphics APC (`ESC _ G`) or an iTerm OSC 1337 carries base64 image bytes, which survive
 * escape stripping as arbitrary characters. Such a render is excluded from every guarantee rather
 * than judged by one.
 */
function carriesBinaryPayload(rawRows: readonly string[]): boolean {
	return rawRows.some(row => row.includes("\x1b_G") || row.includes("\x1b]1337;"));
}

/** What one renderer did with one fixture, or the error it threw instead of rendering. */
export interface RenderAttempt {
	tool: string;
	surface: ToolRenderSurface;
	fixture: string;
	width: number;
	snapshot: ToolRenderSnapshot | null;
	/** The error a renderer threw instead of returning rows. A pending call crashes the frame on one. */
	error: Error | null;
}

function attempt(
	tool: string,
	surface: ToolRenderSurface,
	fixture: RenderFixture,
	width: number,
	produce: () => Component,
): RenderAttempt {
	try {
		const rawRows = [...produce().render(width)];
		const plainRows = rawRows.map(plainRowOf);
		return {
			tool,
			surface,
			fixture: fixture.name,
			width,
			snapshot: {
				tool,
				surface,
				fixture: fixture.name,
				width,
				rawRows,
				plainRows,
				carriesBinaryPayload: carriesBinaryPayload(rawRows),
			},
			error: null,
		};
	} catch (error) {
		return {
			tool,
			surface,
			fixture: fixture.name,
			width,
			snapshot: null,
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
}

export interface ToolRenderSweepOptions {
	theme: Theme;
	widths: readonly number[];
	fixtures?: readonly RenderFixture[];
	/** Restrict the sweep to these tool names. Defaults to every registered renderer. */
	tools?: readonly string[];
	options?: RenderResultOptions;
}

/**
 * Drive every registered renderer over every fixture at every width.
 *
 * Both surfaces of a renderer are driven for each fixture: a defect in the pending-call preview and a
 * defect in the result card are different code, and the streaming preview is the path that receives
 * half-parsed arguments.
 */
export function sweepToolRenders(sweep: ToolRenderSweepOptions): readonly RenderAttempt[] {
	const fixtures = sweep.fixtures ?? RENDER_FIXTURES;
	const names = sweep.tools ?? Object.keys(toolRenderers);
	const renderOptions = sweep.options ?? { expanded: false, isPartial: false };
	const attempts: RenderAttempt[] = [];

	for (const tool of names) {
		const renderer = toolRenderers[tool];
		if (!renderer) throw new Error(`no renderer registered for ${tool}`);
		for (const fixture of fixtures) {
			for (const width of sweep.widths) {
				const args = argsFor(fixture);
				attempts.push(
					attempt(tool, "call", fixture, width, () => renderer.renderCall(args, renderOptions, sweep.theme)),
				);
				attempts.push(
					attempt(tool, "result", fixture, width, () =>
						renderer.renderResult(resultFor(fixture, false), renderOptions, sweep.theme, args),
					),
				);
			}
		}
	}

	return attempts;
}

/** Judge one or more renders: the frame state and the evaluation in one step. */
export function evaluateToolRenderAttempts(attempts: readonly RenderAttempt[]): ToolRenderEvaluationResult {
	return evaluateAllToolRenderOracles(frameStateFor(attempts));
}

/** Collect the renders that produced rows into one frame state for the oracles to judge. */
export function frameStateFor(attempts: readonly RenderAttempt[]): ToolRenderOracleFrameState {
	return {
		homeDir: TOOL_RENDER_FIXTURE_HOME,
		forbiddenSequences: INJECTED_SEQUENCES,
		renders: attempts
			.map(entry => entry.snapshot)
			.filter((snapshot): snapshot is ToolRenderSnapshot => snapshot !== null),
	};
}
