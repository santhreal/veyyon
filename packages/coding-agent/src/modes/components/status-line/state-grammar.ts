/**
 * The one owner of how the composer footline spaces things out.
 *
 * The footline shows a variable number of independent states, and the reader's
 * only way to tell where one ends and the next begins is the gap between them.
 * There are exactly TWO gaps that mean anything, and they have to differ:
 *
 *   - {@link segmentSeparator} between two SEGMENTS (model, mode, badges …)
 *   - {@link stateSeparator} between two independent STATES inside one segment
 *
 * A single space is neither. It belongs INSIDE one state, joining a state to
 * its own icon and values (`Goal 12K/50K 25%`, `▰▰▰▱ 58% left`), and nowhere
 * else. That distinction is the whole point: with a bare space doing both jobs
 * the mode segment rendered `! YOLO Goal 12K/50K 25%`, five words at one
 * strength, in which the boundary between the approval bypass and the goal is
 * indistinguishable from the boundary between the goal and its own token
 * count. It read as one phrase and it is three facts.
 *
 * WHY THIS IS A MODULE AND NOT A CONSTANT PER CALLER. The defect is not that
 * one join used the wrong string; it is that four surfaces each chose their
 * own — the footline hardcoded `"  ·  "` twice, the background-job badge slot
 * hardcoded `" · "`, and the mode segment used `" "`. Spacing that is decided
 * four times is spacing that is right by coincidence at whatever state count
 * the author happened to look at, and the bug only appears as the number of
 * simultaneous states rises. One owner, two strengths, any number of states.
 *
 * WHY THE GLYPH COMES FROM THE THEME. `theme.sep.dot` is already the preset's
 * answer to "what divides two things on one line": `" · "` on unicode and
 * nerd, `" - "` on ascii. The footline used to spell its own `·` regardless,
 * so the ascii preset — which exists for terminals that cannot draw `·` —
 * printed one anyway. Both strengths are built from that one glyph, so a
 * preset change moves them together and they can never disagree.
 *
 * These are functions rather than constants because the theme is swapped at
 * run time; a constant captured at import would keep the first theme's
 * separator for the life of the process.
 */
import { theme } from "../../theme/theme";

/** The glyph the active preset divides things with, without its padding. */
function dot(): string {
	return theme.sep.dot.trim();
}

/**
 * Between two independent states inside one segment: `! YOLO · Goal 12K/50K`.
 *
 * One space either side — narrower than the segment separator, wider than the
 * space that binds a state to its own values, which is exactly the ranking the
 * reader has to be able to see.
 */
export function stateSeparator(): string {
	return theme.fg("dim", ` ${dot()} `);
}

/**
 * Between two segments of the footline: `gpt-5  ·  ! YOLO · Goal  ·  3`.
 *
 * Two spaces either side. The extra cell on each side is what makes the outer
 * boundary read as stronger than the inner one at a glance, with no second
 * glyph to learn.
 */
export function segmentSeparator(): string {
	return theme.fg("dim", `  ${dot()}  `);
}

/**
 * Join independent states with {@link stateSeparator}, dropping the ones that
 * are not active.
 *
 * Every caller composing a segment out of states goes through here, so the
 * answer is the same for one state and for five: no leading separator when the
 * first state is absent, no trailing one when the last is, and never two
 * separators in a row when a state in the middle drops out. Those three are
 * the failures a hand-written `[a, b, c].join(" ")` produces the moment any
 * one of them is empty, and the mode segment could produce all three.
 */
export function joinStates(...states: (string | null | undefined | false)[]): string {
	return states.filter((state): state is string => typeof state === "string" && state !== "").join(stateSeparator());
}
