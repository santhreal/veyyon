import {
	type Component,
	clampLow,
	matchesKey,
	padding,
	routeSgrMouseInput,
	type SgrMouseEvent,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/tui";
import { replaceTabs } from "../../tools/render-utils";
import { highlightCode, theme } from "../theme/theme";
import type { CopyTarget } from "../utils/copy-targets";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import {
	applyModalReveal,
	computeModalDims,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	type ModalShellGeometry,
	renderModalShell,
	withCompact,
	ModalRevealDriver,
} from "./modal-shell";

/** Minimum rows reserved for the tree even on short terminals. */
const MIN_TREE_ROWS = 3;

export interface CopySelectorCallbacks {
	/** A copy target was chosen — copy its `content`. */
	onPick: (target: CopyTarget) => void;
	/** The picker was dismissed. */
	onCancel: () => void;
}

interface FlatNode {
	target: CopyTarget;
	depth: number;
	/** Last among its siblings (drives └─ vs ├─). */
	isLast: boolean;
	/** Per-ancestor flag: does ancestor at that level have a following sibling? */
	ancestorHasNext: boolean[];
}

/** Render one tree connector as exactly three cells (e.g. "├─ ", "└─ ", "|--"). */
function connectorCells(symbol: string): string {
	const chars = Array.from(symbol);
	return (chars[0] ?? " ") + (chars[1] ?? theme.tree.horizontal) + (chars[2] ?? " ");
}

/** The 3-cell ancestor gutter: a vertical guide when the ancestor continues. */
function gutterCells(hasNext: boolean): string {
	return `${hasNext ? theme.tree.vertical : " "}  `;
}

/**
 * `/copy` picker: tree of copy targets inside a floating ModalShell card with
 * live preview and shortcut chips.
 */
export class CopySelectorComponent implements Component {
	#roots: CopyTarget[];
	#cursorId: string;
	#lastSourceTarget?: CopyTarget;
	#lastSource?: string;
	#treeRows = MIN_TREE_ROWS;
	// Reused across renders to wrap preview content to the pane width.
	#previewText = new Text("", 0, 0);
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#onRequestRender?: () => void;
	#reveal = new ModalRevealDriver();

	constructor(
		roots: CopyTarget[],
		private readonly callbacks: CopySelectorCallbacks,
		/** Play the open unfold (TOUCH-5). Show site decides via modalRevealEnabled(). */
		reveal?: boolean,
	) {
		this.#roots = roots;
		this.#cursorId = roots[0]?.id ?? "";
		if (reveal) {
			this.#reveal.start(() => this.#onRequestRender?.());
		}
	}

	setOnRequestRender(cb: () => void): void {
		this.#onRequestRender = cb;
	}

	invalidate(): void {
		this.#lastSourceTarget = undefined;
		this.#lastSource = undefined;
	}

	#flatten(): FlatNode[] {
		const out: FlatNode[] = [];
		const walk = (nodes: CopyTarget[], depth: number, ancestorHasNext: boolean[]) => {
			nodes.forEach((target, i) => {
				const isLast = i === nodes.length - 1;
				out.push({ target, depth, isLast, ancestorHasNext });
				if (target.children?.length) walk(target.children, depth + 1, [...ancestorHasNext, !isLast]);
			});
		};
		walk(this.#roots, 0, []);
		return out;
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<")) {
			routeSgrMouseInput(keyData, event => this.#routeMouse(event));
			return;
		}
		if (matchesSelectCancel(keyData)) {
			this.callbacks.onCancel();
			return;
		}

		const flat = this.#flatten();
		if (flat.length === 0) return;
		const idx = Math.max(
			0,
			flat.findIndex(n => n.target.id === this.#cursorId),
		);

		if (matchesSelectUp(keyData)) {
			this.#cursorId = flat[idx === 0 ? flat.length - 1 : idx - 1]!.target.id;
		} else if (matchesSelectDown(keyData)) {
			this.#cursorId = flat[idx === flat.length - 1 ? 0 : idx + 1]!.target.id;
		} else if (matchesSelectPageUp(keyData)) {
			this.#cursorId = flat[Math.max(0, idx - this.#treeRows)]!.target.id;
		} else if (matchesSelectPageDown(keyData)) {
			this.#cursorId = flat[Math.min(flat.length - 1, idx + this.#treeRows)]!.target.id;
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const target = flat[idx]!.target;
			if (target.content !== undefined) this.callbacks.onPick(target);
		}
	}

	#routeMouse(event: SgrMouseEvent): boolean {
		const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
			motion: event.motion,
			leftClick: event.leftClick,
		});
		if (chrome.kind === "hover-shortcut") {
			if (this.#hoveredShortcutId !== chrome.id) {
				this.#hoveredShortcutId = chrome.id;
				this.#onRequestRender?.();
			}
			return true;
		}
		if (
			chrome.kind === "close" ||
			chrome.kind === "outside" ||
			(chrome.kind === "shortcut" && chrome.id === "close")
		) {
			this.callbacks.onCancel();
			return true;
		}
		if (chrome.kind === "shortcut" && chrome.id === "confirm") {
			this.handleInput("\n");
			return true;
		}
		return true;
	}

	#renderTree(inner: number, flat: FlatNode[], cursorIdx: number, rows: number): string[] {
		const start = clampLow(cursorIdx - Math.floor(rows / 2), 0, Math.max(0, flat.length - rows));
		const out: string[] = [];
		for (let r = 0; r < rows; r++) {
			const i = start + r;
			const node = flat[i];
			if (!node) {
				out.push("");
				continue;
			}
			const target = node.target;
			const isSelected = i === cursorIdx;

			let prefix = "";
			for (let l = 0; l < node.depth - 1; l++) prefix += gutterCells(node.ancestorHasNext[l]!);
			if (node.depth > 0) prefix += connectorCells(node.isLast ? theme.tree.last : theme.tree.branch);

			const cursor = isSelected ? `${theme.nav.cursor} ` : "  ";
			const hint = target.hint ?? "";
			const hintWidth = hint ? visibleWidth(hint) + 2 : 0;
			const used = visibleWidth(cursor) + visibleWidth(prefix);
			const labelPlain = truncateToWidth(target.label, Math.max(1, inner - used - hintWidth));
			const left = isSelected
				? theme.fg("accent", cursor) + theme.fg("dim", prefix) + theme.bold(theme.fg("accent", labelPlain))
				: cursor + theme.fg("dim", prefix) + labelPlain;
			const gap = Math.max(1, inner - used - visibleWidth(labelPlain) - visibleWidth(hint));
			out.push(left + padding(gap) + (hint ? theme.fg("dim", hint) : ""));
		}
		return out;
	}

	#renderPreview(inner: number, target: CopyTarget | undefined, rows: number): string[] {
		const out: string[] = [];
		const hint = target?.hint;
		out.push(theme.fg("dim", `Preview${hint ? ` · ${hint}` : ""}`));

		const contentRows = rows - 1;
		if (!target || contentRows <= 0) {
			while (out.length < rows) out.push("");
			return out;
		}

		const isCode = target.language !== undefined;
		let source: string;
		if (target === this.#lastSourceTarget && this.#lastSource !== undefined) {
			source = this.#lastSource;
		} else {
			source = isCode
				? highlightCode(replaceTabs(target.preview), target.language).join("\n")
				: replaceTabs(target.preview);
			this.#lastSourceTarget = target;
			this.#lastSource = source;
		}
		this.#previewText.setText(source);
		const wrapped = this.#previewText.render(Math.max(1, inner));

		const hasMore = wrapped.length > contentRows;
		const visibleCount = hasMore ? contentRows - 1 : Math.min(wrapped.length, contentRows);
		for (let k = 0; k < contentRows; k++) {
			if (k < visibleCount) {
				out.push(isCode ? wrapped[k]! : theme.fg("muted", wrapped[k]!));
			} else if (k === visibleCount && hasMore) {
				out.push(theme.fg("dim", `… ${wrapped.length - visibleCount} more lines`));
			} else {
				out.push("");
			}
		}
		return out;
	}

	render(width: number): readonly string[] {
		const height = process.stdout.rows || 40;
		const sizing = withCompact(MODAL_SIZING_LARGE, height < 24);
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			return Array.from({ length: height }, () => padding(width));
		}

		const flat = this.#flatten();
		const cursorIdx = Math.max(
			0,
			flat.findIndex(n => n.target.id === this.#cursorId),
		);
		const selected = flat[cursorIdx]?.target;

		const available = Math.max(MIN_TREE_ROWS + 1, dims.modalHeight - 8);
		const treeRows = clampLow(flat.length, 1, Math.floor(available / 2));
		this.#treeRows = treeRows;
		const previewRows = Math.max(1, available - treeRows);
		const inner = dims.contentWidth;

		const body = [
			...this.#renderTree(inner, flat, cursorIdx, treeRows),
			"",
			...this.#renderPreview(inner, selected, previewRows),
		];

		const shell = renderModalShell({
			title: "Copy to clipboard",
			sizing,
			areaWidth: width,
			areaHeight: height,
			body,
			shortcuts: [
				{ label: "up/down move" },
				{ label: "enter copy", clickable: true, id: "confirm" },
				{ label: "esc close", clickable: true, id: "close" },
			],
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		return applyModalReveal(shell, width, this.#reveal.value);
	}
}
