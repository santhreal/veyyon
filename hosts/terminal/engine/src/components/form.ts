/**
 * Form: a column of labelled fields with one focus ring.
 *
 * A dialog that sets a handful of values (a goal, a count, a switch, a
 * choice, a button that runs it) has been rebuilt on top of {@link SelectList}
 * more than once, each time with its own caret, its own stepper keys and its
 * own idea of what a click does. This is the one owner of that shape: the host
 * describes the fields as data, the form owns the ring, the in-field caret, the
 * keys each kind of field takes and the pointer, and calls back with a new
 * value. The host keeps the values; the form keeps only what a field needs
 * between frames (the text fields' carets).
 *
 * Kinds:
 * - `text`: a single line edited in place through {@link Input}, so it has
 *   the same word motion, kill ring and paste handling as every other field.
 * - `stepper`: an integer within bounds. ←→ step it, digits type it (a second
 *   digit in a row appends, so `2` then `5` is 25), Backspace drops the last
 *   digit, and the arrow glyphs are click targets.
 * - `toggle`: a switch. Space, Enter, ←→ and a click flip it.
 * - `segmented`: one of a few options in a row. ←→ walk them, a click on an
 *   option picks it. A strip wider than the row is windowed so the chosen
 *   option is on it.
 * - `button`: Enter or a click presses it; a disabled button states why.
 * - `note`: prose that takes no focus, wrapped to the form.
 *
 * Keys the ring owns: ↑↓ and Tab/Shift+Tab move focus over the fields that
 * take it; Escape is {@link Form.onCancel}; Enter on a text field is the
 * field's own submit, else {@link Form.onSubmit} (the dialog's default
 * action), else it moves the ring to the next field.
 */
import { extractPrintableText, matchesKey } from "@veyyon/utils/keys";
import { clampLow } from "@veyyon/utils/math";
import type { MouseRoutable, SgrMouseEvent } from "@veyyon/utils/mouse";
import { padding } from "@veyyon/utils/padding";
import { offsetAtVisualCol, truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { wrapTextWithAnsi } from "@veyyon/utils/wrap";
import type { Component, Focusable } from "../tui";
import { Input } from "./input";

interface FormFieldBase {
	/** Stable across frames: the ring is kept by id when the fields are replaced. */
	id: string;
	label: string;
	/** Footer text while this field has the ring, for the host to print. */
	hint?: string;
}

export interface FormTextField extends FormFieldBase {
	kind: "text";
	value: string;
	/** Shown dimmed in place of an empty value. */
	placeholder?: string;
	onChange: (value: string) => void;
	/** Enter on this field. Absent, Enter is the form's submit, or moves on when the form has none. */
	onSubmit?: () => void;
}

export interface FormStepperField extends FormFieldBase {
	kind: "stepper";
	value: number;
	min: number;
	max: number;
	/** The value as printed; defaults to the number. */
	format?: (value: number) => string;
	onChange: (value: number) => void;
}

export interface FormToggleField extends FormFieldBase {
	kind: "toggle";
	value: boolean;
	/** Printed beside the switch; defaults to on/off. */
	labels?: { on: string; off: string };
	onChange: (value: boolean) => void;
}

export interface FormSegmentedOption {
	value: string;
	label: string;
}

export interface FormSegmentedField extends FormFieldBase {
	kind: "segmented";
	options: readonly FormSegmentedOption[];
	/** The selected option's value, or null when none is. */
	value: string | null;
	onChange: (value: string) => void;
}

export interface FormButtonField extends FormFieldBase {
	kind: "button";
	/** Why the button cannot be pressed, printed after it; null or absent when it can. */
	disabled?: string | null;
	/** The dialog's default action: painted as such. */
	primary?: boolean;
	onPress: () => void;
}

export interface FormNote {
	kind: "note";
	id: string;
	text: string;
}

export type FormField =
	| FormTextField
	| FormStepperField
	| FormToggleField
	| FormSegmentedField
	| FormButtonField
	| FormNote;

export type FocusableFormField = Exclude<FormField, FormNote>;

export interface FormTheme {
	/** The ring marker and the label of the field that has the ring. */
	focusedLabel: (text: string) => string;
	label: (text: string) => string;
	value: (text: string) => string;
	placeholder: (text: string) => string;
	/** The arrow glyphs of a stepper and the inactive options of a segmented field. */
	control: (text: string) => string;
	/** The active option of a segmented field and the on state of a toggle. */
	active: (text: string) => string;
	button: (text: string) => string;
	primaryButton: (text: string) => string;
	disabledButton: (text: string) => string;
	/** The reason a button is disabled, and a note's prose. */
	muted: (text: string) => string;
	/** The switch glyphs; defaults to `●`/`○`, the stepper arrows to `◂`/`▸`. */
	symbols?: { on?: string; off?: string; decrement?: string; increment?: string; marker?: string };
}

/** Where a field landed in the last paint, in the form's own cells. */
interface FieldGeometry {
	id: string;
	top: number;
	rows: number;
	/** First column of the value area, after the label column. */
	valueCol: number;
	/** For a segmented field: each option's column span; for a stepper: the two arrows. */
	targets: readonly { value: string; col: number; width: number }[];
	/** A text field the input painted, scrolled to its caret; else the form painted it from its first column. */
	byInput: boolean;
}

const DEFAULT_SYMBOLS = { on: "●", off: "○", decrement: "◂", increment: "▸", marker: "▸" } as const;

/** Columns between the label column and the value. */
const LABEL_GAP = 2;
/** Columns the ring marker takes before the label. */
const MARKER_WIDTH = 2;
/** Columns between the chips of a segmented field. */
const SEGMENT_GAP = 2;
/** Columns the leading ellipsis of a windowed chip strip takes. */
const ELLIPSIS_WIDTH = 1;

export class Form implements Component, Focusable, MouseRoutable {
	focused = false;
	onCancel?: () => void;
	/** Enter on a text field with no submit of its own. */
	onSubmit?: () => void;
	/** The ring moved, by key or pointer. */
	onFocusChange?: (field: FocusableFormField) => void;

	#fields: readonly FormField[] = [];
	#focusedId: string | null = null;
	#inputs = new Map<string, Input>();
	#theme: FormTheme;
	#geometry: FieldGeometry[] = [];
	/** Label column, as wide as the widest label; set by {@link setFields}. */
	#labelWidth = 0;
	/** The stepper the last key typed a digit into, so the next digit appends rather than replaces. */
	#typingInto: string | null = null;

	constructor(theme: FormTheme, fields: readonly FormField[] = []) {
		this.#theme = theme;
		this.setFields(fields);
	}

	/**
	 * Replace the fields. The ring stays on the field with the same id; a
	 * field that vanished under it moves the ring to the nearest one that
	 * takes focus. Text fields keep their caret across the replacement, and a
	 * value the host changed under a text field resets the caret to its end.
	 */
	setFields(fields: readonly FormField[]): void {
		this.#fields = fields;
		this.#labelWidth = 0;
		const live = new Set<string>();
		for (const field of fields) {
			if (field.kind === "note") continue;
			live.add(field.id);
			// A button has no label column, so its label does not widen it.
			if (field.kind !== "button") this.#labelWidth = Math.max(this.#labelWidth, visibleWidth(field.label));
			if (field.kind === "text") {
				let input = this.#inputs.get(field.id);
				if (!input) {
					input = new Input();
					input.prompt = "";
					this.#inputs.set(field.id, input);
				}
				if (input.getValue() !== field.value) input.setValue(field.value);
			}
		}
		for (const id of this.#inputs.keys()) if (!live.has(id)) this.#inputs.delete(id);
		if (this.#focusedId !== null && live.has(this.#focusedId)) {
			this.#syncInputFocus();
			return;
		}
		const first = this.#focusable()[0];
		this.#focusedId = first ? first.id : null;
		this.#syncInputFocus();
	}

	get fields(): readonly FormField[] {
		return this.#fields;
	}

	/** The field with the ring, or null when nothing takes focus. */
	get focusedField(): FocusableFormField | null {
		if (this.#focusedId === null) return null;
		const field = this.#fields.find(entry => entry.id === this.#focusedId);
		return field && field.kind !== "note" ? field : null;
	}

	/** Row of the field with the ring in the last paint, or null before one. */
	get focusedTop(): number | null {
		return this.#geometry.find(entry => entry.id === this.#focusedId)?.top ?? null;
	}

	/** Put the ring on `id`. A note or an unknown id is ignored. */
	focus(id: string): boolean {
		const field = this.#fields.find(entry => entry.id === id);
		if (!field || field.kind === "note") return false;
		if (this.#focusedId !== id) {
			this.#focusedId = id;
			this.#typingInto = null;
			this.#syncInputFocus();
			this.onFocusChange?.(field);
		}
		return true;
	}

	/** The caret offset of a text field, for a host that asserts where a click landed. */
	caretOf(id: string): number | null {
		const input = this.#inputs.get(id);
		return input ? input.getCursor() : null;
	}

	invalidate(): void {}

	#focusable(): FocusableFormField[] {
		return this.#fields.filter((field): field is FocusableFormField => field.kind !== "note");
	}

	#syncInputFocus(): void {
		for (const [id, input] of this.#inputs) input.focused = this.focused && id === this.#focusedId;
	}

	#move(step: 1 | -1): void {
		const ring = this.#focusable();
		if (ring.length === 0) return;
		const current = ring.findIndex(field => field.id === this.#focusedId);
		const next = ring[(current + step + ring.length) % ring.length]!;
		this.focus(next.id);
	}

	handleInput(data: string): void {
		this.#syncInputFocus();
		if (matchesKey(data, "escape")) {
			this.onCancel?.();
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "tab")) {
			this.#move(1);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
			this.#move(-1);
			return;
		}
		const field = this.focusedField;
		if (!field) return;
		switch (field.kind) {
			case "text":
				this.#textKey(field, data);
				return;
			case "stepper":
				this.#stepperKey(field, data);
				return;
			case "toggle":
				if (isEnter(data) || data === " " || matchesKey(data, "left") || matchesKey(data, "right"))
					field.onChange(!field.value);
				return;
			case "segmented":
				this.#segmentedKey(field, data);
				return;
			case "button":
				if (isEnter(data) || data === " ") this.#press(field);
				return;
		}
	}

	#press(field: FormButtonField): void {
		if (field.disabled) return;
		field.onPress();
	}

	#textKey(field: FormTextField, data: string): void {
		const input = this.#inputs.get(field.id);
		if (!input) return;
		if (isEnter(data)) {
			// Enter submits where something takes the submit; otherwise it moves
			// on, since a field that swallows Enter reads as a form that is stuck.
			if (field.onSubmit) field.onSubmit();
			else if (this.onSubmit) this.onSubmit();
			else this.#move(1);
			return;
		}
		const before = input.getValue();
		// A chunk with a line break and no escape is a paste a transport did not
		// bracket (a list pasted into a pipe, a chunk ending in the newline that
		// terminated it). Fed as keys it would type nothing, since a control
		// byte makes the whole chunk unprintable; a break is a separator, so it
		// is a space.
		if (data.length > 1 && !data.includes("\x1b") && /[\r\n\t]/.test(data)) {
			input.pasteText(data.replace(/\r\n?|\n|\t/g, " "));
		} else {
			input.handleInput(data);
		}
		const after = input.getValue();
		if (after !== before) field.onChange(after);
	}

	#stepperKey(field: FormStepperField, data: string): void {
		const delta = matchesKey(data, "left") ? -1 : matchesKey(data, "right") ? 1 : 0;
		if (delta !== 0) {
			this.#step(field, delta);
			return;
		}
		if (matchesKey(data, "backspace")) {
			// Backspace drops the last digit typed, and a value that falls below
			// the floor lands on it, so a count is erased rather than stuck.
			this.#typingInto = field.id;
			const next = Math.max(field.min, Math.floor(field.value / 10));
			if (next !== field.value) field.onChange(next);
			return;
		}
		const digit = extractPrintableText(data);
		if (digit === undefined || !/^[0-9]$/.test(digit)) {
			this.#typingInto = null;
			return;
		}
		// A digit right after another appends: `2`, `5`, `0` is 250. The first
		// digit on a field replaces its value, and so does one whose appending
		// would overflow the bounds, so `5` then `2` on a field that stops at 5
		// is 2. A digit that fits neither way is dropped rather than clamped,
		// since `9` on that field is a typo, not a request for the maximum.
		const typed = Number(digit);
		const fits = (value: number): boolean => value >= field.min && value <= field.max;
		const appended = this.#typingInto === field.id ? field.value * 10 + typed : typed;
		this.#typingInto = field.id;
		const next = fits(appended) ? appended : fits(typed) ? typed : field.value;
		if (next !== field.value) field.onChange(next);
	}

	#step(field: FormStepperField, delta: number): void {
		// A step ends a run of typed digits, whether it came by key or by click:
		// the next digit replaces the stepped value rather than appending to it.
		this.#typingInto = null;
		const next = clampLow(field.value + delta, field.min, field.max);
		if (next !== field.value) field.onChange(next);
	}

	#segmentedKey(field: FormSegmentedField, data: string): void {
		const delta = matchesKey(data, "left") ? -1 : matchesKey(data, "right") || data === " " ? 1 : 0;
		if (delta === 0 || field.options.length === 0) return;
		const current = field.options.findIndex(option => option.value === field.value);
		// With nothing chosen, → is the first option and ← the last; the walk
		// from -1 would otherwise land ← on the second to last.
		const index =
			current < 0
				? delta > 0
					? 0
					: field.options.length - 1
				: (current + delta + field.options.length) % field.options.length;
		const next = field.options[index]!;
		if (next.value !== field.value) field.onChange(next.value);
	}

	/**
	 * A report in the form's cells. A click on a field's rows puts the ring on
	 * it and, for the kinds a click can operate, operates it: the caret lands
	 * under the pointer in a text field, an arrow steps a stepper, an option is
	 * picked, a switch flips, a button is pressed. The wheel walks the ring.
	 */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (event.wheel !== null) {
			this.#move(event.wheel < 0 ? -1 : 1);
			return;
		}
		if (!event.leftClick) return;
		const hit = this.#geometry.find(entry => line >= entry.top && line < entry.top + entry.rows);
		if (!hit) return;
		const field = this.#fields.find(entry => entry.id === hit.id);
		if (!field || field.kind === "note") return;
		this.focus(field.id);
		switch (field.kind) {
			case "text": {
				const input = this.#inputs.get(field.id);
				if (!input || col < hit.valueCol) return;
				// The input painted the field with the ring, scrolled to its caret;
				// the form painted any other from its first column. The click
				// resolves against the paint it landed on.
				if (hit.byInput) input.routeMouse(event, 0, col - hit.valueCol);
				else input.setCursor(offsetAtVisualCol(field.value, col - hit.valueCol));
				return;
			}
			case "stepper": {
				const arrow = hit.targets.find(target => col >= target.col && col < target.col + target.width);
				if (arrow) this.#step(field, arrow.value === "-" ? -1 : 1);
				return;
			}
			case "toggle":
				if (col >= hit.valueCol) field.onChange(!field.value);
				return;
			case "segmented": {
				const option = hit.targets.find(target => col >= target.col && col < target.col + target.width);
				if (option && option.value !== field.value) field.onChange(option.value);
				return;
			}
			case "button":
				this.#press(field);
				return;
		}
	}

	render(width: number): readonly string[] {
		this.#syncInputFocus();
		const theme = this.#theme;
		const symbols = { ...DEFAULT_SYMBOLS, ...theme.symbols };
		const lines: string[] = [];
		const geometry: FieldGeometry[] = [];
		const labelWidth = Math.min(this.#labelWidth, Math.max(0, width - MARKER_WIDTH - LABEL_GAP - 4));
		const valueCol = MARKER_WIDTH + labelWidth + LABEL_GAP;
		const valueWidth = Math.max(1, width - valueCol);
		for (const field of this.#fields) {
			if (field.kind === "note") {
				const wrapped = wrapTextWithAnsi(field.text, Math.max(1, width - MARKER_WIDTH));
				const top = lines.length;
				for (const row of wrapped) lines.push(padding(MARKER_WIDTH) + theme.muted(row));
				geometry.push({
					id: field.id,
					top,
					rows: wrapped.length,
					valueCol: MARKER_WIDTH,
					targets: [],
					byInput: false,
				});
				continue;
			}
			const focused = field.id === this.#focusedId;
			const marker = focused ? theme.focusedLabel(symbols.marker.padEnd(MARKER_WIDTH)) : padding(MARKER_WIDTH);
			const label = truncateToWidth(field.label, labelWidth, null, true);
			const head = `${marker}${focused ? theme.focusedLabel(label) : theme.label(label)}${padding(LABEL_GAP)}`;
			const targets: { value: string; col: number; width: number }[] = [];
			let byInput = false;
			let body: string;
			switch (field.kind) {
				case "text": {
					const input = this.#inputs.get(field.id);
					if (focused && this.focused && input) {
						byInput = true;
						if (field.value.length === 0 && field.placeholder && valueWidth > 1) {
							// An empty field with the ring shows its caret, then what it
							// is for: a bare inverse cell on a row named "Goal" is not
							// a prompt.
							const caret = input.render(1)[0] ?? "";
							body = `${caret}${theme.placeholder(truncateToWidth(field.placeholder, valueWidth - 1))}`;
						} else {
							body = input.render(valueWidth)[0] ?? "";
						}
					} else if (field.value.length > 0) {
						body = theme.value(truncateToWidth(field.value, valueWidth));
					} else {
						body = theme.placeholder(truncateToWidth(field.placeholder ?? "", valueWidth));
					}
					break;
				}
				case "stepper": {
					// The value starts at the column; an arrow is drawn only where a
					// step in that direction exists, so a stepper at its floor has no
					// empty arrow slot ahead of its value.
					const shown = field.format ? field.format(field.value) : String(field.value);
					const parts: string[] = [];
					let col = valueCol;
					if (field.value > field.min) {
						const decrementWidth = visibleWidth(symbols.decrement);
						targets.push({ value: "-", col, width: decrementWidth });
						parts.push(theme.control(symbols.decrement), " ");
						col += decrementWidth + 1;
					}
					parts.push(theme.value(shown));
					col += visibleWidth(shown);
					if (field.value < field.max) {
						targets.push({ value: "+", col: col + 1, width: visibleWidth(symbols.increment) });
						parts.push(" ", theme.control(symbols.increment));
					}
					body = truncateToWidth(parts.join(""), valueWidth);
					break;
				}
				case "toggle": {
					const labels = field.labels ?? { on: "on", off: "off" };
					const glyph = field.value ? symbols.on : symbols.off;
					const text = `${glyph} ${field.value ? labels.on : labels.off}`;
					body = truncateToWidth(field.value ? theme.active(text) : theme.control(text), valueWidth);
					break;
				}
				case "segmented": {
					// Chips from the column, two cells apart; the chosen one is painted.
					// A strip wider than the value area is windowed so the chosen chip
					// is on the row: the chips before the window are one ellipsis.
					const widths = field.options.map(option => visibleWidth(option.label));
					const chosen = field.options.findIndex(option => option.value === field.value);
					let first = 0;
					const chosenEnd = (): number => {
						let end = first > 0 ? ELLIPSIS_WIDTH + SEGMENT_GAP : 0;
						for (let index = first; index <= chosen; index++)
							end += widths[index]! + (index > first ? SEGMENT_GAP : 0);
						return end;
					};
					while (first < chosen && chosenEnd() > valueWidth) first++;
					const parts: string[] = [];
					let col = valueCol;
					if (first > 0) {
						parts.push(theme.muted("…"));
						col += ELLIPSIS_WIDTH + SEGMENT_GAP;
					}
					for (let index = first; index < field.options.length; index++) {
						const option = field.options[index]!;
						targets.push({ value: option.value, col, width: widths[index]! });
						parts.push(option.value === field.value ? theme.active(option.label) : theme.control(option.label));
						col += widths[index]! + SEGMENT_GAP;
					}
					body = truncateToWidth(parts.join(padding(SEGMENT_GAP)), valueWidth);
					break;
				}
				case "button": {
					const text = `[ ${field.label} ]`;
					const paint = field.disabled ? theme.disabledButton : field.primary ? theme.primaryButton : theme.button;
					const reason = field.disabled ? `  ${theme.muted(field.disabled)}` : "";
					body = truncateToWidth(`${paint(text)}${reason}`, Math.max(1, width - MARKER_WIDTH));
					break;
				}
			}
			const top = lines.length;
			if (field.kind === "button") {
				// A button has no label column: the label is the button.
				lines.push(`${marker}${body}`);
				geometry.push({ id: field.id, top, rows: 1, valueCol: MARKER_WIDTH, targets, byInput });
			} else {
				lines.push(`${head}${body}`);
				geometry.push({ id: field.id, top, rows: 1, valueCol, targets, byInput });
			}
		}
		this.#geometry = geometry;
		return lines;
	}
}

function isEnter(data: string): boolean {
	return matchesKey(data, "return") || matchesKey(data, "enter") || data === "\n";
}
