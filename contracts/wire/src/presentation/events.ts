/**
 * Input events a renderer reports back to the session.
 *
 * The direction is one way: the session sends view-models down, the renderer
 * sends these up. Nothing here carries a callback or a handle, so the same
 * event survives a serialization boundary unchanged.
 */

import type { DialogResult } from "./overlay";
import type { Attachment } from "./transcript";

/** The operator submitted the composer. */
export interface SubmitEvent {
	type: "submit";
	text: string;
	attachments: readonly Attachment[];
}

/** The operator asked the current turn to stop. */
export interface InterruptEvent {
	type: "interrupt";
}

/** The operator scrolled the transcript. Negative walks back into history. */
export interface ScrollEvent {
	type: "scroll";
	delta: number;
}

/** The operator jumped the transcript to the live tail. */
export interface ScrollToLiveEvent {
	type: "scroll-to-live";
}

/** The operator answered a tool-approval prompt. */
export interface ToolApprovalEvent {
	type: "select-tool-approval";
	toolCallId: string;
	approved: boolean;
	/** True when the answer should apply to later calls of the same tool. */
	remember: boolean;
}

/** A dialog closed with an answer. */
export interface DialogResultEvent {
	type: "dialog-result";
	dialogId: string;
	result: DialogResult;
}

/** The operator ran a slash command. */
export interface CommandEvent {
	type: "command";
	command: string;
	args: string;
}

/** The rendering surface changed size. */
export interface ResizeEvent {
	type: "resize";
	width: number;
	height: number;
}

/** The composer's text or cursor changed. Sent as the operator types. */
export interface ComposerChangeEvent {
	type: "composer-change";
	text: string;
	cursorOffset: number;
}

/** The operator asked to leave the session. */
export interface ExitEvent {
	type: "exit";
	/** True when the operator wants the session state kept for a later resume. */
	save: boolean;
}

export type UIEvent =
	| SubmitEvent
	| InterruptEvent
	| ScrollEvent
	| ScrollToLiveEvent
	| ToolApprovalEvent
	| DialogResultEvent
	| CommandEvent
	| ResizeEvent
	| ComposerChangeEvent
	| ExitEvent;

/** Every `UIEvent["type"]`, as a value, so a sweep can enumerate the union at run time. */
export const UI_EVENT_TYPES = [
	"submit",
	"interrupt",
	"scroll",
	"scroll-to-live",
	"select-tool-approval",
	"dialog-result",
	"command",
	"resize",
	"composer-change",
	"exit",
] as const satisfies readonly UIEvent["type"][];

/**
 * A new `UIEvent` member that is missing from UI_EVENT_TYPES makes this fail to
 * compile, naming the member. `satisfies` above rejects a stale entry; this
 * rejects a missing one, so the table cannot drift from the union either way.
 */
type UnlistedUIEvent = Exclude<UIEvent["type"], (typeof UI_EVENT_TYPES)[number]>;
const _ui_event_types_is_exhaustive: UnlistedUIEvent extends never ? true : UnlistedUIEvent = true;
void _ui_event_types_is_exhaustive;
