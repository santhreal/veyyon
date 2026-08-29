import type { Component, MouseRoutable, SgrMouseEvent } from "@veyyon/tui";
import { COMPOSER_INSET_COLS } from "./composer-chrome";
import { EMPTY_SHORTCUT_ROWS } from "./composer-shortcuts-helpers";
import { layoutShortcutRows, type ModalShortcut, type ShortcutHitRect } from "./modal-shell";

export { buildComposerShortcuts } from "./composer-shortcuts-helpers";

export class ComposerShortcutsBar implements Component, MouseRoutable {
	#shortcuts: readonly ModalShortcut[] = [];
	#hits: ShortcutHitRect[] = [];

	#cachedWidth = -1;
	#cachedShortcuts: readonly ModalShortcut[] | null = null;
	#cachedRows: readonly string[] = [];
	#cachedHits: ShortcutHitRect[] = [];

	onChipClick?: (id: string) => void;

	setShortcuts(shortcuts: readonly ModalShortcut[]): void {
		this.#shortcuts = shortcuts;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedShortcuts = null;
	}

	render(width: number): string[] {
		if (width === this.#cachedWidth && this.#shortcuts === this.#cachedShortcuts) {
			this.#hits = this.#cachedHits;
			return this.#cachedRows as string[];
		}
		this.#cachedWidth = width;
		this.#cachedShortcuts = this.#shortcuts;
		if (this.#shortcuts.length === 0) {
			this.#hits = [];
			this.#cachedHits = [];
			this.#cachedRows = EMPTY_SHORTCUT_ROWS;
			return this.#cachedRows as string[];
		}
		const maxWidth = Math.max(0, width - COMPOSER_INSET_COLS);
		const rows = layoutShortcutRows(this.#shortcuts, maxWidth);
		if (rows.length === 0) {
			this.#hits = [];
			this.#cachedHits = [];
			this.#cachedRows = EMPTY_SHORTCUT_ROWS;
			return this.#cachedRows as string[];
		}
		const first = rows[0]!;
		const hits: ShortcutHitRect[] = [];
		for (let ci = 0; ci < first.chips.length; ci++) {
			const chip = first.chips[ci]!;
			if (!chip.clickable || !chip.id) continue;
			hits.push({
				id: chip.id,
				row: 0,
				colStart: COMPOSER_INSET_COLS + chip.offset,
				colEnd: COMPOSER_INSET_COLS + chip.offset + chip.width,
			});
		}
		this.#hits = hits;
		this.#cachedHits = hits;
		const inset = " ".repeat(COMPOSER_INSET_COLS);
		this.#cachedRows = [inset + first.styled];
		return this.#cachedRows as string[];
	}

	wantsPointer(): boolean {
		return this.#hits.length > 0;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (!event.leftClick) return;
		const hit = this.#hits.find(h => h.row === line && col >= h.colStart && col < h.colEnd);
		if (hit) this.onChipClick?.(hit.id);
	}
}
