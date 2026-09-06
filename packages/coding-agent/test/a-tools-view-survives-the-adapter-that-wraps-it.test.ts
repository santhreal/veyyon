/**
 * A tool's `view` survives the adapter that wraps it, and an adapter invents none.
 *
 * WHY THIS SUITE EXISTS. Both authoring APIs let a tool describe its cards as a `ToolView` --
 * `ToolDefinition.view` for an extension, `CustomTool.view` for a tool under `src/` -- and neither
 * reaches a host directly: `RegisteredToolAdapter` and `CustomToolAdapter` wrap it into an
 * `AgentTool` first. A `view` the adapter drops is a card no host draws, and the tool falls back to
 * the generic one; a `view` the adapter invents is a card with nothing in it. Neither adapter can
 * lean on `applyToolProxy` for this member, because a field declared on the wrapper is a key the
 * proxy skips, so each forwarding is written out and each is asserted here through the predicate a
 * host actually reads.
 *
 * THE DEFECT CLASS THIS CLOSES. A registered or custom tool adapter, including the custom-tool
 * definition conversion, that drops a declared call or result view or invents one for a tool
 * without a view. Additional authoring routes require an entry in ADAPTERS.
 *
 * WHAT IT DOES NOT CATCH. Nothing here draws anything: that a forwarded view describes the card
 * correctly is what `test/differential/` proves per tool. It also says nothing about which renderer
 * a host prefers when a tool declares both -- `a-converted-tools-card-obeys-the-policy-…` owns that.
 */

import { describe, expect, it } from "bun:test";
import type { CustomTool } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import { CustomToolAdapter } from "@veyyon/coding-agent/extensibility/custom-tools/wrapper";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import type { RegisteredTool, ToolDefinition } from "@veyyon/coding-agent/extensibility/extensions/types";
import { RegisteredToolAdapter } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import { toolDrawsItself } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { customToolToDefinition } from "@veyyon/coding-agent/session/factory-tools";
import { Type } from "@veyyon/kernel/registry/typebox";
import type { ToolView, ToolViewRenderer } from "@veyyon/view";

const PARAMETERS = Type.Object({ input: Type.String() });
const OK = { content: [{ type: "text" as const, text: "ok" }] };

/** The view a tool declares, recognizable by identity so a copy is not mistaken for a forward. */
const VIEW: Required<ToolViewRenderer<{ input: string }, typeof OK>> = {
	renderCall: (): ToolView => ({ kind: "statusRow", status: "pending", title: "Wrapped" }),
	renderResult: (): ToolView => ({ kind: "statusRow", status: "success", title: "Wrapped" }),
};

/**
 * What a host reads off a wrapped tool. `CustomToolAdapter` carries no declared `view` member --
 * `applyToolProxy` answers it from the wrapped tool -- so the member is named here rather than read
 * off either adapter's type, and the assertions below are about the value a host receives.
 */
type ViewBearer = { view?: ToolViewRenderer<{ input: string }, typeof OK> };

/** A stand-in runner: the adapter only calls it when a wrapped tool executes, which nothing here does. */
const RUNNER = { createContext: () => ({}) } as unknown as ExtensionRunner;

function extensionTool(view?: ToolViewRenderer<{ input: string }, typeof OK>): ViewBearer {
	const definition = {
		name: "wrapped",
		description: "d",
		parameters: PARAMETERS,
		execute: async () => OK,
		...(view === undefined ? {} : { view }),
	} as unknown as ToolDefinition;
	return new RegisteredToolAdapter(
		{ definition, extensionPath: "fixture-extension.ts" } satisfies RegisteredTool,
		RUNNER,
	) as ViewBearer;
}

function customTool(view?: ToolViewRenderer<{ input: string }, typeof OK>): ViewBearer {
	const tool = {
		name: "wrapped",
		description: "d",
		parameters: PARAMETERS,
		execute: async () => OK,
		...(view === undefined ? {} : { view }),
	} as unknown as CustomTool<typeof PARAMETERS, unknown>;
	return new CustomToolAdapter(tool, () => ({}) as never) as unknown as ViewBearer;
}

function convertedCustomTool(view?: ToolViewRenderer<{ input: string }, typeof OK>): ViewBearer {
	const tool = {
		name: "wrapped",
		description: "d",
		parameters: PARAMETERS,
		execute: async () => OK,
		...(view === undefined ? {} : { view }),
	} as unknown as CustomTool;
	return new RegisteredToolAdapter(
		{ definition: customToolToDefinition(tool), extensionPath: "fixture-extension.ts" } satisfies RegisteredTool,
		RUNNER,
	) as ViewBearer;
}

/** Direct extension registration, direct custom adaptation, and custom-tool conversion. */
const ADAPTERS = [
	["an extension tool", extensionTool],
	["a custom tool", customTool],
	["a custom tool converted to an extension", convertedCustomTool],
] as const;
const VIEW_SHAPES: readonly [string, ToolViewRenderer<{ input: string }, typeof OK>][] = [
	["call only", { renderCall: VIEW.renderCall }],
	["result only", { renderResult: VIEW.renderResult }],
	["call and result", VIEW],
];

describe("a tool's view survives the adapter that wraps it", () => {
	for (const [label, wrap] of ADAPTERS) {
		for (const [shape, view] of VIEW_SHAPES) {
			it(`draws the declared ${shape} view through ${label}`, () => {
				const wrapped = wrap(view);
				expect(toolDrawsItself(wrapped)).toBe(true);
				const context = { expanded: false };
				expect(wrapped.view?.renderCall?.({ input: "input" }, context)).toEqual(
					view.renderCall?.({ input: "input" }, context),
				);
				expect(wrapped.view?.renderResult?.(OK, context)).toEqual(view.renderResult?.(OK, context));
			});
		}

		it(`reports no card of its own when ${label} describes none`, () => {
			const wrapped = wrap();
			expect(wrapped.view).toBeUndefined();
			// The predicate a host reads, so a wrapper that declares the member and answers undefined is
			// still a tool that falls back to the generic card rather than drawing an empty one.
			expect(toolDrawsItself(wrapped)).toBe(false);
		});
	}
});
