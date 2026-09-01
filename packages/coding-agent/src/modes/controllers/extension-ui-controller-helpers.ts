import type { CollabUiSelectItem } from "@veyyon/wire";
import type { ExtensionAskDialogResult, ExtensionUISelectItem } from "../../extensibility/extensions";
import type { InteractiveModeContext } from "../../modes/types";

export type ExtensionUiControllerContext = Pick<
	InteractiveModeContext,
	| "addAutocompleteProvider"
	| "clearTransientSessionUi"
	| "collabHost"
	| "editor"
	| "editorContainer"
	| "executeCompaction"
	| "focusActiveEditorArea"
	| "hookEditor"
	| "hookInput"
	| "hookSelector"
	| "hookWidgetContainerAbove"
	| "hookWidgetContainerBelow"
	| "initialChatRendered"
	| "present"
	| "rebuildChatFromMessages"
	| "reloadTodos"
	| "renderInitialMessages"
	| "resetTranscript"
	| "session"
	| "sessionManager"
	| "setEditorComponent"
	| "setToolUIContext"
	| "setToolsExpanded"
	| "setWorkingMessage"
	| "showError"
	| "showStatus"
	| "showWarning"
	| "shutdownRequested"
	| "statusLine"
	| "toolOutputExpanded"
	| "ui"
>;

export const MAX_WIDGET_LINES = 10;

export interface CollabDialogWinner {
	source: "local" | "remote";
	value: string | undefined;
}

export interface CollabAskDialogWinner {
	source: "local" | "remote";
	value: ExtensionAskDialogResult | undefined;
}
export type GuestUiResult = { kind: "answered"; value: string } | { kind: "cancelled" } | { kind: "unavailable" };

export function toWireSelectOptions(options: ExtensionUISelectItem[]): CollabUiSelectItem[] {
	return options.map(option =>
		typeof option === "string"
			? option
			: option.description
				? { label: option.label, description: option.description }
				: { label: option.label },
	);
}
