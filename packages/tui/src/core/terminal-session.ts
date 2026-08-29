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
	planSixelProbe,
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

/**
 * A terminal that reports Sixel support through neither env nor termcap is
 * asked directly: primary device attributes (`CSI c`, attribute 4) and, where
 * the extension exists, the graphics-attributes report (`CSI ? 2 ; 1 ; 0 S`)
 * are sent together and whichever answers first decides. Responses are stripped
 * from the input stream; everything else passes through, including a response
 * split across reads. A silent terminal loses the race after 250ms and stays
 * non-Sixel.
 *
 * `KNOWN_TERMINALS` grants an image protocol to five terminals, all of them
 * Kitty or iTerm2, and never `ImageProtocol.Sixel`. Everything else falls to
 * `base`/`trueColor`, whose protocol is null, and a null protocol makes image
 * rendering return nothing with no message saying why. DA is universal, so it
 * goes to every TTY; XTSMGRAPHICS is an xterm extension and stays on Windows
 * Terminal, which is what it was written against. `planSixelProbe` owns that
 * decision, and `#pendingGraphics` starts at whatever it says so a DA without
 * attribute 4 settles the probe instead of waiting out the timeout.
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
		const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
		const plan = planSixelProbe(TERMINAL.imageProtocol, isTty);
		if (!plan) return;

		this.#clear();
		this.#pendingDa = true;
		this.#pendingGraphics = plan.xtsmgraphics;
		this.#unsubscribe = this.#host.addInputListener(data => this.#handleInput(data));
		this.#host.write("\x1b[c");
		if (plan.xtsmgraphics) this.#host.write("\x1b[?2;1;0S");
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

		while (this.#buffer.length > 0) {
			const daMatch = this.#buffer.match(/\x1b\[\?([0-9;]+)c/u);
			const graphicsMatch = this.#buffer.match(/\x1b\[\?2;(\d+);([0-9;]+)S/u);

			if (!daMatch && !graphicsMatch) break;

			const daIndex = daMatch?.index ?? Number.POSITIVE_INFINITY;
			const graphicsIndex = graphicsMatch?.index ?? Number.POSITIVE_INFINITY;
			const useDa = daIndex <= graphicsIndex;
			const match = useDa ? daMatch : graphicsMatch;
			if (!match || match.index === undefined) break;

			passthrough += this.#buffer.slice(0, match.index);
			this.#buffer = this.#buffer.slice(match.index + match[0].length);

			if (useDa && this.#pendingDa) {
				this.#pendingDa = false;
				const attributes = (match[1] ?? "")
					.split(";")
					.map(value => Number.parseInt(value, 10))
					.filter(value => Number.isFinite(value));
				const hasSixelAttribute = attributes.includes(4);
				if (hasSixelAttribute) {
					this.#pendingGraphics = false;
					probeOutcome = true;
				} else if (!this.#pendingGraphics) {
					probeOutcome = false;
				}
			} else if (!useDa && this.#pendingGraphics) {
				this.#pendingGraphics = false;
				const status = Number.parseInt(match[1] ?? "", 10);
				const supportsSixel = !Number.isNaN(status) && status !== 0;
				if (supportsSixel) {
					this.#pendingDa = false;
					probeOutcome = true;
				} else if (!this.#pendingDa) {
					probeOutcome = false;
				}
			}
		}

		if (this.#pendingDa || this.#pendingGraphics) {
			const partialStart = this.#partialStart(this.#buffer);
			if (partialStart >= 0) {
				passthrough += this.#buffer.slice(0, partialStart);
				this.#buffer = this.#buffer.slice(partialStart);
			} else {
				passthrough += this.#buffer;
				this.#buffer = "";
			}
		} else {
			passthrough += this.#buffer;
			this.#buffer = "";
		}

		if (probeOutcome !== null) {
			this.#finish(probeOutcome);
		}

		if (passthrough.length === 0) {
			return { consume: true };
		}

		return { data: passthrough };
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
