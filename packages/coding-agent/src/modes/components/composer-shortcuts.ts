/**
 * Contextual shortcut chip band under the composer (Grok ShortcutsBar dialect).
 * Same chip renderer as ModalShell footers — one grammar for overlays and session.
 */
import { type Component } from "@veyyon/tui";
import type { KeybindingsManager } from "../../config/keybindings";
import { theme } from "../theme/theme";
import { COMPOSER_INSET_COLS } from "./composer-chrome";
import { appKey } from "./keybinding-hints";
import { layoutShortcutRows, type ModalShortcut, renderModalShortcuts } from "./modal-shell";

export type ComposerContext = {
	/** Agent is streaming / tools running. */
	busy: boolean;
	/** Composer draft is non-empty. */
	hasDraft: boolean;
	/** Queue has pending messages. */
	hasQueue: boolean;
};

/**
 * Build contextual chips for the idle/busy composer. Always includes a quiet
 * baseline; busy mode swaps send for interrupt.
 */
export function buildComposerShortcuts(keybindings: KeybindingsManager, ctx: ComposerContext): ModalShortcut[] {
	// A quiet composer: no chrome when idle. `enter` to send, `/` for commands
	// and `alt+m` for the model are self-evident and discoverable in `/help` —
	// crowding the prompt with them is exactly the pre-rebrand clutter we removed.
	// Chips appear only when there is a live action to surface: an interrupt
	// while the agent is streaming, or a queued message to dequeue.
	const chips: ModalShortcut[] = [];
	if (ctx.busy) {
		chips.push({ label: `${appKey(keybindings, "app.interrupt")} interrupt` });
	}
	if (ctx.hasQueue) {
		chips.push({ label: `${appKey(keybindings, "app.message.dequeue")} dequeue` });
	}
	return chips;
}

/**
 * Contextual chip band under the composer, left-aligned at the composer
 * rail so it sits under the footline's location group on one shared axis.
 * Fixed height: exactly one row in every state, chips or blank. A 0/1-row
 * band changes the composer zone's height on every busy flip, jerking the
 * whole footer up and down mid-conversation (user report 2026-07-22); the
 * zone reserves this row whether or not there is a live action to surface.
 */
export class ComposerShortcutsBar implements Component {
	#shortcuts: readonly ModalShortcut[] = [];
	// Live scroll-isolation state, read at render time so the indicator never
	// needs a rebuild trigger from the engine's wheel handling.
	#scrollState: (() => { active: boolean; newRows: number }) | null = null;

	setShortcuts(shortcuts: readonly ModalShortcut[]): void {
		this.#shortcuts = shortcuts;
	}

	setScrollState(source: (() => { active: boolean; newRows: number }) | null): void {
		this.#scrollState = source;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const scroll = this.#scrollState?.();
		const inset = " ".repeat(COMPOSER_INSET_COLS);
		if (scroll?.active) {
			const label = theme.fg("dim", `\u2193 ${scroll.newRows} new rows`) + theme.fg("muted", "  wheel down to resume");
			return [inset + label];
		}
		if (this.#shortcuts.length === 0 || width < 20) return [""];
		// renderModalShortcuts centers within the given width; the band aligns
		// at the rail instead, so use the raw layout rows.
		const rows = layoutShortcutRows(this.#shortcuts, Math.max(1, width - COMPOSER_INSET_COLS));
		return rows.map(({ styled }) => inset + styled);
	}
}
