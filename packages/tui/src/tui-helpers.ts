import { performance } from "node:perf_hooks";
import { isInsideTerminalMultiplexer } from "./terminal-capabilities";
import { visibleWidth } from "./utils";

export const LINE_TERMINATOR = "\x1b[0m\x1b]8;;\x07";
export const ERASE_LINE = "\x1b[2K";
export const ERASE_TO_END_OF_LINE = "\x1b[K";
export const LINE_FIT_MIN_SOURCE_CODE_UNITS = 4096;
export const LINE_FIT_MAX_SOURCE_CODE_UNITS = 65536;
export const LINE_FIT_SOURCE_WIDTH_MULTIPLIER = 64;
export const HIDE_CURSOR = "\x1b[?25l";
export const SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
export const SYNC_OUTPUT_END = "\x1b[?2026l";
export const DISABLE_AUTOWRAP = "\x1b[?7l";
export const ENABLE_AUTOWRAP = "\x1b[?7h";
export const PAINT_BEGIN = `${HIDE_CURSOR}${SYNC_OUTPUT_BEGIN}${DISABLE_AUTOWRAP}`;
export const PAINT_END = `${ENABLE_AUTOWRAP}${SYNC_OUTPUT_END}`;
export const PAINT_BEGIN_NO_SYNC = `${HIDE_CURSOR}${DISABLE_AUTOWRAP}`;
export const PAINT_END_NO_SYNC = ENABLE_AUTOWRAP;
export const CURSOR_BEGIN = `${HIDE_CURSOR}${SYNC_OUTPUT_BEGIN}`;
export const CURSOR_BEGIN_NO_SYNC = HIDE_CURSOR;
export const CURSOR_END = SYNC_OUTPUT_END;
export const CURSOR_END_NO_SYNC = "";
export const MOUSE_TRACKING_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
export const MOUSE_TRACKING_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";
export const MOUSE_WHEEL_TRACKING_ON = "\x1b[?1000h\x1b[?1006h";
export const SCROLL_TRACK_GROOVE = "\x1b[2m│\x1b[22m";
export const SCROLL_TRACK_THUMB = "█";
export const MOUSE_WHEEL_TRACKING_OFF = "\x1b[?1006l\x1b[?1000l";
export const ALT_SCREEN_ENTER = "\x1b[?1049h";
export const ALT_SCREEN_EXIT = "\x1b[?1049l";
export const ALT_SCROLL_ON = "\x1b[?1007h";
export const ALT_SCROLL_OFF = "\x1b[?1007l";
export const LEGACY_CURSOR_SCROLL: Readonly<Record<string, -1 | 1 | undefined>> = {
	"\x1b[A": -1,
	"\x1b[B": 1,
	"\x1bOA": -1,
	"\x1bOB": 1,
};

export type ScrollTransport = "mouse" | "alt-arrows";
export type InputListenerResult = { consume?: boolean; data?: string } | undefined;
export type InputListener = (data: string) => InputListenerResult;
export type StartListener = () => void;

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

export const DEFAULT_RENDER_SCHEDULER: RenderScheduler = {
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

export interface Component {
	render(width: number): readonly string[];

	handleInput?(data: string): void;

	wantsKeyRelease?: boolean;

	invalidate?(): void;
	setIgnoreTight?(ignore: boolean): void;

	dispose?(): void;
}

export interface OverlayFocusOwner {
	ownsOverlayFocusTarget(component: Component): boolean;
}

export interface NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined;
}

export interface NativeScrollbackCommittedRows {
	setNativeScrollbackCommittedRows(rows: number): void;
}

export interface NativeScrollbackReplay {
	prepareNativeScrollbackReplay(): void;
}

export function prepareNativeScrollbackReplay(component: Component): void {
	(component as Component & Partial<NativeScrollbackReplay>).prepareNativeScrollbackReplay?.();
}

export interface NativeScrollbackCompaction {
	takeNativeScrollbackDroppedRows(): number;
	setNativeScrollbackRetainRows?(rows: number): void;
}

export function takeNativeScrollbackDroppedRows(component: Component): number {
	const rows = (component as Component & Partial<NativeScrollbackCompaction>).takeNativeScrollbackDroppedRows?.();
	return typeof rows === "number" && Number.isFinite(rows) && rows > 0 ? Math.trunc(rows) : 0;
}

export function setNativeScrollbackRetainRows(component: Component, rows: number): void {
	(component as Component & Partial<NativeScrollbackCompaction>).setNativeScrollbackRetainRows?.(rows);
}
export function canPrepareNativeScrollbackReplay(component: Component): boolean {
	return (
		typeof (component as Component & Partial<NativeScrollbackReplay>).prepareNativeScrollbackReplay === "function"
	);
}

export function setNativeScrollbackCommittedRows(component: Component, rows: number): void {
	(component as Component & Partial<NativeScrollbackCommittedRows>).setNativeScrollbackCommittedRows?.(rows);
}

export function isOverlayFocusTarget(owner: Component, component: Component | null): boolean {
	if (component === owner) return true;
	if (!component) return false;
	const candidate = owner as Component & Partial<OverlayFocusOwner>;
	return candidate.ownsOverlayFocusTarget?.(component) === true;
}

export function getNativeScrollbackLiveRegionStart(component: Component): number | undefined {
	return (component as Component & Partial<NativeScrollbackLiveRegion>).getNativeScrollbackLiveRegionStart?.();
}

export interface RenderStablePrefix {
	getRenderStablePrefixRows(): number;
}

export function getRenderStablePrefixRows(component: Component): number | undefined {
	return (component as Component & Partial<RenderStablePrefix>).getRenderStablePrefixRows?.();
}

export interface ViewportTailProvider {
	renderViewportTail(width: number, maxRows: number): readonly string[];
}

export function asViewportTailProvider(component: Component): ViewportTailProvider | undefined {
	const candidate = component as Component & Partial<ViewportTailProvider>;
	return typeof candidate.renderViewportTail === "function" ? (candidate as ViewportTailProvider) : undefined;
}

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

export function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

export function isMultiplexerSession(): boolean {
	return isInsideTerminalMultiplexer();
}

function reportsSizeOnAltScreenToggle(): boolean {
	const override = Bun.env.VEYYON_TUI_RESIZE_IN_PLACE;
	if (override === "0" || override === "false") return false;
	if (override === "1" || override === "true") return true;
	return Bun.env.TERM_PROGRAM?.toLowerCase() === "warpterminal";
}

export function resizeRepaintsInPlace(): boolean {
	return isMultiplexerSession() || reportsSizeOnAltScreenToggle();
}

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

	visible?: (termWidth: number, termHeight: number) => boolean;

	fullscreen?: boolean;
}

export interface OverlayHandle {
	hide(): void;
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
}

export interface OverlayExitAnimatable {
	beginOverlayExit(requestRender: () => void, done: () => void): boolean;
}

export function canAnimateOverlayExit(component: Component): component is Component & OverlayExitAnimatable {
	return typeof (component as Partial<OverlayExitAnimatable>).beginOverlayExit === "function";
}
