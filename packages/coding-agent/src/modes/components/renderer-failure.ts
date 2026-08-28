/** One owner for "a third-party renderer threw, so what you are looking at is not what it asked to draw". */

import { Text } from "@veyyon/tui";
import { collapseWhitespace, errorMessage, logger } from "@veyyon/utils";
import { replaceTabs, shortenEmbeddedPaths, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import { theme } from "../theme/theme";

/** The notice text, as one line. `subject` is the thing that failed, phrased for a reader: `tool "read" result`, */
export function rendererFailureNotice(subject: string, error: unknown, fallbackDescription: string): string {
	// One row: a multi-line throw would otherwise reflow the block it reports on.
	// A message that is nothing but whitespace collapses to empty, which would
	// leave the notice trailing off after the colon, so say so instead.
	const rawDetail = shortenEmbeddedPaths(replaceTabs(collapseWhitespace(errorMessage(error))));
	const detail = (rawDetail ? truncateToWidth(rawDetail, TRUNCATE_LENGTHS.LINE) : "") || "no message";
	const cleanSubject = shortenEmbeddedPaths(replaceTabs(collapseWhitespace(subject)));
	const cleanFallback = shortenEmbeddedPaths(replaceTabs(collapseWhitespace(fallbackDescription)));
	return `${cleanSubject} renderer threw: ${detail} — ${cleanFallback}; fix or remove the renderer`;
}

/** Log the failure and return the transcript row that reports it. The glyph matters as much as the colour: the inline TUI paints no backgrounds */
export function reportRendererFailure(subject: string, error: unknown, fallbackDescription: string): Text {
	logger.warn("Renderer failed", { subject, error: String(error) });
	const notice = rendererFailureNotice(subject, error, fallbackDescription);
	return new Text(`${theme.styledSymbol("status.error", "error")} ${theme.fg("error", notice)}`, 0, 0);
}
