/**
 * The display tab width and the tab expansion every renderer applies before measuring.
 *
 * Dependency-free so the browser bundles (`@veyyon/tool-render`, the web client) share the one
 * value the terminal uses; the `.editorconfig` per-file width is in `./tab-spacing`, which reads
 * the filesystem.
 */

/**
 * The display tab width, and the one number that DOES cross the FFI: `packages/utils/src/width.ts`
 * charges it per tab in `visibleWidth` and hands it to every native cut, slice, wrap and overlay.
 * The native side clamps what it is handed to its own maximum and the JS oracle does not, so a
 * value above that maximum makes the two disagree and every cut overflow the width it was cut to.
 * `packages/utils/test/tab-width-crosses-ffi.test.ts` is what fails when it does.
 */
export const DEFAULT_TAB_WIDTH = 3;

const TAB_SPACES = " ".repeat(DEFAULT_TAB_WIDTH);

/** Replace tabs with the fixed display tab width for consistent rendering. */
export function replaceTabs(text: string): string {
	return text.replaceAll("\t", TAB_SPACES);
}
