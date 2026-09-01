import { theme } from "../theme/theme-binding";
import type { CopyTarget } from "../utils/copy-targets";
import type { ModalShortcut } from "./modal-shell";

export const MIN_TREE_ROWS = 3;

export interface CopySelectorCallbacks {
	onPick: (target: CopyTarget) => void;
	onCancel: () => void;
}

export interface FlatNode {
	target: CopyTarget;
	depth: number;
	isLast: boolean;
	ancestorHasNext: boolean[];
}

export function connectorCells(symbol: string): string {
	return (symbol[0] ?? " ") + (symbol[1] ?? theme.tree.horizontal) + (symbol[2] ?? " ");
}

export function gutterCells(hasNext: boolean): string {
	return `${hasNext ? theme.tree.vertical : " "}  `;
}

export const COPY_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down move" },
	{ label: "enter copy", clickable: true, id: "confirm" },
	{ label: "esc close", clickable: true, id: "close" },
];
