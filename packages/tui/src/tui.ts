/**
 * Minimal TUI implementation with differential rendering.
 * See `docs/internal/tui-core-renderer.md`.
 */
import * as fs from "node:fs";
import { performance } from "node:perf_hooks";
import { getDebugLogPath } from "@veyyon/utils/dirs";
import { $flag } from "@veyyon/utils/env";
import * as logger from "@veyyon/utils/logger";
import { popLoopPhase, pushLoopPhase } from "@veyyon/utils/loop-phase";
import { errorMessage } from "@veyyon/utils/type-guards";
import { SGR_RESET, sgrSequence } from "./ansi";
import { DEFAULT_MAX_INLINE_IMAGES, ImageBudget } from "./components/image";
import { planDeccaraFills } from "./deccara";
import { isKeyRelease, matchesKey } from "./keys";
import { LoopWatchdog } from "./loop-watchdog";
import { type MouseRoutable, parseSgrMouse, type SgrMouseEvent } from "./mouse";
import { isConPTYHosted, setAltScreenActive, type Terminal } from "./terminal";
import {
	encodeKittyDeleteImage,
	ImageProtocol,
	isInsideTerminalMultiplexer,
	setCellDimensions,
	setTerminalImageProtocol,
	shouldEnableSynchronizedOutputByDefault,
	synchronizedOutputUserOverride,
	TERMINAL,
} from "./terminal-capabilities";
import {
	clampLow,
	Ellipsis,
	extractSegments,
	normalizeTerminalOutput,
	padding,
	sliceByColumn,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
} from "./utils";

/** Per-line terminator written after non-image content rows to close SGR and OSC 8 state. */
const LINE_TERMINATOR = "\x1b[0m\x1b]8;;\x07";
const ERASE_LINE = "\x1b[2K";
const ERASE_TO_END_OF_LINE = "\x1b[K";
const LINE_FIT_MIN_SOURCE_CODE_UNITS = 4096;
const LINE_FIT_MAX_SOURCE_CODE_UNITS = 65536;
const LINE_FIT_SOURCE_WIDTH_MULTIPLIER = 64;
const HIDE_CURSOR = "\x1b[?25l";
const SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
const SYNC_OUTPUT_END = "\x1b[?2026l";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const PAINT_BEGIN = `${HIDE_CURSOR}${SYNC_OUTPUT_BEGIN}${DISABLE_AUTOWRAP}`;
const PAINT_END = `${ENABLE_AUTOWRAP}${SYNC_OUTPUT_END}`;
const PAINT_BEGIN_NO_SYNC = `${HIDE_CURSOR}${DISABLE_AUTOWRAP}`;
const PAINT_END_NO_SYNC = ENABLE_AUTOWRAP;
const CURSOR_BEGIN = `${HIDE_CURSOR}${SYNC_OUTPUT_BEGIN}`;
const CURSOR_BEGIN_NO_SYNC = HIDE_CURSOR;
const CURSOR_END = SYNC_OUTPUT_END;
const CURSOR_END_NO_SYNC = "";
// Mouse reporting for fullscreen overlays (click, any-motion, SGR coordinates).
const MOUSE_TRACKING_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
const MOUSE_TRACKING_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";
// Wheel/button-only tracking for scroll isolation (buttons 64/65 and SGR coordinates).
const MOUSE_WHEEL_TRACKING_ON = "\x1b[?1000h\x1b[?1006h";
// Scroll track chrome drawn on the right edge of frozen transcript regions.
const SCROLL_TRACK_GROOVE = "\x1b[2m│\x1b[22m";
const SCROLL_TRACK_THUMB = "█";
const MOUSE_WHEEL_TRACKING_OFF = "\x1b[?1006l\x1b[?1000l";
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";
const ALT_SCROLL_ON = "\x1b[?1007h";
const ALT_SCROLL_OFF = "\x1b[?1007l";
/** Legacy cursor-key sequences mapped to scroll direction (-1 back, +1 tail). */
const LEGACY_CURSOR_SCROLL: Readonly<Record<string, -1 | 1 | undefined>> = {
	"\x1b[A": -1,
	"\x1b[B": 1,
	"\x1bOA": -1,
	"\x1bOB": 1,
};

export type ScrollTransport = "mouse" | "alt-arrows";
type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;
type StartListener = () => void;

export interface RenderTimer {
	cancel(): void;
}

export interface RenderScheduler {
	now(): number;
	scheduleImmediate(callback: () => void): void;
	scheduleRender(callback: () => void, delayMs: number): RenderTimer;
}

export interface TUIOptions {
	renderScheduler?: RenderScheduler;
}

export interface TUIStartOptions {
	clearScrollback?: boolean;
}

const DEFAULT_RENDER_SCHEDULER: RenderScheduler = {
	now: () => performance.now(),
	scheduleImmediate: callback => {
		setImmediate(callback);
	},
	scheduleRender: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		return {
			cancel: () => {
				clearTimeout(timer);
			},
		};
	},
};

/** Component interface - components return an array of physical rows at the given width. */
export interface Component {
	/**
	 * Render the component to an array of physical rows at the given width.
	 * The result is component-owned and `readonly` to the caller; an unchanged
	 * component may (and should) return the same array reference it returned
	 * last time.
	 */
	render(width: number): readonly string[];

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
	setIgnoreTight?(ignore: boolean): void;

	/**
	 * Optional teardown. Called when the component is permanently removed from
	 * the live tree (e.g. a transcript reset). Release timers, intervals, and
	 * subscriptions here. Must be idempotent. Containers propagate dispose to
	 * their children; leaf components without resources may omit it.
	 */
	dispose?(): void;
}

export interface OverlayFocusOwner {
	ownsOverlayFocusTarget(component: Component): boolean;
}

/** Component seam for append-only native-scrollback commits. */
export interface NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined;
}

export interface NativeScrollbackCommittedRows {
	setNativeScrollbackCommittedRows(rows: number): void;
}

/**
 * A component that discards rows after they enter native scrollback implements
 * this hook so a destructive full replay can rehydrate its complete frame.
 */
export interface NativeScrollbackReplay {
	prepareNativeScrollbackReplay(): void;
}

function prepareNativeScrollbackReplay(component: Component): void {
	(component as Component & Partial<NativeScrollbackReplay>).prepareNativeScrollbackReplay?.();
}

/** Virtualized root notification for rows dropped from the front of render output. */
export interface NativeScrollbackCompaction {
	takeNativeScrollbackDroppedRows(): number;
	/** Rows of committed history the render must retain in the frame. */
	setNativeScrollbackRetainRows?(rows: number): void;
}

function takeNativeScrollbackDroppedRows(component: Component): number {
	const rows = (component as Component & Partial<NativeScrollbackCompaction>).takeNativeScrollbackDroppedRows?.();
	return typeof rows === "number" && Number.isFinite(rows) && rows > 0 ? Math.trunc(rows) : 0;
}

function setNativeScrollbackRetainRows(component: Component, rows: number): void {
	(component as Component & Partial<NativeScrollbackCompaction>).setNativeScrollbackRetainRows?.(rows);
}
function canPrepareNativeScrollbackReplay(component: Component): boolean {
	return (
		typeof (component as Component & Partial<NativeScrollbackReplay>).prepareNativeScrollbackReplay === "function"
	);
}

function setNativeScrollbackCommittedRows(component: Component, rows: number): void {
	(component as Component & Partial<NativeScrollbackCommittedRows>).setNativeScrollbackCommittedRows?.(rows);
}

function isOverlayFocusTarget(owner: Component, component: Component | null): boolean {
	if (component === owner) return true;
	if (!component) return false;
	const candidate = owner as Component & Partial<OverlayFocusOwner>;
	return candidate.ownsOverlayFocusTarget?.(component) === true;
}

function getNativeScrollbackLiveRegionStart(component: Component): number | undefined {
	return (component as Component & Partial<NativeScrollbackLiveRegion>).getNativeScrollbackLiveRegionStart?.();
}

/** Stability report for components that mutate returned render arrays in place. */
export interface RenderStablePrefix {
	getRenderStablePrefixRows(): number;
}

function getRenderStablePrefixRows(component: Component): number | undefined {
	return (component as Component & Partial<RenderStablePrefix>).getRenderStablePrefixRows?.();
}

/** Fast path for composing only the visible tail of a tall component during resize. */
export interface ViewportTailProvider {
	renderViewportTail(width: number, maxRows: number): readonly string[];
}

function asViewportTailProvider(component: Component): ViewportTailProvider | undefined {
	const candidate = component as Component & Partial<ViewportTailProvider>;
	return typeof candidate.renderViewportTail === "function" ? (candidate as ViewportTailProvider) : undefined;
}

/** Interface for components that can receive focus and display a cursor. */
export interface Focusable {
	focused: boolean;
	setUseTerminalCursor?(useTerminalCursor: boolean): void;
}

export interface RenderRequestOptions {
	clearScrollback?: boolean;
}
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/** Zero-width APC cursor marker emitted at cursor position by focused components. */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

export type SizeValue = number | `${number}%`;

function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

function isMultiplexerSession(): boolean {
	return isInsideTerminalMultiplexer();
}

/** Terminals that re-report size on alt screen toggle (e.g. Warp), requiring in-place resize. */
function reportsSizeOnAltScreenToggle(): boolean {
	const override = Bun.env.VEYYON_TUI_RESIZE_IN_PLACE;
	if (override === "0" || override === "false") return false;
	if (override === "1" || override === "true") return true;
	return Bun.env.TERM_PROGRAM?.toLowerCase() === "warpterminal";
}

/** Resize repaints in place for multiplexers and terminals looping on alt-screen toggles. */
function resizeRepaintsInPlace(): boolean {
	return isMultiplexerSession() || reportsSizeOnAltScreenToggle();
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	width?: SizeValue;
	minWidth?: number;
	maxHeight?: SizeValue;

	anchor?: OverlayAnchor;
	offsetX?: number;
	offsetY?: number;

	row?: SizeValue;
	col?: SizeValue;

	margin?: OverlayMargin | number;

	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;

	/** Borrow alternate screen buffer for this overlay's lifetime. */
	fullscreen?: boolean;
}

export interface OverlayHandle {
	hide(): void;
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
}

/** Overlay that animates its exit before removal. */
export interface OverlayExitAnimatable {
	beginOverlayExit(requestRender: () => void, done: () => void): boolean;
}

export function canAnimateOverlayExit(component: Component): component is Component & OverlayExitAnimatable {
	return typeof (component as Partial<OverlayExitAnimatable>).beginOverlayExit === "function";
}

export class Container implements Component, MouseRoutable {
	children: Component[] = [];

	// Memoized concatenation of child renders, invalidated on child change or invalidate().
	#memoLines: string[] | undefined;
	#memoChildLines: (readonly string[])[] = [];
	#memoWidth = -1;

	#ignoreTight = false;

	setIgnoreTight(ignore: boolean): this {
		this.#ignoreTight = ignore;
		for (let ci = 0; ci < this.children.length; ci++) {
			this.children[ci]!.setIgnoreTight?.(ignore);
		}
		this.invalidate();
		return this;
	}

	addChild(component: Component): void {
		this.children.push(component);
		if (this.#ignoreTight) {
			component.setIgnoreTight?.(true);
		}
		this.#memoLines = undefined;
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.#memoLines = undefined;
		}
	}

	clear(): void {
		this.children = [];
		this.#memoLines = undefined;
	}

	disposeChildren(): void {
		this.dispose();
		this.clear();
	}

	invalidate(): void {
		this.#memoLines = undefined;
		for (let ci = 0; ci < this.children.length; ci++) {
			this.children[ci]!.invalidate?.();
		}
	}

	/**
	 * Propagate teardown to children. Call when the container's children are
	 * being permanently discarded (not when they are detached for reuse — use
	 * {@link clear} for that). Idempotent per child via each child's own dispose.
	 */
	dispose(): void {
		for (let ci = 0; ci < this.children.length; ci++) {
			this.children[ci]!.dispose?.();
		}
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		const children = this.children;
		const count = children.length;
		let refs = this.#memoChildLines;
		let unchanged = this.#memoLines !== undefined && this.#memoWidth === width && refs.length === count;
		if (refs.length !== count) {
			refs = new Array(count);
			this.#memoChildLines = refs;
		}
		for (let i = 0; i < count; i++) {
			const childLines = children[i]!.render(width);
			if (refs[i] !== childLines) {
				unchanged = false;
				refs[i] = childLines;
			}
		}
		this.#memoWidth = width;
		if (unchanged) return this.#memoLines!;
		const lines: string[] = [];
		for (let i = 0; i < count; i++) {
			const childLines = refs[i]!;
			for (let j = 0; j < childLines.length; j++) lines.push(childLines[j]!);
		}
		this.#memoLines = lines;
		return lines;
	}

	/** Hand a pointer event to the child under `line`. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		const children = this.children;
		const refs = this.#memoChildLines;
		if (refs.length !== children.length) return;
		let start = 0;
		for (let i = 0; i < children.length; i++) {
			const rows = refs[i]?.length ?? 0;
			if (line < start + rows) {
				const child = children[i] as Component & Partial<MouseRoutable>;
				child.routeMouse?.(event, line - start, col);
				return;
			}
			start += rows;
		}
	}
}

/** Render intent for the frame: fullPaint (replay/resize/clear) vs update (relative repaint). */
type RenderIntent =
	| { kind: "fullPaint"; clearScrollback: boolean }
	| { kind: "update"; chunkTo: number; windowTop: number };

interface HardwareCursorState {
	row: number;
	col: number;
	visible: boolean;
}

interface HardwareCursorUpdate {
	toRow: number;
	state: HardwareCursorState | null;
	visible?: boolean;
}

interface CursorControlResult extends HardwareCursorUpdate {
	seq: string;
	toCol: number;
	visible: boolean;
}

/** Root child segment record within the composed frame. */
interface FrameSegment {
	component: Component;
	lines: readonly string[];
	start: number;
	rowCount: number;
	liveLocalStart?: number;
}

function subtreeContains(root: Component, target: Component): boolean {
	if (root === target) return true;
	const children = (root as Partial<Container>).children;
	if (!Array.isArray(children)) return false;
	for (let i = 0; i < children.length; i++) {
		if (subtreeContains(children[i]!, target)) return true;
	}
	return false;
}

interface PreparedLine {
	raw: string;
	width: number;
	line: string;
}

const SGR_SEQUENCE = sgrSequence("g");

// SGR coalescing: merges adjacent CSI SGR sequences into single sequences to cut byte volume.
const SGR_COALESCE_ENABLED = !$flag("VEYYON_NO_SGR_COALESCE");
const CC_ESC = 0x1b;
const CC_BRACKET = 0x5b; // [
const CC_M = 0x6d; // m
const CC_SEMI = 0x3b; // ;
const CC_COLON = 0x3a; // :
// Max parameter tokens per emitted merged SGR to stay within terminal parameter limits.

function isSgrParamByte(c: number): boolean {
	return (c >= 0x30 && c <= 0x39) || c === CC_SEMI || c === CC_COLON;
}

// Check if parameter list ends mid extended-color spec in ambiguous semicolon form.
function endsWithIncompleteExtendedColor(params: string): boolean {
	let i = 0;
	const n = params.length;
	while (i < n) {
		let j = i;
		while (j < n && params.charCodeAt(j) !== 0x3b) j++;
		const tokLen = j - i;
		if (
			tokLen === 2 &&
			params.charCodeAt(i + 1) === 0x38 &&
			(params.charCodeAt(i) === 0x33 || params.charCodeAt(i) === 0x34 || params.charCodeAt(i) === 0x35)
		) {
			const p = j + 1;
			let modeEnd = p;
			while (modeEnd < n && params.charCodeAt(modeEnd) !== 0x3b) modeEnd++;
			const modeLen = modeEnd - p;
			if (modeLen === 0) return true;
			if (modeLen === 1 && params.charCodeAt(p) === 0x32) {
				let q = modeEnd + 1;
				for (let s = 0; s < 3; s++) {
					if (q > n) return true;
					while (q < n && params.charCodeAt(q) !== 0x3b) q++;
					q++;
				}
				i = q - 1;
			} else if (modeLen === 1 && params.charCodeAt(p) === 0x35) {
				let q = modeEnd + 1;
				if (q > n) return true;
				while (q < n && params.charCodeAt(q) !== 0x3b) q++;
				i = q;
			} else {
				i = modeEnd;
			}
		}
		i += 1;
	}
	return false;
}

const MERGE_TOKEN_CAP = 16;

/** Merge runs of byte-adjacent SGR sequences into one. */
export function coalesceAdjacentSgr(line: string): string {
	if (!SGR_COALESCE_ENABLED || line.indexOf("\x1b[") === -1) return line;
	const n = line.length;
	let out = "";
	let copiedUpto = 0;
	let i = 0;
	while (i < n) {
		if (line.charCodeAt(i) !== CC_ESC || line.charCodeAt(i + 1) !== CC_BRACKET) {
			i++;
			continue;
		}
		let j = i + 2;
		while (j < n && isSgrParamByte(line.charCodeAt(j))) j++;
		if (j >= n || line.charCodeAt(j) !== CC_M) {
			i = j;
			continue;
		}
		let k = j + 1;
		if (k >= n || line.charCodeAt(k) !== CC_ESC || line.charCodeAt(k + 1) !== CC_BRACKET) {
			i = k;
			continue;
		}
		const params: string[] = [line.slice(i + 2, j)];
		while (k < n && line.charCodeAt(k) === CC_ESC && line.charCodeAt(k + 1) === CC_BRACKET) {
			let p = k + 2;
			while (p < n && isSgrParamByte(line.charCodeAt(p))) p++;
			if (p >= n || line.charCodeAt(p) !== CC_M) break;
			params.push(line.slice(k + 2, p));
			k = p + 1;
		}
		if (params.length > 1) {
			out += line.slice(copiedUpto, i);
			// Emit the merged run, but flush the current group before appending a
			// list when (a) the previous list ended mid extended-color, so the
			// next code cannot be absorbed as its missing channel/index, or (b)
			// the token count would exceed MERGE_TOKEN_CAP. SGR params apply
			// left-to-right regardless of how they are grouped across adjacent
			// CSIs, so a capped/guarded split stays behavior-preserving — while a
			// single unbounded merge would overflow a terminal's CSI parameter
			// buffer (xterm.js caps at 32 and silently truncates the rest,
			// corrupting colors). Empty params (`CSI m`) mean a full reset;
			// normalize to `0` so the merged list stays unambiguous.
			let group = "";
			let groupTokens = 0;
			let groupOpenSafe = true;
			for (let q = 0; q < params.length; q++) {
				const norm = params[q]!.length === 0 ? "0" : params[q]!;
				let tk = 1;
				for (let z = 0; z < norm.length; z++) {
					const cc = norm.charCodeAt(z);
					if (cc === CC_SEMI || cc === CC_COLON) tk++;
				}
				if (groupTokens > 0 && (!groupOpenSafe || groupTokens + tk > MERGE_TOKEN_CAP)) {
					out += `\x1b[${group}m`;
					group = "";
					groupTokens = 0;
				}
				group += group.length === 0 ? norm : `;${norm}`;
				groupTokens += tk;
				groupOpenSafe = !endsWithIncompleteExtendedColor(norm);
			}
			if (group.length > 0) out += `\x1b[${group}m`;
			copiedUpto = k;
		}
		i = k;
	}
	if (copiedUpto === 0) return line;
	return out + line.slice(copiedUpto);
}

function rowsEquivalent(a: string, b: string): boolean {
	if (a === b) return true;
	return a.replace(SGR_SEQUENCE, "") === b.replace(SGR_SEQUENCE, "");
}

function isBlankRow(row: string): boolean {
	if (row.length === 0) return true;
	return row.replace(SGR_SEQUENCE, "").trim().length === 0;
}

const RESYNC_TAIL_LOOKBACK = 24;
const RESYNC_TAIL_SAMPLES = 8;

/**
 * Decide whether `frame` still aligns with the committed prefix, and where to
 * re-anchor the commit index when it does not (-1 if no resync needed).
 */
export function findCommittedPrefixResync(
	frame: readonly string[],
	prefix: readonly string[],
	verifiedTo: number = prefix.length,
	finalTo: number = verifiedTo,
): number {
	const verified = Math.min(prefix.length, Math.max(0, Math.trunc(verifiedTo)));
	const hardEnd = Math.min(prefix.length, Math.max(verified, Math.trunc(finalTo)));
	if (hardEnd === 0) return -1;
	if (frame.length >= hardEnd) {
		// 1. Hard scan: frozen snapshots whose source just became final. Full
		// scan, no tolerance — a finalized row that changed must re-anchor.
		let hardMismatch = false;
		for (let i = verified; i < hardEnd; i++) {
			if (!rowsEquivalent(frame[i]!, prefix[i]!)) {
				hardMismatch = true;
				break;
			}
		}
		if (!hardMismatch) {
			// 2. Tail sample over the verified zone (only when the hard scan is
			// clean): walk up from its end until LOOKBACK rows or SAMPLES
			// non-blank comparisons.
			let samples = 0;
			let mismatches = 0;
			for (let j = 1; j <= verified && j <= RESYNC_TAIL_LOOKBACK && samples < RESYNC_TAIL_SAMPLES; j++) {
				const idx = verified - j;
				const row = frame[idx]!;
				const old = prefix[idx]!;
				if (row === old) {
					if (!isBlankRow(row)) samples++;
					continue;
				}
				if (isBlankRow(row) && isBlankRow(old)) continue;
				samples++;
				if (!rowsEquivalent(row, old)) mismatches++;
			}
			if (samples === 0 || mismatches <= 1) return -1;
		}
	}
	// Misaligned (hard mismatch, tail-sample shift, or the frame no longer
	// covers the checked zones): re-anchor at the first row whose content
	// changed.
	const limit = Math.min(hardEnd, frame.length);
	for (let i = 0; i < limit; i++) {
		if (!rowsEquivalent(frame[i]!, prefix[i]!)) return i;
	}
	return limit < hardEnd ? limit : -1;
}

export class TUI extends Container {
	terminal: Terminal;
	#previousFrameLength = 0;
	#previousWidth = 0;
	#previousHeight = 0;
	#focusedComponent: Component | null = null;
	#inputListeners = new Set<InputListener>();
	#startListeners = new Set<StartListener>();

	onDebug?: () => void;

	/** Callback when user attempts text drag-select while mouse tracking is held. */
	onSelectionAttempt?: () => void;
	#pressCell: { row: number; col: number } | null = null;
	#renderRequested = false;
	#renderTimer: RenderTimer | undefined;
	#renderScheduler: RenderScheduler;
	#lastRenderAt = 0;
	/** Decayed estimate of frame render cost (ms) for adaptive duty-cycle throttling. */
	#frameCostEstimateMs = 0;
	/** Weight of the newest frame in `#frameCostEstimateMs`. */
	static readonly #FRAME_COST_SMOOTHING = 0.3;
	static readonly #MIN_RENDER_INTERVAL_MS = 1000 / 30;
	static readonly #INPUT_RENDER_GRACE_MS = TUI.#MIN_RENDER_INTERVAL_MS;
	/** Cap on the adaptive floor derived from `#frameCostEstimateMs` (~5 fps bound). */
	static readonly #MAX_ADAPTIVE_RENDER_MS = 200;
	#inputRenderGraceUntilMs = 0;
	// Pane-reflow settle window for multiplexer resize debounce.
	static readonly #MULTIPLEXER_RESIZE_DEBOUNCE_MS = 50;
	// Resize viewport fast path settle window (non-multiplexer).
	static readonly #RESIZE_VIEWPORT_SETTLE_MS = 120;
	// Delay before first Kitty image paint on Ghostty.
	static readonly #GHOSTTY_INITIAL_IMAGE_DELAY_MS = 100;
	// Post-paint settle window for ConPTY hosts.
	static readonly #CONPTY_POST_FULL_PAINT_SETTLE_MS = 150;
	static readonly #CONPTY_FRAME_TRUNCATE_THRESHOLD_BYTES = 512 * 1024;
	static readonly #CONPTY_FRAME_RETAIN_BYTES = 64 * 1024;
	#postFullPaintSettleUntilMs = 0;
	#postFullPaintSettleTimer: RenderTimer | undefined;
	#hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	#hardwareCursorState: HardwareCursorState | null = null;
	#hardwareCursorVisibilityKnown = false;
	#hardwareCursorVisible = false;
	#sixelProbePendingDa = false;
	#sixelProbePendingGraphics = false;
	#sixelProbeBuffer = "";
	#sixelProbeTimeout?: NodeJS.Timeout;
	#sixelProbeUnsubscribe?: () => void;
	#showHardwareCursor = $flag("VEYYON_HARDWARE_CURSOR");
	#synchronizedOutputEnabled = shouldEnableSynchronizedOutputByDefault();
	#paintBeginSequence = this.#synchronizedOutputEnabled ? PAINT_BEGIN : PAINT_BEGIN_NO_SYNC;
	#paintEndSequence = this.#synchronizedOutputEnabled ? PAINT_END : PAINT_END_NO_SYNC;
	#cursorBeginSequence = this.#synchronizedOutputEnabled ? CURSOR_BEGIN : CURSOR_BEGIN_NO_SYNC;
	#cursorEndSequence = this.#synchronizedOutputEnabled ? CURSOR_END : CURSOR_END_NO_SYNC;
	// Rows of the current frame physically committed to native scrollback or scrolled past window top.
	#committedRows = 0;
	// Raw rows mirroring [0, #committedRows) for audit against current render.
	#committedPrefix: string[] = [];
	// Rows virtualized children dropped from the front of render output.
	#frameDroppedRows = 0;
	// Frame row where child drop happened in previous frame coordinates.
	#frameDroppedAt: number | undefined;
	// Guards rehydrating re-render during destructive rebuild.
	#rehydratingDivergence = false;
	// Prepared rows scrolled off the window (engine mirror of terminal scrollback).
	#scrollTape: string[] = [];
	// Max rows kept on scroll tape.
	#scrollTapeCap = 20_000;
	// Snapshot of scroll space when frozen view freezes.
	#scrollSnapshot: string[] | null = null;
	// Rows of committed prefix verified as exact-final bytes.
	#committedPrefixAuditRows = 0;
	// Frame row currently mapped to screen row 0.
	#windowTopRow = 0;
	// Virtual scroll offset in scroll space when frozen; null when following live tail.
	#scrollIsolation = false;
	// Scroll transport mode: "mouse" (tracking on normal screen) vs "alt-arrows" (alt screen).
	#scrollTransport: ScrollTransport = Bun.env.VEYYON_TUI_SCROLL_TRANSPORT === "alt-arrows" ? "alt-arrows" : "mouse";
	#altScrollActive = false;
	#wheelTrackingActive = false;
	// True while composed frame overflows viewport or rows exist on scroll tape.
	#frameScrollable = false;
	// Pinned footer child count and resolved rows (composer zone).
	#pinnedFooterChildCount = 0;
	#pinnedFooterRows = 0;
	#virtualScrollTop: number | null = null;
	// Base scroll step in rows per wheel tick.
	static readonly #WHEEL_SCROLL_ROWS = 3;
	// Wheel acceleration window and max streak.
	static readonly #WHEEL_ACCEL_WINDOW_MS = 300;
	static readonly #WHEEL_ACCEL_MAX_STREAK = 3;
	#lastWheelDirection: -1 | 1 | null = null;
	#lastWheelAtMs = 0;
	#wheelStreak = 0;
	// Shift+drag selects while mouse tracking is active.
	// Exactly what is painted on the screen rows (post-composite, prepared).
	#previousWindow: string[] = [];
	#nativeScrollbackLiveRegionStart: number | undefined;
	#fullRedrawCount = 0;
	// Inline image budget for graphics vs text fallback.
	#imageBudget = new ImageBudget(DEFAULT_MAX_INLINE_IMAGES, () => this.requestRender());
	#ghosttyInitialImageDelayDone = false;
	#ghosttyInitialImageDelayTimer: RenderTimer | undefined;
	#ghosttyImageReadyAtMs = 0;
	#clearScrollbackOnNextRender = false;
	#forceViewportRepaintOnNextRender = false;
	#hasEverRendered = false;
	// Erase and replay history when final block form replaces live preview.
	#scrollbackRebuildEnabled = true;
	// Set by terminal resize callback; consumed on next render.
	#resizeEventPending = false;
	// Active multiplexer SIGWINCH debounce timer and deferred flags.
	#multiplexerResizeTimer: RenderTimer | undefined;
	#deferredForcedClearScrollback = false;
	// True during non-multiplexer resize drag for viewport fast path.
	#resizeViewportActive = false;
	// Quiet-window settle timer for resize fast path.
	#resizeViewportSettleTimer: RenderTimer | undefined;
	// Transient viewport-only resize paint counter.
	#resizeViewportPaintCount = 0;
	// Alternate screen borrowed for transient resize frames.
	#resizeAltActive = false;
	#stopped = false;
	// Event loop lag watchdog probe.
	#watchdog: LoopWatchdog;

	// Live tail of last resident alt paint.
	#altTailRows: string[] = [];
	// Pending replay flag for resident alt transcript on exit.
	#altTranscriptReplayPending = false;
	// Alt screen state for fullscreen overlay.
	#altActive = false;
	#altPreviousLines: string[] = [];
	// Caret position from last alt-buffer paint.
	#altPreviousCursor: { row: number; col: number } | undefined;
	// True when alt screen is active due to fullscreen overlay.
	#altOverlayBorrow = false;
	#altEnterWidth = 0;
	#altEnterHeight = 0;

	// Persistent composed frame and segment ledger.
	#composedFrame: string[] = [];
	#frameSegments: FrameSegment[] = [];
	#composeWidth = -1;
	#frameCursorMarkers: { row: number; col: number }[] = [];
	#renderStablePrefixRows = 0;

	// Component-scoped render targets accumulated since last frame.
	#componentRenderTargets = new Set<Component>();
	#pendingRenderComponentsOnly = false;
	// Root children to re-render during partial compose.
	#partialComposeRoots: Set<Component> | null = null;
	#partialComposeRootsScratch = new Set<Component>();
	// Component to containing root child cache.
	#componentRootCache = new WeakMap<Component, Component>();

	// Prepared frame rows and metadata cache aligned with #composedFrame.
	#preparedFrame: string[] = [];
	#preparedMeta: PreparedLine[] = [];
	#preparedValidRows = 0;

	overlayStack: {
		component: Component;
		options?: OverlayOptions;
		preFocus: Component | null;
		hidden: boolean;
		/** Overlay is animating its exit: painted but non-interactive. */
		exiting: boolean;
	}[] = [];

	constructor(terminal: Terminal, showHardwareCursor?: boolean, options?: TUIOptions) {
		super();
		this.terminal = terminal;
		this.#renderScheduler = options?.renderScheduler ?? DEFAULT_RENDER_SCHEDULER;
		this.#showHardwareCursor = showHardwareCursor === undefined ? this.#showHardwareCursor : showHardwareCursor;
		this.#watchdog = new LoopWatchdog();
	}

	override render(width: number): readonly string[] {
		width = Math.max(1, width);
		this.#nativeScrollbackLiveRegionStart = undefined;
		this.#frameDroppedRows = 0;
		this.#frameDroppedAt = undefined;
		const children = this.children;
		const previousSegments = this.#frameSegments;
		const segments: FrameSegment[] = new Array(children.length);
		let chainStable = this.#composeWidth === width;
		this.#composeWidth = width;
		let offset = 0;
		let stableRows = 0;
		const partialRoots = this.#partialComposeRoots;
		for (let index = 0; index < children.length; index++) {
			const child = children[index]!;
			const previous = previousSegments[index];
			// Component-scoped reuse: skip render if child unchanged.
			const reuse =
				partialRoots !== null && previous !== undefined && previous.component === child && !partialRoots.has(child);
			let childLines: readonly string[];
			let liveLocalStart: number | undefined;
			let reported: number | undefined;
			if (reuse) {
				childLines = previous.lines;
				liveLocalStart = previous.liveLocalStart;
			} else {
				// Feed committed rows count to child before render.
				const prevRows = previous !== undefined && previous.component === child ? previous.rowCount : 0;
				const prevStart = previous !== undefined && previous.component === child ? previous.start : offset;
				setNativeScrollbackCommittedRows(child, Math.min(prevRows, Math.max(0, this.#committedRows - prevStart)));
				// Keep a viewport of committed history for shrink re-display.
				setNativeScrollbackRetainRows(child, this.terminal.rows);
				childLines = child.render(width);
				// Read dropped rows report from virtualized child.
				const childDropped = takeNativeScrollbackDroppedRows(child);
				if (childDropped > 0) {
					this.#frameDroppedRows += childDropped;
					// Previous-frame coordinate offset for dropped rows.
					this.#frameDroppedAt = Math.min(this.#frameDroppedAt ?? prevStart, prevStart);
				}
				const liveRegionStart = getNativeScrollbackLiveRegionStart(child);
				if (liveRegionStart !== undefined) {
					liveLocalStart = Number.isFinite(liveRegionStart)
						? clampLow(Math.trunc(liveRegionStart), 0, childLines.length)
						: childLines.length;
				}
				// Read stability report for in-place mutators.
				reported = getRenderStablePrefixRows(child);
			}
			// Topmost seam defines the exactness boundary.
			if (liveLocalStart !== undefined && this.#nativeScrollbackLiveRegionStart === undefined) {
				this.#nativeScrollbackLiveRegionStart = offset + liveLocalStart;
			}
			if (chainStable) {
				if (previous !== undefined && previous.component === child && previous.start === offset) {
					let stableCount = 0;
					if (reported !== undefined) {
						// In-place mutator report overrides reference equality.
						stableCount = Number.isFinite(reported)
							? Math.max(0, Math.min(childLines.length, previous.rowCount, Math.trunc(reported)))
							: 0;
					} else if (previous.lines === childLines) {
						stableCount = childLines.length;
					}
					stableRows += stableCount;
					if (stableCount < childLines.length || previous.rowCount !== childLines.length) chainStable = false;
				} else {
					chainStable = false;
				}
			}
			segments[index] = {
				component: child,
				lines: childLines,
				start: offset,
				rowCount: childLines.length,
				liveLocalStart,
			};
			offset += childLines.length;
		}
		this.#frameSegments = segments;
		// Derive pinned footer rows from segment ledger.
		if (this.#pinnedFooterChildCount > 0 && segments.length >= this.#pinnedFooterChildCount) {
			this.#pinnedFooterRows = offset - segments[segments.length - this.#pinnedFooterChildCount]!.start;
		} else {
			this.#pinnedFooterRows = 0;
		}

		const frame = this.#composedFrame;
		// Clamp stable rows defensively.
		if (stableRows > frame.length) stableRows = frame.length;
		if (stableRows !== offset || frame.length !== offset) {
			// Re-ingest rows at/after stable prefix.
			frame.length = stableRows;
			this.#pruneFrameCursorMarkers(stableRows);
			for (let si = 0; si < segments.length; si++) {
				const segment = segments[si]!;
				const lines = segment.lines;
				const from = segment.start >= stableRows ? 0 : stableRows - segment.start;
				for (let i = from; i < lines.length; i++) this.#ingestFrameRow(lines[i]!);
			}
		}
		this.#renderStablePrefixRows = stableRows;
		this.#preparedValidRows = Math.min(this.#preparedValidRows, stableRows);
		return frame;
	}

	#pruneFrameCursorMarkers(fromRow: number): void {
		const markers = this.#frameCursorMarkers;
		let keep = markers.length;
		while (keep > 0 && markers[keep - 1]!.row >= fromRow) keep--;
		markers.length = keep;
	}

	/** Append one row to composed frame, stripping CURSOR_MARKER sentinels. */
	#ingestFrameRow(line: string): void {
		let markerIndex = line.indexOf(CURSOR_MARKER);
		if (markerIndex === -1) {
			this.#composedFrame.push(line);
			return;
		}
		this.#frameCursorMarkers.push({
			row: this.#composedFrame.length,
			col: visibleWidth(line.slice(0, markerIndex)),
		});
		let stripped = line;
		while (markerIndex !== -1) {
			stripped = stripped.slice(0, markerIndex) + stripped.slice(markerIndex + CURSOR_MARKER.length);
			markerIndex = stripped.indexOf(CURSOR_MARKER, markerIndex);
		}
		this.#composedFrame.push(stripped);
	}

	#syncTerminalCursorMode(component: Component | null): void {
		if (isFocusable(component)) {
			component.setUseTerminalCursor?.(this.#showHardwareCursor);
		}
	}

	get fullRedraws(): number {
		return this.#fullRedrawCount;
	}

	/** True while a frame is owed: requested, throttled, or settling. */
	get renderPending(): boolean {
		return (
			this.#renderRequested ||
			this.#renderTimer !== undefined ||
			this.#postFullPaintSettleTimer !== undefined ||
			this.#multiplexerResizeTimer !== undefined
		);
	}

	/** Rows of composed frame committed to native scrollback. */
	get committedRows(): number {
		return this.#committedRows;
	}

	/** Rows currently stored on the scroll tape. */
	get scrollTapeRows(): number {
		return this.#scrollTape.length;
	}

	/** Cap the scroll tape (rows). Floor enforced at terminal height. */
	setScrollTapeCap(rows: number): void {
		this.#scrollTapeCap = Math.max(this.terminal.rows, Math.trunc(rows));
		this.#trimScrollTape();
	}

	#trimScrollTape(): void {
		const excess = this.#scrollTape.length - this.#scrollTapeCap;
		if (excess > 0) this.#scrollTape.splice(0, excess);
	}

	/** Append rows that scrolled off the window to the scroll tape. */
	#appendScrollTape(rows: readonly string[], from: number, to: number): void {
		for (let i = from; i < to; i++) this.#scrollTape.push(rows[i] ?? "");
		this.#trimScrollTape();
	}

	/** Total rows in scroll space (tape plus uncommitted frame rows above pinned footer). */
	#scrollSpaceRows(frameRows = this.#previousFrameLength): number {
		const uncommittedEnd = Math.max(this.#committedRows, frameRows - this.#pinnedFooterRows);
		return this.#scrollTape.length + (uncommittedEnd - this.#committedRows);
	}

	/** Top row index of live tail view in scroll space. */
	#scrollSpaceLiveTop(frameRows = this.#previousFrameLength): number {
		const height = Math.max(1, this.terminal.rows);
		const footerRows = Math.min(this.#pinnedFooterRows, height - 1);
		const regionRows = height - footerRows;
		return Math.max(0, this.#scrollSpaceRows(frameRows) - regionRows);
	}

	/** Row count of the last composed frame. 0 before first render. */
	get composedFrameRows(): number {
		return this.#previousFrameLength;
	}

	/** Invoked at the top of every frame before root children render. */
	onBeforeCompose?: () => void;

	/** Invoked after frame commit once composed row count is readable. */
	onFrameComposed?: () => void;
	get resizeViewportPaints(): number {
		return this.#resizeViewportPaintCount;
	}

	get resizeViewportActive(): boolean {
		return this.#resizeViewportActive;
	}

	get imageBudget(): ImageBudget {
		return this.#imageBudget;
	}

	/** Set max live inline images before older ones fall back to text. */
	setMaxInlineImages(cap: number): void {
		this.#imageBudget.setCap(cap);
	}

	getScrollbackRebuild(): boolean {
		return this.#scrollbackRebuildEnabled;
	}

	/** Enable/disable scrollback divergence rebuild on finalized block updates. */
	setScrollbackRebuild(enabled: boolean): void {
		this.#scrollbackRebuildEnabled = enabled;
	}

	/** Enable or disable scroll isolation. */
	setScrollIsolation(enabled: boolean): void {
		if (this.#scrollIsolation === enabled) return;
		this.#scrollIsolation = enabled;
		this.#resumeLiveTail();
		this.#syncWheelTracking();
		this.#syncAltScroll();
		this.requestRender();
	}

	/** Set scroll transport mode ("mouse" vs "alt-arrows"). */
	setScrollTransport(transport: ScrollTransport): void {
		if (this.#scrollTransport === transport) return;
		this.#scrollTransport = transport;
		this.#resumeLiveTail();
		this.#syncWheelTracking();
		this.#syncAltScroll();
		// Log selected scroll transport and capabilities.
		logger.info("tui scroll transport selected", {
			transport,
			nativeSelectionPreserved: transport === "alt-arrows",
			typedArrowsReachComposer: transport === "mouse" || this.terminal.kittyProtocolActive === true,
			kittyKeyboardProtocol: this.terminal.kittyProtocolActive === true,
		});
		this.requestRender();
	}

	get scrollTransport(): ScrollTransport {
		return this.#scrollTransport;
	}

	/** Scroll frozen transcript region by `rows` (-1 back, +1 tail). */
	scrollByRows(rows: number): boolean {
		if (!this.#scrollIsolation || rows === 0) return false;
		if (!this.#frameScrollable) return false;
		return this.#applyScrollDelta(rows);
	}

	/** Reset virtual scroll state and resume following live tail. */
	#resumeLiveTail(): void {
		this.#virtualScrollTop = null;
		this.#scrollSnapshot = null;
	}

	get scrollIsolation(): boolean {
		return this.#scrollIsolation;
	}

	/** Pin the last `count` root children as the live footer (composer zone). */
	setPinnedFooterChildCount(count: number): void {
		this.#pinnedFooterChildCount = Math.max(0, count);
	}

	get virtualScrollActive(): boolean {
		return this.#virtualScrollTop !== null;
	}

	/** Rows between frozen view top and live tail. */
	get virtualScrollNewRows(): number {
		if (this.#virtualScrollTop === null) return 0;
		return Math.max(0, this.#scrollSpaceLiveTop() - this.#virtualScrollTop);
	}

	scrollToLiveTail(): void {
		if (this.#virtualScrollTop === null) return;
		this.#resumeLiveTail();
		this.requestRender();
	}

	/** True while any pinned footer child has click targets. */
	#footerWantsPointer(): boolean {
		const segments = this.#frameSegments;
		if (this.#pinnedFooterChildCount <= 0 || segments.length === 0) return false;
		const first = Math.max(0, segments.length - this.#pinnedFooterChildCount);
		for (let i = first; i < segments.length; i++) {
			const component = segments[i]!.component as Component & Partial<MouseRoutable>;
			if (component.wantsPointer?.() === true) return true;
		}
		return false;
	}
	/** Update mouse wheel/button tracking state. */
	#syncWheelTracking(): void {
		const want =
			this.#scrollTransport === "mouse" &&
			this.#scrollIsolation &&
			!this.#stopped &&
			this.#hasEverRendered &&
			!this.#altActive &&
			(this.#frameScrollable || this.#footerWantsPointer());
		if (want === this.#wheelTrackingActive) return;
		this.#wheelTrackingActive = want;
		// A press whose release lands after tracking flips would pair a stale cell
		// with an unrelated report, so the gesture never spans a mode change.
		this.#pressCell = null;
		this.terminal.write(want ? MOUSE_WHEEL_TRACKING_ON : MOUSE_WHEEL_TRACKING_OFF);
	}

	/** Update Alternate Scroll Mode state. */
	#syncAltScroll(): void {
		const want = this.#scrollTransport === "alt-arrows" && this.#scrollIsolation && !this.#stopped;
		if (want === this.#altScrollActive) return;
		this.#altScrollActive = want;
		this.terminal.write(want ? ALT_SCROLL_ON : ALT_SCROLL_OFF);
	}

	getShowHardwareCursor(): boolean {
		return this.#showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.#showHardwareCursor === enabled) return;
		this.#showHardwareCursor = enabled;
		this.#syncTerminalCursorMode(this.#focusedComponent);
		if (!enabled) {
			this.terminal.hideCursor();
			this.#recordHardwareCursorHidden();
		}
		this.requestRender();
	}

	/** Whether synchronized output (DEC 2026) is active. */
	get synchronizedOutput(): boolean {
		return this.#synchronizedOutputEnabled;
	}
	#deccaraFillsEnabled(): boolean {
		return TERMINAL.deccara && this.#synchronizedOutputEnabled;
	}

	setFocus(component: Component | null): void {
		const topVisibleOverlay = this.#getTopmostInteractiveOverlay();
		if (topVisibleOverlay && !isOverlayFocusTarget(topVisibleOverlay.component, component)) {
			const currentFocus = this.#focusedComponent;
			component = isOverlayFocusTarget(topVisibleOverlay.component, currentFocus)
				? currentFocus
				: topVisibleOverlay.component;
		}

		const previousFocusedComponent = this.#focusedComponent;
		if (isFocusable(previousFocusedComponent)) {
			previousFocusedComponent.focused = false;
		}

		this.#focusedComponent = component;

		// Set focused flag on new component and keep its software/hardware cursor
		// rendering mode aligned with TUI's single cursor-visibility preference.
		if (isFocusable(component)) {
			component.focused = true;
			this.#syncTerminalCursorMode(component);
		}
	}

	getFocused(): Component | null {
		return this.#focusedComponent;
	}
	/** Whether component is currently attached to root children or overlay stack. */
	#isAttached(component: Component): boolean {
		const seen = new Set<Component>();
		const search = (children: readonly Component[]): boolean => {
			for (let ci = 0; ci < children.length; ci++) {
				const child = children[ci]!;
				if (child === component) return true;
				if (seen.has(child)) continue;
				seen.add(child);
				const nested = (child as Partial<Container>).children;
				if (nested && search(nested)) return true;
			}
			return false;
		};
		if (search(this.children)) return true;
		const overlayComponents: Component[] = new Array(this.overlayStack.length);
		for (let oi = 0; oi < this.overlayStack.length; oi++) overlayComponents[oi] = this.overlayStack[oi]!.component;
		return search(overlayComponents);
	}

	/** Restore focus after an overlay closes, falling back to attached focusables. */
	#restoreFocusAfterOverlay(preFocus: Component | null): void {
		const topVisible = this.#getTopmostInteractiveOverlay();
		if (topVisible) {
			this.setFocus(topVisible.component);
			return;
		}
		if (preFocus && this.#isAttached(preFocus)) {
			this.setFocus(preFocus);
			return;
		}
		this.setFocus(this.#firstAttachedFocusable() ?? null);
	}

	#firstAttachedFocusable(): Component | null {
		const seen = new Set<Component>();
		const search = (children: readonly Component[]): Component | null => {
			for (const child of children) {
				if (seen.has(child)) continue;
				seen.add(child);
				const nested = (child as Partial<Container>).children;
				if (nested) {
					const found = search(nested);
					if (found) return found;
					continue;
				}
				if (isFocusable(child)) return child;
			}
			return null;
		};
		return search(this.children);
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		component.setIgnoreTight?.(true);
		const entry = { component, options, preFocus: this.#focusedComponent, hidden: false, exiting: false };
		this.overlayStack.push(entry);
		if (this.#isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.#recordHardwareCursorHidden();
		this.requestRender();

		const remove = (): void => {
			const index = this.overlayStack.indexOf(entry);
			if (index === -1) return;
			this.overlayStack.splice(index, 1);
			if (this.overlayStack.length === 0) {
				this.terminal.hideCursor();
				this.#recordHardwareCursorHidden();
			}
			this.requestRender();
		};

		return {
			hide: () => {
				if (entry.exiting || this.overlayStack.indexOf(entry) === -1) return;
				entry.exiting = true;
				if (isOverlayFocusTarget(component, this.#focusedComponent)) {
					this.#restoreFocusAfterOverlay(entry.preFocus);
				}
				if (canAnimateOverlayExit(component) && component.beginOverlayExit(() => this.requestRender(), remove)) {
					this.requestRender();
					return;
				}
				remove();
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				if (hidden) {
					// Move focus on hide.
					if (isOverlayFocusTarget(component, this.#focusedComponent)) {
						this.#restoreFocusAfterOverlay(entry.preFocus);
					}
				} else {
					if (this.#isOverlayVisible(entry)) {
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
		};
	}

	hasOverlay(): boolean {
		for (let i = 0; i < this.overlayStack.length; i++) {
			if (this.#isOverlayInteractive(this.overlayStack[i]!)) return true;
		}
		return false;
	}

	#isOverlayVisible(entry: (typeof this.overlayStack)[number]): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Whether overlay entry is visible and interactive (not exiting). */
	#isOverlayInteractive(entry: (typeof this.overlayStack)[number]): boolean {
		return !entry.exiting && this.#isOverlayVisible(entry);
	}

	#getTopmostVisibleOverlay(): (typeof this.overlayStack)[number] | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			if (this.#isOverlayVisible(this.overlayStack[i])) {
				return this.overlayStack[i];
			}
		}
		return undefined;
	}

	#getTopmostInteractiveOverlay(): (typeof this.overlayStack)[number] | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			if (this.#isOverlayInteractive(this.overlayStack[i])) {
				return this.overlayStack[i];
			}
		}
		return undefined;
	}

	override invalidate(): void {
		super.invalidate();
		for (let oi = 0; oi < this.overlayStack.length; oi++) {
			this.overlayStack[oi]!.component.invalidate?.();
		}
	}

	start(options?: TUIStartOptions): void {
		this.#stopped = false;
		this.#watchdog.start();
		this.#ghosttyInitialImageDelayDone = false;
		this.#ghosttyImageReadyAtMs = this.#renderScheduler.now() + TUI.#GHOSTTY_INITIAL_IMAGE_DELAY_MS;
		// Listen for mode 2026 synchronized output support reports.
		this.terminal.onPrivateModeReport?.((mode, supported) => {
			if (mode !== 2026) return;
			if (synchronizedOutputUserOverride() !== null) return;
			this.#setSynchronizedOutput(supported);
		});
		this.terminal.start(
			data => this.#handleInput(data),
			() => {
				// Debounce multiplexer resizes to prevent flash during pane reflow.
				this.#resizeEventPending = true;
				if (!resizeRepaintsInPlace()) {
					// Viewport fast path for non-multiplexer drag resizes.
					this.#beginResizeViewport();
					this.#requestResizeViewportPaint();
					return;
				}
				this.#armMultiplexerResizeTimer(false);
			},
		);
		for (const listener of this.#startListeners) {
			try {
				listener();
			} catch (error) {
				// Isolate start listener failures from core rendering.
				logger.error("TUI start listener threw; its feature did not initialize", {
					error: errorMessage(error),
				});
			}
		}
		this.terminal.hideCursor();
		this.#recordHardwareCursorHidden();
		this.#querySixelSupport();
		this.#queryCellSize();
		this.requestRender(true, { clearScrollback: options?.clearScrollback === true });
	}

	addStartListener(listener: StartListener): () => void {
		this.#startListeners.add(listener);
		return () => {
			this.#startListeners.delete(listener);
		};
	}

	addInputListener(listener: InputListener): () => void {
		this.#inputListeners.add(listener);
		return () => {
			this.#inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: InputListener): void {
		this.#inputListeners.delete(listener);
	}

	#querySixelSupport(): void {
		if (TERMINAL.imageProtocol) return;
		if (process.platform !== "win32") return;
		if (!Bun.env.WT_SESSION) return;
		if (!process.stdin.isTTY || !process.stdout.isTTY) return;

		this.#clearSixelProbeState();
		this.#sixelProbePendingDa = true;
		this.#sixelProbePendingGraphics = true;
		this.#sixelProbeUnsubscribe = this.addInputListener(data => this.#handleSixelProbeInput(data));
		this.terminal.write("\x1b[c");
		this.terminal.write("\x1b[?2;1;0S");
		this.#sixelProbeTimeout = setTimeout(() => {
			this.#finishSixelProbe(false);
		}, 250);
	}

	#handleSixelProbeInput(data: string): InputListenerResult {
		if (!this.#sixelProbePendingDa && !this.#sixelProbePendingGraphics) {
			return undefined;
		}

		this.#sixelProbeBuffer += data;
		let passthrough = "";
		let probeOutcome: boolean | null = null;

		while (this.#sixelProbeBuffer.length > 0) {
			const daMatch = this.#sixelProbeBuffer.match(/\x1b\[\?([0-9;]+)c/u);
			const graphicsMatch = this.#sixelProbeBuffer.match(/\x1b\[\?2;(\d+);([0-9;]+)S/u);

			if (!daMatch && !graphicsMatch) break;

			const daIndex = daMatch?.index ?? Number.POSITIVE_INFINITY;
			const graphicsIndex = graphicsMatch?.index ?? Number.POSITIVE_INFINITY;
			const useDa = daIndex <= graphicsIndex;
			const match = useDa ? daMatch : graphicsMatch;
			if (!match || match.index === undefined) break;

			passthrough += this.#sixelProbeBuffer.slice(0, match.index);
			this.#sixelProbeBuffer = this.#sixelProbeBuffer.slice(match.index + match[0].length);

			if (useDa && this.#sixelProbePendingDa) {
				this.#sixelProbePendingDa = false;
				const attributes = (match[1] ?? "")
					.split(";")
					.map(value => Number.parseInt(value, 10))
					.filter(value => Number.isFinite(value));
				const hasSixelAttribute = attributes.includes(4);
				if (hasSixelAttribute) {
					this.#sixelProbePendingGraphics = false;
					probeOutcome = true;
				} else if (!this.#sixelProbePendingGraphics) {
					probeOutcome = false;
				}
			} else if (!useDa && this.#sixelProbePendingGraphics) {
				this.#sixelProbePendingGraphics = false;
				const status = Number.parseInt(match[1] ?? "", 10);
				const supportsSixel = !Number.isNaN(status) && status !== 0;
				if (supportsSixel) {
					this.#sixelProbePendingDa = false;
					probeOutcome = true;
				} else if (!this.#sixelProbePendingDa) {
					probeOutcome = false;
				}
			}
		}

		if (this.#sixelProbePendingDa || this.#sixelProbePendingGraphics) {
			const partialStart = this.#getSixelProbePartialStart(this.#sixelProbeBuffer);
			if (partialStart >= 0) {
				passthrough += this.#sixelProbeBuffer.slice(0, partialStart);
				this.#sixelProbeBuffer = this.#sixelProbeBuffer.slice(partialStart);
			} else {
				passthrough += this.#sixelProbeBuffer;
				this.#sixelProbeBuffer = "";
			}
		} else {
			passthrough += this.#sixelProbeBuffer;
			this.#sixelProbeBuffer = "";
		}

		if (probeOutcome !== null) {
			this.#finishSixelProbe(probeOutcome);
		}

		if (passthrough.length === 0) {
			return { consume: true };
		}

		return { data: passthrough };
	}

	#getSixelProbePartialStart(buffer: string): number {
		const lastEsc = buffer.lastIndexOf("\x1b");
		if (lastEsc < 0) return -1;
		const tail = buffer.slice(lastEsc);
		if (/^\x1b\[\?[0-9;]*$/u.test(tail)) {
			return lastEsc;
		}
		return -1;
	}

	#clearSixelProbeState(): void {
		if (this.#sixelProbeTimeout) {
			clearTimeout(this.#sixelProbeTimeout);
			this.#sixelProbeTimeout = undefined;
		}
		if (this.#sixelProbeUnsubscribe) {
			this.#sixelProbeUnsubscribe();
			this.#sixelProbeUnsubscribe = undefined;
		}
		this.#sixelProbePendingDa = false;
		this.#sixelProbePendingGraphics = false;
		this.#sixelProbeBuffer = "";
	}

	#finishSixelProbe(supported: boolean): void {
		this.#clearSixelProbeState();
		if (!supported || TERMINAL.imageProtocol) return;

		setTerminalImageProtocol(ImageProtocol.Sixel);
		this.#queryCellSize();
		this.invalidate();
		this.requestRender(true);
	}
	#queryCellSize(): void {
		if (!TERMINAL.imageProtocol) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	/**
	 * Toggle synchronized-output (DEC 2026) wrappers on paint/cursor writes and
	 * recompute the cached begin/end sequences. Driven by the terminal's DECRQM
	 * mode-2026 report (#1765 covers the static env opt-out).
	 */
	#setSynchronizedOutput(enabled: boolean): void {
		if (this.#synchronizedOutputEnabled === enabled) return;
		this.#synchronizedOutputEnabled = enabled;
		this.#paintBeginSequence = enabled ? PAINT_BEGIN : PAINT_BEGIN_NO_SYNC;
		this.#paintEndSequence = enabled ? PAINT_END : PAINT_END_NO_SYNC;
		this.#cursorBeginSequence = enabled ? CURSOR_BEGIN : CURSOR_BEGIN_NO_SYNC;
		this.#cursorEndSequence = enabled ? CURSOR_END : CURSOR_END_NO_SYNC;
	}

	stop(): void {
		// Leave the alt buffer first so the teardown cursor math below runs against
		// the restored normal screen (which #previousLines still describes).
		if (this.#resizeAltActive) {
			this.terminal.write(this.#leaveResizeAltSequence());
		}
		if (this.#altActive) {
			const enhancementExit = this.#keyboardEnhancementExit();
			this.terminal.write(`${MOUSE_TRACKING_OFF}${enhancementExit}\x1b[?1049l`);
			setAltScreenActive(false);
			this.#altActive = false;
			this.#altPreviousLines = [];
		}
		if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
			for (const id of this.#imageBudget.takeAllTransmittedIds()) {
				this.terminal.write(encodeKittyDeleteImage(id));
			}
		}
		this.#clearSixelProbeState();
		this.#stopped = true;
		this.#syncWheelTracking();
		// Alternate Scroll Mode is a terminal flag, not a per-buffer one, so a
		// stopped engine that left it set would hand the operator's next
		// full-screen program a wheel that types arrow keys.
		this.#syncAltScroll();
		this.#watchdog.stop();
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
		// The request itself, not just its timer: a stopped engine owes no frame,
		// and leaving the flag set made `renderPending` report a frame that could
		// never arrive (`#scheduleRender` refuses while stopped). `start()` issues
		// its own full-paint request, so nothing depends on carrying this across.
		this.#renderRequested = false;
		if (this.#ghosttyInitialImageDelayTimer) {
			this.#ghosttyInitialImageDelayTimer.cancel();
			this.#ghosttyInitialImageDelayTimer = undefined;
		}
		if (this.#multiplexerResizeTimer) {
			this.#multiplexerResizeTimer.cancel();
			this.#multiplexerResizeTimer = undefined;
		}
		if (this.#resizeViewportSettleTimer) {
			this.#resizeViewportSettleTimer.cancel();
			this.#resizeViewportSettleTimer = undefined;
		}
		this.#resizeViewportActive = false;
		this.#clearPostFullPaintSettle();
		this.#deferredForcedClearScrollback = false;
		// Replay resident alt-buffer transcript to normal screen on exit.
		const replayedRows = this.#replayTranscriptToNormalScreen();
		// Place cursor after rendered content on exit.
		if (replayedRows === 0 && this.#previousFrameLength > 0) {
			const targetRow = this.#previousFrameLength;
			const viewportBottom = this.#windowTopRow + this.terminal.rows - 1;
			const clampedCursorRow = clampLow(this.#hardwareCursorRow, this.#windowTopRow, viewportBottom);
			const moveTargetRow = Math.min(targetRow, viewportBottom);
			const lineDiff = moveTargetRow - clampedCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write(targetRow <= viewportBottom ? "\r" : "\r\n");
		}

		this.terminal.showCursor();
		this.#forgetHardwareCursorState();
		this.terminal.stop();
	}

	/** Replay resident alt-buffer transcript to normal screen. */
	#replayTranscriptToNormalScreen(): number {
		if (!this.#altTranscriptReplayPending) return 0;
		this.#altTranscriptReplayPending = false;
		const rows = this.#scrollTape.concat(this.#altTailRows);
		if (rows.length === 0) return 0;
		// Format rows with line terminators for clean terminal history.
		let buffer = "";
		for (let ri = 0; ri < rows.length; ri++) buffer += `${rows[ri]!}${LINE_TERMINATOR}\r\n`;
		this.terminal.write(buffer);
		return rows.length;
	}

	/** Force an immediate full repaint and scrollback replay. */
	resetDisplay(): void {
		if (this.#stopped) return;
		this.invalidate();
		// Fold into in-flight multiplexer resize debounce if active.
		if (this.#multiplexerResizeTimer) {
			this.#armMultiplexerResizeTimer(!isMultiplexerSession());
			return;
		}
		this.#prepareForcedRender(!isMultiplexerSession());
		this.#resizeEventPending = true;
		this.#renderRequested = false;
		this.#executeRender();
	}

	requestRender(force = false, options?: RenderRequestOptions): void {
		this.#pendingRenderComponentsOnly = false;
		if (force) {
			// Fold forced repaints into in-flight multiplexer debounce.
			if (this.#multiplexerResizeTimer) {
				this.#armMultiplexerResizeTimer(options?.clearScrollback === true);
				return;
			}
			// Forced render preempts post-full-paint settle.
			this.#clearPostFullPaintSettle();
			this.#prepareForcedRender(options?.clearScrollback === true);
			this.#renderRequested = true;
			this.#renderScheduler.scheduleImmediate(() => {
				if (this.#stopped || !this.#renderRequested) {
					return;
				}
				this.#renderRequested = false;
				this.#executeRender();
			});
			return;
		}
		this.#requestOrdinaryRender();
	}

	/** Request a component-scoped partial render for localized updates. */
	requestComponentRender(component: Component): void {
		if (this.#stopped) return;
		// Accumulate component-scoped targets if no full render is pending.
		if (!this.#renderRequested && this.#postFullPaintSettleTimer === undefined) {
			this.#pendingRenderComponentsOnly = true;
		}
		this.#componentRenderTargets.add(component);
		this.#requestOrdinaryRender();
	}

	/** Rewrite a quiet, visible component segment directly without scheduling a full render. */
	requestDirectWrite(component: Component): void {
		if (this.#stopped) return;
		if (
			this.#renderRequested ||
			this.#postFullPaintSettleTimer !== undefined ||
			this.#postFullPaintSettleUntilMs > 0
		) {
			this.requestComponentRender(component);
			return;
		}

		const width = this.terminal.columns;
		const height = this.terminal.rows;
		if (!this.#hasEverRendered || this.#resizeEventPending) {
			this.requestComponentRender(component);
			return;
		}
		if (width !== this.#previousWidth || height !== this.#previousHeight || width !== this.#composeWidth) {
			this.requestComponentRender(component);
			return;
		}
		if (this.#clearScrollbackOnNextRender || this.#forceViewportRepaintOnNextRender) {
			this.requestComponentRender(component);
			return;
		}
		if (this.overlayStack.length > 0 || this.#altActive || !this.#imageBudget.quiescent) {
			this.requestComponentRender(component);
			return;
		}

		const children = this.children;
		const segments = this.#frameSegments;
		if (segments.length !== children.length) {
			this.requestComponentRender(component);
			return;
		}
		for (let i = 0; i < children.length; i++) {
			if (segments[i]!.component !== children[i]) {
				this.requestComponentRender(component);
				return;
			}
		}

		const root = this.#resolveComponentRoot(component);
		if (root === null) {
			this.requestComponentRender(component);
			return;
		}
		const segmentIndex = segments.findIndex(segment => segment.component === root);
		if (segmentIndex === -1) {
			this.requestComponentRender(component);
			return;
		}
		const segment = segments[segmentIndex]!;
		const fullyLiveUncommittedSegment = segment.liveLocalStart === 0 && segment.start >= this.#committedRows;
		if (
			(segment.liveLocalStart !== undefined && !fullyLiveUncommittedSegment) ||
			segment.start < this.#committedRows
		) {
			this.requestComponentRender(component);
			return;
		}

		const windowTop = Math.max(this.#committedRows, this.#composedFrame.length - height, 0);
		if (windowTop !== this.#windowTopRow) {
			this.requestComponentRender(component);
			return;
		}
		const screenStart = segment.start - windowTop;
		if (screenStart < 0 || screenStart + segment.rowCount > height) {
			this.requestComponentRender(component);
			return;
		}

		const nextLines = root.render(width);
		if (nextLines.length !== segment.rowCount) {
			this.requestComponentRender(component);
			return;
		}
		for (let li = 0; li < nextLines.length; li++) {
			if (nextLines[li]!.includes(CURSOR_MARKER)) {
				this.requestComponentRender(component);
				return;
			}
		}

		let firstChanged = -1;
		let lastChanged = -1;
		const previousWindow = this.#previousWindow;
		for (let i = 0; i < nextLines.length; i++) {
			const frameRow = segment.start + i;
			const raw = nextLines[i]!;
			const prepared = this.#prepareLine(raw, width);
			this.#composedFrame[frameRow] = raw;
			this.#preparedMeta[frameRow] = prepared;
			this.#preparedFrame[frameRow] = prepared.line;
			if (previousWindow[screenStart + i] === prepared.line) continue;
			previousWindow[screenStart + i] = prepared.line;
			if (firstChanged === -1) firstChanged = i;
			lastChanged = i;
		}
		segments[segmentIndex] = { ...segment, lines: nextLines };
		this.#preparedValidRows = Math.max(this.#preparedValidRows, segment.start + nextLines.length);
		this.#renderStablePrefixRows = Math.min(this.#renderStablePrefixRows, segment.start);

		let cursorPos: { row: number; col: number } | null = null;
		for (let i = this.#frameCursorMarkers.length - 1; i >= 0; i--) {
			const marker = this.#frameCursorMarkers[i]!;
			if (marker.row >= windowTop) {
				cursorPos = marker;
				break;
			}
		}

		if (firstChanged === -1) {
			this.#writeCursorPosition(cursorPos, this.#composedFrame.length);
			this.#previousWidth = width;
			this.#previousHeight = height;
			return;
		}

		const currentScreenRow = clampLow(this.#hardwareCursorRow - windowTop, 0, height - 1);
		const targetScreenRow = screenStart + firstChanged;
		const rowDelta = targetScreenRow - currentScreenRow;
		let buffer = this.#paintBeginSequence;
		if (rowDelta > 0) buffer += `\x1b[${rowDelta}B`;
		else if (rowDelta < 0) buffer += `\x1b[${-rowDelta}A`;
		buffer += "\r";
		for (let i = firstChanged; i <= lastChanged; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(this.#preparedFrame[segment.start + i] ?? "", width);
		}
		const cursorControl = this.#cursorControlSequence(
			cursorPos,
			this.#composedFrame.length,
			segment.start + lastChanged,
		);
		buffer += cursorControl.seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
		this.#windowTopRow = windowTop;
		this.#commit(this.#composedFrame, previousWindow, width, height, cursorControl);
	}

	#requestOrdinaryRender(): void {
		// Coalesce non-forced renders inside post-full-paint settle window.
		if (this.#postFullPaintSettleUntilMs > 0) {
			const now = this.#renderScheduler.now();
			if (now < this.#postFullPaintSettleUntilMs) {
				if (this.#postFullPaintSettleTimer === undefined) {
					this.#postFullPaintSettleTimer = this.#renderScheduler.scheduleRender(() => {
						this.#postFullPaintSettleTimer = undefined;
						this.#postFullPaintSettleUntilMs = 0;
						if (this.#stopped) return;
						this.#requestOrdinaryRender();
					}, this.#postFullPaintSettleUntilMs - now);
				}
				return;
			}
			this.#postFullPaintSettleUntilMs = 0;
		}
		if (this.#renderRequested) return;
		this.#renderRequested = true;
		this.#renderScheduler.scheduleImmediate(() => this.#scheduleRender());
	}

	/** Decide whether this frame may compose component-scoped, resolving root children to re-render. */
	#resolvePartialComposeRoots(width: number, height: number): Set<Component> | null {
		if (this.#componentRenderTargets.size === 0) return null;
		if (!this.#hasEverRendered || this.#resizeEventPending) return null;
		if (width !== this.#previousWidth || height !== this.#previousHeight || width !== this.#composeWidth) return null;
		if (this.#clearScrollbackOnNextRender || this.#forceViewportRepaintOnNextRender) return null;
		if (this.overlayStack.length > 0) return null;
		if (!this.#imageBudget.quiescent) return null;
		const children = this.children;
		const segments = this.#frameSegments;
		if (segments.length !== children.length) return null;
		for (let i = 0; i < children.length; i++) {
			if (segments[i]!.component !== children[i]) return null;
		}
		const roots = this.#partialComposeRootsScratch;
		roots.clear();
		for (const target of this.#componentRenderTargets) {
			const root = this.#resolveComponentRoot(target);
			if (root === null) return null;
			roots.add(root);
		}
		return roots;
	}

	#resolveComponentRoot(target: Component): Component | null {
		const cached = this.#componentRootCache.get(target);
		if (cached !== undefined && this.children.includes(cached) && subtreeContains(cached, target)) {
			return cached;
		}
		for (let ci = 0; ci < this.children.length; ci++) {
			if (subtreeContains(this.children[ci]!, target)) {
				this.#componentRootCache.set(target, this.children[ci]!);
				return this.children[ci]!;
			}
		}
		this.#componentRootCache.delete(target);
		return null;
	}

	/** Arm or extend multiplexer-resize debounce timer for a single forced render once quiet. */
	#armMultiplexerResizeTimer(clearScrollback: boolean): void {
		this.#deferredForcedClearScrollback ||= clearScrollback;
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
		this.#renderRequested = false;
		if (this.#multiplexerResizeTimer) {
			this.#multiplexerResizeTimer.cancel();
		}
		this.#multiplexerResizeTimer = this.#renderScheduler.scheduleRender(() => {
			this.#multiplexerResizeTimer = undefined;
			if (this.#stopped) {
				this.#deferredForcedClearScrollback = false;
				return;
			}
			const deferredClearScrollback = this.#deferredForcedClearScrollback;
			this.#deferredForcedClearScrollback = false;
			this.requestRender(true, { clearScrollback: deferredClearScrollback });
		}, TUI.#MULTIPLEXER_RESIZE_DEBOUNCE_MS);
	}

	/** Arm post-full-paint settle window after an overflowing emit on ConPTY hosts. */
	#armPostFullPaintSettle(): void {
		if (!isConPTYHosted()) return;
		const until = this.#renderScheduler.now() + TUI.#CONPTY_POST_FULL_PAINT_SETTLE_MS;
		if (until <= this.#postFullPaintSettleUntilMs) return;
		this.#postFullPaintSettleUntilMs = until;
		const hadPendingRender = this.#renderRequested || this.#renderTimer !== undefined;
		this.#renderRequested = false;
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
		if (this.#postFullPaintSettleTimer) {
			this.#postFullPaintSettleTimer.cancel();
			this.#postFullPaintSettleTimer = undefined;
		}
		if (hadPendingRender) {
			this.#postFullPaintSettleTimer = this.#renderScheduler.scheduleRender(() => {
				this.#postFullPaintSettleTimer = undefined;
				this.#postFullPaintSettleUntilMs = 0;
				if (this.#stopped) return;
				this.#requestOrdinaryRender();
			}, TUI.#CONPTY_POST_FULL_PAINT_SETTLE_MS);
		}
	}

	#clearPostFullPaintSettle(): void {
		if (this.#postFullPaintSettleTimer) {
			this.#postFullPaintSettleTimer.cancel();
			this.#postFullPaintSettleTimer = undefined;
		}
		this.#postFullPaintSettleUntilMs = 0;
	}

	#maybeDeferGhosttyInitialImagePaint(): boolean {
		if (this.#ghosttyInitialImageDelayDone) return false;
		if (TERMINAL.id !== "ghostty" || TERMINAL.imageProtocol !== ImageProtocol.Kitty) {
			this.#ghosttyInitialImageDelayDone = true;
			return false;
		}
		if (!this.#imageBudget.hasPendingTransmits()) return false;
		if (this.#ghosttyInitialImageDelayTimer) return true;

		const delayMs = Math.max(0, this.#ghosttyImageReadyAtMs - this.#renderScheduler.now());
		if (delayMs === 0) {
			this.#ghosttyInitialImageDelayDone = true;
			return false;
		}

		this.#ghosttyInitialImageDelayTimer = this.#renderScheduler.scheduleRender(() => {
			this.#ghosttyInitialImageDelayTimer = undefined;
			this.#ghosttyInitialImageDelayDone = true;
			if (this.#stopped) return;
			this.#executeRender();
			if (this.#renderRequested) this.#scheduleRender();
		}, delayMs);
		return true;
	}
	#prepareForcedRender(clearScrollback: boolean): void {
		this.#clearScrollbackOnNextRender ||= clearScrollback;
		this.#forceViewportRepaintOnNextRender = true;
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
	}

	#scheduleRender(): void {
		if (this.#stopped || this.#renderTimer || !this.#renderRequested) {
			return;
		}
		if (this.#multiplexerResizeTimer) {
			return;
		}
		const now = this.#renderScheduler.now();
		const elapsed = now - this.#lastRenderAt;
		const cadenceDelay = Math.max(0, TUI.#MIN_RENDER_INTERVAL_MS - elapsed);
		// Adaptive backpressure: target ~50% render duty cycle.
		const adaptiveFloor = Math.min(TUI.#MAX_ADAPTIVE_RENDER_MS, this.#frameCostEstimateMs * 2);
		const adaptiveDelay = Math.max(0, adaptiveFloor - elapsed);
		const inputGraceDelay = Math.max(0, this.#inputRenderGraceUntilMs - now);
		const delay = Math.max(cadenceDelay, adaptiveDelay, inputGraceDelay);
		this.#renderTimer = this.#renderScheduler.scheduleRender(() => {
			this.#renderTimer = undefined;
			if (this.#stopped || !this.#renderRequested) {
				return;
			}
			this.#renderRequested = false;
			this.#executeRender();
			if (this.#renderRequested) {
				this.#scheduleRender();
			}
		}, delay);
	}

	/** Wrap #doRender() to record frame cost and report loop phase. */
	#executeRender(): void {
		const start = this.#renderScheduler.now();
		this.#lastRenderAt = start;
		pushLoopPhase("ui.render");
		try {
			this.#doRender();
		} finally {
			popLoopPhase();
			const costMs = this.#renderScheduler.now() - start;
			this.#frameCostEstimateMs += TUI.#FRAME_COST_SMOOTHING * (costMs - this.#frameCostEstimateMs);
		}
	}

	/** Wheel step for scroll isolation: freeze/walk the transcript region. */
	#pinnedFooterScreenBounds(): {
		footerTop: number;
		footerBottom: number;
		footerRowOffset: number;
		contentBottom: number;
	} {
		if (this.#virtualScrollTop !== null) {
			const height = Math.max(1, this.terminal.rows);
			const footerRows = Math.min(this.#pinnedFooterRows, height - 1);
			const footerTop = height - footerRows;
			return {
				footerTop,
				footerBottom: height - 1,
				contentBottom: height - 1,
				footerRowOffset: height - this.#pinnedFooterRows,
			};
		}
		const frameLength = this.#composedFrame.length;
		const windowTop = this.#windowTopRow;
		const footerTop = frameLength - this.#pinnedFooterRows - windowTop;
		const footerBottom = frameLength - 1 - windowTop;
		return {
			footerTop,
			footerBottom,
			contentBottom: footerBottom,
			footerRowOffset: footerTop,
		};
	}

	/** Route a pinned-footer click to the root child under it. */
	#routeFooterMouse(event: SgrMouseEvent, footerRow: number): void {
		const segments = this.#frameSegments;
		if (segments.length === 0) return;
		const last = segments[segments.length - 1]!;
		const totalFrameRows = last.start + last.rowCount;
		const frameRow = totalFrameRows - this.#pinnedFooterRows + footerRow;
		const firstFooterIndex = Math.max(0, segments.length - this.#pinnedFooterChildCount);
		for (let i = firstFooterIndex; i < segments.length; i++) {
			const segment = segments[i]!;
			if (segment.rowCount <= 0) continue;
			if (frameRow < segment.start || frameRow >= segment.start + segment.rowCount) continue;
			const component = segment.component as Component & Partial<MouseRoutable>;
			if (typeof component.routeMouse === "function") {
				const localRow = clampLow(frameRow - segment.start, 0, segment.rowCount - 1);
				component.routeMouse(event, localRow, event.col);
				this.requestRender();
			}
			return;
		}
	}

	#handleIsolationWheel(direction: -1 | 1): void {
		const now = this.#renderScheduler.now();
		if (direction === this.#lastWheelDirection && now - this.#lastWheelAtMs < TUI.#WHEEL_ACCEL_WINDOW_MS) {
			this.#wheelStreak = Math.min(this.#wheelStreak + 1, TUI.#WHEEL_ACCEL_MAX_STREAK);
		} else {
			this.#wheelStreak = 0;
		}
		this.#lastWheelDirection = direction;
		this.#lastWheelAtMs = now;
		const step = TUI.#WHEEL_SCROLL_ROWS * (1 + this.#wheelStreak);
		this.#applyScrollDelta(direction === -1 ? -step : step);
	}

	/** Move the frozen transcript view by `rows` in scroll-space coordinates. */
	#applyScrollDelta(rows: number): boolean {
		const liveTop = this.#scrollSpaceLiveTop();
		if (rows < 0) {
			if (liveTop === 0 && this.#virtualScrollTop === null) return false;
			const next = Math.max(0, (this.#virtualScrollTop ?? liveTop) + rows);
			if (next === this.#virtualScrollTop) return false; // already at the oldest row
			this.#virtualScrollTop = next;
		} else if (this.#virtualScrollTop !== null) {
			const next = this.#virtualScrollTop + rows;
			if (next >= liveTop) {
				this.#resumeLiveTail();
			} else {
				this.#virtualScrollTop = next;
			}
		} else {
			return false;
		}
		this.requestRender();
		return true;
	}

	/** Handle raw input bytes delivered by the terminal. */
	#handleInput(data: string): void {
		pushLoopPhase("ui.input");
		try {
			this.#dispatchInput(data);
		} finally {
			popLoopPhase();
		}
	}

	#dispatchInput(data: string): void {
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
			this.#inputRenderGraceUntilMs = this.#renderScheduler.now() + TUI.#INPUT_RENDER_GRACE_MS;
		}
		if (this.#inputListeners.size > 0) {
			let current = data;
			for (const listener of this.#inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		if (this.#consumeCellSizeResponse(data)) {
			return;
		}

		if (this.#wheelTrackingActive && !this.#altActive && data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (event) {
				if (event.wheel) {
					this.#pressCell = null;
					this.#handleIsolationWheel(event.wheel);
					return;
				}
				const { footerTop, footerBottom, footerRowOffset, contentBottom } = this.#pinnedFooterScreenBounds();
				if (event.leftClick) {
					this.#pressCell =
						event.row >= 0 && event.row < footerTop && event.row <= contentBottom
							? { row: event.row, col: event.col }
							: null;
				} else if (event.release) {
					const press = this.#pressCell;
					this.#pressCell = null;
					if (press && (press.row !== event.row || press.col !== event.col)) {
						this.onSelectionAttempt?.();
					}
				}
				if (
					event.leftClick &&
					this.#pinnedFooterRows > 0 &&
					event.row >= footerTop &&
					event.row <= footerBottom &&
					event.row >= 0 &&
					event.row < this.terminal.rows
				) {
					this.#routeFooterMouse(event, event.row - footerRowOffset);
					if (this.#virtualScrollTop !== null) {
						this.scrollToLiveTail();
					}
				}
				return;
			}
		}

		if (this.#altActive && !this.#altOverlayBorrow && this.#altTranscriptWanted()) {
			const scroll = LEGACY_CURSOR_SCROLL[data];
			if (scroll !== undefined && this.scrollByRows(scroll * TUI.#WHEEL_SCROLL_ROWS)) {
				return;
			}
		}

		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		const focusedOverlay = this.overlayStack.find(o => o.component === this.#focusedComponent);
		if (focusedOverlay && !this.#isOverlayInteractive(focusedOverlay)) {
			this.#restoreFocusAfterOverlay(focusedOverlay.preFocus);
		}

		if (this.#focusedComponent?.handleInput) {
			if (isKeyRelease(data) && !this.#focusedComponent.wantsKeyRelease) {
				return;
			}
			this.#focusedComponent.handleInput(data);
			this.requestRender();
		}
	}

	#consumeCellSizeResponse(data: string): boolean {
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		this.invalidate();
		this.requestRender();
		return true;
	}

	/** Resolve overlay layout from options. */
	#resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number } {
		const opt = options ?? {};

		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		width = clampLow(width, 1, availWidth);

		let maxHeight = parseSizeValue(opt.maxHeight, termHeight) ?? availHeight;
		maxHeight = clampLow(maxHeight, 1, availHeight);

		const effectiveHeight = Math.min(overlayHeight, maxHeight);

		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					row = this.#resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				row = opt.row;
			}
		} else {
			const anchor = opt.anchor ?? "center";
			row = this.#resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					col = this.#resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				col = opt.col;
			}
		} else {
			const anchor = opt.anchor ?? "center";
			col = this.#resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		row = clampLow(row, marginTop, termHeight - marginBottom - effectiveHeight);
		col = clampLow(col, marginLeft, termWidth - marginRight - width);

		return { width, row, col, maxHeight };
	}

	#resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	#resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** Composite all visible overlays into the window slice. */
	#compositeOverlaysIntoWindow(window: string[], termWidth: number, termHeight: number): string[] {
		let result = window;
		let copied = false;
		for (let oi = 0; oi < this.overlayStack.length; oi++) {
			const entry = this.overlayStack[oi]!;
			if (!this.#isOverlayVisible(entry)) continue;
			const { component, options } = entry;
			const { width, maxHeight } = this.#resolveOverlayLayout(options, 0, termWidth, termHeight);
			let overlayLines = component.render(width);
			if (overlayLines.length > maxHeight) {
				const anchor = options?.anchor ?? "center";
				overlayLines =
					anchor === "bottom-left" || anchor === "bottom-center" || anchor === "bottom-right"
						? overlayLines.slice(overlayLines.length - maxHeight)
						: overlayLines.slice(0, maxHeight);
			}
			const { row, col } = this.#resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);
			if (!copied) {
				result = window.slice();
				copied = true;
			}
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = row + i;
				if (idx < 0 || idx >= result.length) continue;
				const truncatedOverlayLine =
					visibleWidth(overlayLines[i]) > width ? sliceByColumn(overlayLines[i], 0, width, true) : overlayLines[i];
				result[idx] = this.#compositeLineAt(result[idx], truncatedOverlayLine, col, width, termWidth);
			}
		}
		return result;
	}

	/** Draw scroll track on the right edge of the frozen transcript region. */
	#drawScrollTrack(window: string[], regionRows: number, viewTop: number, spaceRows: number, width: number): void {
		if (width < 4 || regionRows < 2 || spaceRows <= regionRows) return;
		const col = width - 1;
		const thumbRows = clampLow(Math.round((regionRows * regionRows) / spaceRows), 1, regionRows);
		const travel = regionRows - thumbRows;
		const scrollable = spaceRows - regionRows;
		const thumbTop = travel <= 0 ? 0 : clampLow(Math.round((viewTop / scrollable) * travel), 0, travel);
		for (let r = 0; r < regionRows; r++) {
			const inThumb = r >= thumbTop && r < thumbTop + thumbRows;
			const cell = inThumb ? SCROLL_TRACK_THUMB : SCROLL_TRACK_GROOVE;
			window[r] = this.#compositeLineAt(window[r] ?? "", cell, col, 1, width);
		}
	}

	#compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (TERMINAL.isImageLine(baseLine)) return baseLine;

		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		const r = SGR_RESET;
		const result = padding(beforePad) + r + overlay.text + padding(overlayPad) + r + base.after + padding(afterPad);

		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}
		return sliceByColumn(result, 0, totalWidth, true);
	}

	/** Strip every CURSOR_MARKER from rendered lines and return marker positions. */
	#extractCursorMarkers(lines: string[]): { row: number; col: number }[] {
		const markers: { row: number; col: number }[] = [];
		for (let row = lines.length - 1; row >= 0; row--) {
			const line = lines[row];
			let markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex === -1) continue;
			const beforeMarker = line.slice(0, markerIndex);
			markers.push({ row, col: visibleWidth(beforeMarker) });
			let stripped = line;
			while (markerIndex !== -1) {
				stripped = stripped.slice(0, markerIndex) + stripped.slice(markerIndex + CURSOR_MARKER.length);
				markerIndex = stripped.indexOf(CURSOR_MARKER, markerIndex);
			}
			lines[row] = stripped;
		}
		return markers;
	}

	#truncateLargeConptyFrame(
		lines: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
	): { lines: string[]; cursorPos: { row: number; col: number } | null } {
		if (!isConPTYHosted()) return { lines, cursorPos };

		let totalBytes = 0;
		let exceedsThreshold = false;
		for (let li = 0; li < lines.length; li++) {
			totalBytes += Buffer.byteLength(lines[li]!, "utf8") + 8;
			if (totalBytes > TUI.#CONPTY_FRAME_TRUNCATE_THRESHOLD_BYTES) {
				exceedsThreshold = true;
				break;
			}
		}
		if (!exceedsThreshold) return { lines, cursorPos };

		let retainedBytes = 0;
		let retainedStart = lines.length;
		while (
			retainedStart > 0 &&
			(retainedBytes < TUI.#CONPTY_FRAME_RETAIN_BYTES || lines.length - retainedStart < height)
		) {
			retainedStart -= 1;
			retainedBytes += Buffer.byteLength(lines[retainedStart] ?? "", "utf8") + 8;
		}
		if (retainedStart <= 0) return { lines, cursorPos };

		const marker = truncateToWidth(
			`[${retainedStart} older lines hidden to keep Windows console resume responsive]`,
			width,
			Ellipsis.Omit,
		);
		const truncated = new Array<string>(lines.length - retainedStart + 1);
		truncated[0] = marker;
		for (let i = retainedStart; i < lines.length; i++) {
			truncated[i - retainedStart + 1] = lines[i] ?? "";
		}

		if (cursorPos === null || cursorPos.row < retainedStart) {
			return { lines: truncated, cursorPos: null };
		}
		return {
			lines: truncated,
			cursorPos: { row: cursorPos.row - retainedStart + 1, col: cursorPos.col },
		};
	}

	#terminalLine(line: string): string {
		if (TERMINAL.isImageLine(line)) return line;
		const coalesced = coalesceAdjacentSgr(line);
		return coalesced + (line.includes("\x1b]8;") ? LINE_TERMINATOR : SGR_RESET);
	}

	#syncAltScreenState(width: number, height: number): boolean {
		const overlayWantsAlt = this.#wantsAltScreen();
		const transcriptWantsAlt = this.#altTranscriptWanted();
		const wantAlt = overlayWantsAlt || transcriptWantsAlt;
		if (wantAlt && !this.#altActive) {
			const tracking = overlayWantsAlt ? MOUSE_TRACKING_ON : "";
			this.terminal.write(`\x1b[?1049h${this.#keyboardEnhancementEnter()}${tracking}`);
			setAltScreenActive(true);
			this.terminal.hideCursor();
			this.#forgetHardwareCursorState();
			this.#recordHardwareCursorHidden();
			this.#altActive = true;
			this.#altPreviousLines = [];
			this.#altPreviousCursor = undefined;
			this.#altEnterWidth = width;
			this.#altEnterHeight = height;
			this.#syncAltScroll();
		} else if (wantAlt && this.#altActive && overlayWantsAlt !== this.#altOverlayBorrow) {
			this.terminal.write(overlayWantsAlt ? MOUSE_TRACKING_ON : MOUSE_TRACKING_OFF);
			this.#altPreviousLines = [];
			this.#altPreviousCursor = undefined;
		} else if (!wantAlt && this.#altActive) {
			const enhancementExit = this.#keyboardEnhancementExit();
			this.terminal.write(`${MOUSE_TRACKING_OFF}${enhancementExit}\x1b[?1049l`);
			setAltScreenActive(false);
			this.#forgetHardwareCursorState();
			this.#altActive = false;
			this.#syncWheelTracking();
			this.#altPreviousLines = [];
			this.#altPreviousCursor = undefined;
			if (width !== this.#altEnterWidth || height !== this.#altEnterHeight) {
				this.#resizeEventPending = true;
			}
		}
		this.#altOverlayBorrow = overlayWantsAlt;
		if (this.#altActive && overlayWantsAlt) {
			this.#componentRenderTargets.clear();
			this.#renderAltFrame(width, height);
			return true;
		}
		return false;
	}

	#composeFrame(width: number, height: number, componentScopedOnly: boolean): readonly string[] {
		const replayFullHistory =
			this.#hasEverRendered &&
			!resizeRepaintsInPlace() &&
			(this.#clearScrollbackOnNextRender ||
				this.#resizeEventPending ||
				(this.#previousWidth > 0 && this.#previousWidth !== width) ||
				(this.#previousHeight > 0 && this.#previousHeight !== height));
		if (replayFullHistory) {
			for (const child of this.children) prepareNativeScrollbackReplay(child);
		}

		const partialRoots = componentScopedOnly ? this.#resolvePartialComposeRoots(width, height) : null;
		this.#componentRenderTargets.clear();
		let rawFrame: readonly string[];
		if (partialRoots !== null) {
			this.#partialComposeRoots = partialRoots;
			try {
				rawFrame = this.render(width);
			} finally {
				this.#partialComposeRoots = null;
			}
		} else {
			this.#imageBudget.beginPass();
			rawFrame = this.render(width);
			this.#imageBudget.endPass();
		}
		this.#compactVirtualizedDroppedRows();
		return rawFrame;
	}

	#compactVirtualizedDroppedRows(): void {
		if (this.#frameDroppedRows <= 0) return;
		const at = Math.min(this.#frameDroppedAt ?? 0, this.#committedRows);
		const dropped = Math.min(this.#frameDroppedRows, Math.max(0, this.#committedRows - at));
		this.#frameDroppedRows = 0;
		this.#frameDroppedAt = undefined;
		if (dropped > 0) {
			this.#committedRows -= dropped;
			this.#committedPrefixAuditRows =
				this.#committedPrefixAuditRows > at
					? Math.max(at, this.#committedPrefixAuditRows - dropped)
					: this.#committedPrefixAuditRows;
			this.#committedPrefix.splice(at, dropped);
			this.#windowTopRow = Math.max(0, this.#windowTopRow - dropped);
			this.#previousFrameLength = Math.max(0, this.#previousFrameLength - dropped);
			this.#hardwareCursorRow =
				this.#hardwareCursorRow > at ? Math.max(at, this.#hardwareCursorRow - dropped) : this.#hardwareCursorRow;
		}
	}

	#auditAndResyncCommittedPrefix(
		rawFrame: readonly string[],
		width: number,
		height: number,
		finalBoundary: number,
	): {
		geometryChanged: boolean;
		committedRowsResynced: boolean;
		frameSqueezed: boolean;
		preCommitRows: number;
		preAuditRows: number;
		auditRan: boolean;
	} {
		const resizeEventOccurred = this.#resizeEventPending;
		this.#resizeEventPending = false;
		if (resizeEventOccurred) this.#forgetHardwareCursorState();
		const widthChanged = this.#previousWidth > 0 && this.#previousWidth !== width;
		const heightChanged =
			(this.#previousHeight > 0 && this.#previousHeight !== height) ||
			(resizeEventOccurred && this.#previousHeight > 0);
		const geometryChanged = widthChanged || heightChanged;

		let committedRowsResynced = false;
		const newlyFinalEnd = Math.min(this.#committedRows, finalBoundary);
		if (this.#committedPrefixAuditRows > newlyFinalEnd) {
			this.#committedPrefixAuditRows = newlyFinalEnd;
		}
		const auditRan =
			this.#hasEverRendered &&
			!geometryChanged &&
			!this.#clearScrollbackOnNextRender &&
			(this.#renderStablePrefixRows < this.#committedPrefixAuditRows ||
				newlyFinalEnd > this.#committedPrefixAuditRows);
		if (auditRan) {
			const committedRowsBeforeAudit = this.#committedRows;
			this.#auditCommittedPrefix(rawFrame, newlyFinalEnd);
			committedRowsResynced = this.#committedRows !== committedRowsBeforeAudit;
		}

		let frameSqueezed = false;
		const frameLength = rawFrame.length;
		if (!geometryChanged && !this.#clearScrollbackOnNextRender && frameLength < this.#committedRows) {
			const limit = Math.min(this.#committedRows, frameLength);
			let diverged = limit;
			for (let i = 0; i < limit; i++) {
				if (!rowsEquivalent(rawFrame[i]!, this.#committedPrefix[i]!)) {
					diverged = i;
					break;
				}
			}
			const contentDiverged = diverged < limit;
			frameSqueezed = !contentDiverged;
			if (diverged < this.#committedRows) {
				this.#committedRows = diverged;
				this.#committedPrefixAuditRows = Math.min(this.#committedPrefixAuditRows, diverged);
				this.#committedPrefix.length = diverged;
				if (contentDiverged) committedRowsResynced = true;
			}
		}

		return {
			geometryChanged,
			committedRowsResynced,
			frameSqueezed,
			preCommitRows: this.#committedRows,
			preAuditRows: this.#committedPrefixAuditRows,
			auditRan,
		};
	}

	#planCommitAndWindow(
		rawFrame: readonly string[],
		height: number,
		geometryChanged: boolean,
		committedRowsResynced: boolean,
		frameSqueezed: boolean,
		cursorMarkers: readonly { row: number; col: number }[],
	): {
		windowTop: number;
		chunkTo: number;
		committedPrefixResliced: boolean;
		hasVisibleOverlay: boolean;
		fullPaint: boolean;
		shouldRehydrate: boolean;
		divergenceRebuild: boolean;
		replaceRequested: boolean;
		geometryRebuild: boolean;
	} {
		let hasVisibleOverlay = false;
		for (let oi = 0; oi < this.overlayStack.length; oi++) {
			if (this.#isOverlayVisible(this.overlayStack[oi]!)) {
				hasVisibleOverlay = true;
				break;
			}
		}

		const frameLength = rawFrame.length;
		const firstPaint = !this.#hasEverRendered;
		const replaceRequested = this.#clearScrollbackOnNextRender;
		const geometryRebuild = geometryChanged && !resizeRepaintsInPlace();
		const divergenceRebuild =
			this.#scrollbackRebuildEnabled &&
			!firstPaint &&
			!replaceRequested &&
			!geometryChanged &&
			!isMultiplexerSession() &&
			!frameSqueezed &&
			(committedRowsResynced || frameLength <= this.#committedRows);
		const fullPaint = firstPaint || replaceRequested || geometryRebuild || divergenceRebuild;

		if (
			divergenceRebuild &&
			!this.#rehydratingDivergence &&
			this.children.some(child => canPrepareNativeScrollbackReplay(child))
		) {
			return {
				windowTop: 0,
				chunkTo: 0,
				committedPrefixResliced: false,
				hasVisibleOverlay,
				fullPaint,
				shouldRehydrate: true,
				divergenceRebuild,
				replaceRequested,
				geometryRebuild,
			};
		}

		const historyEnd = this.#historyEndRow(frameLength);
		let windowTop: number;
		let chunkTo: number;
		let committedPrefixResliced = false;
		let cursorBeyondCommitted = false;
		if (frameLength - this.#committedRows < height) {
			for (let mi = 0; mi < cursorMarkers.length; mi++) {
				if (cursorMarkers[mi]!.row >= this.#committedRows) {
					cursorBeyondCommitted = true;
					break;
				}
			}
		}

		if (fullPaint) {
			committedPrefixResliced = true;
			windowTop = Math.max(0, frameLength - height);
			chunkTo = Math.min(windowTop, historyEnd);
		} else if (frameLength <= this.#committedRows || cursorBeyondCommitted) {
			committedPrefixResliced = true;
			windowTop = Math.max(0, frameLength - height);
			chunkTo = Math.min(windowTop, historyEnd);
			this.#committedRows = chunkTo;
			this.#committedPrefix = rawFrame.slice(0, chunkTo);
		} else {
			windowTop = Math.max(this.#committedRows, frameLength - height, 0);
			const commitWouldTakeLiveRows = windowTop > historyEnd;
			chunkTo = hasVisibleOverlay || geometryChanged || commitWouldTakeLiveRows ? this.#committedRows : windowTop;
			if (geometryChanged) {
				committedPrefixResliced = true;
				this.#committedPrefix = rawFrame.slice(0, this.#committedRows);
			}
		}

		return {
			windowTop,
			chunkTo,
			committedPrefixResliced,
			hasVisibleOverlay,
			fullPaint,
			shouldRehydrate: false,
			divergenceRebuild,
			replaceRequested,
			geometryRebuild,
		};
	}

	#resolveVisibleCursorMarker(
		cursorMarkers: readonly { row: number; col: number }[],
		windowTop: number,
	): { row: number; col: number } | null {
		for (let i = cursorMarkers.length - 1; i >= 0; i--) {
			const marker = cursorMarkers[i]!;
			if (marker.row >= windowTop) {
				return marker;
			}
		}
		return null;
	}

	#assembleVisibleWindow(
		frame: readonly string[],
		width: number,
		height: number,
		windowTop: number,
		chunkTo: number,
		hasVisibleOverlay: boolean,
		cursorMarkers: readonly { row: number; col: number }[],
		fullPaint: boolean,
		geometryChanged: boolean,
	): {
		window: string[];
		cursorPos: { row: number; col: number } | null;
		altCaret: { row: number; col: number } | null;
		virtualScrollSlice: boolean;
		chunkTo: number;
		cursorTrackingLineCount: number;
	} {
		let virtualScrollSlice = false;
		let effectiveChunkTo = chunkTo;
		const frameLength = frame.length;
		if (this.#virtualScrollTop !== null) {
			const liveTop = this.#scrollSpaceLiveTop(frameLength);
			if (fullPaint || geometryChanged || hasVisibleOverlay || this.#virtualScrollTop >= liveTop) {
				this.#resumeLiveTail();
			} else {
				virtualScrollSlice = true;
				effectiveChunkTo = this.#committedRows;
			}
		}

		let cursorPos: { row: number; col: number } | null = this.#resolveVisibleCursorMarker(cursorMarkers, windowTop);
		let window: string[] = new Array(height);
		let altCaret: { row: number; col: number } | null = null;

		if (virtualScrollSlice) {
			this.#scrollSnapshot ??= this.#scrollTape.concat(frame.slice(this.#committedRows));
			const snapshot = this.#scrollSnapshot;
			const footerRows = Math.min(this.#pinnedFooterRows, height - 1);
			const regionRows = height - footerRows;
			const viewTop = this.#virtualScrollTop!;
			for (let r = 0; r < height; r++) {
				window[r] =
					r < regionRows
						? (snapshot[viewTop + r] ?? "")
						: (frame[frameLength - footerRows + (r - regionRows)] ?? "");
			}
			this.#drawScrollTrack(window, regionRows, viewTop, snapshot.length, width);
			const footerTop = frameLength - footerRows;
			if (cursorPos !== null && cursorPos.row >= footerTop) {
				altCaret = { row: regionRows + (cursorPos.row - footerTop), col: cursorPos.col };
			}
		} else {
			for (let r = 0; r < height; r++) window[r] = frame[windowTop + r] ?? "";
			if (cursorPos !== null && cursorPos.row >= windowTop && cursorPos.row < windowTop + height) {
				altCaret = { row: cursorPos.row - windowTop, col: cursorPos.col };
			}
		}

		if (hasVisibleOverlay) {
			window = this.#compositeOverlaysIntoWindow(window, width, height);
			const overlayMarkers = this.#extractCursorMarkers(window);
			if (overlayMarkers.length > 0) {
				cursorPos = { row: windowTop + overlayMarkers[0]!.row, col: overlayMarkers[0]!.col };
			}
			window = this.#prepareLinesArray(window, width);
		}
		const cursorTrackingLineCount = hasVisibleOverlay ? Math.max(frame.length, windowTop + height) : frame.length;
		return { window, cursorPos, altCaret, virtualScrollSlice, chunkTo: effectiveChunkTo, cursorTrackingLineCount };
	}

	#collectImageTransmitsAndPurges(): { imageTransmitBuffer: string; purgeSequence: string } {
		let imageTransmitBuffer = "";
		const transmits = this.#imageBudget.takeTransmits();
		for (let ti = 0; ti < transmits.length; ti++) imageTransmitBuffer += transmits[ti]!;
		let purgeSequence = "";
		if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
			const purgeIds = this.#imageBudget.takePurgeIds();
			for (let pi = 0; pi < purgeIds.length; pi++) purgeSequence += encodeKittyDeleteImage(purgeIds[pi]!);
		} else {
			this.#imageBudget.takePurgeIds();
		}
		return { imageTransmitBuffer, purgeSequence };
	}

	#commitAndEmitFrame(params: {
		frame: readonly string[];
		rawFrame: readonly string[];
		window: string[];
		width: number;
		height: number;
		cursorPos: { row: number; col: number } | null;
		altCaret: { row: number; col: number } | null;
		intent: RenderIntent;
		chunkTo: number;
		windowTop: number;
		prevWindowTop: number;
		prevHardwareCursorRow: number;
		cursorTrackingLineCount: number;
		purgeSequence: string;
		imageTransmitBuffer: string;
		virtualScrollSlice: boolean;
		hasVisibleOverlay: boolean;
		geometryChanged: boolean;
		preCommitRows: number;
		preAuditRows: number;
		finalBoundary: number;
		committedPrefixResliced: boolean;
		auditRan: boolean;
	}): void {
		const {
			frame,
			rawFrame,
			window,
			width,
			height,
			cursorPos,
			altCaret,
			intent,
			chunkTo,
			windowTop,
			prevWindowTop,
			prevHardwareCursorRow,
			cursorTrackingLineCount,
			purgeSequence,
			imageTransmitBuffer,
			virtualScrollSlice,
			hasVisibleOverlay,
			geometryChanged,
			preCommitRows,
			preAuditRows,
			finalBoundary,
			committedPrefixResliced,
			auditRan,
		} = params;

		const frameLength = frame.length;
		const firstPaint = !this.#hasEverRendered;

		if (this.#altActive) {
			this.#appendScrollTape(frame, Math.min(preCommitRows, chunkTo), chunkTo);
			this.#committedRows = chunkTo;
			this.#committedPrefix.length = 0;
			this.#committedPrefixAuditRows = 0;
			this.#windowTopRow = windowTop;
			this.#emitAltFrame(window, width, height, altCaret ?? undefined);
			this.#previousWindow = window;
			this.#previousFrameLength = frameLength;
			this.#altTailRows = frame.slice(chunkTo);
			this.#altTranscriptReplayPending = true;
			this.#clearScrollbackOnNextRender = false;
			this.#hasEverRendered = true;
			this.#publishCommittedRows();
			return;
		}

		if (intent.kind === "fullPaint") {
			this.#emitFullPaint(frame, window, width, height, cursorPos, purgeSequence, imageTransmitBuffer, {
				clearScrollback: intent.clearScrollback,
				chunkTo,
				windowTop,
				cursorTrackingLineCount,
			});
			this.#committedPrefix = rawFrame.slice(0, chunkTo);
			if (intent.clearScrollback) this.#scrollTape.length = 0;
			this.#appendScrollTape(frame, 0, chunkTo);
			this.#committedPrefixAuditRows = Math.min(chunkTo, finalBoundary);
			this.#clearScrollbackOnNextRender = false;
			this.#hasEverRendered = true;
			this.#syncWheelTracking();
			this.#publishCommittedRows();
			if (!firstPaint && frameLength > height) this.#armPostFullPaintSettle();
			return;
		}

		if (imageTransmitBuffer.length > 0) {
			this.terminal.write(imageTransmitBuffer);
		}
		this.#emitUpdate(frame, window, width, height, cursorPos, purgeSequence, {
			chunkTo,
			windowTop,
			prevWindowTop,
			prevHardwareCursorRow,
			forceWindowRewrite: this.#forceViewportRepaintOnNextRender || (geometryChanged && resizeRepaintsInPlace()),
			repaintVirtualScrollInPlace: hasVisibleOverlay || virtualScrollSlice,
			cursorTrackingLineCount,
		});
		this.#syncWheelTracking();
		this.#appendScrollTape(frame, Math.min(preCommitRows, chunkTo), chunkTo);
		for (let i = this.#committedPrefix.length; i < chunkTo; i++) {
			this.#committedPrefix.push(rawFrame[i] ?? "");
		}
		if (committedPrefixResliced || auditRan || preAuditRows >= Math.min(preCommitRows, finalBoundary)) {
			this.#committedPrefixAuditRows = Math.min(this.#committedRows, finalBoundary);
		} else {
			this.#committedPrefixAuditRows = Math.min(preAuditRows, this.#committedRows);
		}
		this.#publishCommittedRows();
	}

	#doRender(): void {
		if (this.#stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;

		this.onBeforeCompose?.();

		const componentScopedOnly = this.#pendingRenderComponentsOnly;
		this.#pendingRenderComponentsOnly = false;

		if (this.#syncAltScreenState(width, height)) return;

		if (this.#resizeViewportActive && this.#hasEverRendered && this.#getTopmostVisibleOverlay() === undefined) {
			this.#componentRenderTargets.clear();
			this.#renderResizeViewport(width, height);
			return;
		}

		const rawFrame = this.#composeFrame(width, height, componentScopedOnly);
		if (this.#maybeDeferGhosttyInitialImagePaint()) return;

		const cursorMarkers = this.#frameCursorMarkers;
		const liveRegionStart = this.#nativeScrollbackLiveRegionStart;
		const frameLength = rawFrame.length;
		this.#frameScrollable = frameLength > height || this.#scrollTape.length > 0;
		const finalBoundary = clampLow(liveRegionStart ?? frameLength, 0, frameLength);

		const prevWindowTop = this.#windowTopRow;
		const prevHardwareCursorRow = this.#hardwareCursorRow;

		const auditResult = this.#auditAndResyncCommittedPrefix(rawFrame, width, height, finalBoundary);

		const plan = this.#planCommitAndWindow(
			rawFrame,
			height,
			auditResult.geometryChanged,
			auditResult.committedRowsResynced,
			auditResult.frameSqueezed,
			cursorMarkers,
		);

		if (plan.shouldRehydrate) {
			this.#rehydratingDivergence = true;
			this.#clearScrollbackOnNextRender = true;
			try {
				this.#doRender();
			} finally {
				this.#rehydratingDivergence = false;
			}
			return;
		}

		const frame = this.#prepareFrame(rawFrame, width);
		const assembled = this.#assembleVisibleWindow(
			frame,
			width,
			height,
			plan.windowTop,
			plan.chunkTo,
			plan.hasVisibleOverlay,
			cursorMarkers,
			plan.fullPaint,
			auditResult.geometryChanged,
		);

		const intent: RenderIntent = plan.fullPaint
			? {
					kind: "fullPaint",
					clearScrollback:
						plan.divergenceRebuild ||
						((plan.replaceRequested || plan.geometryRebuild) && !isMultiplexerSession()),
				}
			: { kind: "update", chunkTo: assembled.chunkTo, windowTop: plan.windowTop };
		this.#logRedraw(intent, frameLength, height);

		const { imageTransmitBuffer, purgeSequence } = this.#collectImageTransmitsAndPurges();

		this.#commitAndEmitFrame({
			frame,
			rawFrame,
			window: assembled.window,
			width,
			height,
			cursorPos: assembled.cursorPos,
			altCaret: assembled.altCaret,
			intent,
			chunkTo: assembled.chunkTo,
			windowTop: plan.windowTop,
			prevWindowTop,
			prevHardwareCursorRow,
			cursorTrackingLineCount: assembled.cursorTrackingLineCount,
			purgeSequence,
			imageTransmitBuffer,
			virtualScrollSlice: assembled.virtualScrollSlice,
			hasVisibleOverlay: plan.hasVisibleOverlay,
			geometryChanged: auditResult.geometryChanged,
			preCommitRows: auditResult.preCommitRows,
			preAuditRows: auditResult.preAuditRows,
			finalBoundary,
			committedPrefixResliced: plan.committedPrefixResliced,
			auditRan: auditResult.auditRan,
		});
	}

	/** Audit committed prefix for divergence and recommit if needed. */
	#auditCommittedPrefix(rawFrame: readonly string[], newlyFinalEnd: number): void {
		const prefix = this.#committedPrefix;
		if (prefix.length === 0) return;
		const resyncTo = findCommittedPrefixResync(rawFrame, prefix, this.#committedPrefixAuditRows, newlyFinalEnd);
		if (resyncTo < 0) return;
		this.#committedRows = resyncTo;
		this.#committedPrefixAuditRows = Math.min(this.#committedPrefixAuditRows, resyncTo);
		prefix.length = resyncTo;
		if ($flag("VEYYON_DEBUG_REDRAW")) {
			const msg = `[${new Date().toISOString()}] commit resync: committed prefix diverged at row ${resyncTo}; recommitting\n`;
			fs.appendFileSync(getDebugLogPath(), msg);
		}
	}

	/** Frame row where transcript history ends. */
	#historyEndRow(frameLength: number): number {
		const segments = this.#frameSegments;
		let end = frameLength;
		for (let i = segments.length - 1; i >= 0; i--) {
			const segment = segments[i]!;
			if (canPrepareNativeScrollbackReplay(segment.component)) {
				end = segment.start + segment.rowCount;
				break;
			}
		}
		if (this.#pinnedFooterChildCount > 0 && segments.length >= this.#pinnedFooterChildCount) {
			end = Math.min(end, segments[segments.length - this.#pinnedFooterChildCount]!.start);
		}
		return end;
	}

	/** Push post-emit committed-row count to root children. */
	#publishCommittedRows(): void {
		for (let si = 0; si < this.#frameSegments.length; si++) {
			const segment = this.#frameSegments[si]!;
			setNativeScrollbackCommittedRows(
				segment.component,
				Math.min(segment.rowCount, Math.max(0, this.#committedRows - segment.start)),
			);
		}
	}

	/** Prepare composed frame for emission in place. */
	#prepareFrame(frame: readonly string[], width: number): string[] {
		const prepared = this.#preparedFrame;
		const meta = this.#preparedMeta;
		if (prepared.length > frame.length) {
			prepared.length = frame.length;
			meta.length = frame.length;
		}
		for (let i = Math.min(this.#preparedValidRows, prepared.length); i < frame.length; i++) {
			const raw = frame[i]!;
			const cached = meta[i];
			if (cached !== undefined && cached.raw === raw && cached.width === width) {
				prepared[i] = cached.line;
				continue;
			}
			const entry = this.#prepareLine(raw, width);
			meta[i] = entry;
			prepared[i] = entry.line;
		}
		this.#preparedValidRows = frame.length;
		return prepared;
	}

	#prepareLinesArray(lines: readonly string[], width: number): string[] {
		const prepared: string[] = new Array(lines.length);
		for (let i = 0; i < lines.length; i++) {
			prepared[i] = this.#prepareLine(lines[i]!, width).line;
		}
		return prepared;
	}

	#prepareLine(raw: string, width: number): PreparedLine {
		if (TERMINAL.isImageLine(raw)) {
			return { raw, width, line: raw };
		}
		const source = this.#lineFitSource(raw, width);
		const normalized = normalizeTerminalOutput(source);
		const asciiWidth = this.#ansiAsciiLineWidth(normalized, width);
		if ((asciiWidth ?? visibleWidth(normalized)) <= width) {
			return { raw, width, line: normalized };
		}
		const line = truncateToWidth(normalized, width, Ellipsis.Omit);
		return { raw, width, line };
	}

	#lineFitSource(raw: string, width: number): string {
		const safeWidth = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
		const maxSourceLength = Math.min(
			LINE_FIT_MAX_SOURCE_CODE_UNITS,
			Math.max(LINE_FIT_MIN_SOURCE_CODE_UNITS, safeWidth * LINE_FIT_SOURCE_WIDTH_MULTIPLIER),
		);
		if (raw.length <= maxSourceLength) return raw;

		let output = "";
		let cells = 0;
		for (let i = 0; i < raw.length && cells < safeWidth; ) {
			if (raw.charCodeAt(i) === 0x1b) {
				const end = this.#ansiSequenceEnd(raw, i);
				if (end < 0) break;
				if (this.#ansiSequenceHasVisiblePayload(raw, i)) {
					const sequence = raw.slice(i, end);
					if (output.length + sequence.length <= maxSourceLength) {
						output += sequence;
						cells += visibleWidth(sequence);
					}
				}
				i = end;
				continue;
			}

			const code = raw.charCodeAt(i);
			const next = code >= 0xd800 && code <= 0xdbff && i + 1 < raw.length ? i + 2 : i + 1;
			const char = raw.slice(i, next);
			const charWidth = visibleWidth(char);
			if (charWidth > 0 && cells + charWidth > safeWidth) break;
			if (output.length + char.length > maxSourceLength) {
				if (charWidth > 0) break;
				i = next;
				continue;
			}
			if (charWidth === 0) {
				const remainingVisibleCells = safeWidth - cells;
				const reservedCodeUnits = remainingVisibleCells * 2;
				if (output.length + char.length > maxSourceLength - reservedCodeUnits) {
					i = next;
					continue;
				}
			}
			output += char;
			cells += charWidth;
			i = next;
		}

		return output + SGR_RESET;
	}

	#ansiSequenceEnd(line: string, start: number): number {
		const next = line.charCodeAt(start + 1);
		if (next === 0x5b) {
			let i = start + 2;
			while (i < line.length) {
				const final = line.charCodeAt(i);
				if (final >= 0x40 && final <= 0x7e) return i + 1;
				i++;
			}
			return -1;
		}
		if (next === 0x5d) {
			let i = start + 2;
			while (i < line.length) {
				const osc = line.charCodeAt(i);
				if (osc === 0x07) return i + 1;
				if (osc === 0x1b && line.charCodeAt(i + 1) === 0x5c) return i + 2;
				i++;
			}
			return -1;
		}
		return start + 2 <= line.length ? start + 2 : -1;
	}

	#ansiSequenceHasVisiblePayload(line: string, start: number): boolean {
		return (
			line.charCodeAt(start + 1) === 0x5d &&
			line.charCodeAt(start + 2) === 0x36 &&
			line.charCodeAt(start + 3) === 0x36 &&
			line.charCodeAt(start + 4) === 0x3b
		);
	}

	#ansiAsciiLineWidth(line: string, maxWidth: number): number | undefined {
		let col = 0;
		for (let i = 0; i < line.length; ) {
			const code = line.charCodeAt(i);
			if (code === 0x1b) {
				const next = line.charCodeAt(i + 1);
				if (next === 0x5b) {
					let j = i + 2;
					while (j < line.length) {
						const final = line.charCodeAt(j);
						if (final >= 0x40 && final <= 0x7e) break;
						j++;
					}
					if (j >= line.length) return undefined;
					i = j + 1;
					continue;
				}
				if (next === 0x5d) {
					// OSC 66 text-sizing spans carry visible payload inside the OSC.
					// Fall back to visibleWidth() so scaled cells stay exact.
					if (
						line.charCodeAt(i + 2) === 0x36 &&
						line.charCodeAt(i + 3) === 0x36 &&
						line.charCodeAt(i + 4) === 0x3b
					) {
						return undefined;
					}
					let j = i + 2;
					while (j < line.length) {
						const osc = line.charCodeAt(j);
						if (osc === 0x07) {
							i = j + 1;
							break;
						}
						if (osc === 0x1b && line.charCodeAt(j + 1) === 0x5c) {
							i = j + 2;
							break;
						}
						j++;
					}
					if (j >= line.length) return undefined;
					continue;
				}
				return undefined;
			}
			if (code < 0x20 || code > 0x7e) return undefined;
			col++;
			if (col > maxWidth) return col;
			i++;
		}
		return col;
	}

	#lineRewriteSequence(line: string, width: number): string {
		if (TERMINAL.isImageLine(line)) return ERASE_LINE + line;
		const terminalLine = this.#terminalLine(line);
		const asciiWidth = this.#ansiAsciiLineWidth(line, width);
		if (asciiWidth !== undefined) {
			return asciiWidth >= width ? terminalLine : terminalLine + ERASE_TO_END_OF_LINE;
		}
		return SGR_RESET + ERASE_TO_END_OF_LINE + terminalLine;
	}

	/** Record state transition and update previous frame bookkeeping. */
	#commit(
		lines: readonly string[],
		window: string[],
		width: number,
		height: number,
		hardwareCursor: HardwareCursorUpdate,
	): void {
		this.#previousFrameLength = lines.length;
		this.#previousWindow = window;
		this.#forceViewportRepaintOnNextRender = false;
		this.#previousWidth = width;
		this.#previousHeight = height;
		this.#recordHardwareCursorUpdate(hardwareCursor);
		this.onFrameComposed?.();
	}

	#targetHardwareCursorState(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
	): HardwareCursorState | null {
		if (!cursorPos || totalLines <= 0) return null;
		return {
			row: clampLow(cursorPos.row, 0, totalLines - 1),
			col: Math.max(0, cursorPos.col),
			visible: this.#showHardwareCursor,
		};
	}

	#recordHardwareCursorState(state: HardwareCursorState): void {
		this.#hardwareCursorRow = state.row;
		this.#hardwareCursorState = state;
		this.#hardwareCursorVisible = state.visible;
		this.#hardwareCursorVisibilityKnown = true;
	}

	#recordHardwareCursorRowOnly(row: number, visible?: boolean): void {
		this.#hardwareCursorRow = row;
		this.#hardwareCursorState = null;
		if (visible !== undefined) {
			this.#hardwareCursorVisible = visible;
			this.#hardwareCursorVisibilityKnown = true;
		}
	}

	#recordHardwareCursorUpdate(update: HardwareCursorUpdate): void {
		if (update.state) {
			this.#recordHardwareCursorState(update.state);
			return;
		}
		this.#recordHardwareCursorRowOnly(update.toRow, update.visible);
	}

	#recordHardwareCursorHidden(): void {
		this.#hardwareCursorVisible = false;
		this.#hardwareCursorVisibilityKnown = true;
		if (!this.#hardwareCursorState) return;
		this.#hardwareCursorState = { ...this.#hardwareCursorState, visible: false };
	}

	#forgetHardwareCursorState(): void {
		this.#hardwareCursorState = null;
		this.#hardwareCursorVisibilityKnown = false;
	}

	#sameHardwareCursorState(state: HardwareCursorState): boolean {
		const current = this.#hardwareCursorState;
		return (
			current !== null && current.row === state.row && current.col === state.col && current.visible === state.visible
		);
	}

	/** Replay the frame from home, optionally clearing native scrollback first. */
	#emitFullPaint(
		frame: readonly string[],
		window: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		purgeSequence: string,
		imageTransmitBuffer: string,
		options: {
			clearScrollback: boolean;
			chunkTo: number;
			windowTop: number;
			cursorTrackingLineCount: number;
		},
	): void {
		this.#fullRedrawCount += 1;
		const { chunkTo, windowTop, cursorTrackingLineCount } = options;
		let paintCursorPos: { row: number; col: number } | null = null;
		if (cursorPos !== null) {
			if (cursorPos.row < chunkTo) {
				paintCursorPos = cursorPos;
			} else if (cursorPos.row >= windowTop && cursorPos.row < windowTop + height) {
				paintCursorPos = { row: chunkTo + cursorPos.row - windowTop, col: cursorPos.col };
			}
		}
		let paintLines: string[] | null = null;
		let paintLineCount = chunkTo + height;
		if (isConPTYHosted()) {
			const merged = new Array<string>(chunkTo + height);
			for (let i = 0; i < chunkTo; i++) merged[i] = frame[i] ?? "";
			for (let screenRow = 0; screenRow < height; screenRow++) {
				merged[chunkTo + screenRow] = window[screenRow] ?? "";
			}
			const paint = this.#truncateLargeConptyFrame(merged, width, height, paintCursorPos);
			if (paint.lines !== merged) {
				paintLines = paint.lines;
				paintLineCount = paint.lines.length;
				paintCursorPos = paint.cursorPos;
			}
		}
		let buffer = this.#paintBeginSequence + this.#leaveResizeAltSequence() + purgeSequence;
		if (options.clearScrollback) {
			buffer += "\x1b[H\x1b[3J";
		} else {
			if (TERMINAL.supportsScreenToScrollback) buffer += "\x1b[22J";
			buffer += "\x1b[2J\x1b[H";
		}
		if (imageTransmitBuffer.length > 0) buffer += imageTransmitBuffer;
		const visibleStart = Math.max(0, paintLineCount - height);
		let fillSequence = "";
		let visibleTexts: string[] | null = null;
		if (this.#deccaraFillsEnabled() && visibleStart < paintLineCount) {
			let visible = window;
			if (paintLines !== null) {
				visible = new Array<string>(paintLineCount - visibleStart);
				for (let k = 0; k < visible.length; k++) visible[k] = paintLines[visibleStart + k] ?? "";
			}
			const plan = planDeccaraFills(visible, width);
			visibleTexts = plan.texts;
			fillSequence = plan.sequence;
		}
		if (paintLines === null) {
			for (let i = 0; i < chunkTo; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += options.clearScrollback
					? this.#lineRewriteSequence(frame[i] ?? "", width)
					: this.#terminalLine(frame[i] ?? "");
			}
			for (let screenRow = 0; screenRow < height; screenRow++) {
				if (chunkTo + screenRow > 0) buffer += "\r\n";
				const line = visibleTexts ? (visibleTexts[screenRow] ?? "") : (window[screenRow] ?? "");
				buffer += options.clearScrollback ? this.#lineRewriteSequence(line, width) : this.#terminalLine(line);
			}
		} else {
			for (let i = 0; i < paintLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				const line = visibleTexts && i >= visibleStart ? visibleTexts[i - visibleStart] : (paintLines[i] ?? "");
				buffer += options.clearScrollback ? this.#lineRewriteSequence(line, width) : this.#terminalLine(line);
			}
		}
		buffer += fillSequence;
		const contentRows = clampLow(frame.length - windowTop, 1, height);
		const parkUp = height - contentRows;
		if (parkUp > 0) buffer += `\x1b[${parkUp}A`;
		const contentBottomRow = windowTop + contentRows - 1;
		const paintContentBottomRow = Math.max(0, paintLineCount - 1 - parkUp);
		const cursorControl = this.#cursorControlSequence(paintCursorPos, paintLineCount, paintContentBottomRow);
		buffer += cursorControl.seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);

		const committedCursorState = paintCursorPos
			? this.#targetHardwareCursorState(cursorPos, cursorTrackingLineCount)
			: null;
		const committedCursor = committedCursorState
			? {
					toRow: committedCursorState.row,
					state: committedCursorState,
					visible: committedCursorState.visible,
				}
			: {
					toRow: contentBottomRow,
					state: null,
					visible: cursorControl.visible,
				};

		this.#committedRows = chunkTo;
		this.#windowTopRow = windowTop;
		this.#commit(frame, window, width, height, committedCursor);
	}

	/** Enter non-multiplexer resize fast path. */
	#beginResizeViewport(): void {
		this.#resizeViewportActive = true;
		this.#resizeViewportSettleTimer?.cancel();
		this.#resizeViewportSettleTimer = this.#renderScheduler.scheduleRender(() => {
			this.#resizeViewportSettleTimer = undefined;
			this.#resizeViewportActive = false;
			if (this.#stopped) return;
			this.#resizeEventPending = true;
			this.requestRender(true, { clearScrollback: !isMultiplexerSession() });
		}, TUI.#RESIZE_VIEWPORT_SETTLE_MS);
	}

	#requestResizeViewportPaint(): void {
		if (this.#stopped) return;
		this.#renderRequested = false;
		this.#executeRender();
		if (this.#renderRequested) this.#scheduleRender();
	}

	/** Compose and paint viewport for one resize fast-path frame. */
	#renderResizeViewport(width: number, height: number): void {
		if (width <= 0 || height <= 0) return;
		this.#imageBudget.beginPass(true);
		const { window, contentRows } = this.#composeResizeViewport(width, height);
		this.#emitResizeViewport(window, height, contentRows, width);
		this.#resizeViewportPaintCount += 1;
	}

	/** Build viewport window for a resize fast-path frame. */
	#composeResizeViewport(width: number, height: number): { window: readonly string[]; contentRows: number } {
		const tail: string[] = []; // bottom-first
		const children = this.children;
		for (let i = children.length - 1; i >= 0 && tail.length < height; i--) {
			const child = children[i]!;
			const provider = asViewportTailProvider(child);
			const rows = provider ? provider.renderViewportTail(width, height - tail.length) : child.render(width);
			for (let r = rows.length - 1; r >= 0 && tail.length < height; r--) {
				tail.push(rows[r]!);
			}
		}
		const count = tail.length;
		const window: string[] = new Array(height);
		for (let screenRow = 0; screenRow < height; screenRow++) {
			window[screenRow] = screenRow < count ? tail[count - 1 - screenRow]! : "";
		}
		this.#extractCursorMarkers(window);
		return { window: this.#prepareLinesArray(window, width), contentRows: count };
	}

	/** Resolve active keyboard-enhancement enter sequence. */
	#keyboardEnhancementEnter(): string {
		return this.terminal.keyboardEnhancementEnterSequence ?? this.terminal.kittyEnableSequence ?? "";
	}

	/** Resolve active keyboard-enhancement exit sequence. */
	#keyboardEnhancementExit(): string {
		const exit = this.terminal.keyboardEnhancementExitSequence;
		if (exit !== undefined) return exit ?? "";
		return this.terminal.kittyEnableSequence ? "\x1b[<u" : "";
	}

	#enterResizeAltSequence(): string {
		if (this.#resizeAltActive || this.#altActive) return "";
		this.#resizeAltActive = true;
		setAltScreenActive(true);
		this.#forgetHardwareCursorState();
		this.#recordHardwareCursorHidden();
		return `${ALT_SCREEN_ENTER}${this.#keyboardEnhancementEnter()}`;
	}

	#leaveResizeAltSequence(): string {
		if (!this.#resizeAltActive) return "";
		const enhancementExit = this.#keyboardEnhancementExit();
		this.#resizeAltActive = false;
		setAltScreenActive(false);
		this.#forgetHardwareCursorState();
		return `${enhancementExit}${ALT_SCREEN_EXIT}`;
	}

	/** Emit throwaway viewport repaint for resize fast path. */
	#emitResizeViewport(window: readonly string[], height: number, contentRows: number, width: number): void {
		let buffer = `${this.#paintBeginSequence + this.#enterResizeAltSequence()}\x1b[H`;
		for (let r = 0; r < height; r++) {
			if (r > 0) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(window[r] ?? "", width);
		}
		const parkUp = height - Math.max(1, contentRows);
		if (parkUp > 0) buffer += `\x1b[${parkUp}A`;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
	}

	#wantsAltScreen(): boolean {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			const entry = this.overlayStack[i]!;
			if (!this.#isOverlayVisible(entry)) continue;
			return entry.options?.fullscreen === true;
		}
		return false;
	}

	/** Compose and paint fullscreen overlay on alt buffer. */
	#renderAltFrame(width: number, height: number): void {
		const base: string[] = new Array(Math.max(0, height)).fill("");
		let lines = this.#compositeOverlaysIntoWindow(base, width, height);
		this.#extractCursorMarkers(lines);
		lines = this.#prepareLinesArray(lines, width);
		this.#emitAltFrame(lines, width, height);
	}

	/** Whether transcript should reside on alt buffer. */
	#altTranscriptWanted(): boolean {
		return this.#scrollTransport === "alt-arrows" && this.#scrollIsolation && !this.#stopped && this.#hasEverRendered;
	}

	/** Full per-row viewport rewrite on alt buffer. */
	#emitAltFrame(lines: string[], width: number, height: number, cursor?: { row: number; col: number }): void {
		const fitted: string[] = new Array(height);
		for (let r = 0; r < height; r++) fitted[r] = lines[r] ?? "";
		const imageTransmits = this.#imageBudget.takeTransmits();
		if (imageTransmits.length > 0) {
			let transmitBuffer = "";
			for (let si = 0; si < imageTransmits.length; si++) transmitBuffer += imageTransmits[si]!;
			this.terminal.write(transmitBuffer);
		}
		const force = this.#forceViewportRepaintOnNextRender;
		this.#forceViewportRepaintOnNextRender = false;
		const caretMoved =
			cursor === undefined
				? this.#altPreviousCursor !== undefined
				: this.#altPreviousCursor === undefined ||
					this.#altPreviousCursor.row !== cursor.row ||
					this.#altPreviousCursor.col !== cursor.col;
		if (!force && !caretMoved && this.#altPreviousLines.length === height) {
			let same = true;
			for (let r = 0; r < height; r++) {
				if (fitted[r] !== this.#altPreviousLines[r]) {
					same = false;
					break;
				}
			}
			if (same) return;
		}
		let buffer = `${this.#paintBeginSequence}\x1b[H`;
		for (let r = 0; r < height; r++) {
			if (r > 0) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(fitted[r], width);
		}
		if (cursor !== undefined) {
			const row = clampLow(cursor.row + 1, 1, Math.max(1, height));
			const col = clampLow(cursor.col + 1, 1, Math.max(1, width));
			buffer += `\x1b[${row};${col}H`;
		}
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
		if (cursor !== undefined) {
			this.terminal.showCursor();
			this.#recordHardwareCursorRowOnly(cursor.row, true);
		}
		this.#altPreviousCursor = cursor;
		this.#altPreviousLines = fitted;
		this.#fullRedrawCount += 1;
	}

	/** Incremental frame update. */
	#emitUpdate(
		frame: readonly string[],
		window: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		purgeSequence: string,
		options: {
			chunkTo: number;
			windowTop: number;
			prevWindowTop: number;
			prevHardwareCursorRow: number;
			forceWindowRewrite: boolean;
			repaintVirtualScrollInPlace: boolean;
			cursorTrackingLineCount: number;
		},
	): void {
		const {
			chunkTo,
			windowTop,
			prevWindowTop,
			prevHardwareCursorRow,
			forceWindowRewrite,
			repaintVirtualScrollInPlace,
			cursorTrackingLineCount,
		} = options;
		const chunkFrom = this.#committedRows;
		const chunkLength = chunkTo - chunkFrom;
		const scroll = windowTop - prevWindowTop;
		const previousWindow = this.#previousWindow;
		const contentRows = clampLow(frame.length - windowTop, 1, height);
		const contentBottomRow = windowTop + contentRows - 1;
		const clampedCursor = Math.min(prevHardwareCursorRow, prevWindowTop + height - 1);
		const currentScreenRow = clampLow(clampedCursor - prevWindowTop, 0, height - 1);

		if (
			!forceWindowRewrite &&
			chunkLength > 0 &&
			chunkLength === scroll &&
			scroll < height &&
			chunkFrom === prevWindowTop
		) {
			let prefixIntact = previousWindow.length === height;
			for (let i = 0; prefixIntact && i < chunkLength; i++) {
				if (previousWindow[i] !== frame[chunkFrom + i]) prefixIntact = false;
			}
			if (prefixIntact) {
				let buffer = this.#paintBeginSequence + purgeSequence;
				const moveToBottom = height - 1 - currentScreenRow;
				if (moveToBottom > 0) buffer += `\x1b[${moveToBottom}B`;
				for (let r = height - scroll; r < height; r++) {
					buffer += `\r\n${this.#lineRewriteSequence(window[r] ?? "", width)}`;
				}
				let firstChanged = -1;
				let lastChanged = -1;
				for (let r = 0; r < height - scroll; r++) {
					if ((window[r] ?? "") === (previousWindow[r + scroll] ?? "")) continue;
					if (firstChanged === -1) firstChanged = r;
					lastChanged = r;
				}
				let cursorFromRow = windowTop + height - 1;
				if (firstChanged !== -1) {
					const up = height - 1 - firstChanged;
					if (up > 0) buffer += `\x1b[${up}A`;
					buffer += "\r";
					for (let r = firstChanged; r <= lastChanged; r++) {
						if (r > firstChanged) buffer += "\r\n";
						buffer += this.#lineRewriteSequence(window[r] ?? "", width);
					}
					cursorFromRow = windowTop + lastChanged;
				}
				const cursorControl = this.#cursorControlSequence(cursorPos, cursorTrackingLineCount, cursorFromRow);
				buffer += cursorControl.seq;
				buffer += this.#paintEndSequence;
				this.terminal.write(buffer);
				this.#committedRows = chunkTo;
				this.#windowTopRow = windowTop;
				this.#commit(frame, window, width, height, cursorControl);
				return;
			}
		}

		const inPlaceRewrite = repaintVirtualScrollInPlace || scroll !== 0;
		if (chunkLength === 0) {
			if (forceWindowRewrite || inPlaceRewrite) this.#fullRedrawCount += 1;
			let firstChanged = forceWindowRewrite || inPlaceRewrite ? 0 : -1;
			let lastChanged = forceWindowRewrite || inPlaceRewrite ? height - 1 : -1;
			if (!forceWindowRewrite && !inPlaceRewrite) {
				const comparable = previousWindow.length === height;
				for (let r = 0; r < height; r++) {
					if (comparable && (window[r] ?? "") === (previousWindow[r] ?? "")) continue;
					if (firstChanged === -1) firstChanged = r;
					lastChanged = r;
				}
			}
			if (firstChanged === -1) {
				if (purgeSequence.length > 0) this.terminal.write(purgeSequence);
				this.#writeCursorPosition(cursorPos, cursorTrackingLineCount);
				this.#previousWidth = width;
				this.#previousHeight = height;
				return;
			}
			let buffer = this.#paintBeginSequence + purgeSequence;
			if (inPlaceRewrite) {
				if (height > 1) buffer += `\x1b[${height - 1}A`;
			} else {
				const rowDelta = firstChanged - currentScreenRow;
				if (rowDelta > 0) buffer += `\x1b[${rowDelta}B`;
				else if (rowDelta < 0) buffer += `\x1b[${-rowDelta}A`;
			}
			buffer += "\r";
			let fillTexts: string[] | null = null;
			let fillSequence = "";
			if (this.#deccaraFillsEnabled()) {
				const slice: string[] = new Array(lastChanged - firstChanged + 1);
				for (let r = firstChanged; r <= lastChanged; r++) slice[r - firstChanged] = window[r] ?? "";
				const plan = planDeccaraFills(slice, width, firstChanged);
				fillTexts = plan.texts;
				fillSequence = plan.sequence;
			}
			for (let r = firstChanged; r <= lastChanged; r++) {
				if (r > firstChanged) buffer += "\r\n";
				buffer += this.#lineRewriteSequence(fillTexts ? fillTexts[r - firstChanged] : (window[r] ?? ""), width);
			}
			buffer += fillSequence;
			let cursorFromRow = windowTop + lastChanged;
			const contentBottomScreenRow = contentBottomRow - windowTop;
			if (lastChanged > contentBottomScreenRow) {
				buffer += `\x1b[${lastChanged - contentBottomScreenRow}A`;
				cursorFromRow = contentBottomRow;
			}
			const cursorControl = this.#cursorControlSequence(cursorPos, cursorTrackingLineCount, cursorFromRow);
			buffer += cursorControl.seq;
			buffer += this.#paintEndSequence;
			this.terminal.write(buffer);
			this.#windowTopRow = windowTop;
			this.#commit(frame, window, width, height, cursorControl);
			return;
		}

		this.#fullRedrawCount += 1;
		let buffer = this.#paintBeginSequence + purgeSequence;
		if (currentScreenRow > 0) buffer += `\x1b[${currentScreenRow}A`;
		buffer += "\r";
		let wroteLine = false;
		for (let i = chunkFrom; i < chunkTo; i++) {
			if (wroteLine) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(frame[i] ?? "", width);
			wroteLine = true;
		}
		for (let screenRow = 0; screenRow < height; screenRow++) {
			if (wroteLine) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(window[screenRow] ?? "", width);
			wroteLine = true;
		}
		const cursorControl = this.#cursorControlSequence(cursorPos, cursorTrackingLineCount, contentBottomRow);
		buffer += cursorControl.seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
		this.#committedRows = chunkTo;
		this.#windowTopRow = windowTop;
		this.#commit(frame, window, width, height, cursorControl);
	}

	#logRedraw(intent: RenderIntent, newLength: number, height: number): void {
		if (!$flag("VEYYON_DEBUG_REDRAW")) return;
		const detail =
			intent.kind === "update"
				? `update(chunk=${this.#committedRows}..${intent.chunkTo}, windowTop=${intent.windowTop})`
				: `fullPaint(clearScrollback=${intent.clearScrollback})`;
		const state =
			`committed=${this.#committedRows}, windowTop=${this.#windowTopRow}, ` +
			`lrStart=${this.#nativeScrollbackLiveRegionStart}`;
		const msg = `[${new Date().toISOString()}] render: ${detail} (prev=${this.#previousFrameLength}, new=${newLength}, height=${height}, ${state})\n`;
		fs.appendFileSync(getDebugLogPath(), msg);
	}

	/** Build cursor control sequences to position hardware cursor. */
	#cursorControlSequence(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
		fromRow: number,
	): CursorControlResult {
		const target = this.#targetHardwareCursorState(cursorPos, totalLines);
		if (!target) {
			return { seq: "\x1b[?25l", toRow: fromRow, toCol: 0, visible: false, state: null };
		}

		const rowDelta = target.row - fromRow;
		let seq = "";
		if (rowDelta > 0) {
			seq += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			seq += `\x1b[${-rowDelta}A`; // Move up
		}
		seq += `\x1b[${target.col + 1}G`;
		seq += target.visible ? "\x1b[?25h" : "\x1b[?25l";

		return { seq, toRow: target.row, toCol: target.col, visible: target.visible, state: target };
	}

	#isHiddenCursorKnown(): boolean {
		return this.#hardwareCursorVisibilityKnown && !this.#hardwareCursorVisible;
	}

	/** Write hardware cursor position as synchronized output block. */
	#writeCursorPosition(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		const target = this.#targetHardwareCursorState(cursorPos, totalLines);
		if (!target) {
			if (this.#isHiddenCursorKnown()) return;
			this.terminal.hideCursor();
			this.#recordHardwareCursorHidden();
			return;
		}
		if (this.#sameHardwareCursorState(target)) return;
		const cursorControl = this.#cursorControlSequence(cursorPos, totalLines, this.#hardwareCursorRow);
		this.terminal.write(`${this.#cursorBeginSequence}${cursorControl.seq}${this.#cursorEndSequence}`);
		this.#recordHardwareCursorUpdate(cursorControl);
	}
}
