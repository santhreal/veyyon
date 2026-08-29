import type { ModalShortcut } from "./modal-shell";

export const RESET_SELECTOR_MAX_VISIBLE = 10;

export const RESET_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down navigate" },
	{ label: "enter spend", clickable: true, id: "confirm" },
	{ label: "esc close", clickable: true, id: "close" },
];

export const RESET_PENDING_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "enter confirm", clickable: true, id: "confirm" },
	{ label: "esc cancel pending", clickable: true, id: "close" },
];
