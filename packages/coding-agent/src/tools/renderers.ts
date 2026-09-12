/**
 * Terminal adapters for the canonical tool view definitions.
 * Shared definitions retain one adapter identity across provider aliases.
 */
import type { Component } from "@veyyon/tui";
import type { ToolViewRenderer } from "@veyyon/view";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { viewToolRenderer } from "../modes/terminal/draw/draw-tool-view";
import type { Theme } from "../theme/theme";
import { type ToolViewDefinition, toolViewDefinitions } from "./view-registry";

export * from "./view-registry";

export type ToolRenderer = Omit<ToolViewDefinition, "view"> & {
	renderCall: (args: unknown, options: RenderResultOptions, theme: Theme) => Component;
	renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: RenderResultOptions & { renderContext?: Record<string, unknown> },
		theme: Theme,
		args?: unknown,
	) => Component;
	/**
	 * The host-agnostic card this entry draws, present only on an entry built by `viewToolRenderer`.
	 *
	 * An entry either DESCRIBES its card as a {@link ToolViewRenderer} and lets a host draw it, or
	 * draws terminal components itself. Both look the same from the two members above, so the
	 * distinction is stated here rather than inferred, and the architecture gate that records every
	 * card still drawn in terminal components resolves the split from the registry instead of from a
	 * list kept by hand.
	 */
	view?: ToolViewRenderer<never, never>;
};

export const toolRenderers: Record<string, ToolRenderer> = {};
{
	const adapters = new Map<ToolViewDefinition, ToolRenderer>();
	for (const name of Object.keys(toolViewDefinitions)) {
		const definition = toolViewDefinitions[name];
		let renderer = adapters.get(definition);
		if (renderer === undefined) {
			renderer = viewToolRenderer(definition.view, definition) as ToolRenderer;
			adapters.set(definition, renderer);
		}
		toolRenderers[name] = renderer;
	}
}
