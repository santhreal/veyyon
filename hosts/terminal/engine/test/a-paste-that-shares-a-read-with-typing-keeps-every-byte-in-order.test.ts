/**
 * A terminal hands a component whatever bytes one read returned, so typing, a paste and a
 * follow-up keystroke routinely share a chunk. Both engine input components deliver each part
 * in the order it was typed: bytes before the start marker as keys, the assembled payload as a
 * paste, and bytes after the end marker back through the component's own input entry, so a
 * second paste in the same chunk is assembled too.
 *
 * WHY THIS SUITE EXISTS. `Editor` and `Input` each carried their own copy of that delivery,
 * and neither had a test for the prefix or the remainder. Both now route through
 * `BracketedPasteHandler.route`; this suite drives the two components, not the handler, so a
 * component that stops calling it, or calls it with the wrong sinks, is caught here.
 *
 * WHAT IT DOES NOT CATCH: the coding-agent `CustomEditor`, which runs its own paste handler
 * ahead of `Editor` and queues the remainder behind an async paste; it has its own suite.
 */
import { describe, expect, it } from "bun:test";
import { Editor } from "@veyyon/tui/components/editor";
import { Input } from "@veyyon/tui/components/input";
import { defaultEditorTheme } from "./test-themes";

const START = "\x1b[200~";
const END = "\x1b[201~";

function editor(): Editor {
	const ed = new Editor(defaultEditorTheme);
	ed.focused = true;
	return ed;
}

function input(): Input {
	const field = new Input();
	field.focused = true;
	return field;
}

describe("a paste that shares a read with typing keeps every byte in order", () => {
	it("delivers prefix, payload and trailing bytes as typed, in the editor", () => {
		const ed = editor();

		ed.handleInput(`ab${START}X${END}cd`);

		expect(ed.getText()).toBe("abXcd");
	});

	it("delivers prefix, payload and trailing bytes as typed, in the single-line input", () => {
		const field = input();

		field.handleInput(`ab${START}X${END}cd`);

		expect(field.getValue()).toBe("abXcd");
	});

	it("assembles a second paste that begins in the remainder of the first", () => {
		const ed = editor();
		const field = input();

		ed.handleInput(`${START}one${END}-${START}two${END}`);
		field.handleInput(`${START}one${END}-${START}two${END}`);

		expect(ed.getText()).toBe("one-two");
		expect(field.getValue()).toBe("one-two");
	});

	it("keeps the prefix when the paste spans two reads", () => {
		const ed = editor();
		const field = input();

		ed.handleInput(`ab${START}PAS`);
		ed.handleInput(`TED${END}`);
		field.handleInput(`ab${START}PAS`);
		field.handleInput(`TED${END}`);

		expect(ed.getText()).toBe("abPASTED");
		expect(field.getValue()).toBe("abPASTED");
	});
});
