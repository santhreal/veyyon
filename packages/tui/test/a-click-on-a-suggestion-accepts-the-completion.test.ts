/**
 * A pointer accepts a composer suggestion.
 *
 * WHY: the suggestion popup paints as the tail rows of the editor's own frame,
 * inside the engine's pinned footer, and a footer click is routed to the ROOT
 * child under it. The editor is mounted inside a Container, and neither the
 * container nor the editor answered a pointer at all, so every click on a
 * visible, hit-testable suggestion did nothing — the list could only be driven
 * from the keyboard.
 *
 * The class this closes is "a row the user can see and cannot click": the
 * container now routes to the child under the line, and the editor resolves a
 * row to a suggestion and accepts it through the SAME apply path Tab uses, so a
 * click and a key can never diverge. The cases drive the production route
 * (terminal bytes -> TUI -> container -> editor), pin the per-child row offset,
 * and pin the events that must NOT accept.
 *
 * What it does not catch: the popup's own layout (which row a given item lands
 * on) belongs to SelectList and is proven there, so this suite finds the row by
 * reading the painted frame and a layout change moves the click with it. Nor
 * does it pin the two defences against a frame that was never painted — the
 * `-1` row start and the guard that reads it — because the engine repaints on
 * every keystroke and on every suggestion refresh, so no reachable sequence
 * leaves the popup showing over a frame that does not carry it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { CombinedAutocompleteProvider } from "@veyyon/tui/autocomplete";
import { Editor } from "@veyyon/tui/components/editor";
import { parseSgrMouse } from "@veyyon/tui/mouse";
import { type Component, Container, TUI } from "@veyyon/tui/tui";
import { defaultEditorTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

const COLS = 60;
const ROWS = 24;

/** Transcript filler: taller than the screen, which is what arms wheel tracking. */
class Filler implements Component {
	constructor(private readonly rows: number) {}
	render(): string[] {
		return Array.from({ length: this.rows }, (_, i) => `filler-${i}`);
	}
}

/** A one-row child mounted ABOVE the editor inside the same container. */
class PadRow implements Component {
	render(): string[] {
		return [""];
	}
}

/** SGR left-button press at 0-based (row, col). */
function clickAt(row: number, col: number): string {
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

/** SGR left-button release at 0-based (row, col). */
function releaseAt(row: number, col: number): string {
	return `\x1b[<0;${col + 1};${row + 1}m`;
}

/** SGR motion report at 0-based (row, col). */
function motionAt(row: number, col: number): string {
	return `\x1b[<35;${col + 1};${row + 1}M`;
}

/** SGR wheel-down notch at 0-based (row, col). */
function wheelDownAt(row: number, col: number): string {
	return `\x1b[<65;${col + 1};${row + 1}M`;
}

interface Harness {
	tui: TUI;
	term: VirtualTerminal;
	editor: Editor;
	/** Viewport row (0-based) whose painted text contains `needle`. */
	rowOf(needle: string): number;
	/** Row within the EDITOR's own frame whose text contains `needle`. */
	localRowOf(needle: string): number;
}

async function mountComposer(options: { padRows?: number } = {}): Promise<Harness> {
	const term = new VirtualTerminal(COLS, ROWS, 1000);
	const tui = new TUI(term, true);
	const editor = new Editor(defaultEditorTheme);
	editor.setAutocompleteProvider(
		new CombinedAutocompleteProvider(
			[
				{
					name: "model",
					description: "Switch model",
					// An ARGUMENT completion is the case that does not chain into a
					// second popup, so accepting one is the only gesture whose close
					// comes from the accept path itself.
					getArgumentCompletions: (prefix: string) =>
						[
							{ value: "opus-4", label: "opus-4" },
							{ value: "sonnet-4", label: "sonnet-4" },
						].filter(item => item.value.startsWith(prefix)),
				},
				{ name: "mcp", description: "Manage MCP servers" },
				{ name: "memory", description: "Inspect memory" },
			],
			"/tmp",
		),
	);
	// The host is what turns a debounced suggestion refresh into a repaint, and a
	// row that was never painted cannot be hit-tested. Wiring it is not harness
	// convenience: it is the contract interactive-mode holds.
	editor.onAutocompleteUpdate = () => tui.requestRender();
	const container = new Container();
	for (let i = 0; i < (options.padRows ?? 0); i++) container.addChild(new PadRow());
	container.addChild(editor);

	tui.addChild(new Filler(ROWS + 5));
	tui.addChild(container);
	tui.setPinnedFooterChildCount(1);
	tui.setScrollIsolation(true);
	tui.setFocus(editor);
	tui.start();
	await term.waitForRender();

	return {
		tui,
		term,
		editor,
		rowOf(needle: string): number {
			const row = term.getViewport().findIndex(line => line.includes(needle));
			if (row < 0) throw new Error(`no viewport row contains ${JSON.stringify(needle)}`);
			return row;
		},
		localRowOf(needle: string): number {
			const row = editor.render(COLS).findIndex(line => line.includes(needle));
			if (row < 0) throw new Error(`no editor row contains ${JSON.stringify(needle)}`);
			return row;
		},
	};
}

/** Type `/m` and wait for the popup to paint. */
async function openPopup(h: Harness): Promise<void> {
	h.term.sendInput("/");
	await Bun.sleep(5);
	h.term.sendInput("m");
	await Bun.sleep(120);
	expect(h.editor.isShowingAutocomplete()).toBe(true);
	await h.term.waitForRender();
}

describe("a click on a composer suggestion", () => {
	let stop: (() => void) | undefined;
	afterEach(() => {
		stop?.();
		stop = undefined;
	});

	it("accepts the row under the pointer, not the highlighted one", async () => {
		const h = await mountComposer();
		stop = () => h.tui.stop();
		await openPopup(h);

		// `/memory` is neither the first nor the last row, so a routing bug that
		// lands on the selection or on an edge row cannot pass by accident.
		h.term.sendInput(clickAt(h.rowOf("memory"), 6));
		await h.term.waitForRender();

		expect(h.editor.getText()).toBe("/memory ");
		expect(h.editor.isShowingAutocomplete()).toBe(false);
	});

	it("subtracts the rows of the container children above the editor", async () => {
		const h = await mountComposer({ padRows: 3 });
		stop = () => h.tui.stop();
		await openPopup(h);

		// Same gesture, three extra rows between the container's top and the
		// editor: a container that forwarded the raw line would land three rows
		// further down the popup, or off it.
		h.term.sendInput(clickAt(h.rowOf("memory"), 6));
		await h.term.waitForRender();

		expect(h.editor.getText()).toBe("/memory ");
	});

	it("accepts through the same path as Tab", async () => {
		const clicked = await mountComposer();
		stop = () => clicked.tui.stop();
		await openPopup(clicked);
		clicked.term.sendInput(clickAt(clicked.rowOf("mcp"), 4));
		await clicked.term.waitForRender();
		const byClick = clicked.editor.getText();
		clicked.tui.stop();

		const typed = await mountComposer();
		stop = () => typed.tui.stop();
		await openPopup(typed);
		typed.term.sendInput("\x1b[B"); // down: model -> mcp
		typed.term.sendInput("\t");
		await typed.term.waitForRender();

		expect(byClick).toBe(typed.editor.getText());
		expect(byClick).toBe("/mcp ");
	});

	it("places the caret and dismisses the popup when the click lands on the input row", async () => {
		// This row used to be inert on purpose. It stopped being inert when a
		// click on the text became a caret move (see
		// a-click-in-the-composer-places-the-caret.test.ts): the buffer is still
		// untouched, but the caret follows the pointer and the popup goes, because
		// its prefix no longer describes where the caret is.
		const h = await mountComposer();
		stop = () => h.tui.stop();
		await openPopup(h);

		// The prompt row carries the typed text, so it is above the popup. Column
		// 3 is the first text cell of the framed variant (border plus padding).
		h.term.sendInput(clickAt(h.rowOf("/m"), 3));
		await h.term.waitForRender();

		expect(h.editor.getText()).toBe("/m");
		expect(h.editor.getCursor()).toEqual({ line: 0, col: 0 });
		expect(h.editor.isShowingAutocomplete()).toBe(false);
	});

	it("ignores a press on a row past the last suggestion", async () => {
		const h = await mountComposer();
		stop = () => h.tui.stop();
		await openPopup(h);
		// One row below the last suggestion: the popup ends at the bottom of the
		// screen, so this row exists only in the routing arithmetic, and a hit
		// test that clamped instead of missing would accept the last item.
		const line = h.localRowOf("memory") + 1;
		const press = parseSgrMouse(clickAt(line, 4));
		if (!press) throw new Error("unparsed press");
		h.editor.routeMouse(press, line, 4);

		expect(h.editor.getText()).toBe("/m");
		expect(h.editor.isShowingAutocomplete()).toBe(true);
	});

	it("accepts on a press and on nothing else", async () => {
		const h = await mountComposer();
		stop = () => h.tui.stop();
		await openPopup(h);
		const line = h.localRowOf("memory");

		// Motion and wheel never reach the footer through the engine, so they are
		// injected at the component the engine would route to: a pointer that only
		// passes over a suggestion must never rewrite the buffer.
		for (const bytes of [motionAt(line, 6), wheelDownAt(line, 6), releaseAt(line, 6)]) {
			const event = parseSgrMouse(bytes);
			if (!event) throw new Error(`unparsed report ${JSON.stringify(bytes)}`);
			h.editor.routeMouse(event, line, 6);
		}

		expect(h.editor.getText()).toBe("/m");
		expect(h.editor.isShowingAutocomplete()).toBe(true);
	});

	it("cancels without rewriting the buffer when the popup is stale", async () => {
		const h = await mountComposer();
		stop = () => h.tui.stop();
		await openPopup(h);
		const line = h.localRowOf("memory");

		// Move the buffer off the prefix the popup was built for, without letting
		// the debounced refresh run: accepting now would splice the completion
		// into a span the user is no longer typing.
		h.editor.setText("unrelated text");
		const press = parseSgrMouse(clickAt(line, 6));
		if (!press) throw new Error("unparsed press");
		h.editor.routeMouse(press, line, 6);

		expect(h.editor.getText()).toBe("unrelated text");
		expect(h.editor.isShowingAutocomplete()).toBe(false);
	});

	it("closes the popup when the accepted item opens no second popup", async () => {
		const h = await mountComposer();
		stop = () => h.tui.stop();

		// A completed command name re-triggers a popup for its arguments, so
		// accepting a NAME cannot prove the accept path closes anything. An
		// argument completion chains into nothing, and is the case that does.
		for (const ch of "/model s") h.term.sendInput(ch);
		await Bun.sleep(120);
		expect(h.editor.isShowingAutocomplete()).toBe(true);
		await h.term.waitForRender();

		h.term.sendInput(clickAt(h.rowOf("sonnet-4"), 4));
		await h.term.waitForRender();

		expect(h.editor.getText()).toBe("/model sonnet-4");
		expect(h.editor.isShowingAutocomplete()).toBe(false);
	});
});
