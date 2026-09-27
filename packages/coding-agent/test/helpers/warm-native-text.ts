import { Text } from "@veyyon/tui";

/**
 * Load the native text addon on the real clock, before a test installs fake
 * timers.
 *
 * A `Text` render wraps through `@veyyon/natives`, and the first native load in
 * the process schedules an unref'd stale-cache prune (`scheduleStaleNativeCleanup`
 * in `natives/bridge/bindings/native/loader-state.js`). With fake timers already
 * installed, that prune is a pending fake timer, so `vi.getTimerCount()` reports
 * 1 for a component that armed nothing. Rendering once first moves the prune onto
 * the real clock, where it is not counted and the process still does not wait for
 * it.
 *
 * The warm text is wider than the render width and holds a non-ASCII character:
 * `wrapTextWithAnsi` returns a printable-ASCII line that fits without calling the
 * binding, so a short ASCII warm text loads nothing.
 *
 * Call this BEFORE `vi.useFakeTimers()` in any test whose assertion is a timer
 * count.
 */
export function warmNativeTextPath(): void {
	new Text("warm the native text path \u2192 wrapped", 0, 0).render(10);
}
