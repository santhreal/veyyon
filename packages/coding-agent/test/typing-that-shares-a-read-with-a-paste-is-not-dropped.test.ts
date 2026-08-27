/**
 * A terminal hands the app whatever bytes are available on one read, so the characters typed just
 * before `Cmd+V` and the paste itself routinely arrive in the SAME chunk. `BracketedPasteHandler`
 * splits those leading bytes off as `prefix` and documents them as ordinary input, but
 * `CustomEditor` read only `pasteContent` and `remaining` and dropped `prefix` on the floor.
 *
 * The defect had two faces, and the second is the one that hid it. When the whole paste fit in one
 * read the prefix was lost at the assembly branch; when the paste spanned reads the handler returned
 * "still buffering" and `CustomEditor` returned early, losing the prefix before any payload existed.
 * A fix to the first branch alone leaves the second silently broken, so both are pinned here.
 *
 * The contract: every byte the terminal delivered reaches the editor, in the order it was typed,
 * whatever chunk boundary the paste happened to land on.
 *
 * WHAT THIS DOES NOT CATCH: it drives `CustomEditor.handleInput` directly, so it says nothing about
 * how the tty layer above it splits reads, nor about paste payloads large enough to be replaced by a
 * `[Paste #N]` marker — those take a different insert path and are covered elsewhere.
 */

import { describe, expect, it } from "bun:test";
import { CustomEditor } from "@veyyon/coding-agent/modes/components/custom-editor";
import { getEditorTheme } from "@veyyon/coding-agent/modes/theme/theme";

const START = "\x1b[200~";
const END = "\x1b[201~";

function editor(): CustomEditor {
	return new CustomEditor(getEditorTheme());
}

describe("typing that shares a read with a paste is not dropped", () => {
	it("keeps characters typed before the start marker in the same chunk", () => {
		const ed = editor();

		ed.handleInput(`abc${START}PASTED${END}`);

		expect(ed.getText()).toBe("abcPASTED");
	});

	it("keeps them when the paste spans two reads, so the prefix arrives while still buffering", () => {
		const ed = editor();

		// The early return for an unfinished paste is a separate loss site from the assembly branch.
		ed.handleInput(`abc${START}PAS`);
		ed.handleInput(`TED${END}`);

		expect(ed.getText()).toBe("abcPASTED");
	});

	it("orders prefix, payload and trailing bytes as they were typed", () => {
		const ed = editor();

		ed.handleInput(`ab${START}X${END}cd`);

		expect(ed.getText()).toBe("abXcd");
	});

	it("still inserts a paste that no typing preceded", () => {
		const ed = editor();

		ed.handleInput(`${START}only${END}`);

		expect(ed.getText()).toBe("only");
	});

	it("does not fold the prefix into the payload, which re-entering the paste handler would do", () => {
		const ed = editor();

		// `abc` must be inserted as text. Were it appended to the buffer being assembled it would
		// still appear in the editor, in the same order, and only its absence from the paste payload
		// tells the two apart — so assert on a payload the prefix would visibly corrupt.
		ed.handleInput(`abc${START}`);
		ed.handleInput(`${END}`);

		expect(ed.getText()).toBe("abc");
	});
});
