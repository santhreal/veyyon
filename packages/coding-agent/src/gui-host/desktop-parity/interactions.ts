/**
 * How the desktop carries each decision the interaction ledger raises and
 * each member of the extension UI surface the host hands a plugin.
 *
 * `GuiHostUIContext` is that surface when a window is attached. Its four
 * prompting methods raise decisions on the ledger, which the host publishes in
 * the `Interactions` section and the window draws in the interaction dock.
 * The rest is terminal chrome. Each such member is either opted out with the
 * reason the window does without it, or a recorded gap stating what an
 * extension loses on the desktop.
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
};

const THEMES_ARE_THE_WINDOWS =
	"terminal themes do not style the window; the desktop lists and applies its own through LoadThemes and its settings";

const EXPANSION_IS_PER_ROW =
	"the window expands tool rows one at a time through SetToolViewExpanded; there is no global expansion state to read or set";

const RETIRED_CHROME =
	"retired from ExtensionUIContext; no host draws an extension header or footer, and the interface no longer reaches the method";

export const UI_CONTEXT_CARRIERS: Readonly<Record<UiContextMember, DesktopCarrier>> = {
	select: DOCK,
	confirm: DOCK,
	input: DOCK,
	editor: DOCK,
	askDialog: {
		gap: "absent on the desktop context, so the ask tool falls back to one plain question per prompt: option descriptions, previews and the multi-question dialog are not shown",
	},
	notify: { gap: "an extension notification is dropped; the window shows no toast for it" },
	onTerminalInput: {
		optOut: "a window has no raw terminal byte stream; the returned unsubscribe does nothing",
	},
	setStatus: { gap: "status text an extension sets is not shown anywhere in the window" },
	setWorkingMessage: {
		gap: "the working message an extension sets while a turn streams is not shown; the window keeps its own",
	},
	setWidget: { gap: "text widgets an extension sets above or below the editor are not drawn around the composer" },
	setTitle: {
		optOut: "the window title is the session title the host publishes; an extension does not retitle the window",
	},
	terminal: {
		optOut: "screen takeover hands out a live TUI, which a window does not have; callers take their non-terminal path",
	},
	setEditorText: { gap: "an extension cannot put text into the desktop composer" },
	pasteToEditor: { gap: "an extension cannot paste into the desktop composer" },
	getEditorText: { gap: "an extension reads an empty string instead of the desktop composer's draft" },
	addAutocompleteProvider: {
		gap: "extension completion sources are not offered in the composer's `/` and `@` completion",
	},
	theme: {
		optOut: "returns the terminal theme so extension renderers keep formatting; the window draws with its own theme",
	},
	getAllThemes: { optOut: THEMES_ARE_THE_WINDOWS },
	getTheme: { optOut: THEMES_ARE_THE_WINDOWS },
	setTheme: { optOut: THEMES_ARE_THE_WINDOWS },
	getToolsExpanded: { optOut: EXPANSION_IS_PER_ROW },
	setToolsExpanded: { optOut: EXPANSION_IS_PER_ROW },
	setHeader: { optOut: RETIRED_CHROME },
	setFooter: { optOut: RETIRED_CHROME },
	custom: {
		optOut: "the terminal screen takeover moved to `terminal.custom`; this flat member rejects, since a window cannot mount a TUI component",
	},
	setEditorComponent: {
		optOut: "the terminal editor replacement moved to `terminal.setEditorComponent`; the window's composer is not a TUI component",
	},
};

/** The terminal-only capability, which the desktop context omits as a whole. */
export const TERMINAL_CAPABILITY_CARRIERS: Readonly<Record<keyof ExtensionTerminalCapability, { optOut: string }>> = {
	custom: { optOut: "mounts a TUI component with keyboard focus; a window has no TUI to mount it in" },
	setWidgetComponent: { optOut: "draws a TUI component as a widget; a window draws text widgets only" },
	setEditorComponent: { optOut: "replaces the terminal editor with a TUI component; the composer is a GPUI view" },
};
