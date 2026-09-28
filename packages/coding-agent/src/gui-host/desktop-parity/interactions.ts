/**
 * How the desktop carries each decision the interaction ledger raises and
 * each member of the extension UI surface the host hands a plugin.
 *
 * `GuiHostUIContext` is that surface when a window is attached. Its four
 * prompting methods and the multi-question `askDialog` raise decisions on the
 * ledger, which the host publishes in the `Interactions` section and the
 * window draws in the interaction dock.
 * The chrome an extension sets is held by the window's `ExtensionChrome`:
 * status entries, the working message and text widgets in the `ExtensionUi`
 * section, notices in `ExtensionNotice`, edits to the draft in
 * `ComposerEdit`. The composer reports its draft with `ReportComposerDraft`
 * and asks the extension completion sources with `CompleteComposer`.
 * The rest is terminal chrome the window keeps as its own, each member opted
 * out with the reason the window does without it.
 */
import type { ExtensionUIContext } from "../../extensibility/extensions/types";
import type { ExtensionTerminalCapability } from "../../extensibility/terminal-capability";
import type { GuiHostUIContext } from "../interactions";
import type { PendingDecisions } from "../wire";
import type { DesktopCarrier } from "./carrier";

/** Every member of the extension UI surface, as declared and as the desktop context implements it. */
export type UiContextMember = Exclude<
	keyof ExtensionUIContext | keyof GuiHostUIContext,
	"ledger" | "timeoutStartsOnPresentation"
>;

const DOCK = { section: "Interactions" } as const;

export const PENDING_DECISION_CARRIERS: Readonly<Record<keyof PendingDecisions, DesktopCarrier>> = {
	approvals: DOCK,
	questions: DOCK,
	plans: DOCK,
	dialogs: DOCK,
};

const THEMES_ARE_THE_WINDOWS =
	"terminal themes do not style the window; the desktop lists and applies its own through LoadThemes and its settings";

const EXPANSION_IS_PER_ROW =
	"the window expands tool rows one at a time through SetToolViewExpanded; there is no global expansion state to read or set";

export const UI_CONTEXT_CARRIERS: Readonly<Record<UiContextMember, DesktopCarrier>> = {
	select: DOCK,
	confirm: DOCK,
	input: DOCK,
	editor: DOCK,
	askDialog: DOCK,
	notify: { section: "ExtensionNotice" },
	onTerminalInput: {
		optOut: "a window has no raw terminal byte stream; the returned unsubscribe does nothing",
	},
	setStatus: { section: "ExtensionUi" },
	setWorkingMessage: { section: "ExtensionUi" },
	setWidget: { section: "ExtensionUi" },
	setTitle: {
		optOut: "the window title is the session title the host publishes; an extension does not retitle the window",
	},
	terminal: {
		optOut:
			"screen takeover hands out a live TUI, which a window does not have; callers take their non-terminal path",
	},
	setEditorText: { section: "ComposerEdit" },
	pasteToEditor: { section: "ComposerEdit" },
	getEditorText: { action: "ReportComposerDraft" },
	addAutocompleteProvider: { action: "CompleteComposer" },
	theme: {
		optOut: "returns the terminal theme so extension renderers keep formatting; the window draws with its own theme",
	},
	getAllThemes: { optOut: THEMES_ARE_THE_WINDOWS },
	getTheme: { optOut: THEMES_ARE_THE_WINDOWS },
	setTheme: { optOut: THEMES_ARE_THE_WINDOWS },
	getToolsExpanded: { optOut: EXPANSION_IS_PER_ROW },
	setToolsExpanded: { optOut: EXPANSION_IS_PER_ROW },
};

/** The terminal-only capability, which the desktop context omits as a whole. */
export const TERMINAL_CAPABILITY_CARRIERS: Readonly<Record<keyof ExtensionTerminalCapability, { optOut: string }>> = {
	custom: { optOut: "mounts a TUI component with keyboard focus; a window has no TUI to mount it in" },
	setWidgetComponent: { optOut: "draws a TUI component as a widget; a window draws text widgets only" },
	setEditorComponent: { optOut: "replaces the terminal editor with a TUI component; the composer is a GPUI view" },
};
