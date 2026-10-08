import { getPaddingX } from "@veyyon/utils/tight-mode";
import { getSegmenter, sliceByColumn, visibleWidth } from "@veyyon/utils/width";
import type { TUI } from "../tui";
import { Text } from "./text";

const RENDER_INTERVAL_MS = 1000 / 30;
const SPINNER_ADVANCE_MS = 80;

type ColorFn = (str: string) => string;

/**
 * Styles Loader message fragments without changing their visible text or width.
 * Set `animated` for colorizers whose ANSI output changes over time.
 */
export type LoaderMessageColorFn = ColorFn & {
	readonly animated?: true;
};

/**
 * The frame a loader lays its message out against for every frame of `frames`, or `undefined` when
 * the layout depends on which frame is drawn. A frame that holds no whitespace or control character,
 * is the whole first grapheme cluster of `${frame} ` (one cluster, which the space after it does not
 * join) and has the width of every other frame is one unbreakable word of that width, so
 * `${frame} ${message}` wraps to the same rows whichever such frame leads it.
 */
function layoutFrameFor(frames: readonly string[]): string | undefined {
	const first = frames[0];
	if (first === undefined) return undefined;
	const width = visibleWidth(first);
	const segmenter = getSegmenter();
	for (const frame of frames) {
		if (/[\s\p{Cc}]/u.test(frame) || visibleWidth(frame) !== width) return undefined;
		if (segmenter.segment(`${frame} `).containing(0)?.segment !== frame) return undefined;
	}
	return first;
}

/** A rendered row split into its left padding, its text, and the spaces after the text. */
interface LoaderRow {
	leading: string;
	content: string;
	trailing: string;
}

/** Split each row, clamped to `width`, around its text so the spinner and message can be styled in place. */
function splitRows(source: readonly string[], width: number): LoaderRow[] {
	const paddingX = getPaddingX(1);
	return source.map(line => {
		const clamped = visibleWidth(line) > width ? sliceByColumn(line, 0, width, true) : line;
		const body = clamped.slice(paddingX);
		const content = body.trimEnd();
		return { leading: clamped.slice(0, paddingX), content, trailing: body.slice(content.length) };
	});
}

/** Animates a spinner and colorized message while asynchronous work is pending. */
export class Loader extends Text {
	// The breathing pixel: the sun's intensity ramp inhaling and exhaling.
	#frames = ["·", ":", "░", "▒", "▓", "█", "▓", "▒", "░", ":"];
	#currentFrame = 0;
	#intervalId?: NodeJS.Timeout;
	#ui: TUI | null = null;
	#lastSpinnerTick = 0;
	// The frame the message is laid out against (see layoutFrameFor), so a tick that only advances the
	// spinner re-wraps nothing; undefined lays it out against the frame drawn.
	#layoutFrame: string | undefined;
	// The frame the last update requested a repaint for.
	#requestedFrame: string | undefined;
	#layoutSource?: readonly string[];
	#layout?: readonly LoaderRow[];

	constructor(
		ui: TUI,
		private spinnerColorFn: ColorFn,
		private messageColorFn: LoaderMessageColorFn,
		private message: string = "Loading...",
		spinnerFrames?: string[],
	) {
		super("", 1, 0);
		this.#ui = ui;
		if (spinnerFrames && spinnerFrames.length > 0) {
			this.#frames = spinnerFrames;
		}
		this.#layoutFrame = layoutFrameFor(this.#frames);
		this.start();
	}

	render(width: number): readonly string[] {
		const source = super.render(width);
		if (source !== this.#layoutSource) {
			this.#layoutSource = source;
			this.#layout = splitRows(source, width);
		}

		const frame = this.#frames[this.#currentFrame];
		const marker = this.#layoutFrame ?? frame;
		const lines = [""];
		const layout = this.#layout ?? [];
		for (let i = 0; i < layout.length; i++) {
			const { leading, content, trailing } = layout[i];
			let body = "";
			if (i === 0 && content.startsWith(marker)) body = this.#spinnerRow(content.slice(marker.length), frame);
			else if (content) body = this.messageColorFn(content);
			lines.push(`${leading}${body}${trailing}`);
		}
		return lines;
	}

	/** The drawn spinner frame, then the message that followed the layout marker on the first row. */
	#spinnerRow(remainder: string, frame: string): string {
		const separator = remainder.startsWith(" ") ? " " : "";
		const message = remainder.slice(separator.length);
		return `${this.spinnerColorFn(frame)}${separator}${message ? this.messageColorFn(message) : ""}`;
	}

	start() {
		this.#lastSpinnerTick = performance.now();
		this.#updateDisplay();
		const intervalMs = this.messageColorFn.animated === true ? RENDER_INTERVAL_MS : SPINNER_ADVANCE_MS;
		this.#intervalId = setInterval(() => {
			const now = performance.now();
			const elapsed = now - this.#lastSpinnerTick;
			const shouldAdvanceSpinner = elapsed >= SPINNER_ADVANCE_MS;
			if (shouldAdvanceSpinner) {
				const steps = Math.floor(elapsed / SPINNER_ADVANCE_MS);
				this.#currentFrame = (this.#currentFrame + steps) % this.#frames.length;
				this.#lastSpinnerTick += steps * SPINNER_ADVANCE_MS;
			}
			if (shouldAdvanceSpinner || this.#ui?.synchronizedOutput === true) {
				this.#updateDisplay();
			}
		}, intervalMs);
	}

	stop() {
		if (this.#intervalId) {
			clearInterval(this.#intervalId);
			this.#intervalId = undefined;
		}
	}

	/** Lifecycle teardown: stop the animation timer. Idempotent. */
	dispose() {
		this.stop();
	}

	setMessage(message: string) {
		if (message === this.message) {
			return;
		}
		this.message = message;
		this.#updateDisplay();
	}

	#updateDisplay() {
		const frame = this.#frames[this.#currentFrame];
		const textChanged = this.setText(`${this.#layoutFrame ?? frame} ${this.message}`);
		const frameChanged = frame !== this.#requestedFrame;
		this.#requestedFrame = frame;
		if ((textChanged || frameChanged || this.messageColorFn.animated === true) && this.#ui) {
			// Direct write: a loader tick changes only this component, so the TUI
			// can update the already-positioned rows without driving the full
			// compose/prepare/diff pipeline. Lightweight test stubs may not carry
			// the newer API; keep their legacy component-scoped path working.
			if (typeof this.#ui.requestDirectWrite === "function") {
				this.#ui.requestDirectWrite(this);
			} else {
				this.#ui.requestComponentRender(this);
			}
		}
	}
}
