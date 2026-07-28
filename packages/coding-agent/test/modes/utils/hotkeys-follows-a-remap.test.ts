/**
 * `/hotkeys` prints the keys that are live right now, including the editor's.
 *
 * WHY THIS SUITE EXISTS. `/hotkeys` is the panel a user opens to answer "what does
 * this key do here", and the reference page sends them to it in as many words: "run
 * `/hotkeys` in a session for the live list after your remaps". Half the table was
 * not live. Every `app.*` row read its chord from `KeybindingsManager`, and every
 * composer and editor row was a hardcoded string: `Ctrl+U`, `Ctrl+K`, `Ctrl+W`,
 * `Enter`, `Tab`, `Ctrl+A`, `Ctrl+E`, `Option+Left/Right`.
 *
 * So a user who set `tui.editor.deleteToLineStart: Ctrl+X` in their
 * `keybindings.yml` opened the panel that exists to tell them what they had done and
 * was told `Ctrl+U`, which now does nothing. Nothing failed, because the earlier
 * suite drove `buildHotkeysMarkdown` with a stub map covering only the `app.*` ids
 * and asserted only on rows it had stubbed, so the hardcoded half was invisible to
 * it.
 *
 * These tests drive the REAL `KeybindingsManager` with a real user config rather
 * than a stub, because a stub is exactly what let the bug through: the question is
 * whether the panel follows a remap, and a hand-written map cannot answer it.
 */

import { describe, expect, it } from "bun:test";
import { KEYBINDINGS, type KeybindingsConfig, KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { buildHotkeysMarkdown } from "@veyyon/coding-agent/modes/utils/hotkeys-markdown";

/**
 * The panel as a user with this `keybindings.yml` would see it.
 *
 * The app-side `KeybindingsManager` takes the user config alone: it supplies
 * `KEYBINDINGS` to its base class itself, which is the whole point of the subclass.
 */
function panel(userConfig: KeybindingsConfig = {}): string {
	return buildHotkeysMarkdown({ keybindings: new KeybindingsManager(userConfig) });
}

describe("the hotkeys panel prints live editor keys", () => {
	/**
	 * The defaults, first, so the rows are known to exist before anything is remapped.
	 * A rule about a remap proves nothing if the row it watches was silently dropped.
	 */
	it("prints the shipped editor and composer chords with no user config", () => {
		const markdown = panel();

		expect(markdown).toContain("| `Ctrl+U` | Delete to start of line |");
		expect(markdown).toContain("| `Ctrl+K` | Delete to end of line |");
		expect(markdown).toContain("| `Enter` | Send message |");
		expect(markdown).toContain("| `Tab` | Path completion / accept autocomplete |");
	});

	/**
	 * The regression itself. Each of these rows was a hardcoded literal, so each one
	 * told a user who had rebound it about a key that no longer does anything.
	 */
	it.each([
		["tui.editor.deleteToLineStart", "Delete to start of line"],
		["tui.editor.deleteToLineEnd", "Delete to end of line"],
		["tui.editor.deleteWordBackward", "Delete word backwards"],
		["tui.editor.cursorLineStart", "Start of line"],
		["tui.editor.cursorLineEnd", "End of line"],
		["tui.input.submit", "Send message"],
		["tui.input.tab", "Path completion / accept autocomplete"],
	])("follows a remap of %s", (id, action) => {
		const markdown = panel({ [id]: "alt+shift+j" } as KeybindingsConfig);

		expect(markdown).toContain(`| \`Alt+Shift+J\` | ${action} |`);
	});

	/**
	 * A remap of one action does not move another's row. The delete-to-start and
	 * delete-to-end rows are adjacent and differ by one word, which is precisely the
	 * pair a careless template would cross.
	 */
	it("moves only the row that was remapped", () => {
		const markdown = panel({ "tui.editor.deleteToLineStart": "alt+shift+j" });

		expect(markdown).toContain("| `Alt+Shift+J` | Delete to start of line |");
		expect(markdown).toContain("| `Ctrl+K` | Delete to end of line |");
	});

	/**
	 * An action the user unbound with an empty list says so, rather than printing an
	 * empty pair of backticks that reads as a key nobody can name.
	 */
	it("says Disabled for an action the user unbound", () => {
		const markdown = panel({ "tui.editor.deleteToLineEnd": [] });

		expect(markdown).toContain("| `Disabled` | Delete to end of line |");
	});

	/**
	 * The word-motion row carries both directions, so a remap of one must not take
	 * the other's chord with it.
	 */
	it("keeps both directions of the word-motion row apart", () => {
		const markdown = panel({ "tui.editor.cursorWordLeft": "alt+shift+j" });

		expect(markdown).toContain("| `Alt+Shift+J` / `Alt+Right/Ctrl+Right/Alt+F` | Move by word |");
	});

	/**
	 * And the general rule the seven above are instances of, which is the one that
	 * fails on the eighth whoever adds it.
	 *
	 * Every binding in the table is remapped to the same unused chord at once, and
	 * then no chord from the DEFAULT render may survive. A row reading its chord from
	 * the manager moves; a row carrying a hardcoded literal does not, and its chord
	 * is still sitting there afterwards. That is a rule about the mechanism rather
	 * than about a list of ids, so it needs no maintenance when a row is added.
	 *
	 * What is exempt, each with its reason. `Arrow keys` describes four bindings at
	 * once as a family rather than naming one action. `Alt+Enter` is matched by the
	 * editor directly rather than through a binding. `Space` is a push-to-talk
	 * gesture, held rather than pressed. `←` is a double-tap gesture. And the prompt
	 * sigils (`/`, `!`, `!!`, `$`, `$$`, `#`, `#<number>`, `#<text>`) are prompt
	 * SYNTAX rather than keys: they are characters the composer reads at the start of
	 * a line, so there is no binding to remap and nothing for this rule to watch.
	 */
	it("has no key column a remap cannot move", () => {
		const PROSE = new Set([
			"Arrow keys",
			"Alt+Enter",
			"Space",
			"←",
			"/",
			"!",
			"!!",
			"$",
			"$$",
			"#",
			"#<number>",
			"#<text>",
		]);
		const chordsOf = (markdown: string): string[] =>
			markdown
				.split("\n")
				.filter(line => line.startsWith("|"))
				.flatMap(line => [...(line.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map(match => match[1] as string))
				.filter(chord => !PROSE.has(chord));

		const everythingRemapped: KeybindingsConfig = Object.fromEntries(
			Object.keys(KEYBINDINGS).map(id => [id, "alt+shift+j"]),
		);
		const survivors = [...new Set(chordsOf(panel()))].filter(chord =>
			chordsOf(panel(everythingRemapped)).includes(chord),
		);

		expect(chordsOf(panel()).length).toBeGreaterThan(20);
		expect(
			survivors.sort(),
			"these chords stayed put when every binding was remapped, so their row is a hardcoded literal. Read it from KeybindingsManager, or the panel lies to anyone who remaps it",
		).toEqual([]);
	});
});
