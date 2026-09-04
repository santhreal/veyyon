/**
 * Overlay and dialog view-models: modal surfaces a renderer paints above the
 * transcript, and the answers it sends back.
 *
 * A dialog is a question with a result. An overlay is a surface with a
 * lifetime. Both are described here in terms of what is shown, never in terms
 * of the terminal component or DOM node that shows it.
 */

/** Where an overlay sits relative to the viewport. */
export type OverlayAnchor = "center" | "top" | "bottom" | "fullscreen";

/** One selectable row in a list dialog. */
export interface SelectOption {
	/** Value reported back when the row is chosen. */
	value: string;
	label: string;
	description?: string;
	/** True when the row cannot be chosen. */
	disabled?: boolean;
}

export interface ConfirmDialog {
	kind: "confirm";
	id: string;
	title: string;
	body: string;
	confirmLabel: string;
	cancelLabel: string;
	/** True when the destructive action is the default. */
	destructive: boolean;
}

export interface SelectDialog {
	kind: "select";
	id: string;
	title: string;
	options: readonly SelectOption[];
	/** Index pre-highlighted when the dialog opens. */
	selectedIndex: number;
	/** True when the operator may choose several rows. */
	multi: boolean;
	/** True when the list filters as the operator types. */
	filterable: boolean;
}

export interface PromptDialog {
	kind: "prompt";
	id: string;
	title: string;
	placeholder: string;
	/** Text the input opens with. */
	initialValue: string;
	/** True when the input must not be echoed. */
	masked: boolean;
}

/** A tool call waiting for the operator to allow or refuse it. */
export interface ToolApprovalDialog {
	kind: "tool-approval";
	id: string;
	toolCallId: string;
	toolName: string;
	/** Arguments rendered for display; secrets already redacted. */
	input: string;
	/** What the tool will change, when the tool can say. */
	impact?: string;
}

export type DialogViewModel = ConfirmDialog | SelectDialog | PromptDialog | ToolApprovalDialog;

/** Every `DialogViewModel["kind"]`, as a value, so a sweep can enumerate the union at run time. */
export const DIALOG_KINDS = [
	"confirm",
	"select",
	"prompt",
	"tool-approval",
] as const satisfies readonly DialogViewModel["kind"][];

/** What the operator answered. `cancelled` covers escape, close and timeout alike. */
export type DialogResult =
	| { outcome: "cancelled" }
	| { outcome: "confirmed" }
	| { outcome: "selected"; values: readonly string[] }
	| { outcome: "entered"; value: string }
	| { outcome: "approved"; remember: boolean }
	| { outcome: "rejected"; reason?: string };

export interface OverlayViewModel {
	id: string;
	anchor: OverlayAnchor;
	title?: string;
	/** Rendered rows. The renderer paints them as given and adds only its own framing. */
	rows: readonly string[];
	/** True when the overlay takes input; false when it only displays. */
	interactive: boolean;
	/** True when dismissing the overlay is the operator's to decide. */
	dismissable: boolean;
}

/** Handle to a live overlay. Closing is idempotent. */
export interface OverlayHandle {
	readonly id: string;
	close(): void;
	/** Replace the overlay's contents in place. */
	update(overlay: OverlayViewModel): void;
}

/**
 * A new `DialogViewModel` member that is missing from DIALOG_KINDS makes this fail to
 * compile, naming the member. `satisfies` above rejects a stale entry; this
 * rejects a missing one, so the table cannot drift from the union either way.
 */
type UnlistedDialogViewModel = Exclude<DialogViewModel["kind"], (typeof DIALOG_KINDS)[number]>;
const _dialog_kinds_is_exhaustive: UnlistedDialogViewModel extends never ? true : UnlistedDialogViewModel = true;
void _dialog_kinds_is_exhaustive;
