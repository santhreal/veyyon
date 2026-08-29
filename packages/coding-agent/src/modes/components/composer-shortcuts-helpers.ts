import type { KeybindingsManager } from "../../config/keybindings";
import { appKey } from "./keybinding-hints";
import type { ModalShortcut } from "./modal-shell";

export const EMPTY_SHORTCUT_ROWS: readonly string[] = [""];

export interface ComposerShortcutContext {
	busy: boolean;
	hasDraft: boolean;
	hasQueue: boolean;
	focused: boolean;
	canBackgroundBash: boolean;
}

export function buildComposerShortcuts(keybindings: KeybindingsManager, ctx: ComposerShortcutContext): ModalShortcut[] {
	const chips: ModalShortcut[] = [];

	if (ctx.busy && !ctx.focused) {
		chips.push({ label: `${appKey(keybindings, "app.interrupt")} interrupt`, clickable: true, id: "interrupt" });
	}
	if (ctx.canBackgroundBash) {
		chips.push({
			label: `${appKey(keybindings, "app.bash.background")} background`,
			clickable: true,
			id: "background",
		});
	}
	if (ctx.hasQueue && !ctx.focused) {
		chips.push({
			label: `${appKey(keybindings, "app.message.dequeue")} dequeue`,
			clickable: true,
			id: "dequeue",
		});
	}

	return chips;
}
