/**
 * WHY: the autoresearch dashboard overlay was bound to `ctrl+shift+x`, which no
 * user could press. kitty's `kitty_mod` defaults to `ctrl+shift` and kitty
 * swallows every chord in that space whether or not it is bound, so the byte
 * never left the terminal; a terminal without the kitty keyboard protocol is no
 * better, because there `ctrl+shift+x` and `ctrl+x` are both `0x18`, so pressing
 * it opened the collapse toggle instead. The feature shipped with a key that did
 * nothing on one terminal family and the wrong thing on the other.
 *
 * The class this closes is a chord veyyon registers that a terminal does not
 * deliver as itself. `ctrl+shift` is the whole of that class for the chord shapes
 * in use: it is eaten by kitty and aliased onto plain `ctrl` everywhere else. The
 * sweep reads the chords out of the extension at run time rather than from a
 * list here, so a new binding is covered the day it is added and an offending one
 * turns this red until someone records a decision for it.
 *
 * What it does not catch: a chord that a specific terminal emulator rebinds for
 * itself (a user's own kitty config, tmux prefix, a window manager grab). Those
 * are per-machine and no test here can see them. It also only sweeps the
 * extension that registers shortcuts today; a second built-in extension that
 * starts registering them needs adding to `chordsRegisteredBy` below.
 */
import { describe, expect, it } from "bun:test";
import { createAutoresearchExtension } from "@veyyon/coding-agent/autoresearch";
import { AUTORESEARCH_OVERLAY_KEY, AUTORESEARCH_TOGGLE_KEY } from "@veyyon/coding-agent/autoresearch/shortcuts";
import type { ExtensionAPI, ExtensionFactory } from "@veyyon/coding-agent/extensibility/extensions";
import { canonicalKeyId, type KeyId, parseKey } from "@veyyon/tui";

/** Every chord one extension factory registers, collected through the real API surface. */
function chordsRegisteredBy(factory: ExtensionFactory): KeyId[] {
	const chords: KeyId[] = [];
	const api = {
		appendEntry(): void {},
		exec: async () => ({ code: 0, stderr: "", stdout: "" }),
		on(): void {},
		registerCommand(): void {},
		registerShortcut(key: KeyId): void {
			chords.push(key);
		},
		registerTool(): void {},
		sendMessage(): void {},
		sendUserMessage(): void {},
	} as unknown as ExtensionAPI;
	factory(api);
	return chords;
}

/**
 * The chord veyyon resolves `bytes` to, through the same two calls the editor
 * makes on every keystroke. Bytes that parse to nothing are a failure, not a
 * silent `undefined` compared against a string that can never equal it.
 */
function chordFor(bytes: string): string {
	const parsed = parseKey(bytes);
	if (parsed === undefined) throw new Error(`no key parsed from ${JSON.stringify(bytes)}`);
	return canonicalKeyId(parsed);
}

const REGISTERED = chordsRegisteredBy(createAutoresearchExtension);

describe("every chord veyyon registers reaches veyyon", () => {
	it("registers the chords the dashboard advertises, and no others", () => {
		// Exact equality, so a new binding lands here rather than slipping through
		// the sweep below on the strength of not using ctrl+shift.
		expect(REGISTERED).toEqual([AUTORESEARCH_TOGGLE_KEY, AUTORESEARCH_OVERLAY_KEY]);
	});

	it("binds nothing in the ctrl+shift space, which no terminal family delivers", () => {
		const offenders = REGISTERED.filter(chord => {
			const parts = chord.toLowerCase().split("+");
			return parts.includes("ctrl") && parts.includes("shift");
		});
		expect(offenders).toEqual([]);
	});

	it("gives each chord its own canonical id, so one cannot shadow another", () => {
		const canonical = REGISTERED.map(chord => chord.toLowerCase());
		expect(new Set(canonical).size).toBe(canonical.length);
	});

	it("parses the bytes a kitty terminal emits for each chord back to that chord", () => {
		// Recorded from kitty 0.41.1 at keyboard-protocol level 7 (`\x1b[>7u`), which
		// is the mode veyyon negotiates: `\x1b[<codepoint>;<mods>u`, mods being
		// 1 + shift(1) + alt(2) + ctrl(4). The same probe emitted NOTHING AT ALL for
		// `ctrl+shift+x`, which is why that chord is banned above rather than pinned
		// to bytes here.
		expect(chordFor("\x1b[120;5u")).toBe("ctrl+x");
		expect(chordFor("\x1b[120;3u")).toBe("alt+x");
	});

	it("parses the bytes a terminal without the kitty protocol emits for each chord", () => {
		// The legacy encodings. `ctrl+x` is 0x18 and `alt+x` is ESC-prefixed, and they
		// stay distinct — which `ctrl+shift+x` did not, since a legacy terminal sends
		// 0x18 for it too and the overlay chord arrived as the collapse toggle.
		expect(chordFor("\x18")).toBe("ctrl+x");
		expect(chordFor("\x1bx")).toBe("alt+x");
	});
});
