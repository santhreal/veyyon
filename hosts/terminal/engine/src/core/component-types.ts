/**
 * The contracts a component implements and the engine reads.
 *
 * Every interface here is structural and optional: a component declares a capability by having the
 * member, and the engine asks for it through the accessor beside the interface rather than by
 * `instanceof`. That is what lets a component in another package participate in native-scrollback
 * commits, stable-prefix reuse or resize tail rendering without importing the engine.
 *
 * This module is the one `core/` sibling every other one may import. It holds no state, performs no
 * I/O, and imports nothing from the rest of the engine.
 */

/**
 * Component interface - all components must implement this
 *
 * Render contract: the returned array (and its rows) belongs to the component.
 * Callers MUST NOT mutate it — components are allowed to return a cached array
 * and will return the exact same reference for as long as their rendered
 * content is unchanged. Conversely, a component MUST return a fresh array
 * reference whenever its content changed; reference equality across two
 * render() calls is the engine's proof that the rows are byte-identical
 * (containers memoize their concatenation on it, and the TUI derives the
 * frame's stable prefix from it). A component that mutates a previously
 * returned array in place must implement {@link RenderStablePrefix} to declare
 * which leading rows survived.
 */
export interface Component {
	/**
	 * Render the component to an array of physical rows at the given width.
	 * The result is component-owned and `readonly` to the caller; an unchanged
	 * component may (and should) return the same array reference it returned
	 * last time.
	 */
	render(width: number): readonly string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Optional hook to invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate?(): void;
	/**
	 * Optional hook to set whether this component ignores tight layout mode.
	 */
	setIgnoreTight?(ignore: boolean): void;

	/**
	 * Optional teardown. Called when the component is permanently removed from
	 * the live tree (e.g. a transcript reset). Release timers, intervals, and
	 * subscriptions here. Must be idempotent. Containers propagate dispose to
	 * their children; leaf components without resources may omit it.
	 */
	dispose?(): void;
}

/** Lets an overlay root delegate keyboard focus to components it owns. */
export interface OverlayFocusOwner {
	/** Returns true when `component` is a focus target inside this overlay. */
	ownsOverlayFocusTarget(component: Component): boolean;
}

export function isOverlayFocusTarget(owner: Component, component: Component | null): boolean {
	if (component === owner) return true;
	if (!component) return false;
	const candidate = owner as Component & Partial<OverlayFocusOwner>;
	return candidate.ownsOverlayFocusTarget?.(component) === true;
}

/**
 * Component seam for append-only native-scrollback commits. A component whose
 * rendered rows can still change reports, after each render, the local line
 * index where that mutable suffix begins. Rows above the boundary are declared
 * FINAL — byte-stable at the current width for the component's lifetime — and
 * commit to native scrollback as exact, audited content. Rows at/after the
 * boundary repaint in place inside the visible window; when they scroll above
 * the window top they still commit — the tape records what was on screen —
 * but as frozen visual snapshots that are permanently audit-exempt: later
 * re-layout of their source never re-anchors or recommits them. A root that
 * reports no seam commits everything that scrolls as final (shell semantics).
 *
 * When several root children report a seam in the same frame, the topmost one
 * defines the boundary: exactness is prefix-only, so everything below the
 * first seam is already excluded.
 */
export interface NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined;
}

export function getNativeScrollbackLiveRegionStart(component: Component): number | undefined {
	return (component as Component & Partial<NativeScrollbackLiveRegion>).getNativeScrollbackLiveRegionStart?.();
}

export interface NativeScrollbackCommittedRows {
	setNativeScrollbackCommittedRows(rows: number): void;
}

export function setNativeScrollbackCommittedRows(component: Component, rows: number): void {
	(component as Component & Partial<NativeScrollbackCommittedRows>).setNativeScrollbackCommittedRows?.(rows);
}

/**
 * A component that discards rows after they enter native scrollback implements
 * this hook so a destructive full replay can rehydrate its complete frame.
 */
export interface NativeScrollbackReplay {
	prepareNativeScrollbackReplay(): void;
}

export function prepareNativeScrollbackReplay(component: Component): void {
	(component as Component & Partial<NativeScrollbackReplay>).prepareNativeScrollbackReplay?.();
}

export function canPrepareNativeScrollbackReplay(component: Component): boolean {
	return (
		typeof (component as Component & Partial<NativeScrollbackReplay>).prepareNativeScrollbackReplay === "function"
	);
}

/**
 * A virtualized root that DROPS committed rows out of the front of its render
 * output reports how many it dropped this render, so the engine can move its
 * own commit coordinates with the frame.
 *
 * Without the report the shift is invisible until classification, where it
 * reads as a committed-prefix violation: the frame is suddenly shorter than
 * the commit index and row 0 no longer matches the recorded prefix, so the
 * engine re-anchors and — on a direct terminal with `tui.scrollbackRebuild`
 * on — erases native scrollback and replays a frame the component has already
 * emptied of history. That is a whole transcript deleted to repair a
 * divergence that never happened.
 */
export interface NativeScrollbackCompaction {
	takeNativeScrollbackDroppedRows(): number;
	/**
	 * Rows of already-committed history the render MUST keep in the frame,
	 * however committed they are. The engine re-shows committed rows whenever
	 * the frame shrinks below the viewport — a tall streaming answer collapsing
	 * to its short final render, an overlay closing — and it can only re-show
	 * rows the frame still contains ("duplication, never loss"). A child that
	 * compacted every committed row leaves the engine nothing to fill the screen
	 * with, and the viewport paints a screen-sized band of blank rows over a
	 * conversation that is still on the tape.
	 */
	setNativeScrollbackRetainRows?(rows: number): void;
}

export function takeNativeScrollbackDroppedRows(component: Component): number {
	const rows = (component as Component & Partial<NativeScrollbackCompaction>).takeNativeScrollbackDroppedRows?.();
	return typeof rows === "number" && Number.isFinite(rows) && rows > 0 ? Math.trunc(rows) : 0;
}

export function setNativeScrollbackRetainRows(component: Component, rows: number): void {
	(component as Component & Partial<NativeScrollbackCompaction>).setNativeScrollbackRetainRows?.(rows);
}

/**
 * Opt-in stability report for components that mutate their returned render
 * array in place across frames (instead of returning a fresh array per
 * change). The engine reads it right after the component's `render()` returns:
 * the report counts the leading rows of the just-returned array that are
 * byte-identical to the array state the reader last observed. The engine uses
 * it to reuse the composed frame's prefix — skipping marker extraction, line
 * preparation, and the committed-prefix audit for those rows.
 *
 * Contract:
 * - Reading CONSUMES the report: it re-bases the baseline to the current
 *   array state. The accumulated count therefore covers every render since
 *   the previous read, so out-of-band `render()` calls between engine frames
 *   (an exporter walking the tree) can only lower the report, never inflate
 *   it past what the engine actually has.
 * - An implementer that cannot prove stability for a frame must lower the
 *   accumulated count to 0 for that render.
 * - Rows at or beyond the report may have been mutated in place; rows before
 *   it must be the identical string values at the identical indices.
 */
export interface RenderStablePrefix {
	getRenderStablePrefixRows(): number;
}

export function getRenderStablePrefixRows(component: Component): number | undefined {
	return (component as Component & Partial<RenderStablePrefix>).getRenderStablePrefixRows?.();
}

/**
 * Opt-in fast path for composing only the visible tail of a tall component
 * during a terminal resize. A drag emits a SIGWINCH burst, and the width
 * changes on every event: a full compose re-lays-out (and, for markdown,
 * re-lexes) the entire transcript per event — O(history) work that is
 * discarded the instant the next event arrives. While the resize is in flight
 * the engine paints only the viewport, so it asks each tall root child for at
 * most `maxRows` rows from the bottom of its render at `width` and skips
 * composing everything above the fold. The authoritative full paint replays
 * once the drag settles (see {@link TUI} resize handling).
 *
 * Contract:
 * - Returns the BOTTOM rows of the component's full render at `width`, in
 *   top-to-bottom order, capped at `maxRows` (fewer when the component is
 *   shorter). The rows MUST be byte-identical to the corresponding tail of
 *   what `render(width)` would have returned, modulo a one-row separator at
 *   the very top edge (a transient frame the settle paint overwrites).
 * - MUST NOT mutate any persistent full-compose state: the next `render()`
 *   (the settle paint) has to reconcile exactly as if the tail render never
 *   happened. Warming pure per-width render caches is fine and desirable.
 */
export interface ViewportTailProvider {
	renderViewportTail(width: number, maxRows: number): readonly string[];
}

export function asViewportTailProvider(component: Component): ViewportTailProvider | undefined {
	const candidate = component as Component & Partial<ViewportTailProvider>;
	return typeof candidate.renderViewportTail === "function" ? (candidate as ViewportTailProvider) : undefined;
}

/**
 * Interface for components that can receive focus and display a cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 *
 * Components that can switch between terminal-cursor and software-cursor
 * rendering expose `setUseTerminalCursor`; TUI keeps that mode in sync with
 * its resolved hardware-cursor preference whenever focus or the preference
 * changes.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
	/** Set by TUI when hardware cursor rendering is enabled or disabled. */
	setUseTerminalCursor?(useTerminalCursor: boolean): void;
}

/** Options for scheduling a TUI render. */
export interface RenderRequestOptions {
	/** Clear terminal scrollback for intentional transcript replacement. */
	clearScrollback?: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

/**
 * One root child's contribution to the composed frame: the array reference its
 * render() returned, the frame row it starts at, the row count recorded at
 * compose time (in-place mutators keep the reference but may change length),
 * and the child-local seam report captured at render time — replayed verbatim
 * when a component-scoped frame reuses this segment without re-rendering.
 */
export interface FrameSegment {
	component: Component;
	lines: readonly string[];
	start: number;
	rowCount: number;
	liveLocalStart?: number;
}
