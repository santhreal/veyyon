/**
 * WHY. `HookInputComponent` and `HookEditorComponent` are the other two hook
 * dialogs: the single-field prompt behind `ui.input` and every credential
 * question, and the multi-line editor behind `ui.editor` and the ask tool's
 * custom answer. Both were bare stacks between two DynamicBorder rules with the
 * keys written into a dim line, so neither had a close glyph and neither read a
 * mouse report. They are ModalShell cards now, and a card that paints a close
 * glyph and clickable chips has to answer the pointer or it lies.
 *
 * THE CLASS THIS CLOSES. For each of the two cards: the chip set (pinned by
 * exact equality, so a new chip turns this RED until someone decides what a
 * click on it does), the close glyph, a click outside the card, the cancel
 * chip, the submit chip, and chip hover repaints. It also pins the seam that
 * separates the two presentations: an embedded editor draws no frame and reads
 * no mouse of its own, because its host's card offsets every row it would
 * hit-test against.
 *
 * WHAT IT DOES NOT CATCH. One width and one height, so nothing about a footer
 * that wraps to two rows. It says nothing about the editor's own text handling
 * (`hook-editor.test.ts` owns that) or the countdown (`hook-input-timeout`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { HookEditorComponent } from "@veyyon/coding-agent/modes/components/hook-editor";
import { HookInputComponent } from "@veyyon/coding-agent/modes/components/hook-input";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy, setKeybindings, type TUI } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

// Wide enough that a three-chip footer stays on one row: the wrapped footer is
// the modal shell's own contract, not either dialog's, and reading chips off a
// wrapped row would only re-test the shell's wrapping.
const WIDTH = 160;
const ROWS = 40;

let policy: AnsiPolicy;
let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	// Every chip label carrying a chord reads it from the live binding, so the
	// suite pins the manager rather than inheriting whatever ran before it.
	setKeybindings(KeybindingsManager.inMemory());
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: ROWS });
});
afterEach(() => {
	setAnsiPolicy(policy);
	geometry.restore();
	vi.restoreAllMocks();
});

function motionAt(row1: number, col1 = 40): string {
	return `\x1b[<35;${col1};${row1}M`;
}
function clickAt(row1: number, col1 = 40): string {
	return `\x1b[<0;${col1};${row1}M`;
}

function createTui(): TUI {
	return {
		requestRender: vi.fn(),
		requestComponentRender: vi.fn(),
		setFocus: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
		terminal: { columns: WIDTH, rows: ROWS },
	} as unknown as TUI;
}

/** Stripped frame of whatever card the component last painted. */
function frameOf(component: { render(width: number): readonly string[] }): string[] {
	return [...component.render(WIDTH)].map(line => Bun.stripANSI(line));
}

/** 1-based row/col of the close glyph. */
function closeGlyph(lines: string[]): { row: number; col: number } {
	const row = lines.findIndex(line => line.includes("[x]"));
	expect(row, "close glyph row").toBeGreaterThanOrEqual(0);
	return { row: row + 1, col: (lines[row] as string).indexOf("[x]") + 2 };
}

/** 1-based row/col inside the footer chip carrying `label`. */
function chip(lines: string[], label: string): { row: number; col: number } {
	const row = lines.findIndex(line => line.includes(label));
	expect(row, `footer row carrying ${JSON.stringify(label)}`).toBeGreaterThanOrEqual(0);
	return { row: row + 1, col: (lines[row] as string).indexOf(label) + 2 };
}
/** Footer chip labels, in order, across every footer row. */
function chipLabels(lines: string[]): string[] {
	const footer = lines.filter(line => line.includes("·"));
	expect(footer.length, "footer rows").toBeGreaterThan(0);
	return footer
		.join("·")
		.replaceAll("│", "")
		.split("·")
		.map(part => part.trim())
		.filter(part => part.length > 0);
}

describe("the hook input card answers the pointer", () => {
	function makeInput(opts?: { hint?: string; mask?: string }) {
		const submitted: string[] = [];
		let cancelled = 0;
		let renders = 0;
		const component = new HookInputComponent(
			"Paste your API key",
			undefined,
			value => submitted.push(value),
			() => {
				cancelled += 1;
			},
			{ ...opts, onRequestRender: () => (renders += 1) },
		);
		return {
			component,
			submitted,
			cancelled: () => cancelled,
			renders: () => renders,
			frame: () => frameOf(component),
		};
	}

	it("paints a titled card with a close glyph and the submit/cancel chips", () => {
		const h = makeInput();
		const frame = h.frame();

		expect(frame.some(line => line.includes("Paste your API key"))).toBe(true);
		expect(frame.some(line => line.includes("[x]"))).toBe(true);
		expect(chipLabels(frame)).toEqual(["enter submit", "esc/ctrl+c cancel"]);
	});

	it("leads the chips with the field's own hint, because that describes THIS field", () => {
		const h = makeInput({ hint: "stored in the OS keychain" });

		expect(chipLabels(h.frame())).toEqual(["stored in the OS keychain", "enter submit", "esc/ctrl+c cancel"]);
	});

	it("submits what is typed from the submit chip, exactly as Enter does", () => {
		const h = makeInput();
		for (const char of "sk-live") h.component.handleInput(char);
		const frame = h.frame();
		const submit = chip(frame, "submit");

		h.component.handleInput(clickAt(submit.row, submit.col));

		expect(h.submitted).toEqual(["sk-live"]);
		expect(h.cancelled()).toBe(0);
	});

	it("keeps a masked field masked on screen while the chip submits the real value", () => {
		const h = makeInput({ mask: "*" });
		for (const char of "secret") h.component.handleInput(char);
		const frame = h.frame();

		expect(frame.some(line => line.includes("secret"))).toBe(false);
		const submit = chip(frame, "submit");
		h.component.handleInput(clickAt(submit.row, submit.col));
		expect(h.submitted).toEqual(["secret"]);
	});

	it("cancels on the close glyph, on a click outside the card, and on the cancel chip", () => {
		for (const gesture of ["close-glyph", "outside", "chip"] as const) {
			const h = makeInput();
			const frame = h.frame();
			const target =
				gesture === "close-glyph"
					? closeGlyph(frame)
					: gesture === "chip"
						? chip(frame, "cancel")
						: { row: 1, col: 1 };

			h.component.handleInput(clickAt(target.row, target.col));

			expect(h.cancelled(), gesture).toBe(1);
			expect(h.submitted, gesture).toEqual([]);
		}
	});

	it("repaints a chip as it is hovered, and not again while the pointer rests on it", () => {
		const h = makeInput();
		const submit = chip(h.frame(), "submit");

		h.component.handleInput(motionAt(submit.row, submit.col));
		const afterEnter = h.renders();
		expect(afterEnter).toBeGreaterThan(0);

		h.component.handleInput(motionAt(submit.row, submit.col));
		expect(h.renders()).toBe(afterEnter);
	});
});

describe("the hook editor card answers the pointer", () => {
	function makeEditor(opts?: { promptStyle?: boolean; presentation?: "card" | "embedded" }) {
		const submitted: string[] = [];
		let cancelled = 0;
		const component = new HookEditorComponent(
			createTui(),
			"Write the commit message",
			"draft text",
			value => submitted.push(value),
			() => {
				cancelled += 1;
			},
			opts,
		);
		return {
			component,
			submitted,
			cancelled: () => cancelled,
			frame: () => frameOf(component),
		};
	}

	it("paints a titled card whose chips name the live chords", () => {
		const h = makeEditor();
		const frame = h.frame();

		expect(frame.some(line => line.includes("Write the commit message"))).toBe(true);
		expect(frame.some(line => line.includes("[x]"))).toBe(true);
		expect(chipLabels(frame)).toEqual(["ctrl+q/ctrl+enter submit", "esc cancel", "ctrl+g external editor"]);
	});

	it("submits the editor's text from the submit chip", () => {
		const h = makeEditor();
		const submit = chip(h.frame(), "submit");

		h.component.handleInput(clickAt(submit.row, submit.col));

		expect(h.submitted).toEqual(["draft text"]);
		expect(h.cancelled()).toBe(0);
	});

	it("cancels on the close glyph, on a click outside the card, and on the cancel chip", () => {
		for (const gesture of ["close-glyph", "outside", "chip"] as const) {
			const h = makeEditor();
			const frame = h.frame();
			const target =
				gesture === "close-glyph"
					? closeGlyph(frame)
					: gesture === "chip"
						? chip(frame, "esc cancel")
						: { row: 1, col: 1 };

			h.component.handleInput(clickAt(target.row, target.col));

			expect(h.cancelled(), gesture).toBe(1);
			expect(h.submitted, gesture).toEqual([]);
		}
	});

	it("draws no frame and reads no mouse when a host owns the card", () => {
		const h = makeEditor({ presentation: "embedded" });
		const frame = h.frame();

		expect(frame.some(line => line.includes("[x]"))).toBe(false);
		expect(frame.some(line => line.includes("·"))).toBe(false);
		// The keys are a dim line under the editor instead, since the host's
		// footer names its own.
		expect(frame.some(line => line.includes("submit"))).toBe(true);
		expect(frame.some(line => line.includes("Write the commit message"))).toBe(true);

		// An embedded editor paints no shell, so its chrome geometry is null and
		// every hit-test misses: the report is swallowed rather than answered, and
		// — the part that would be visible — never typed into the text.
		h.component.handleInput(clickAt(1, 1));
		h.component.handleInput(motionAt(6, 6));
		expect(h.cancelled()).toBe(0);
		expect(h.submitted).toEqual([]);
		expect(h.frame()).toEqual(frame);
	});
});
