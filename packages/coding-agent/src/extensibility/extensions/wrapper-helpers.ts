import type { ExtensionUIDialogOptions, ExtensionUISelectOption } from "./types";

export const APPROVAL_CHOICE = {
	approveOnce: "Approve",
	approveSession: "Approve for session",
	denyOnce: "Deny",
	denySession: "Deny for session",
} as const;

export const APPROVAL_SELECT_OPTIONS: ExtensionUISelectOption[] = [
	{ label: APPROVAL_CHOICE.approveOnce, description: "Run this call once. Nothing is remembered." },
	{
		label: APPROVAL_CHOICE.approveSession,
		description: "Run this and every later call to this tool, until you exit.",
	},
	{ label: APPROVAL_CHOICE.denyOnce, description: "Do not run this call." },
	{
		label: APPROVAL_CHOICE.denySession,
		description: "Refuse this and every later call to this tool, until you exit.",
	},
];
export const APPROVAL_DIALOG_OPTIONS: ExtensionUIDialogOptions = {
	selectionMarker: "radio",
	helpText: "↑/↓ navigate  enter confirm  esc cancel",
};

export const IN_FLIGHT_APPROVALS = new Map<string, Promise<void>>();
