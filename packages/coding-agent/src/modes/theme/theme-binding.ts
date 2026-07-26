import type { Theme } from "./theme-class";

/**
 * The live binding for the active theme.
 *
 * WHY THIS IS ITS OWN MODULE. `theme` is a mutable module-level binding that
 * `applyTheme` and friends reassign, and importers see the reassignment because
 * ES module bindings are live. That is the behaviour callers depend on, so it
 * cannot be replaced with a snapshot or deferred behind `await import` inside a
 * synchronous getter.
 *
 * It used to live in `./theme`, which is the theme ENGINE: theme JSON loading,
 * syntax highlighting, mermaid rendering, the whole terminal presentation layer,
 * 108 modules of it. Anything that wanted to read the active theme had to import
 * all of that. `session/agent-session` did, for one `get theme()` on its
 * null-object UI adapter, and that single import was the largest subtree in the
 * session's 710-module graph.
 *
 * So the binding lives here and the engine assigns through `setActiveTheme`.
 * Reading the theme now costs this file plus a type import, and the engine loads
 * only when something actually renders.
 *
 * KEEP THIS A LEAF. The one import below is `import type`, so it is erased and
 * costs nothing at runtime. A value import of anything at all, and especially of
 * `./theme`, puts the engine back in front of every reader and undoes this.
 */
export var theme: Theme;

/**
 * Publish a newly loaded theme to every reader.
 *
 * The engine calls this instead of assigning `theme` directly, because a module
 * can only write its own bindings. Assignment here is what makes every importer's
 * `theme` update, so a caller that captured the value into a local earlier still
 * sees the old one: read `theme` at the point of use, never cache it.
 */
export function setActiveTheme(next: Theme): void {
	theme = next;
}
