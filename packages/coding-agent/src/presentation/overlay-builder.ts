/**
 * Session requests to `DialogViewModel` / `OverlayViewModel`.
 *
 * Every dialog the session raises is built here, so the wording and the
 * defaults are stated once rather than per renderer. A renderer decides how a
 * dialog looks; it never decides what it asks.
 */

import type {
	ConfirmDialog,
	DialogResult,
	OverlayAnchor,
	OverlayViewModel,
	PromptDialog,
	SelectDialog,
	SelectOption,
	ToolApprovalDialog,
} from "@veyyon/wire/presentation";

/** A tool call waiting on the operator. */
export interface ToolApprovalRequest {
	toolCallId: string;
	toolName: string;
	/** Arguments rendered for display, secrets already redacted. */
	input: string;
	/** What the call will change, when the tool can say. */
	impact?: string;
}

export function toToolApprovalDialog(request: ToolApprovalRequest): ToolApprovalDialog {
	const dialog: ToolApprovalDialog = {
		kind: "tool-approval",
		// The call id IS the identity: two approvals for the same call are the same
		// question, and answering one answers it.
		id: `approve:${request.toolCallId}`,
		toolCallId: request.toolCallId,
		toolName: request.toolName,
		input: request.input,
	};
	if (request.impact !== undefined) dialog.impact = request.impact;
	return dialog;
}

export interface ConfirmRequest {
	id: string;
	title: string;
	body: string;
	confirmLabel?: string;
	cancelLabel?: string;
	destructive?: boolean;
}

export function toConfirmDialog(request: ConfirmRequest): ConfirmDialog {
	return {
		kind: "confirm",
		id: request.id,
		title: request.title,
		body: request.body,
		confirmLabel: request.confirmLabel ?? "Confirm",
		cancelLabel: request.cancelLabel ?? "Cancel",
		// A destructive action never defaults to yes.
		destructive: request.destructive === true,
	};
}

export interface SelectRequest {
	id: string;
	title: string;
	options: readonly SelectOption[];
	selectedIndex?: number;
	multi?: boolean;
	/** Defaults to filterable once the list is long enough to need it. */
	filterable?: boolean;
}

/** Rows past which a list gets a filter whether or not the caller asked. */
const FILTER_THRESHOLD_ROWS = 12;

export function toSelectDialog(request: SelectRequest): SelectDialog {
	const options = request.options;
	const requested = request.selectedIndex ?? 0;
	return {
		kind: "select",
		id: request.id,
		title: request.title,
		options,
		// An index outside the list would open the dialog with nothing highlighted
		// and no way for the operator to tell why.
		selectedIndex: options.length === 0 ? -1 : Math.min(options.length - 1, Math.max(0, Math.trunc(requested))),
		multi: request.multi === true,
		filterable: request.filterable ?? options.length > FILTER_THRESHOLD_ROWS,
	};
}

export interface PromptRequest {
	id: string;
	title: string;
	placeholder?: string;
	initialValue?: string;
	masked?: boolean;
}

export function toPromptDialog(request: PromptRequest): PromptDialog {
	return {
		kind: "prompt",
		id: request.id,
		title: request.title,
		placeholder: request.placeholder ?? "",
		initialValue: request.initialValue ?? "",
		masked: request.masked === true,
	};
}

export interface OverlayRequest {
	id: string;
	rows: readonly string[];
	anchor?: OverlayAnchor;
	title?: string;
	interactive?: boolean;
	dismissable?: boolean;
}

export function toOverlayViewModel(request: OverlayRequest): OverlayViewModel {
	const overlay: OverlayViewModel = {
		id: request.id,
		anchor: request.anchor ?? "center",
		rows: request.rows,
		interactive: request.interactive === true,
		// An overlay the operator cannot dismiss traps the session, so dismissable
		// is the default and refusing it is the deliberate choice.
		dismissable: request.dismissable ?? true,
	};
	if (request.title !== undefined) overlay.title = request.title;
	return overlay;
}

/**
 * Whether a dialog result allows the tool call to run. Only an explicit
 * approval does: a cancel, a close, a timeout and a rejection all refuse, which
 * is what keeps a dismissed prompt from being read as consent.
 */
export function isApproval(result: DialogResult): boolean {
	return result.outcome === "approved";
}
