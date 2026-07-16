/**
 * Contextual shortcut chip band under the composer (Grok ShortcutsBar dialect).
 * Same chip renderer as ModalShell footers — one grammar for overlays and session.
 */
import { type Component, padding, visibleWidth } from "@veyyon/pi-tui";
import type { KeybindingsManager } from "../../config/keybindings";
import { appKey } from "./keybinding-hints";
import { type ModalShortcut, renderModalShortcuts } from "./modal-shell";

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
	// crowding the prompt with them is exactly the omp clutter we removed.
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
 * One-line centered chip band painted under the editor container.
 */
export class ComposerShortcutsBar implements Component {
	#shortcuts: readonly ModalShortcut[] = [];

	setShortcuts(shortcuts: readonly ModalShortcut[]): void {
		this.#shortcuts = shortcuts;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.#shortcuts.length === 0 || width < 20) return [];
		const lines = renderModalShortcuts(this.#shortcuts, Math.max(1, width - 2));
		return lines.map(line => {
			const pad = Math.max(0, width - visibleWidth(line));
			const left = Math.floor(pad / 2);
			return padding(left) + line + padding(pad - left);
		});
	}
}
