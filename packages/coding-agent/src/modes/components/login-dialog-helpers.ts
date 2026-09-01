import type { ModalShortcut } from "./modal-shell";

export interface PromptState {
	message: string;
	placeholder?: string;
	secret: boolean;
	submitVerb: string;
}

export interface AuthState {
	url: string;
	launchUrl?: string;
	instructions?: string;
}

export const LOGIN_CANCEL_CHIPS: readonly ModalShortcut[] = [
	{ label: "cancel", keybindings: ["tui.select.cancel"], clickable: true, id: "cancel" },
];

export function loginPromptChips(submitVerb: string, cancelVerb: string): readonly ModalShortcut[] {
	return [
		{ label: submitVerb, keybindings: ["tui.select.confirm"] },
		{ label: cancelVerb, keybindings: ["tui.select.cancel"], clickable: true, id: "cancel" },
	];
}
