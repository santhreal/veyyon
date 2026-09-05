/**
 * WHY THIS SUITE EXISTS.
 *
 * A dialog of labelled values was rebuilt on top of `SelectList` more than
 * once, each with its own caret, its own stepper keys and its own idea of what
 * a click does, and each rebuild lost one of them: a digit that set a count
 * on one surface typed into a filter on the next, a click that placed a caret
 * in one dialog focused the row and nothing else in another. `Form` is the one
 * owner of that shape, and this suite pins what each kind of field takes.
 *
 * The class this closes is a field kind whose keys or clicks do something
 * other than what its kind states, and a ring that loses its place when the
 * host replaces the fields under it. Every kind is swept from the union at
 * run time: a kind added to `FormField` without a row here fails.
 *
 * What it does not catch: how a host insets the form on its card (each host's
 * suite), and colour (the theme's).
 */
import { describe, expect, it } from "bun:test";
import { CURSOR_MARKER, Form, type FormField, type FormTheme } from "@veyyon/tui";
import type { SgrMouseEvent } from "@veyyon/tui/mouse";

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const ENTER = "\r";
const BACKSPACE = "\x7f";
const ESCAPE = "\x1b";

/** A passthrough theme: the geometry is what is asserted, so no bytes are added. */
const THEME: FormTheme = {
	focusedLabel: text => text,
	label: text => text,
	value: text => text,
	placeholder: text => text,
	control: text => text,
	active: text => text,
	button: text => text,
	primaryButton: text => text,
	disabledButton: text => text,
	muted: text => text,
};

function click(col: number, line = 0): SgrMouseEvent {
	return { button: 0, col, row: line, release: false, wheel: null, motion: false, leftClick: true };
}

function wheel(direction: -1 | 1): SgrMouseEvent {
	return { button: 64, col: 0, row: 0, release: false, wheel: direction, motion: false, leftClick: false };
}

/** Every field kind, one of each, over a host that records each change. */
function fixture() {
	const state = { text: "hello", count: 3, on: false, choice: "b", pressed: 0, submitted: 0 };
	const changes: string[] = [];
	const fields = (): FormField[] => [
		{
			kind: "text",
			id: "text",
			label: "Text",
			value: state.text,
			placeholder: "type here",
			onChange: value => {
				state.text = value;
				changes.push(`text=${value}`);
			},
		},
		{
			kind: "stepper",
			id: "count",
			label: "Count",
			value: state.count,
			min: 1,
			max: 5,
			onChange: value => {
				state.count = value;
				changes.push(`count=${value}`);
			},
		},
		{
			kind: "toggle",
			id: "on",
			label: "Switch",
			value: state.on,
			onChange: value => {
				state.on = value;
				changes.push(`on=${value}`);
			},
		},
		{
			kind: "segmented",
			id: "choice",
			label: "Choice",
			options: [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
				{ value: "c", label: "C" },
			],
			value: state.choice,
			onChange: value => {
				state.choice = value;
				changes.push(`choice=${value}`);
			},
		},
		{ kind: "note", id: "note", text: "prose that takes no focus" },
		{
			kind: "button",
			id: "go",
			label: "Go",
			primary: true,
			onPress: () => {
				state.pressed += 1;
				changes.push("pressed");
			},
		},
	];
	const form = new Form(THEME, fields());
	form.focused = true;
	form.onSubmit = () => {
		state.submitted += 1;
	};
	/** A key, then the host's re-render: the fields are rebuilt from the state. */
	const press = (id: string, ...keys: string[]): void => {
		form.focus(id);
		for (const key of keys) {
			form.handleInput(key);
			form.setFields(fields());
		}
	};
	const paint = (width = 40): string[] => [...form.render(width)];
	/** A report on the row of `id` at `col`, then the host's re-render. */
	const clickOn = (id: string, col: number): void => {
		paint();
		const line = paint().findIndex(row => row.includes(labelOf(id)));
		form.routeMouse(click(col, line), line, col);
		form.setFields(fields());
	};
	const labelOf = (id: string): string => {
		const field = fields().find(entry => entry.id === id);
		return field && field.kind !== "note" ? field.label : "";
	};
	return { form, state, changes, press, paint, clickOn, fields };
}

/** Every member of the `FormField` union, read from a fixture rather than listed. */
function kindsOf(fields: readonly FormField[]): string[] {
	return [...new Set(fields.map(field => field.kind))].sort();
}

describe("a form field answers the keys and the pointer its kind takes", () => {
	it("covers every field kind the union has", () => {
		// The fixture is the sweep: a kind added to the union without a fixture
		// row is not exercised below, and this is the assertion that says so.
		expect(kindsOf(fixture().fields())).toEqual(["button", "note", "segmented", "stepper", "text", "toggle"]);
	});

	it("moves the ring with ↑↓ and Tab over the fields that take it, skipping notes and wrapping", () => {
		const { form } = fixture();
		expect(form.focusedField?.id).toBe("text");
		form.handleInput(DOWN);
		expect(form.focusedField?.id).toBe("count");
		form.handleInput(TAB);
		expect(form.focusedField?.id).toBe("on");
		form.handleInput(TAB);
		form.handleInput(TAB);
		// The note between Choice and Go is skipped.
		expect(form.focusedField?.id).toBe("go");
		form.handleInput(DOWN);
		expect(form.focusedField?.id).toBe("text");
		form.handleInput(UP);
		expect(form.focusedField?.id).toBe("go");
		form.handleInput(SHIFT_TAB);
		expect(form.focusedField?.id).toBe("choice");
		expect(form.focus("note")).toBe(false);
		expect(form.focusedField?.id).toBe("choice");
	});

	it("edits a text field in place: types, deletes a grapheme, keeps the caret, and never types a Tab or an arrow", () => {
		const { form, state, press } = fixture();
		press("text", " 🚀");
		expect(state.text).toBe("hello 🚀");
		press("text", BACKSPACE);
		expect(state.text).toBe("hello ");
		press("text", LEFT, LEFT, "X");
		expect(state.text).toBe("hellXo ");
		expect(form.caretOf("text")).toBe(5);
		press("text", TAB, UP, "\x1bOP");
		expect(state.text).toBe("hellXo ");
		// The caret survives the host replacing the fields under it.
		expect(form.caretOf("text")).toBe(5);
	});

	it("flattens an unbracketed paste with line breaks into one line rather than dropping it", () => {
		const { state, press } = fixture();
		press("text", ",\n\tworld\n");
		expect(state.text).toBe("hello,  world ");
	});

	it("moves the ring on Enter from a text field that has no submit of its own on a form with none", () => {
		const { form } = fixture();
		form.onSubmit = undefined;
		form.setFields([
			{ kind: "text", id: "a", label: "A", value: "", onChange: () => {} },
			{ kind: "text", id: "b", label: "B", value: "", onChange: () => {} },
		]);
		form.handleInput(ENTER);
		expect(form.focusedField?.id).toBe("b");
	});

	it("submits on Enter from a text field: the field's own submit first, the form's otherwise", () => {
		const { form, state, press } = fixture();
		press("text", ENTER);
		expect(state.submitted).toBe(1);
		let own = 0;
		form.setFields([
			{ kind: "text", id: "t", label: "T", value: "", onChange: () => {}, onSubmit: () => void own++ },
		]);
		form.handleInput(ENTER);
		expect(own).toBe(1);
		expect(state.submitted).toBe(1);
	});

	it("steps a count with ←→ inside its bounds, types it with digits, and drops a digit past the bound", () => {
		const { state, press } = fixture();
		press("count", RIGHT, RIGHT, RIGHT);
		expect(state.count).toBe(5);
		press("count", LEFT, LEFT, LEFT, LEFT, LEFT, LEFT);
		expect(state.count).toBe(1);
		press("count", "4");
		expect(state.count).toBe(4);
		// `9` fits neither appended (49) nor alone: dropped, not clamped.
		press("count", "9");
		expect(state.count).toBe(4);
		// `2` does not fit appended (42) but fits alone: a fresh value.
		press("count", "2");
		expect(state.count).toBe(2);
		press("count", "0");
		expect(state.count).toBe(2);
	});

	it("appends digits typed in a row on a wide stepper, and Backspace drops the last one", () => {
		const { form } = fixture();
		let value = 0;
		const wide = (): FormField[] => [
			{
				kind: "stepper",
				id: "n",
				label: "N",
				value,
				min: 0,
				max: 999,
				onChange: next => {
					value = next;
				},
			},
			{ kind: "text", id: "t", label: "T", value: "", onChange: () => {} },
		];
		form.setFields(wide());
		const press = (...keys: string[]): void => {
			for (const key of keys) {
				form.handleInput(key);
				form.setFields(wide());
			}
		};
		press("2", "5", "0");
		expect(value).toBe(250);
		press(BACKSPACE);
		expect(value).toBe(25);
		// An arrow ends the run: the next digit replaces rather than appends.
		press(RIGHT, "7");
		expect(value).toBe(7);
		// So does leaving the field and coming back.
		press("8");
		expect(value).toBe(78);
		form.focus("t");
		form.focus("n");
		press("9");
		expect(value).toBe(9);
		press(BACKSPACE, BACKSPACE);
		expect(value).toBe(0);
	});

	it("ends a run of typed digits on a clicked arrow, so the next digit replaces the stepped value", () => {
		const { form } = fixture();
		let value = 0;
		const wide = (): FormField[] => [
			{
				kind: "stepper",
				id: "n",
				label: "N",
				value,
				min: 0,
				max: 999,
				onChange: next => {
					value = next;
				},
			},
		];
		form.setFields(wide());
		form.handleInput("2");
		form.setFields(wide());
		expect(value).toBe(2);
		// `◂ 2 ▸` from the value column 5: the increment arrow is cell 9.
		form.render(40);
		form.routeMouse(click(9), 0, 9);
		form.setFields(wide());
		expect(value).toBe(3);
		// Appended, this would be 34.
		form.handleInput("4");
		expect(value).toBe(4);
	});

	it("flips a switch on Space, Enter and ←→, and nothing else", () => {
		const { state, press } = fixture();
		press("on", " ");
		expect(state.on).toBe(true);
		press("on", ENTER);
		expect(state.on).toBe(false);
		press("on", LEFT);
		expect(state.on).toBe(true);
		press("on", RIGHT);
		expect(state.on).toBe(false);
		press("on", "x", "1", BACKSPACE);
		expect(state.on).toBe(false);
	});

	it("walks a segmented field with ←→, wrapping, and a letter picks nothing", () => {
		const { state, press } = fixture();
		press("choice", RIGHT);
		expect(state.choice).toBe("c");
		press("choice", RIGHT);
		expect(state.choice).toBe("a");
		press("choice", LEFT);
		expect(state.choice).toBe("c");
		press("choice", "a");
		expect(state.choice).toBe("c");
	});

	it("walks a segmented field with nothing chosen onto its first option with → and its last with ←", () => {
		const { form } = fixture();
		const state: { choice: string | null } = { choice: null };
		const fields = (): FormField[] => [
			{
				kind: "segmented",
				id: "c",
				label: "C",
				options: [
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
					{ value: "c", label: "C" },
				],
				value: state.choice,
				onChange: value => {
					state.choice = value;
				},
			},
		];
		const chosen = (): string | null => state.choice;
		form.setFields(fields());
		form.handleInput(LEFT);
		expect(chosen()).toBe("c");
		state.choice = null;
		form.setFields(fields());
		form.handleInput(RIGHT);
		expect(chosen()).toBe("a");
	});

	it("windows a chip strip wider than the row so the chosen chip is painted and clickable", () => {
		const { form } = fixture();
		let choice = "opt-8";
		const options = Array.from({ length: 9 }, (_, index) => ({ value: `opt-${index}`, label: `opt-${index}` }));
		const fields = (): FormField[] => [
			{
				kind: "segmented",
				id: "c",
				label: "C",
				options,
				value: choice,
				onChange: value => {
					choice = value;
				},
			},
		];
		form.setFields(fields());
		// Value column 5 (marker 2, label 1, gap 2); 25 cells of chips at 30 wide
		// hold three `opt-N` chips and the ellipsis, so the strip starts at
		// opt-6 and the chosen opt-8 is on the row.
		const row = form.render(30)[0] ?? "";
		expect(row).toBe("▸ C  …  opt-6  opt-7  opt-8");
		// The chips are click targets where they were painted, not where an
		// unwindowed strip would have put them.
		form.routeMouse(click(15), 0, 15);
		expect(choice).toBe("opt-7");
		form.setFields(fields());
		// The window follows the choice: opt-7 chosen, the strip starts at opt-5
		// and the chip after the window is the trailing ellipsis.
		expect(form.render(30)[0]).toBe("▸ C  …  opt-5  opt-6  opt-7  …");
		choice = "opt-0";
		form.setFields(fields());
		expect(form.render(30)[0]).toMatch(/^▸ C {2}opt-0 {2}opt-1 {2}opt-2/);
	});

	it("presses a button on Enter or Space, and never a disabled one", () => {
		const { form, state, press, fields } = fixture();
		press("go", ENTER);
		press("go", " ");
		expect(state.pressed).toBe(2);
		form.setFields(fields().map(field => (field.kind === "button" ? { ...field, disabled: "not yet" } : field)));
		form.focus("go");
		form.handleInput(ENTER);
		expect(state.pressed).toBe(2);
		expect(form.render(40).join("\n")).toContain("[ Go ]  not yet");
	});

	it("keeps the ring on the same id when the fields are replaced, and moves it off a field that vanished", () => {
		const { form, fields } = fixture();
		form.focus("on");
		form.setFields(fields().filter(field => field.id !== "count"));
		expect(form.focusedField?.id).toBe("on");
		form.setFields(fields().filter(field => field.id !== "on"));
		expect(form.focusedField?.id).toBe("text");
		let moved: string[] = [];
		form.onFocusChange = field => {
			moved = [...moved, field.id];
		};
		form.handleInput(DOWN);
		expect(moved).toEqual(["count"]);
	});

	it("lays every value out at one column, after the widest label, and paints the ring marker on the focused row", () => {
		const { form, paint, press } = fixture();
		const lines = paint(40);
		// Marker (2), widest label "Switch" (6), gap (2).
		const column = 10;
		for (const line of lines) {
			// A note and a button have no label column.
			if (line.startsWith("  prose") || line.startsWith("  [")) continue;
			expect(line.slice(column - 2, column)).toBe("  ");
			expect(line.charAt(column)).not.toBe(" ");
		}
		expect(lines[0]).toMatch(/^▸ Text {4}/);
		form.focus("count");
		expect(paint(40)[1]).toMatch(/^▸ Count {3}◂ 3 ▸/);
		// At a bound the arrow that cannot step is not drawn, and the value
		// still starts at the column rather than after an empty arrow slot.
		press("count", LEFT, LEFT);
		expect(paint(40)[1]).toMatch(/^▸ Count {3}1 ▸/);
		press("count", RIGHT, RIGHT, RIGHT, RIGHT);
		expect(paint(40)[1]).toMatch(/^▸ Count {3}◂ 5$/);
		expect(paint(40)[3]).toMatch(/^ {2}Choice {2}A {2}B {2}C/);
		// A button has no label column: the label is the button.
		expect(paint(40).at(-1)).toMatch(/^ {2}\[ Go \]/);
	});

	it("shows the placeholder beside the caret of an empty focused text field", () => {
		const form = new Form(THEME, [
			{ kind: "text", id: "t", label: "T", value: "", placeholder: "what to do", onChange: () => {} },
		]);
		form.focused = true;
		// Style bytes off; the cursor marker stays, so its column can be read.
		const line = (form.render(40)[0] ?? "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
		// The caret is the cursor marker on the cell at the value column, and the
		// placeholder follows it on the same row.
		expect(line.indexOf(CURSOR_MARKER)).toBe("▸ T  ".length);
		expect(line.replaceAll(CURSOR_MARKER, "")).toMatch(/^▸ T {2} ?what to do/);
		form.focused = false;
		expect(form.render(40)[0]).toBe("▸ T  what to do");
	});

	it("routes a click to the field under it: the caret lands under the pointer, an arrow steps, an option is picked, a switch flips, a button presses", () => {
		const { form, state, clickOn } = fixture();
		// Column 10 is the value column at width 40 (see the layout case).
		clickOn("text", 12);
		expect(form.focusedField?.id).toBe("text");
		expect(form.caretOf("text")).toBe(2);
		clickOn("count", 10);
		expect(state.count).toBe(2);
		clickOn("count", 14);
		expect(state.count).toBe(3);
		clickOn("on", 11);
		expect(state.on).toBe(true);
		// Options are `A  B  C` from the value column: chips two cells apart.
		clickOn("choice", 16);
		expect(state.choice).toBe("c");
		clickOn("choice", 13);
		expect(state.choice).toBe("b");
		clickOn("go", 3);
		expect(state.pressed).toBe(1);
		// A click on the label puts the ring on the field and edits nothing.
		clickOn("on", 2);
		expect(form.focusedField?.id).toBe("on");
		expect(state.on).toBe(true);
	});

	it("resolves a click that moves the ring onto a text field against the unscrolled paint", () => {
		const { form, state, fields, clickOn } = fixture();
		// Sixty cells in a thirty-cell value area: with the ring on it and the
		// caret at the end, the input paints the tail. With the ring elsewhere
		// the form paints the head, and a click on cell 2 of that paint is
		// offset 2, not 2 plus the input's last scroll.
		state.text = `HEAD${"x".repeat(52)}TAIL`;
		form.setFields(fields());
		form.focus("text");
		expect(form.caretOf("text")).toBe(60);
		expect(form.render(40)[0]).toContain("TAIL");
		form.handleInput(DOWN);
		expect(form.render(40)[0]).toContain("HEAD");
		clickOn("text", 12);
		expect(form.focusedField?.id).toBe("text");
		expect(form.caretOf("text")).toBe(2);
		// With the ring on it the paint is scrolled, and the click follows that
		// paint: cell 2 of a tail painted from column 31 is offset 33.
		form.handleInput("\x05");
		expect(form.caretOf("text")).toBe(60);
		clickOn("text", 12);
		expect(form.caretOf("text")).toBe(33);
	});

	it("walks the ring with the wheel, and leaves the note out", () => {
		const { form } = fixture();
		form.focus("choice");
		form.routeMouse(wheel(1), 0, 0);
		expect(form.focusedField?.id).toBe("go");
		form.routeMouse(wheel(-1), 0, 0);
		expect(form.focusedField?.id).toBe("choice");
	});

	it("cancels on Escape from any field", () => {
		const { form } = fixture();
		let cancelled = 0;
		form.onCancel = () => {
			cancelled += 1;
		};
		for (const id of ["text", "count", "on", "choice", "go"]) {
			form.focus(id);
			form.handleInput(ESCAPE);
		}
		expect(cancelled).toBe(5);
	});
});
