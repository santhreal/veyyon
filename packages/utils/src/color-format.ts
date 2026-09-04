/**
 * How many colors a color is encoded for.
 *
 * `Bun.color` needs to be told which encoding to produce, and the answer is a
 * property of the output device, not of the string being encoded. The device is
 * probed by `@veyyon/tui`'s terminal capabilities, which pushes the answer here;
 * every string encoder reads it from here rather than importing the probe, so
 * encoding a color never drags terminal I/O into a pure string module.
 *
 * The default is truecolor. A process that never probes a device — a test, a
 * non-terminal renderer, an export pipeline — gets the highest-fidelity encoding,
 * and downgrading is what a probe does when it finds a narrower terminal.
 */

/** The `Bun.color` output formats this product encodes ANSI colors in. */
export type AnsiColorFormat = "ansi-16m" | "ansi-256";

let ansiColorFormat: AnsiColorFormat = "ansi-16m";

/** The encoding every ANSI color in this process is written in. */
export function getAnsiColorFormat(): AnsiColorFormat {
	return ansiColorFormat;
}

/** Record what the output device supports. Called once, by whoever probed it. */
export function setAnsiColorFormat(format: AnsiColorFormat): void {
	ansiColorFormat = format;
}
