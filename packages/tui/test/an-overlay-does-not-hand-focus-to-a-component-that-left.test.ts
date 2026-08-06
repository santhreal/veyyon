import { describe, expect, it } from "bun:test";
import { Container, TUI } from "@veyyon/tui";
import type { Component } from "@veyyon/tui";

/**
 * WHY: an overlay captures whatever had focus when it opened and hands focus
 * back to that same component when it closes. Those two moments can be far
 * apart, and in between the captured component can be swapped out of its
 * container and thrown away: a dialog that occupies the editor slot is
 * replaced by the next dialog, or by the editor itself, and disposed on the
 * way out.
 *
 * Restoring focus to it then aims the keyboard at a component nothing renders
 * and nothing can reach. On screen the surface underneath looks live, so the
 * operator presses Enter at a dialog that is genuinely on screen and nothing
 * happens, with no error and nothing to dismiss.
 *
 * The contract: focus restored after an overlay closes must land on a
 * component still attached to the render tree.
 */

class Focusable implements Component {
	focused = false;
	constructor(readonly id: string) {}
	render(): string[] {
		return [this.id];
	}
}

function attachedTui(): { ui: TUI; slot: Container; editor: Focusable } {
	const ui = new TUI({
		// A terminal stub: these tests never paint, they only move focus.
		write: () => {},
		columns: 80,
		rows: 24,
		hideCursor: () => {},
		showCursor: () => {},
		on: () => {},
		off: () => {},
	} as unknown as TUI["terminal"]);
	const slot = new Container();
	const editor = new Focusable("core-editor");
	slot.addChild(editor);
	ui.addChild(slot);
	return { ui, slot, editor };
}

describe("focus restored when an overlay closes", () => {
	it("does not hand focus to a component that left the tree while the overlay was up", () => {
		const { ui, slot, editor } = attachedTui();

		// A dialog owns the editor slot and has focus, exactly as a hook
		// selector does while it is asking something.
		const dialog = new Focusable("dialog");
		slot.clear();
		slot.addChild(dialog);
		ui.setFocus(dialog);

		// An overlay opens on top and captures the dialog as its preFocus.
		const overlay = ui.showOverlay(new Focusable("overlay"));

		// The dialog settles while the overlay is still up: its slot is handed
		// back to the editor and the dialog is discarded.
		slot.clear();
		slot.addChild(editor);

		overlay.hide();

		const focused = ui.getFocused();
		expect(focused).not.toBe(dialog);
		expect(focused).toBe(editor);
	});

	it("still restores a captured component that is genuinely still there", () => {
		const { ui, slot, editor } = attachedTui();
		ui.setFocus(editor);

		const overlay = ui.showOverlay(new Focusable("overlay"));
		overlay.hide();

		expect(ui.getFocused()).toBe(editor);
		expect(slot.children).toEqual([editor]);
	});
});
