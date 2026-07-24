/**
 * `veyyon gallery` — render every built-in tool's renderer across its lifecycle.
 *
 * For each tool with a registered renderer, the gallery drives a real
 * {@link ToolExecutionComponent} through four states — streaming arguments,
 * arguments complete (in progress), success, and failure — and prints the
 * rendered output to stdout. It exists for visual QA of tool renderers without
 * having to provoke each state through a live agent session.
 */
import * as path from "node:path";
import type { AgentTool } from "@veyyon/agent-core";
import type { TUI } from "@veyyon/tui";
import { clampLow, errorMessage, getProjectDir } from "@veyyon/utils";
import chalk from "chalk";
import { Settings } from "../config/settings";
import { ToolExecutionComponent } from "../modes/components/tool-execution";
import { getAvailableThemes, initTheme, setTheme, theme } from "../modes/theme/theme";
import { toolRenderers } from "../tools/renderers";
import { type GalleryFixture, type GalleryResult, galleryFixtures } from "./gallery-fixtures";
import { captureGalleryScreenshots } from "./gallery-screenshot";

/** Lifecycle states the gallery renders, in display order. */
export const GALLERY_STATES = ["streaming", "progress", "success", "error"] as const;
export type GalleryState = (typeof GALLERY_STATES)[number];

/** User-facing labels printed above each rendered lifecycle state. */
export const GALLERY_STATE_LABELS: Record<GalleryState, string> = {
	streaming: "streaming args",
	progress: "in progress",
	success: "done",
	error: "failed",
};

const GALLERY_STATE_ALIASES: Record<string, GalleryState> = {
	streaming: "streaming",
	"streaming args": "streaming",
	progress: "progress",
	"in progress": "progress",
	success: "success",
	done: "success",
	error: "error",
	failed: "error",
};

/** Accepted `--state` tokens, including legacy lifecycle names and displayed labels. */
export const GALLERY_STATE_TOKENS = Object.keys(GALLERY_STATE_ALIASES);

/** Normalize user-provided `--state` tokens to the internal gallery lifecycle states. */
export function parseGalleryStates(states: readonly string[] | undefined): GalleryState[] | undefined {
	if (!states || states.length === 0) return undefined;
	const parsed: GalleryState[] = [];
	for (const raw of states) {
		const state = GALLERY_STATE_ALIASES[raw.trim().toLowerCase()];
		if (!state) {
			throw new Error(`Invalid --state '${raw}'. Valid values: ${GALLERY_STATE_TOKENS.join(", ")}`);
		}
		if (!parsed.includes(state)) parsed.push(state);
	}
	return parsed;
}

export interface GalleryCommandArgs {
	/** Render width in columns (defaults to terminal width, clamped). */
	width?: number;
	/** Restrict to a single tool name. */
	tool?: string;
	/**
	 * Render in the named theme(s) instead of the profile's active theme. Each
	 * theme produces its own output (suffixed `-<theme>`), so one invocation
	 * covers a whole theme matrix. An unknown name fails loudly rather than
	 * falling back to the active theme. Does not mutate the profile's stored
	 * theme: the theme is applied in-memory for the render pass only.
	 */
	themes?: string[];
	/** Restrict to specific lifecycle states. */
	states?: GalleryState[];
	/** Render the expanded variant of each renderer. */
	expanded?: boolean;
	/** Strip ANSI styling from the output (useful when redirecting to a file). */
	plain?: boolean;
	/** Capture the rendered gallery as PNG screenshot(s) via VHS instead of printing ANSI. */
	screenshot?: boolean;
	/** Screenshot output path (single image) or base path (suffixed when split across images). */
	out?: string;
	/** Font family for screenshots (must be installed; Nerd Font recommended for icon glyphs). */
	font?: string;
	/** Font size in points for screenshots. */
	fontSize?: number;
}

/** One tool's rendered lifecycle, as ANSI lines: a leading blank, the section rule, then each state. */
export interface GallerySection {
	heading: string;
	lines: string[];
}

const GENERIC_ERROR: GalleryResult = {
	content: [{ type: "text", text: "Error: operation failed" }],
	isError: true,
};

/**
 * Build the fake `AgentTool` the component needs for its label, edit mode, and —
 * for `customRendered` fixtures — the renderer functions that route it through
 * the same custom-tool branch production uses (see {@link GalleryFixture}).
 */
function fakeToolFor(name: string, fixture: GalleryFixture | undefined): AgentTool | undefined {
	if (!fixture?.label && !fixture?.editMode && !fixture?.customRendered) return undefined;
	const tool: Record<string, unknown> = { name, label: fixture.label ?? name, mode: fixture.editMode };
	if (fixture.customRendered) {
		const renderer = toolRenderers[fixture.renderer ?? name] as
			| { renderCall?: unknown; renderResult?: unknown; mergeCallAndResult?: unknown; inline?: unknown }
			| undefined;
		if (renderer) {
			tool.renderCall = renderer.renderCall;
			tool.renderResult = renderer.renderResult;
			tool.mergeCallAndResult = renderer.mergeCallAndResult;
			tool.inline = renderer.inline;
		}
	}
	return tool as unknown as AgentTool;
}

/** The curated fixture for a tool, or a generic one for registry tools lacking sample data. */
export function resolveFixture(name: string): GalleryFixture {
	return (
		galleryFixtures[name] ??
		({
			args: { note: `sample ${name} call` },
			result: { content: [{ type: "text", text: `${name} completed` }] },
		} satisfies GalleryFixture)
	);
}

/**
 * Render a single tool/state pair to lines. Builds a fresh component, drives it
 * to the requested state, settles any async edit preview, then snapshots the
 * render and stops all animation timers.
 */
export async function renderGalleryState(
	name: string,
	fixture: GalleryFixture,
	state: GalleryState,
	width: number,
	expanded = false,
): Promise<readonly string[]> {
	if (fixture.renderState) {
		return await fixture.renderState(state, width, expanded);
	}

	// A non-customRendered fixture may borrow another tool's built-in renderer
	// (e.g. `edit_delete` → `edit`): drive the component under that real tool
	// name so the sample exercises the exact production branch, not the
	// custom-tool one (which tints/pads non-framed result rows).
	const componentName = fixture.customRendered ? name : (fixture.renderer ?? name);
	const tool = fakeToolFor(componentName, fixture);
	const streamingArgs = state === "streaming" ? (fixture.streamingArgs ?? fixture.args) : fixture.args;
	// The component only calls `requestRender`/`requestComponentRender` (via
	// its loader) during a static render; `imageBudget` is consulted solely
	// when images render, which the gallery disables. A cast avoids
	// constructing a real terminal.
	const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
	const component = new ToolExecutionComponent(
		componentName,
		streamingArgs,
		{ showImages: false },
		tool,
		ui,
		getProjectDir(),
	);
	component.setExpanded(expanded);

	if (state !== "streaming") {
		component.setArgsComplete();
	}
	if (state === "success") {
		component.updateResult(fixture.result, false);
	} else if (state === "error") {
		component.updateResult(fixture.errorResult ?? GENERIC_ERROR, false);
	}

	// Edit-like renderers compute their diff preview off the render path; wait
	// for it to settle so the snapshot is deterministic instead of racing a tick.
	await component.whenPreviewSettled();

	const lines = component.render(width);
	component.stopAnimation();
	return lines;
}

function resolveWidth(requested: number | undefined): number {
	const fallback = process.stdout.columns ?? 100;
	const width = requested ?? fallback;
	return clampLow(width, 40, 200);
}

function sectionRule(label: string, width: number): string {
	const prefix = `── ${label} `;
	const fill = Math.max(0, width - prefix.length);
	return theme.fg("accent", theme.bold(`${prefix}${"─".repeat(fill)}`));
}

/**
 * Render each requested tool's lifecycle into ANSI section blocks. The block
 * layout (leading blank, section rule, then a blank + dim label + body per
 * state) is shared by the stdout and screenshot paths so both stay identical.
 */
async function renderGallerySections(
	names: string[],
	states: GalleryState[],
	width: number,
	expanded: boolean,
): Promise<GallerySection[]> {
	const sections: GallerySection[] = [];
	for (const name of names) {
		const fixture = resolveFixture(name);
		const heading = fixture.label && fixture.label !== name ? `${name} — ${fixture.label}` : name;
		const lines: string[] = ["", sectionRule(heading, width)];
		for (const state of states) {
			lines.push("", theme.fg("dim", `  · ${GALLERY_STATE_LABELS[state]}`));
			try {
				for (const line of await renderGalleryState(name, fixture, state, width, expanded)) lines.push(line);
			} catch (err) {
				lines.push(theme.fg("error", `  render failed: ${String(err)}`));
			}
		}
		sections.push({ heading, lines });
	}
	return sections;
}

/** One theme's fully-rendered gallery sections, tagged with the theme name. */
export interface ThemedGallery {
	theme: string;
	sections: GallerySection[];
}

/**
 * Render the gallery once per requested theme. Every name is validated against
 * the available theme set BEFORE any rendering, so an unknown theme fails the
 * whole invocation loudly (Law 10: no silent fallback to the active theme) with
 * a message naming the offending theme and the known set. Each theme is applied
 * in-memory via {@link setTheme} for its render pass only; the caller's profile
 * theme is never written. Duplicate names in `themes` are rendered once each in
 * the order given, which is intentional (a caller may want the same theme twice
 * with different downstream output paths).
 */
export async function renderGalleryForThemes(
	themes: readonly string[],
	names: string[],
	states: GalleryState[],
	width: number,
	expanded: boolean,
): Promise<ThemedGallery[]> {
	const available = new Set(await getAvailableThemes());
	const unknown = themes.filter(name => !available.has(name));
	if (unknown.length > 0) {
		const known = [...available].sort().join(", ");
		throw new Error(`Unknown theme '${unknown[0]}'. Known themes: ${known}`);
	}
	const rendered: ThemedGallery[] = [];
	for (const name of themes) {
		await setTheme(name);
		rendered.push({ theme: name, sections: await renderGallerySections(names, states, width, expanded) });
	}
	return rendered;
}

/**
 * Insert a `-<theme>` tag before the extension of a screenshot output path so a
 * theme matrix writes distinct files: `shot.png` + theme `light` → `shot-light.png`,
 * and a path with no extension simply appends (`shot` → `shot-light`). The theme
 * name is slugified (non-alphanumerics to `-`) so a custom theme name can never
 * inject a path separator or an unexpected extension boundary.
 */
export function themedOutPath(out: string, themeName: string): string {
	const slug = themeName.replace(/[^A-Za-z0-9._-]+/g, "-");
	const ext = path.extname(out);
	if (ext === "") return `${out}-${slug}`;
	return `${out.slice(0, -ext.length)}-${slug}${ext}`;
}

/**
 * Render the gallery. Iterates the renderer registry (or a single tool),
 * printing each requested lifecycle state under a labeled section — or, with
 * `screenshot`, capturing the rendered output as PNG(s) via VHS.
 */
export async function runGalleryCommand(args: GalleryCommandArgs): Promise<void> {
	const settingsInstance = await Settings.init();
	// Screenshots must carry exact theme RGB regardless of how the invoking
	// terminal advertises its color support, so force truecolor before the theme
	// (and therefore every SGR escape it emits) is built.
	if (args.screenshot) process.env.COLORTERM = "truecolor";
	await initTheme(
		false,
		settingsInstance.get("symbolPreset"),
		settingsInstance.get("colorBlindMode"),
		settingsInstance.get("theme.dark"),
		settingsInstance.get("theme.light"),
	);

	const width = resolveWidth(args.width);
	const expanded = args.expanded ?? false;
	const states = args.states && args.states.length > 0 ? args.states : [...GALLERY_STATES];

	// Renderer-registry tools plus fixture-only tools (no dedicated renderer,
	// e.g. `report_tool_issue` / custom extension tools) so the gallery covers
	// the generic fallback + custom-tool branches too.
	const allNames = Array.from(new Set([...Object.keys(toolRenderers), ...Object.keys(galleryFixtures)])).sort();
	const names = args.tool ? allNames.filter(name => name === args.tool) : allNames;
	if (args.tool && names.length === 0) {
		process.stderr.write(`Unknown tool '${args.tool}'. Known tools: ${allNames.join(", ")}\n`);
		process.exitCode = 1;
		return;
	}

	const plain = args.plain || chalk.level === 0;

	// Theme-matrix path: render (and capture/print) once per named theme, each to
	// its own suffixed output. Unknown names fail the whole run before any output.
	if (args.themes && args.themes.length > 0) {
		let rendered: ThemedGallery[];
		try {
			rendered = await renderGalleryForThemes(args.themes, names, states, width, expanded);
		} catch (err) {
			process.stderr.write(`${errorMessage(err)}\n`);
			process.exitCode = 1;
			return;
		}
		for (const { theme: themeName, sections } of rendered) {
			if (args.screenshot) {
				const paths = await captureGalleryScreenshots(sections, {
					width,
					font: args.font,
					fontSize: args.fontSize,
					out: args.out ? themedOutPath(args.out, themeName) : undefined,
				});
				process.stdout.write(`${paths.join("\n")}\n`);
			} else {
				const lines = [`# theme: ${themeName}`, ...sections.flatMap(section => section.lines), ""];
				process.stdout.write(`${lines.map(line => (plain ? Bun.stripANSI(line) : line)).join("\n")}\n`);
			}
		}
		return;
	}

	const sections = await renderGallerySections(names, states, width, expanded);

	if (args.screenshot) {
		const paths = await captureGalleryScreenshots(sections, {
			width,
			font: args.font,
			fontSize: args.fontSize,
			out: args.out,
		});
		process.stdout.write(`${paths.join("\n")}\n`);
		return;
	}

	const lines = sections.flatMap(section => section.lines);
	lines.push("");
	// --plain forces it, but a piped/redirected stdout (chalk detects non-TTY
	// and NO_COLOR) also degrades to plain text instead of escape soup.
	const text = lines.map(line => (plain ? Bun.stripANSI(line) : line)).join("\n");
	process.stdout.write(`${text}\n`);
}
