/**
 * What the product is called, in the two forms that are not interchangeable.
 *
 * These were one name meaning two values. `dirs.ts` exported `APP_NAME = "veyyon"`, the lowercase slug that
 * appears in filesystem paths, while `tui/desktop-notify.ts` declared `APP_NAME = "Veyyon"`, the capitalized
 * name a human reads, and `tui/terminal-capabilities.ts` and `coding-agent/discovery/builtin.ts` each declared
 * that second value again under a third and fourth name.
 *
 * WHY THE COLLISION IS THE PROBLEM AND NOT THE DUPLICATION. Someone reaching for `APP_NAME` gets whichever
 * one their package happens to export, and both are strings, so nothing complains: a lowercase slug lands in a
 * notification title, or a capitalized name lands in a path, and on a case-insensitive filesystem the second
 * one works on the developer's machine and splits into two directories on a user's Linux box.
 *
 * The two names below cannot be confused for each other, which is the whole point. This module has no imports.
 */

/** The lowercase slug used in filesystem paths: config, cache and data directories. */
export const APP_DIRECTORY_SLUG = "veyyon";

/**
 * The capitalized name a person reads: desktop notification titles, the OSC 99 application field, and the
 * built-in provider's display name.
 */
export const APP_DISPLAY_NAME = "Veyyon";
