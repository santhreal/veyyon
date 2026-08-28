import { BracketedPasteHandler, decodeReencodedPasteControls } from "../bracketed-paste";
import { getKeybindings } from "../keybindings";
import { extractPrintableText, isLoneLineFeed } from "../keys";
import { KillRing } from "../kill-ring";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui";
import {
	clampLow,
	getSegmenter,
	getWordNavKind,
	moveWordLeft,
	moveWordRight,
	padding,
	replaceTabs,
	sliceWithWidth,
	visibleWidth,
} from "../utils";

const segmenter = getSegmenter();

interface InputState {
	value: string;
	cursor: number;
}

/** Default character a masked input renders in place of each grapheme typed. */
export const DEFAULT_MASK_CHAR = "•";

/** Project a value to its masked form and map cursor position. */
export function maskValue(value: string, cursor: number, maskChar: string): { value: string; cursor: number } {
	let masked = "";
	let maskedCursor = 0;
	for (const { index } of segmenter.segment(value)) {
		if (index < cursor) maskedCursor += maskChar.length;
		masked += maskChar;
	}
	return { value: masked, cursor: Math.min(maskedCursor, masked.length) };
}

/**
 * Input component - single-line text input with horizontal scrolling
 */
export class Input implements Component, Focusable {
	#value: string = "";
	#cursor: number = 0; // Cursor position in the value
	#useTerminalCursor = false;
	/** When set, mask displayed characters with this character. */
	mask: string | undefined;
	/** Byte-preserving paste mode for credentials. */
	credentialMode = false;
	/** Rendered before the editable area; set to "" for chrome-less embedding. */
	prompt = "> ";
	onSubmit?: (value: string) => void;
	onEscape?: () => void;
	/** Optional cancel matcher evaluated after bracketed-paste framing. */
	isEscapeInput?: (data: string) => boolean;

	/** Focusable interface - set by TUI when focus changes */
	focused: boolean = false;

	// Bracketed paste mode buffering
	#pasteHandler = new BracketedPasteHandler();

	// Kill ring for Emacs-style kill/yank operations
	#killRing = new KillRing();
	#lastAction: "kill" | "yank" | "type-word" | null = null;

	// Undo support
	#undoStack: InputState[] = [];

	getValue(): string {
		return this.#value;
	}

	setValue(value: string): void {
		this.#value = value;
		// Callers seed or replace the value wholesale; typing continues at the end.
		this.#cursor = value.length;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#useTerminalCursor = useTerminalCursor;
	}

	getUseTerminalCursor(): boolean {
		return this.#useTerminalCursor;
	}

	handleInput(data: string): void {
		// Handle bracketed paste mode
		const paste = this.#pasteHandler.process(data);
		if (paste.handled) {
			// Bytes before the start marker are ordinary input; route them straight
			// to key handling (never back through the paste gate, which would fold
			// them into the active buffer).
			if (paste.prefix !== undefined && paste.prefix.length > 0) {
				this.#handleKeyInput(paste.prefix);
			}
			if (paste.pasteContent !== undefined) {
				this.#handlePaste(paste.pasteContent);
				// `remaining` follows a completed paste and may itself begin another
				// paste, so it goes through the full gate.
				if (paste.remaining.length > 0) {
					this.handleInput(paste.remaining);
				}
			}
			return;
		}

		this.#handleKeyInput(data);
	}

	#handleKeyInput(data: string): void {
		const kb = getKeybindings();

		if (this.isEscapeInput?.(data) || kb.matches(data, "tui.select.cancel")) {
			this.onEscape?.();
			return;
		}

		// Undo
		if (kb.matches(data, "tui.editor.undo")) {
			this.#undo();
			return;
		}

		// Submit
		if (kb.matches(data, "tui.input.submit") || isLoneLineFeed(data)) {
			if (this.onSubmit) this.onSubmit(this.#value);
			return;
		}

		// Deletion
		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			this.#handleBackspace();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteCharForward")) {
			this.#handleForwardDelete();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			this.#deleteWordBackwards();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteWordForward")) {
			this.#deleteWordForward();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.#deleteToLineStart();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.#deleteToLineEnd();
			return;
		}

		// Kill ring actions
		if (kb.matches(data, "tui.editor.yank")) {
			this.#yank();
			return;
		}
		if (kb.matches(data, "tui.editor.yankPop")) {
			this.#yankPop();
			return;
		}

		// Cursor movement
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.#lastAction = null;
			if (this.#cursor > 0) {
				const beforeCursor = this.#value.slice(0, this.#cursor);
				let lastGrapheme = "";
				for (const seg of segmenter.segment(beforeCursor)) lastGrapheme = seg.segment;
				this.#cursor -= lastGrapheme.length || 1;
			}
			return;
		}

		if (kb.matches(data, "tui.editor.cursorRight")) {
			this.#lastAction = null;
			if (this.#cursor < this.#value.length) {
				const afterCursor = this.#value.slice(this.#cursor);
				let firstGrapheme = "";
				for (const seg of segmenter.segment(afterCursor)) {
					firstGrapheme = seg.segment;
					break;
				}
				this.#cursor += firstGrapheme.length || 1;
			}
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.#lastAction = null;
			this.#cursor = 0;
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.#lastAction = null;
			this.#cursor = this.#value.length;
			return;
		}

		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			this.#moveWordBackwards();
			return;
		}

		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			this.#moveWordForwards();
			return;
		}

		// Regular character input, including Kitty CSI-u text-producing sequences.
		const printableText = extractPrintableText(data);
		if (printableText) {
			this.#insertCharacter(printableText);
		}
	}

	/** Apply terminal paste semantics to text from non-bracketed paste transports
	 *  (e.g. kitty's OSC 5522 enhanced clipboard read). Mirrors `Editor.pasteText`. */
	pasteText(text: string): void {
		this.#handlePaste(text);
	}

	#insertCharacter(text: string): void {
		let isWordChunk = true;
		for (const seg of segmenter.segment(text)) {
			if (getWordNavKind(seg.segment) === "whitespace") {
				isWordChunk = false;
				break;
			}
		}
		// Undo coalescing: consecutive word typing coalesces into one undo unit.
		if (!isWordChunk || this.#lastAction !== "type-word") {
			this.#pushUndo();
		}
		this.#lastAction = "type-word";

		this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
		this.#cursor += text.length;
	}

	#handleBackspace(): void {
		this.#lastAction = null;
		if (this.#cursor <= 0) {
			return;
		}

		this.#pushUndo();

		const beforeCursor = this.#value.slice(0, this.#cursor);
		let lastGrapheme = "";
		for (const seg of segmenter.segment(beforeCursor)) lastGrapheme = seg.segment;
		const graphemeLength = lastGrapheme.length || 1;

		this.#value = this.#value.slice(0, this.#cursor - graphemeLength) + this.#value.slice(this.#cursor);
		this.#cursor -= graphemeLength;
	}

	#handleForwardDelete(): void {
		this.#lastAction = null;
		if (this.#cursor >= this.#value.length) {
			return;
		}

		this.#pushUndo();

		const afterCursor = this.#value.slice(this.#cursor);
		let firstGrapheme = "";
		for (const seg of segmenter.segment(afterCursor)) {
			firstGrapheme = seg.segment;
			break;
		}
		const graphemeLength = firstGrapheme.length || 1;

		this.#value = this.#value.slice(0, this.#cursor) + this.#value.slice(this.#cursor + graphemeLength);
	}

	#deleteToLineStart(): void {
		if (this.#cursor === 0) {
			return;
		}

		this.#pushUndo();
		const deletedText = this.#value.slice(0, this.#cursor);
		this.#killRing.push(deletedText, { prepend: true, accumulate: this.#lastAction === "kill" });
		this.#lastAction = "kill";

		this.#value = this.#value.slice(this.#cursor);
		this.#cursor = 0;
	}

	#deleteToLineEnd(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}

		this.#pushUndo();
		const deletedText = this.#value.slice(this.#cursor);
		this.#killRing.push(deletedText, { prepend: false, accumulate: this.#lastAction === "kill" });
		this.#lastAction = "kill";

		this.#value = this.#value.slice(0, this.#cursor);
	}

	#deleteWordBackwards(): void {
		if (this.#cursor === 0) {
			return;
		}

		// Save state before cursor movement (moveWordBackwards resets lastAction).
		const wasKill = this.#lastAction === "kill";
		this.#pushUndo();

		const oldCursor = this.#cursor;
		this.#moveWordBackwards();
		const deleteFrom = this.#cursor;
		this.#cursor = oldCursor;

		const deletedText = this.#value.slice(deleteFrom, this.#cursor);
		this.#killRing.push(deletedText, { prepend: true, accumulate: wasKill });
		this.#lastAction = "kill";

		this.#value = this.#value.slice(0, deleteFrom) + this.#value.slice(this.#cursor);
		this.#cursor = deleteFrom;
	}

	#deleteWordForward(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}

		// Save state before cursor movement (moveWordForwards resets lastAction).
		const wasKill = this.#lastAction === "kill";
		this.#pushUndo();

		const oldCursor = this.#cursor;
		this.#moveWordForwards();
		const deleteTo = this.#cursor;
		this.#cursor = oldCursor;

		const deletedText = this.#value.slice(this.#cursor, deleteTo);
		this.#killRing.push(deletedText, { prepend: false, accumulate: wasKill });
		this.#lastAction = "kill";

		this.#value = this.#value.slice(0, this.#cursor) + this.#value.slice(deleteTo);
	}

	#yank(): void {
		const text = this.#killRing.peek();
		if (!text) {
			return;
		}

		this.#pushUndo();
		this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
		this.#cursor += text.length;
		this.#lastAction = "yank";
	}

	#yankPop(): void {
		if (this.#lastAction !== "yank" || this.#killRing.length <= 1) {
			return;
		}

		this.#pushUndo();

		const prevText = this.#killRing.peek() ?? "";
		this.#value = this.#value.slice(0, this.#cursor - prevText.length) + this.#value.slice(this.#cursor);
		this.#cursor -= prevText.length;

		this.#killRing.rotate();
		const text = this.#killRing.peek() ?? "";
		this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
		this.#cursor += text.length;
		this.#lastAction = "yank";
	}

	#pushUndo(): void {
		this.#undoStack.push({ value: this.#value, cursor: this.#cursor });
	}

	#undo(): void {
		const snapshot = this.#undoStack.pop();
		if (!snapshot) {
			return;
		}
		this.#value = snapshot.value;
		this.#cursor = snapshot.cursor;
		this.#lastAction = null;
	}

	#moveWordBackwards(): void {
		if (this.#cursor === 0) {
			return;
		}
		this.#lastAction = null;
		this.#cursor = moveWordLeft(this.#value, this.#cursor);
	}

	#moveWordForwards(): void {
		if (this.#cursor >= this.#value.length) {
			return;
		}
		this.#lastAction = null;
		this.#cursor = moveWordRight(this.#value, this.#cursor);
	}

	#handlePaste(pastedText: string): void {
		this.#lastAction = null;
		this.#pushUndo();

		// Preserve raw bytes for credentials; apply single-line cleanup otherwise.
		const insertedText = this.credentialMode
			? pastedText
			: replaceTabs(
					decodeReencodedPasteControls(pastedText).replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, ""),
				)
					.normalize("NFC")
					.replace(/[\x00-\x1F\x7F]/g, "");

		this.#value = this.#value.slice(0, this.#cursor) + insertedText + this.#value.slice(this.#cursor);
		this.#cursor += insertedText.length;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): readonly string[] {
		// Calculate visible window
		const prompt = this.prompt;
		const availableWidth = width - visibleWidth(prompt);

		if (availableWidth <= 0) {
			return [prompt];
		}

		// Apply mask if configured.
		const effectiveMask = this.credentialMode ? (this.mask ?? DEFAULT_MASK_CHAR) : this.mask;
		const { value: sourceValue, cursor: cursorIndex } =
			effectiveMask === undefined
				? { value: this.#value, cursor: this.#cursor }
				: maskValue(this.#value, this.#cursor, effectiveMask);
		// Ensure we always have a grapheme to invert at the cursor (space at end).
		const displayValue = cursorIndex >= sourceValue.length ? `${sourceValue} ` : sourceValue;

		const totalCols = visibleWidth(displayValue);
		const cursorCols = visibleWidth(displayValue.slice(0, cursorIndex));

		// Width of the grapheme at the cursor, for ensuring it fits in the viewport.
		const cursorIter = segmenter.segment(displayValue.slice(cursorIndex))[Symbol.iterator]();
		const cursorG = cursorIter.next().value?.segment ?? " ";
		const cursorGWidth = visibleWidth(cursorG);

		const maxStart = Math.max(0, totalCols - availableWidth);
		let startCol = 0;
		if (totalCols > availableWidth) {
			const half = Math.floor(availableWidth / 2);
			startCol = clampLow(cursorCols - half, 0, maxStart);

			// Ensure the cursor grapheme is inside the viewport (and fits fully if wide).
			const maxCursorRel = Math.max(0, availableWidth - cursorGWidth);
			const cursorRel = cursorCols - startCol;
			if (cursorRel > maxCursorRel) {
				startCol = clampLow(cursorCols - maxCursorRel, 0, maxStart);
			}
		}

		const visibleText = sliceWithWidth(displayValue, startCol, availableWidth, true).text;
		const prefixText = sliceWithWidth(displayValue, startCol, Math.max(0, cursorCols - startCol), true).text;
		let cursorDisplay = prefixText.length;
		cursorDisplay = clampLow(cursorDisplay, 0, visibleText.length);

		// Build the visible line and insert the cursor marker at the buffer cursor.
		let cursorGrapheme = "";
		for (const seg of segmenter.segment(visibleText.slice(cursorDisplay))) {
			cursorGrapheme = seg.segment;
			break;
		}

		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const atCursor = cursorGrapheme;
		const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);

		// Hardware cursor marker (zero-width, emitted before the cursor cell for IME positioning)
		const marker = this.focused ? CURSOR_MARKER : "";
		const cursorChar = this.#useTerminalCursor ? atCursor : `\x1b[7m${atCursor || " "}\x1b[27m`;

		// Clamp only the trailing text (measured in terminal cells), keeping the cursor marker intact.
		const beforeWidth = visibleWidth(beforeCursor);
		const cursorWidth = this.#useTerminalCursor ? visibleWidth(atCursor) : visibleWidth(atCursor || " ");
		const remainingAfterWidth = Math.max(0, availableWidth - beforeWidth - cursorWidth);
		const clampedAfterCursor = sliceWithWidth(afterCursor, 0, remainingAfterWidth, true).text;
		const renderedNoMarker = beforeCursor + cursorChar + clampedAfterCursor;
		const textWithCursor = beforeCursor + marker + cursorChar + clampedAfterCursor;

		const visualLength = visibleWidth(renderedNoMarker);
		const pad = padding(Math.max(0, availableWidth - visualLength));
		const line = prompt + textWithCursor + pad;
		return [line];
	}
}
