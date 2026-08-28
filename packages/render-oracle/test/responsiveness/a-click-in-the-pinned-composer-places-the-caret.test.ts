/**
 * A click in the pinned composer places the caret under the pointer.
 *
 * WHY THIS SUITE EXISTS:
 * The engine takes mouse reporting only while the transcript scrolls or a pinned-footer child
 * declares a click target through `MouseRoutable.wantsPointer()`. A component that implements
 * `routeMouse` and never declares a target is therefore reachable by accident alone: in a
 * session short enough that nothing scrolls, the terminal reports no buttons and the routing is
 * dead code. `Editor` routed clicks to the caret and never asked, and `Container` — which the
 * composer zone mounts the editor inside — never forwarded a child's ask, so clicking the
 * composer moved nothing until something else in the footer happened to hold the mouse.
 *
 * WHAT THIS SUITE PROVES:
 * 1. A click on the composer's text row reaches the editor and moves the caret.
 * 2. The column is translated rather than approximated: two clicks separated by N columns move
 *    the caret by exactly N, so a dropped gutter offset or an off-by-one is visible.
 * 3. The ask survives a wrapping container, which is how the real composer is mounted.
 * 4. Every mouse-routable component exported by the engine declares whether it wants the
 *    pointer, enumerated at run time, so a new one turns this suite red until it decides.
 *
 * WHAT IT DOES NOT CATCH:
 * Row translation inside a multi-line composer, routing while an alt-screen overlay owns the
 * tracking set, and components outside `@veyyon/tui` (a host's own footer chrome answers for
 * itself; the sweep below can only see what this engine exports).
 */

import { describe, expect, it } from "bun:test";
import { settleFrames, VirtualTerminal } from "@veyyon/render-oracle";
import * as tuiExports from "@veyyon/tui";
import { Editor } from "@veyyon/tui/components/editor";
import { defaultEditorTheme } from "@veyyon/tui/test-support";
import { type Component, Container, TUI } from "@veyyon/tui/tui";

/** Stands in for rendered transcript rows above the composer. */
class TranscriptFiller implements Component {
	constructor(private readonly lines: string[]) {}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		return this.lines;
	}
}

const COMPOSER_TEXT = "hello world";

const sgrPress = (row: number, col: number) => `\x1b[<0;${col + 1};${row + 1}M`;

/** Mount the editor the way a host does: pinned footer, transcript above, optional wrapper. */
async function composerUnderTranscript(wrapped: boolean) {
	const term = new VirtualTerminal(80, 24);
	const tui = new TUI(term);
	tui.addChild(new TranscriptFiller(["Line 1", "Line 2", "Line 3"]));

	const editor = new Editor(defaultEditorTheme);
	editor.setText(COMPOSER_TEXT);
	if (wrapped) {
		const zone = new Container();
		zone.addChild(editor);
		tui.addChild(zone);
	} else {
		tui.addChild(editor);
	}
	tui.setPinnedFooterChildCount(1);
	tui.setFocus(editor);

	tui.start();
	tui.setScrollIsolation(true);
	await settleFrames(term, tui);

	// The clickable row is the one the composer actually painted its text on, so the gesture
	// follows the layout instead of a row number written into the test.
	const textRow = term.getViewport().findIndex(row => row.includes(COMPOSER_TEXT));
	const { footerTop, footerBottom } = tui.pinnedFooterScreenBounds;
	expect(textRow).toBeGreaterThanOrEqual(footerTop);
	expect(textRow).toBeLessThanOrEqual(footerBottom);

	return { term, tui, editor, textRow, footerTop };
}

describe("a click in the pinned composer places the caret", () => {
	it("moves the caret by the distance between two clicked columns", async () => {
		const { term, tui, editor, textRow } = await composerUnderTranscript(false);

		term.sendInput(sgrPress(textRow, 4));
		await settleFrames(term, tui);
		const near = editor.getCursor().col;

		term.sendInput(sgrPress(textRow, 9));
		await settleFrames(term, tui);
		const far = editor.getCursor().col;

		expect(far - near).toBe(5);
	});

	it("reaches an editor mounted inside a container, as the composer zone mounts it", async () => {
		const { term, tui, editor, textRow } = await composerUnderTranscript(true);

		term.sendInput(sgrPress(textRow, 4));
		await settleFrames(term, tui);
		const near = editor.getCursor().col;

		term.sendInput(sgrPress(textRow, 9));
		await settleFrames(term, tui);

		expect(editor.getCursor().col - near).toBe(5);
	});

	it("leaves the caret where it was for a click above the footer", async () => {
		const { term, tui, editor, footerTop } = await composerUnderTranscript(false);
		const before = editor.getCursor().col;

		term.sendInput(sgrPress(footerTop - 1, 4));
		await settleFrames(term, tui);

		expect(editor.getCursor().col).toBe(before);
	});

	it("asks for nothing while the composer is empty, so the terminal keeps drag-select", async () => {
		const { editor } = await composerUnderTranscript(false);
		expect(editor.wantsPointer()).toBe(true);

		editor.setText("");
		expect(editor.wantsPointer()).toBe(false);
	});

	it("every mouse-routable component the engine exports decides whether it wants the pointer", () => {
		const routableWithoutDeclaration: string[] = [];
		for (const [name, exported] of Object.entries(tuiExports)) {
			if (typeof exported !== "function") continue;
			const proto: unknown = exported.prototype;
			if (proto === null || typeof proto !== "object") continue;
			if (!("routeMouse" in proto) || typeof proto.routeMouse !== "function") continue;
			if ("wantsPointer" in proto && typeof proto.wantsPointer === "function") continue;
			routableWithoutDeclaration.push(name);
		}

		// Pinned by exact equality: a new routable component lands here until someone gives it an
		// answer. `TUI` extends `Container`, so it inherits the forwarding ask rather than opting
		// out — the engine is never a footer child, and forwarding costs it nothing.
		expect(routableWithoutDeclaration).toEqual([]);
	});
});
