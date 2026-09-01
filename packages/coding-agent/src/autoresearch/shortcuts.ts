/**
 * The chord autoresearch registers, named once.
 *
 * This is an EXTENSION shortcut, registered with `api.registerShortcut` at a
 * fixed chord, not an entry in the remappable `KEYBINDINGS` table, so writing it
 * out is correct here in a way it is not for an `app.*` action. What was not
 * correct was writing it out TWICE: the registration in `index.ts` and the hint
 * that states it were separate literals, so changing the chord in
 * one place left the other advertising the old one.
 *
 * There is one chord because there is one surface. It used to be two — a
 * collapsed/expanded toggle and an overlay — which rendered the same lines
 * twice, once inside the composer and once over it.
 */

/** Open the run screen. */
export const AUTORESEARCH_SCREEN_KEY = "ctrl+x";
