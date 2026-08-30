/**
 * Screen takeover: the part of the extension and hook UI surface that only a
 * terminal host can offer.
 *
 * The rest of the published contract is host-agnostic by construction. A
 * renderer returns {@link HostView}, which is covariant, so widening it broke
 * nobody. These members are the opposite case: they hand the caller a live
 * `TUI`, an `EditorTheme` and a `KeybindingsManager` and let it draw its own
 * component and own the keyboard until it finishes. Parameter position is
 * contravariant, so there is no widening that keeps existing callers working,
 * and a host that is not a terminal has nothing to pass.
 *
 * So they are not widened, they are moved. A host reports the capability it
 * has; `ExtensionUIContext.terminal` and `HookUIContext.terminal` are optional
 * and a headless host simply omits them. That is already what headless hosts
 * were doing by hand: RPC mode declared `setEditorComponent()` with an empty
 * body and a comment saying it requires TUI access, because the flat interface
 * gave it no way to say "I cannot do this".
 *
 * `setHeader` and `setFooter` are not here, because the move exposed them as
 * dead. Every one of the six hosts implemented both as `() => {}` — interactive
 * mode included — so the contract published two members no host had ever drawn
 * anything from. They are removed rather than carried across.
 */
import type { ExtensionWidgetContent, ExtensionWidgetOptions } from "@veyyon/kernel/registry/widget";
import type { Component, EditorTheme, TUI } from "@veyyon/tui";
import type { KeybindingsManager } from "../config/keybindings";
import type { CustomEditor } from "../modes/terminal/components/composer/custom-editor";
import type { Theme } from "../theme/theme";

/** A terminal component a plugin hands back for the host to mount and later dispose. */
export type ExtensionUiComponent = Component & { dispose?(): void };

/** Builds an {@link ExtensionUiComponent} against the host's live terminal and theme. */
export type ExtensionUiComponentFactory = (tui: TUI, theme: Theme) => ExtensionUiComponent;

/**
 * What a terminal host can hold in a widget slot: the text lines any host can
 * draw, or a component only this one can. The published contract splits these
 * across `setWidget` and `setWidgetComponent`; the terminal stores both in one
 * slot, so it needs the union.
 */
export type TerminalWidgetContent = ExtensionWidgetContent | ExtensionUiComponentFactory;

/**
 * The screen takeover a hook may perform: draw one component, hold focus, and
 * resolve when it calls `done`.
 */
export interface HookTerminalCapability {
	/**
	 * Show a custom component with keyboard focus.
	 *
	 * The factory receives the TUI, the theme, and a `done()` callback that
	 * closes the component and resolves the promise. It may be async so a
	 * fire-and-forget component can start work without the host awaiting it.
	 *
	 * @example
	 * const result = await ctx.ui.terminal?.custom((tui, theme, done) => {
	 *   const component = new MyComponent(tui, theme);
	 *   component.onFinish = value => done(value);
	 *   return component;
	 * });
	 */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			done: (result: T) => void,
		) => ExtensionUiComponent | Promise<ExtensionUiComponent>,
	): Promise<T>;
}

/**
 * Everything a terminal host lets an extension take over: the hook capability
 * plus the chrome an extension may replace outright.
 */
export interface ExtensionTerminalCapability {
	/**
	 * Show a custom component with keyboard focus. Unlike the hook form, the
	 * factory also receives the keybindings manager, and the component may be
	 * drawn as an overlay rather than replacing the transcript.
	 */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => ExtensionUiComponent | Promise<ExtensionUiComponent>,
		options?: { overlay?: boolean },
	): Promise<T>;

	/** Set a widget drawn from a component, above or below the editor. */
	setWidgetComponent(
		key: string,
		factory: ExtensionUiComponentFactory | undefined,
		options?: ExtensionWidgetOptions,
	): void;

	/**
	 * Set a custom editor component via factory function, or `undefined` to restore the default editor.
	 *
	 * The factory must return a {@link CustomEditor} subclass. Plain `EditorComponent`/`Editor`
	 * instances do not implement the action-keys, escape callbacks, and custom-key-handler surface
	 * required by interactive mode.
	 */
	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
	): void;
}
