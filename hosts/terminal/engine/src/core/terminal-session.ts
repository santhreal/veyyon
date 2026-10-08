/**
 * Terminal-session vocabulary and probes: the escape sequences the engine
 * writes to frame a paint, the host predicates that decide how a resize is
 * repainted, and the Sixel capability probe.
 *
 * Split out of `tui.ts`. Nothing here reads the composed frame or the commit
 * ledger — this is what the engine says to the terminal, not what it paints.
 */
import {
	ImageProtocol,
	isInsideTerminalMultiplexer,
	setTerminalImageProtocol,
	TERMINAL,
} from "../terminal-capabilities";

// Hide the hardware cursor before each paint/move write. Ghostty-style bar
// cursors can otherwise leave visual afterimages while the TUI repaints the
// row under a visible cursor. Paint writes also disable terminal autowrap:
// several terminals keep a "pending wrap" flag after an exact-width row, so a
// following cursor move can first wrap to the next row and produce staircase
// trails. The TUI emits explicit CRLFs and restores autowrap before leaving the
// paint. Synchronized output can be disabled for terminals with broken DEC 2026
// implementations; autowrap discipline stays on either way.
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
// Mouse reporting, enabled only for the lifetime of a fullscreen overlay so the
// rest of the app keeps the terminal's native text selection. 1000h = button
// click tracking, 1003h = any-motion tracking so overlays can light up hover
// targets (the pointer moving with no button held), 1006h = SGR extended
// coordinates so columns/rows past 223 are reported.
export const MOUSE_TRACKING_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
export const MOUSE_TRACKING_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";
// Wheel/button-only tracking for scroll isolation: 1000h reports button
// presses (the wheel arrives as buttons 64/65) and 1006h SGR coordinates,
// skipping 1003h any-motion so idle pointer moves never flood the input
// queue. Tradeoff against native scroll: while the grab is held, drag-select
// becomes Shift+drag -- the standard convention in mouse-capturing TUIs. It is
// held while the transcript is scrollable, and also while a pinned-footer child
// declares a click target (MouseRoutable.wantsPointer), since a target the
// terminal never reports is not a target at all. In a short session that second
// reason comes and goes with the chips; in any session long enough to scroll,
// the first reason already holds it for the duration.
export const MOUSE_WHEEL_TRACKING_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_WHEEL_TRACKING_OFF = "\x1b[?1006l\x1b[?1000l";
export const ALT_SCREEN_ENTER = "\x1b[?1049h";
export const ALT_SCREEN_EXIT = "\x1b[?1049l";

export type InputListenerResult = { consume?: boolean; data?: string } | undefined;
export type InputListener = (data: string) => InputListenerResult;
export type StartListener = () => void;

/** Detect terminal multiplexers where scrollback clearing and height-change redraws are hostile. */
export function isMultiplexerSession(): boolean {
	return isInsideTerminalMultiplexer();
}

/**
 * Terminals that re-report their size whenever the alternate screen buffer is
 * toggled. The non-multiplexer resize fast path ({@link TUI.#beginResizeViewport})
 * borrows the alternate screen for throwaway drag frames; on these terminals
 * entering/leaving the alt buffer emits a fresh SIGWINCH (Warp reports a height
 * one row different for the alt buffer), which re-enters the fast path — a
 * self-sustaining resize loop that floods ED3 full repaints even though the
 * geometry never actually changes. Routing them through the in-place
 * (multiplexer) resize path never touches the alt buffer, breaking the loop.
 *
 * `VEYYON_TUI_RESIZE_IN_PLACE=1|0` forces this on/off for any terminal.
 */
export function reportsSizeOnAltScreenToggle(): boolean {
	const override = Bun.env.VEYYON_TUI_RESIZE_IN_PLACE;
	if (override === "0" || override === "false") return false;
	if (override === "1" || override === "true") return true;
	return Bun.env.TERM_PROGRAM?.toLowerCase() === "warpterminal";
}

/**
 * Resize should repaint the visible window in place — no alternate-screen
 * borrow, no ED3 scrollback rewrap — for multiplexer panes and for terminals
 * that loop on alt-screen toggles. The tradeoff is identical to a multiplexer:
 * scrollback above the window keeps its old wrap instead of being re-flowed.
 */
export function resizeRepaintsInPlace(): boolean {
	return isMultiplexerSession() || reportsSizeOnAltScreenToggle();
}

/**
 * What the Sixel probe needs from the engine: a way to reach the terminal, a
 * way to see input before the components do, and a callback for the one
 * outcome that changes rendering.
 */
export interface SixelProbeHost {
	write(data: string): void;
	addInputListener(listener: InputListener): () => void;
	/** Sixel turned out to be supported and the image protocol has been set. */
	onSixelDiscovered(): void;
}

/** Primary device attributes reply: `CSI ? attrs c`. */
const DA1_REPLY = /\x1b\[\?([0-9;]+)c/u;
/** XTSMGRAPHICS reply for item 2 (Sixel geometry): `CSI ? 2 ; status ; values S`. */
const GRAPHICS_REPLY = /\x1b\[\?2;(\d+);([0-9;]+)S/u;

/** One reply located in the probe buffer: its span and its first parameter group. */
interface ProbeReply {
	index: number;
	end: number;
	params: string;
	isDa: boolean;
}

/**
 * A terminal that reports Sixel support through neither env nor termcap is
 * asked directly: primary device attributes (`CSI c`, attribute 4) and the
 * graphics-attributes report (`CSI ? 2 ; 1 ; 0 S`) are sent together and
 * whichever answers first decides. Responses are stripped from the input
 * stream; everything else passes through, including a response split across
 * reads. A silent terminal loses the race after 250ms and stays non-Sixel.
 *
 * The probe is asked only on Windows Terminal, which is the terminal it was
 * written against: XTSMGRAPHICS is an xterm extension, and `WT_SESSION` is what
 * says the extension is there to answer. A terminal that already carries an
 * image protocol never reaches here.
 */
export class SixelProbe {
	#host: SixelProbeHost;
	#pendingDa = false;
	#pendingGraphics = false;
	#buffer = "";
	#timeout?: NodeJS.Timeout;
	#unsubscribe?: () => void;

	constructor(host: SixelProbeHost) {
		this.#host = host;
	}

	start(): void {
		if (TERMINAL.imageProtocol) return;
		if (process.platform !== "win32") return;
		if (!Bun.env.WT_SESSION) return;
		if (!process.stdin.isTTY || !process.stdout.isTTY) return;

		this.#clear();
		this.#pendingDa = true;
		this.#pendingGraphics = true;
		this.#unsubscribe = this.#host.addInputListener(data => this.#handleInput(data));
		this.#host.write("\x1b[c");
		this.#host.write("\x1b[?2;1;0S");
		this.#timeout = setTimeout(() => {
			this.#finish(false);
		}, 250);
	}

	#handleInput(data: string): InputListenerResult {
		if (!this.#pendingDa && !this.#pendingGraphics) {
			return undefined;
		}

		this.#buffer += data;
		let passthrough = "";
		let probeOutcome: boolean | null = null;

		for (let reply = this.#nextReply(); reply !== null; reply = this.#nextReply()) {
			passthrough += this.#buffer.slice(0, reply.index);
			this.#buffer = this.#buffer.slice(reply.end);
			const outcome = reply.isDa ? this.#applyDa(reply.params) : this.#applyGraphics(reply.params);
			if (outcome !== null) probeOutcome = outcome;
		}

		passthrough += this.#releaseUnmatched();
		if (probeOutcome !== null) {
			this.#finish(probeOutcome);
		}
		return passthrough.length === 0 ? { consume: true } : { data: passthrough };
	}

	/** The earliest DA1 or XTSMGRAPHICS reply in the buffer; DA1 wins a tie. */
	#nextReply(): ProbeReply | null {
		const daMatch = this.#buffer.match(DA1_REPLY);
		const graphicsMatch = this.#buffer.match(GRAPHICS_REPLY);
		const daIndex = daMatch?.index ?? Number.POSITIVE_INFINITY;
		const graphicsIndex = graphicsMatch?.index ?? Number.POSITIVE_INFINITY;
		const isDa = daIndex <= graphicsIndex;
		const match = isDa ? daMatch : graphicsMatch;
		if (!match || match.index === undefined) return null;
		return { index: match.index, end: match.index + match[0].length, params: match[1] ?? "", isDa };
	}

	/** A DA1 reply: attribute 4 is Sixel. Returns the probe outcome once it is known. */
	#applyDa(params: string): boolean | null {
		if (!this.#pendingDa) return null;
		this.#pendingDa = false;
		if (params.split(";").some(value => Number.parseInt(value, 10) === 4)) {
			this.#pendingGraphics = false;
			return true;
		}
		return this.#pendingGraphics ? null : false;
	}

	/** An XTSMGRAPHICS reply: a nonzero status is Sixel. Returns the probe outcome once it is known. */
	#applyGraphics(params: string): boolean | null {
		if (!this.#pendingGraphics) return null;
		this.#pendingGraphics = false;
		const status = Number.parseInt(params, 10);
		if (!Number.isNaN(status) && status !== 0) {
			this.#pendingDa = false;
			return true;
		}
		return this.#pendingDa ? null : false;
	}

	/** Bytes outside a reply pass through; while a reply is pending, a partial reply prefix stays buffered. */
	#releaseUnmatched(): string {
		const keepFrom = this.#pendingDa || this.#pendingGraphics ? this.#partialStart(this.#buffer) : -1;
		const released = keepFrom >= 0 ? this.#buffer.slice(0, keepFrom) : this.#buffer;
		this.#buffer = keepFrom >= 0 ? this.#buffer.slice(keepFrom) : "";
		return released;
	}

	#partialStart(buffer: string): number {
		const lastEsc = buffer.lastIndexOf("\x1b");
		if (lastEsc < 0) return -1;
		const tail = buffer.slice(lastEsc);
		if (/^\x1b\[\?[0-9;]*$/u.test(tail)) {
			return lastEsc;
		}
		return -1;
	}

	#clear(): void {
		if (this.#timeout) {
			clearTimeout(this.#timeout);
			this.#timeout = undefined;
		}
		if (this.#unsubscribe) {
			this.#unsubscribe();
			this.#unsubscribe = undefined;
		}
		this.#pendingDa = false;
		this.#pendingGraphics = false;
		this.#buffer = "";
	}

	#finish(supported: boolean): void {
		this.#clear();
		if (!supported || TERMINAL.imageProtocol) return;

		setTerminalImageProtocol(ImageProtocol.Sixel);
		this.#host.onSixelDiscovered();
	}

	/** Drop probe state without waiting for a response; called on teardown. */
	cancel(): void {
		this.#clear();
	}
}
