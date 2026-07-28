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

/** Open the dashboard as a full overlay. */
export const AUTORESEARCH_OVERLAY_KEY = "ctrl+shift+x";
