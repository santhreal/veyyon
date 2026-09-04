/**
 * The widget vocabulary every host shares.
 *
 * A widget is a small block of text a plugin parks near the input area. Every
 * host can draw that: the terminal mounts it above or below the editor, RPC
 * forwards the same key, lines and placement over the wire, and a GUI can dock
 * it wherever it keeps its composer.
 *
 * These types sit here rather than in `terminal-capability.ts` because nothing
 * about them is terminal-only, and rather than in `extensions/types.ts` because
 * the terminal capability needs them too. Declaring them in either of those
 * would make one import the other for a reason neither is about.
 */

/** Where a widget sits relative to the input editor. */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

export interface ExtensionWidgetOptions {
	placement?: WidgetPlacement;
}

/**
 * Widget content every host can draw. A component widget is a terminal
 * capability and goes through `ui.terminal.setWidgetComponent` instead.
 */
export type ExtensionWidgetContent = string[] | undefined;
