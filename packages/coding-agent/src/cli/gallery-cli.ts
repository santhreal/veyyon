import type { AgentTool } from "@veyyon/agent-core";
import type { TUI } from "@veyyon/tui";
import { clampLow, errorMessage, getProjectDir } from "@veyyon/utils";
import chalk from "chalk";
import { Settings } from "../config/settings";
import { ToolExecutionComponent } from "../modes/components/tool-execution";
import { getAvailableThemes, initTheme, setTheme, theme } from "../modes/theme/theme";
import { toolRenderers } from "../tools/renderers";
import { EXIT_USAGE } from "./exit-codes";
import { type GalleryFixture, type GalleryResult, galleryFixtures } from "./gallery-fixtures";

export const GALLERY_STATES = ["streaming", "progress", "success", "error"] as const;
export type GalleryState = (typeof GALLERY_STATES)[number];

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

export const GALLERY_STATE_TOKENS = Object.keys(GALLERY_STATE_ALIASES);

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
	width?: number;
	tool?: string;
	themes?: string[];
	states?: GalleryState[];
	expanded?: boolean;
	plain?: boolean;
}

export interface GallerySection {
	heading: string;
	lines: string[];
}

const GENERIC_ERROR: GalleryResult = {
	content: [{ type: "text", text: "Error: operation failed" }],
	isError: true,
};

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

export function resolveFixture(name: string): GalleryFixture {
	return (
		galleryFixtures[name] ??
		({
			args: { note: `sample ${name} call` },
			result: { content: [{ type: "text", text: `${name} completed` }] },
		} satisfies GalleryFixture)
	);
}

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

	const componentName = fixture.customRendered ? name : (fixture.renderer ?? name);
	const tool = fakeToolFor(componentName, fixture);
	const streamingArgs = state === "streaming" ? (fixture.streamingArgs ?? fixture.args) : fixture.args;
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

	await component.whenPreviewSettled();

	if (state === "success" || state === "error") component.stopAnimation();

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
				lines.push(theme.fg("error", `  render failed: ${errorMessage(err)}`));
			}
		}
		sections.push({ heading, lines });
	}
	return sections;
}

export interface ThemedGallery {
	theme: string;
	sections: GallerySection[];
}

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
		const known = Array.from(available).sort().join(", ");
		throw new Error(`Unknown theme '${unknown[0]}'. Known themes: ${known}`);
	}
	const rendered: ThemedGallery[] = [];
	for (const name of themes) {
		await setTheme(name);
		rendered.push({ theme: name, sections: await renderGallerySections(names, states, width, expanded) });
	}
	return rendered;
}

export async function runGalleryCommand(args: GalleryCommandArgs): Promise<void> {
	const settingsInstance = await Settings.init();
	await initTheme(
		false,
		settingsInstance.get("symbolPreset"),
		settingsInstance.get("colorBlindMode"),
		settingsInstance.get("theme.dark"),
		settingsInstance.get("theme.light"),
	);

	const width = resolveWidth(args.width);
	const expanded = args.expanded ?? false;
	const states = args.states && args.states.length > 0 ? args.states : GALLERY_STATES.slice();

	const allNames = Array.from(new Set(Object.keys(toolRenderers).concat(Object.keys(galleryFixtures)))).sort();
	const names = args.tool ? allNames.filter(name => name === args.tool) : allNames;
	if (args.tool && names.length === 0) {
		process.stderr.write(`Unknown tool '${args.tool}'. Known tools: ${allNames.join(", ")}\n`);
		process.exitCode = EXIT_USAGE;
		return;
	}

	const plain = args.plain || chalk.level === 0;

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
			const lines = [`# theme: ${themeName}`, ...sections.flatMap(section => section.lines), ""];
			process.stdout.write(`${lines.map(line => (plain ? Bun.stripANSI(line) : line)).join("\n")}\n`);
		}
		return;
	}

	const sections = await renderGallerySections(names, states, width, expanded);

	const lines = sections.flatMap(section => section.lines);
	lines.push("");
	const text = lines.map(line => (plain ? Bun.stripANSI(line) : line)).join("\n");
	process.stdout.write(`${text}\n`);
}
