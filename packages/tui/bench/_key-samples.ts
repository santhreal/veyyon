/**
 * The keypress samples `bench/parse-key.ts` times both key parsers on.
 *
 * They live in their own module so `test/key-bench-samples.test.ts` can check the same table
 * without running a benchmark. That test exists because the bench had been unrunnable for some
 * time and nothing noticed: `_jskey.ts` exported only its types, so the first line of the bench
 * threw `js.setKittyProtocolActive is not a function`, and three of the expectations here had
 * meanwhile fallen behind the shipped parser.
 */

/**
 * A sample the two parsers are timed on.
 *
 * `expected` is the key the CURRENT parser must produce, and is a real contract: these are the
 * ids keybindings are spelled with. `legacyJs` is set only where the frozen baseline in
 * `_jskey.ts` answers differently BY DESIGN, with the reason, since the whole point of that file
 * is that it is the superseded implementation and re-syncing it would measure nothing.
 */
export interface Sample {
	name: string;
	data: string;
	expected: string;
	legacyJs?: string;
}

// Test cases covering various input types
export const samples: Sample[] = [
	// Kitty protocol sequences
	{ name: "kitty ctrl+a", data: "\x1b[97;5u", expected: "ctrl+a" },
	{ name: "kitty shift+tab", data: "\x1b[9;2u", expected: "shift+tab" },
	{ name: "kitty alt+enter", data: "\x1b[13;3u", expected: "alt+enter" },
	{ name: "kitty ctrl+right", data: "\x1b[1;5C", expected: "ctrl+right" },
	{ name: "kitty shift+delete", data: "\x1b[3;2~", expected: "shift+delete" },
	// Primary key `l` (108) on a layout whose PC-101 position is `a` (97). The current parser
	// reports the letter the user SEES, and falls back to the base layout only when the primary
	// key is outside Latin, so a Cyrillic layout still matches `ctrl+c` (asserted in keys.test.ts).
	// The baseline preferred the base layout unconditionally, which gave a Dvorak user `ctrl+a`
	// for a keypress labelled `l`.
	{ name: "kitty base-layout", data: "\x1b[108::97;5u", expected: "ctrl+l", legacyJs: "ctrl+a" },

	// Legacy sequences
	{ name: "legacy escape", data: "\x1b", expected: "escape" },
	{ name: "legacy tab", data: "\t", expected: "tab" },
	{ name: "legacy enter", data: "\r", expected: "enter" },
	{ name: "legacy space", data: " ", expected: "space" },
	{ name: "legacy backspace", data: "\x7f", expected: "backspace" },
	{ name: "legacy shift+tab", data: "\x1b[Z", expected: "shift+tab" },
	{ name: "legacy up", data: "\x1b[A", expected: "up" },
	{ name: "legacy down", data: "\x1b[B", expected: "down" },
	{ name: "legacy left", data: "\x1b[D", expected: "left" },
	{ name: "legacy right", data: "\x1b[C", expected: "right" },
	{ name: "legacy home", data: "\x1b[H", expected: "home" },
	{ name: "legacy end", data: "\x1b[F", expected: "end" },
	{ name: "legacy delete", data: "\x1b[3~", expected: "delete" },
	{ name: "legacy pageUp", data: "\x1b[5~", expected: "pageUp" },
	{ name: "legacy pageDown", data: "\x1b[6~", expected: "pageDown" },

	// Function keys
	{ name: "legacy f1", data: "\x1bOP", expected: "f1" },
	{ name: "legacy f5", data: "\x1b[15~", expected: "f5" },
	{ name: "legacy f12", data: "\x1b[24~", expected: "f12" },

	// Ctrl sequences
	{ name: "ctrl+c", data: "\x03", expected: "ctrl+c" },
	{ name: "ctrl+z", data: "\x1a", expected: "ctrl+z" },
	{ name: "ctrl+space", data: "\x00", expected: "ctrl+space" },

	// Alt sequences (legacy mode)
	{ name: "alt+backspace", data: "\x1b\x7f", expected: "alt+backspace" },
	// ESC-b and ESC-f are readline's word motions, and the baseline resolved them to the arrow
	// keys inside the parser. The current parser reports the keypress and leaves the aliasing to
	// the keybinding table, where `tui.editor.cursorWordLeft` lists `alt+b` beside `alt+left`, so
	// a user can rebind one without the other.
	{ name: "alt+left", data: "\x1bb", expected: "alt+b", legacyJs: "alt+left" },
	{ name: "alt+right", data: "\x1bf", expected: "alt+f", legacyJs: "alt+right" },

	// Arrow with modifiers (legacy)
	{ name: "shift+up", data: "\x1b[a", expected: "shift+up" },
	{ name: "ctrl+up", data: "\x1bOa", expected: "ctrl+up" },

	// Printable characters
	{ name: "letter a", data: "a", expected: "a" },
	{ name: "letter z", data: "z", expected: "z" },
	{ name: "symbol /", data: "/", expected: "/" },
];
