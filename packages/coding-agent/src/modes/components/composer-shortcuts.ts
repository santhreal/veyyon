import type { Component, MouseRoutable, SgrMouseEvent } from "@veyyon/tui";
import type { KeybindingsManager } from "../../config/keybindings";
import { COMPOSER_INSET_COLS } from "./composer-chrome";
import { appKey } from "./keybinding-hints";
import { layoutShortcutRows, type ModalShortcut, type ShortcutHitRect } from "./modal-shell";

export interface ComposerShortcutContext {
	/** Session is streaming/executing (turn in flight). */
	busy: boolean;
	/** Editor has a non-empty draft. */
	hasDraft: boolean;
	/** Queue holds steered/follow-up messages. */
	hasQueue: boolean;
	/** Focused session is a subagent (Esc returns instead of interrupting). */
	focused: boolean;
	/** A foreground bash command is waiting (Ctrl+B moves it to background). */
	canBackgroundBash: boolean;
}

/**
 * Build the composer chip strip: a single row of actionable context hints
 * rendered between the footline and the input card.
 *
 * Design contract (docs/ui/composer-design.md):
 * - Exactly one row in every state: busy, draft, queue, or any mix.
 * - Hints are imperative verbs ("cancel queue", "interrupt"), never key
 *   lists; the key prefix is dimmed and shortened (Ctrl → ^).
 * - Order is stable: interrupt first, then background (escalation reads
 *   left-to-right), then dequeue.
 * - Empty state (idle, no draft, no queue) renders nothing.
 */
export function buildComposerShortcuts(
	keybindings: KeybindingsManager,
	ctx: ComposerShortcutContext,
): ModalShortcut[] {
	const chips: ModalShortcut[] = [];

	if (ctx.busy && !ctx.focused) {
		chips.push({ label: `${appKey(keybindings, "app.interrupt")} interrupt`, clickable: true, id: "interrupt" });
	}
	if (ctx.canBackgroundBash) {
		// Ordered after interrupt deliberately. Both appear while a command runs,
		// and the footline reads left-to-right as escalation: background the
		// command if it is healthy, interrupt it if it is not. Keeping background
		// second also keeps the chip order stable when a command starts mid-turn —
		// a plain streaming turn does not land on a different chip here.
		chips.push({
			label: `${appKey(keybindings, "app.bash.background")} background`,
			clickable: true,
			id: "background",
		});
	}
	if (ctx.hasQueue && !ctx.focused) {
		// The queue hint is the most actionable — the operator usually wants to
		// either drain it (if the draft was wrong) or add to it.
		chips.push({
			label: `${appKey(keybindings, "app.message.dequeue")} dequeue`,
			clickable: true,
			id: "dequeue",
		});
	}

	return chips;
}

/**
 * Composer chip strip. Fixed height (one row), rendered inside the composer
 * zone between the footline and the input card.
 *
 * The zone owns the full terminal width; the bar renders its chips in the
 * content inset (COMPOSER_INSET_COLS) so chips align with the input card's
 * text column.
 *
 * Chips are click targets (MouseRoutable): the pinned-footer mouse route in
 * the TUI delivers clicks here in frame-local coordinates, and the host maps
 * a chip id to the same action its keybinding runs. Hover paint stays off —
 * the main session holds press/release tracking only (any-motion stays with
 * the terminal so drag-select keeps working), so no motion events ever arrive.
 */
export class ComposerShortcutsBar implements Component, MouseRoutable {
	#shortcuts: readonly ModalShortcut[] = [];
	#hits: ShortcutHitRect[] = [];

	/** Host maps a clicked chip id to the action its keybinding runs. */
	onChipClick?: (id: string) => void;

	setShortcuts(shortcuts: readonly ModalShortcut[]): void {
		this.#shortcuts = shortcuts;
	}

	invalidate(): void {
		// Stateless; nothing to invalidate.
	}

	render(width: number): string[] {
		this.#hits = [];
		// Fixed height: one row in every state, blank when idle, so the footer
		// never jumps when a turn starts or the queue drains.
		if (this.#shortcuts.length === 0) return [""];
		const maxWidth = Math.max(0, width - COMPOSER_INSET_COLS);
		const rows = layoutShortcutRows(this.#shortcuts, maxWidth);
		if (rows.length === 0) return [""];
		// One row in every state: on a narrow terminal the layout would wrap to
		// two, so keep the first row and drop the rest rather than grow the band.
		const first = rows[0]!;
		for (const chip of first.chips) {
			if (!chip.clickable || !chip.id) continue;
			this.#hits.push({
				id: chip.id,
				row: 0,
				colStart: COMPOSER_INSET_COLS + chip.offset,
				colEnd: COMPOSER_INSET_COLS + chip.offset + chip.width,
			});
		}
		const inset = " ".repeat(COMPOSER_INSET_COLS);
		return [inset + first.styled];
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (!event.leftClick) return;
		const hit = this.#hits.find(h => h.row === line && col >= h.colStart && col < h.colEnd);
		if (hit) this.onChipClick?.(hit.id);
	}
}
