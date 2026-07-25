/**
 * One owner for "a third-party renderer threw, so what you are looking at is not
 * what it asked to draw".
 *
 * Tools, extensions, and hooks may all supply their own transcript renderer, and
 * every one of those call sites has to survive a throw without taking the session
 * down. The surviving path is a degraded render: a plain label instead of the
 * tool's card, raw output instead of its diff, the built-in card instead of the
 * extension's. That substitution used to happen with nothing but a `logger.warn`
 * behind it (and in one case not even that), which is a silent fallback: the
 * operator reads a deliberate-looking block and never learns their renderer is
 * broken.
 *
 * So the notice is not optional decoration, it is the loud half of the fallback.
 * It goes in the transcript where the missing render would have been, it names
 * the subject and the failure, and it says what to do. Every call site routes
 * through here so the wording, the glyph, and the log entry cannot drift apart.
 */

import { Text } from "@veyyon/tui";
import { collapseWhitespace, errorMessage, logger } from "@veyyon/utils";
import { theme } from "../theme/theme";

/**
 * The notice text, as one line.
 *
 * `subject` is the thing that failed, phrased for a reader: `tool "read" result`,
 * `custom message "deploy-status"`. The thrown value is described by the one owner
 * of that job, `errorMessage` in `@veyyon/utils`, which is why an `Error` with an
 * empty message still reports its name rather than trailing off after "threw:".
 */
export function rendererFailureNotice(subject: string, error: unknown, fallbackDescription: string): string {
	// One row: a multi-line throw would otherwise reflow the block it reports on.
	// A message that is nothing but whitespace collapses to empty, which would
	// leave the notice trailing off after the colon, so say so instead.
	const detail = collapseWhitespace(errorMessage(error)) || "no message";
	return `${subject} renderer threw: ${detail} — ${fallbackDescription}; fix or remove the renderer`;
}

/**
 * Log the failure and return the transcript row that reports it.
 *
 * The glyph matters as much as the colour: the inline TUI paints no backgrounds
 * and a monochrome terminal drops the foreground too, so an outcome carried by
 * colour alone is invisible on exactly the terminals where it matters most.
 */
export function reportRendererFailure(subject: string, error: unknown, fallbackDescription: string): Text {
	logger.warn("Renderer failed", { subject, error: String(error) });
	const notice = rendererFailureNotice(subject, error, fallbackDescription);
	return new Text(`${theme.styledSymbol("status.error", "error")} ${theme.fg("error", notice)}`, 0, 0);
}
