/**
 * The chords autoresearch registers, named once.
 *
 * These are EXTENSION shortcuts, registered with `api.registerShortcut` at a fixed
 * chord, not entries in the remappable `KEYBINDINGS` table, so writing them out is
 * correct here in a way it is not for an `app.*` action. What was not correct was
 * writing them out TWICE: the registration in `index.ts` and the dashboard hints
 * that tell you to press them were separate literals, so changing the chord in one
 * place left the header advertising the other.
 */

/** Toggle the dashboard between its collapsed line and its expanded panel. */
export const AUTORESEARCH_TOGGLE_KEY = "ctrl+x";

/**
 * Open the dashboard as a full overlay.
 *
 * NOT `ctrl+shift+x`, which no kitty user could press. kitty's `kitty_mod` defaults to
 * `ctrl+shift` and kitty consumes every chord in that space, bound or not, so the byte
 * never reaches the application: at keyboard-protocol level 7 a kitty terminal emits
 * `\x1b[120;5u` for `ctrl+x` and `\x1b[120;3u` for `alt+x`, and nothing at all for
 * `ctrl+shift+x`. A terminal without the kitty protocol is no better, because there
 * `ctrl+shift+x` and `ctrl+x` are both 0x18, so the chord opened the collapse toggle
 * instead. `alt+x` is delivered on both paths and sits next to the toggle on the same
 * letter.
 */
export const AUTORESEARCH_OVERLAY_KEY = "alt+x";
