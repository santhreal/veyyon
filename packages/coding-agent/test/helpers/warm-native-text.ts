import { Text } from "@veyyon/tui";

/**
 * Load the native text addon on the real clock, before a test installs fake
 * timers.
 *
 * A `Text` render wraps through `@veyyon/natives`, and the first native load in
 * the process schedules an unref'd stale-cache prune (`scheduleStaleNativeCleanup`
 * in `packages/natives/native/loader-state.js`). With fake timers already
 * installed, that prune is a pending fake timer, so `vi.getTimerCount()` reports
 * 1 for a component that armed nothing. Rendering once first moves the prune onto
 * the real clock, where it is not counted and the process still does not wait for
 * it.
 *
 * Call this BEFORE `vi.useFakeTimers()` in any test whose assertion is a timer
 * count.
 */
export function warmNativeTextPath(): void {
	new Text("warm", 0, 0).render(10);
}
