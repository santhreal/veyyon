/**
 * Compatibility shim for legacy extensions importing the package root of
 * `@veyyon/tui` (or one of its aliased scopes like `@earendil-works/pi-tui` or
 * `@mariozechner/pi-tui`).
 *
 * `@veyyon/tui` used to re-export the string, escape and input primitives from
 * its barrel: width math, ANSI and SGR rewriting, key and mouse parsing, LaTeX
 * conversion, motion curves, fuzzy matching, sub-cell bars and the paint
 * encoders. Those now live in `@veyyon/utils`, and the tui barrel re-exports
 * none of them, because a consumer that needs `visibleWidth` depends on string
 * math and not on a renderer.
 *
 * A third-party extension published against the old barrel does not get to make
 * that distinction retroactively. `@juicesharp/rpiv-*` imports `visibleWidth`
 * from `@earendil-works/pi-tui`, and plannotator imports `Key`. So this file is
 * served by `legacy-pi-compat.ts` in place of the real tui entrypoint whenever an
 * extension imports the bare package root: the renderer surface plus every
 * module the barrel dropped, re-exported from its new owner. Subpath imports
 * (`@veyyon/tui/terminal`, etc.) continue to resolve directly against the
 * bundled tui package.
 *
 * The list below is the barrel's own history, not a guess: it is exactly the set
 * of `export *` lines that `packages/tui/src/index.ts` lost, each pointed at the
 * `@veyyon/utils` module that now owns it. That set came from diffing the barrel
 * against the commit before the split, which no test can re-derive — the old
 * barrel is in git history, not on disk. What the tests do defend:
 * `test/pi-scope-aliases.test.ts` drives the real extension loader and proves a
 * name reached through this root is the same object as the one reached through
 * `@veyyon/utils`, and `test/a-legacy-pi-tui-import-still-resolves.test.ts` pins
 * the names known plugins import and asserts this surface stays a strict superset
 * of the live tui barrel.
 */
export * from "@veyyon/tui";
export * from "@veyyon/utils/autocomplete";
export * from "@veyyon/utils/bar";
export * from "@veyyon/utils/color-format";
export * from "@veyyon/utils/deccara";
export * from "@veyyon/utils/fuzzy";
export * from "@veyyon/utils/keybindings";
export * from "@veyyon/utils/keys";
export * from "@veyyon/utils/kitty-graphics";
export * from "@veyyon/utils/latex-block";
export * from "@veyyon/utils/latex-unicode";
export * from "@veyyon/utils/motion";
export * from "@veyyon/utils/mouse";
export * from "@veyyon/utils/padding";
export * from "@veyyon/utils/paint-columns";
export * from "@veyyon/utils/paint-ground";
export * from "@veyyon/utils/paint-surface";
export * from "@veyyon/utils/sgr";
export type * from "@veyyon/utils/symbols";
export * from "@veyyon/utils/text-sizing";
export * from "@veyyon/utils/tight-mode";
export * from "@veyyon/utils/width";
export * from "@veyyon/utils/word-nav";
export * from "@veyyon/utils/wrap";
