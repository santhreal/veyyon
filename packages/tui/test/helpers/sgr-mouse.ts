/**
 * ONE owner for the SGR mouse reports a test sends to a terminal.
 *
 * The wire format is 1-based in both axes, and every test that wants a wheel notch or a click has
 * to remember that. Before this module, `"\x1b[<64;5;5M"` was written out by hand in six suites
 * across two packages, and five more suites each declared their own `wheelUpAt`/`wheelDownAt`
 * builder that added the same two ones. A hand-written report is one transposed digit away from
 * clicking a different row than the test claims, and a suite that clicks the wrong row still
 * passes, it just stops testing what its name says.
 *
 * Every function here takes 0-BASED screen coordinates, matching the rows a viewport read hands
 * back, and does the conversion once.
 *
 * Button encoding: 64 is wheel up, 65 is wheel down, 0 is the left button. `M` is press, `m` is
 * release. `packages/tui/src/mouse.ts` parses these, and `mouse.test.ts` deliberately asserts on
 * raw literals because the bytes themselves are its subject; it does not use this module.
 */

/** SGR wheel-up report at a 0-based screen position. Scrolls back toward older rows. */
export function wheelUpAt(row: number, col: number): string {
	return `\x1b[<64;${col + 1};${row + 1}M`;
}

/** SGR wheel-down report at a 0-based screen position. Walks forward toward the live tail. */
export function wheelDownAt(row: number, col: number): string {
	return `\x1b[<65;${col + 1};${row + 1}M`;
}

/** SGR left-button press at a 0-based screen position. */
export function pressAt(row: number, col = 0): string {
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

/** SGR left-button release at a 0-based screen position. */
export function releaseAt(row: number, col = 0): string {
	return `\x1b[<0;${col + 1};${row + 1}m`;
}

/**
 * The wheel position the scroll suites use.
 *
 * Row 4, column 4 in 0-based coordinates, which is the middle of the transcript for every geometry
 * they drive. The position only has to miss the pinned footer, so that a notch reaches the
 * transcript's scroll handling rather than a footer child's own pointer routing.
 */
const WHEEL_ROW = 4;
/** Column for {@link WHEEL_ROW}. */
const WHEEL_COL = 4;

/** Wheel-up notch over the transcript. */
export const WHEEL_UP = wheelUpAt(WHEEL_ROW, WHEEL_COL);

/** Wheel-down notch over the transcript. */
export const WHEEL_DOWN = wheelDownAt(WHEEL_ROW, WHEEL_COL);
