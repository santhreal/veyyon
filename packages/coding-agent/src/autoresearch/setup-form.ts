/**
 * The setup form: the console model's fields drawn through the TUI form, with
 * the keys the model adds on top (Delete on the preset row removes a saved
 * preset). The launcher shows it in a card of its own before a session
 * exists; the dashboard shows it as one of its views over a session. Either
 * way, every edit is applied to the host as it is made.
 */
import { type Component, Form, type MouseRoutable, matchesKey, type SgrMouseEvent } from "@veyyon/tui";
import { clamp } from "@veyyon/utils";
import { getFormTheme } from "../modes/theme/theme";
import type { ConsoleAction, LoopConsoleModel } from "./console";

export class SetupFormComponent implements Component, MouseRoutable {
	readonly #model: LoopConsoleModel;
	readonly #form: Form;
	readonly #onAction: (action: ConsoleAction) => void;
	/** First row of the last window, so a report is matched to the row it landed on. */
	#windowTop = 0;

	constructor(options: {
		model: LoopConsoleModel;
		onAction: (action: ConsoleAction) => void;
		onCancel: () => void;
	}) {
		this.#model = options.model;
		this.#onAction = options.onAction;
		this.#form = new Form(getFormTheme());
		// The form is the only thing the card focuses, so the caret is always live.
		this.#form.focused = true;
		this.#form.onCancel = options.onCancel;
		this.sync();
	}

	/** Rebuild the fields from the model; the ring and the carets survive. */
	sync(): void {
		this.#form.setFields(this.#model.formFields({ onAction: this.#onAction }));
	}

	/** The field with the ring, by id. */
	get focusedId(): string | null {
		return this.#form.focusedField?.id ?? null;
	}

	focus(id: string): void {
		this.#form.focus(id);
	}

	/** The caret of a text field, for a host asserting where a click landed. */
	caretOf(id: string): number | null {
		return this.#form.caretOf(id);
	}

	/** Footer text for the field with the ring. */
	hint(): string {
		const focused = this.#form.focusedField;
		return focused ? this.#model.hint(focused.id) : "";
	}

	invalidate(): void {}

	/**
	 * The form at `width`, windowed to `rows` around the field with the ring so
	 * a short terminal never hides what is being edited.
	 */
	render(width: number, rows = Number.POSITIVE_INFINITY): readonly string[] {
		const lines = this.#form.render(width);
		if (lines.length <= rows) {
			this.#windowTop = 0;
			return lines;
		}
		const focusedTop = this.#form.focusedTop ?? 0;
		const maxTop = lines.length - rows;
		let top = this.#windowTop;
		if (focusedTop < top) top = focusedTop;
		else if (focusedTop >= top + rows) top = focusedTop - rows + 1;
		this.#windowTop = clamp(top, 0, maxTop);
		return lines.slice(this.#windowTop, this.#windowTop + rows);
	}

	handleInput(data: string): void {
		if (this.#form.focusedField?.id === "preset" && matchesKey(data, "delete")) {
			this.#model.deletePresetInForce();
			this.sync();
			return;
		}
		this.#form.handleInput(data);
		this.sync();
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.#form.routeMouse(event, line + this.#windowTop, col);
		this.sync();
	}
}
