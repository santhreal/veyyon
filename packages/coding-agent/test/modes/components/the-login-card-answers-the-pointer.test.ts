/**
 * The login card answers the pointer the way every other ModalShell does.
 *
 * WHY: the login surface was a DynamicBorder sandwich in the composer slot —
 * no card, no chips, and no mouse at all, so the only way out of a stalled
 * OAuth flow was finding the key. It is a fullscreen ModalShell card now, and
 * this suite pins the three chrome gestures a card must answer: the `[x]`
 * close glyph, a click outside the card, and the footer cancel chip. Each one
 * runs the SAME path Esc runs, which is what keeps a pointer dismissal and a
 * keyboard dismissal from drifting apart.
 *
 * It also pins the escape-mode split, because that is the part a chrome
 * rewrite silently breaks: while a credential is pending, dismissing ABORTS
 * the login; once the credential is stored and the card is only asking for an
 * optional name, dismissing SKIPS the question and leaves the login intact.
 *
 * NOT COVERED: hover paint on the chips (owned and tested by modal-shell's
 * own chip hit-testing), the body rows (the card has no clickable body), and
 * whether the browser opens.
 */

import { beforeAll, describe, expect, it, vi } from "bun:test";
import { LoginDialogComponent } from "@veyyon/coding-agent/modes/components/login-dialog";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { TUI } from "@veyyon/tui";

beforeAll(() => initTheme());

const WIDTH = 100;
const ROWS = 40;

function makeCard(): {
	dialog: LoginDialogComponent;
	completed: ReturnType<typeof vi.fn>;
	rows: () => string[];
} {
	const tui = { requestRender: vi.fn() } as unknown as TUI;
	const completed = vi.fn();
	const dialog = new LoginDialogComponent(tui, "groq", completed, { getTerminalRows: () => ROWS });
	return { dialog, completed, rows: () => dialog.render(WIDTH) };
}

/** SGR left-press at 1-based screen coordinates, the way a terminal reports it. */
function click(dialog: LoginDialogComponent, row: number, col: number): void {
	dialog.handleInput(`\x1b[<0;${col + 1};${row + 1}M`);
}

/** Screen position of the `[x]` close glyph in the rendered card. */
function closeGlyphAt(rows: string[]): { row: number; col: number } {
	for (let row = 0; row < rows.length; row++) {
		const col = rows[row]!.replace(/\x1b\[[0-9;]*m/g, "").indexOf("[x]");
		if (col !== -1) return { row, col: col + 1 };
	}
	throw new Error("the card drew no close glyph");
}

/** Screen position of a footer chip's label in the rendered card. */
function chipAt(rows: string[], label: string): { row: number; col: number } {
	for (let row = 0; row < rows.length; row++) {
		const col = rows[row]!.replace(/\x1b\[[0-9;]*m/g, "").indexOf(label);
		if (col !== -1) return { row, col };
	}
	throw new Error(`the card drew no "${label}" chip`);
}

describe("the login card answers the pointer", () => {
	it("cancels the pending login when the close glyph is clicked", async () => {
		const { dialog, completed, rows } = makeCard();
		const answer = dialog.showPrompt({ message: "Paste your Groq API key", secret: true });
		const glyph = closeGlyphAt(rows());

		click(dialog, glyph.row, glyph.col);

		expect(dialog.signal.aborted).toBe(true);
		expect(completed).toHaveBeenCalledWith(false, "Login cancelled");
		await expect(answer).rejects.toThrow("Login cancelled");
	});

	it("cancels the pending login when the cancel chip is clicked", async () => {
		const { dialog, completed, rows } = makeCard();
		const answer = dialog.showPrompt({ message: "Paste your Groq API key", secret: true });
		const chip = chipAt(rows(), "cancel");

		click(dialog, chip.row, chip.col);

		expect(dialog.signal.aborted).toBe(true);
		expect(completed).toHaveBeenCalledWith(false, "Login cancelled");
		await expect(answer).rejects.toThrow("Login cancelled");
	});

	it("cancels the pending login when the click lands outside the card", async () => {
		const { dialog, completed, rows } = makeCard();
		const answer = dialog.showPrompt({ message: "Paste your Groq API key", secret: true });
		// The card hit-tests against the geometry of its last paint.
		rows();

		// Top-left corner of the screen: always outside a centered card.
		click(dialog, 0, 0);

		expect(dialog.signal.aborted).toBe(true);
		expect(completed).toHaveBeenCalledWith(false, "Login cancelled");
		await expect(answer).rejects.toThrow("Login cancelled");
	});

	it("skips the optional name on a chip click instead of undoing the login", async () => {
		const { dialog, completed, rows } = makeCard();
		const named = dialog.askOptionalName("Name this account (optional)", "work");
		const chip = chipAt(rows(), "skip");

		click(dialog, chip.row, chip.col);

		// The credential is already stored: dismissing means "leave it unnamed".
		await expect(named).resolves.toBeUndefined();
		expect(dialog.signal.aborted).toBe(false);
		expect(completed).not.toHaveBeenCalled();
	});

	it("leaves the login alone for a click inside the card body", () => {
		const { dialog, completed, rows } = makeCard();
		void dialog.showPrompt({ message: "Paste your Groq API key", secret: true });
		const message = chipAt(rows(), "Paste your Groq API key");

		click(dialog, message.row, message.col);

		expect(dialog.signal.aborted).toBe(false);
		expect(completed).not.toHaveBeenCalled();
	});
});
