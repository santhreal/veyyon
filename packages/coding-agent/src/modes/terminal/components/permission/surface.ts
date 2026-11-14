/**
 * The terminal's permission surface: what a tool approval prompt draws and where it mounts.
 *
 * The approval policy asks through `select` and reads the answer back as one of the select
 * options' labels. A prompt that carries an {@link ApprovalCard} is routed here instead of the
 * generic selector, so the surface can draw the call itself (command, target, reasons) and
 * still settle with the same label strings.
 */
import type { Component, OverlayOptions, TUI } from "@veyyon/tui";
import type { ApprovalCard, ExtensionUISelectItem } from "../../../../extensibility/extensions";
import { HookSelectorComponent } from "../selectors/hook-selector";

/** Where a permission surface is mounted. */
export type PermissionPlacement =
	/** An overlay card, positioned by the options. */
	| { kind: "overlay"; options: OverlayOptions }
	/** In place of the composer, under the transcript. */
	| { kind: "composer" };

export interface PermissionSurface {
	component: Component & { dispose?(): void };
	placement: PermissionPlacement;
}

export interface PermissionSurfaceContext {
	tui: TUI;
	/** The plain-text card the select would show as its title. */
	title: string;
	/** The select options the policy offered, in order. */
	options: readonly ExtensionUISelectItem[];
	/** Settle with the chosen option's label, or `undefined` to cancel (which the policy denies). */
	settle(label: string | undefined): void;
	requestRender(): void;
}

export function createPermissionSurface(_card: ApprovalCard, ctx: PermissionSurfaceContext): PermissionSurface {
	const selector = new HookSelectorComponent(
		ctx.title,
		[...ctx.options],
		option => ctx.settle(option),
		() => ctx.settle(undefined),
		{ selectionMarker: "radio", tui: ctx.tui, onRequestRender: ctx.requestRender },
	);
	return {
		component: selector,
		placement: {
			kind: "overlay",
			options: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true },
		},
	};
}
