import { SGR_BG_RESET, SGR_FG_RESET, SGR_INTENSITY_RESET } from "@veyyon/tui/ansi";
import { type ThemeColor, theme } from "../theme/theme";

export interface TrackSegment {
	label: string;
}

const SEGMENT_COLOR_CANDIDATES: ThemeColor[] = [
	"accent",
	"success",
	"warning",
	"error",
	"mdCode",
	"mdLink",
	"syntaxString",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxNumber",
	"syntaxOperator",
	"syntaxVariable",
];

export function resolveSegmentPalette(count: number): ThemeColor[] {
	const palette: ThemeColor[] = [];
	const seen = new Set<string>();
	for (const color of SEGMENT_COLOR_CANDIDATES) {
		const ansi = theme.getFgAnsi(color);
		if (seen.has(ansi)) continue;
		seen.add(ansi);
		palette.push(color);
		if (palette.length >= count) break;
	}
	return palette;
}

export function renderSegmentTrack(segments: TrackSegment[], activeIndex: number): string {
	const capLeft = theme.sep.powerlineRight;
	const capRight = theme.sep.powerlineLeft;
	const thinSep = theme.fg("statusLineSep", theme.sep.powerlineThin);
	const palette = resolveSegmentPalette(segments.length);

	let track = "";
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i]!;
		if (i > 0) {
			track += i === activeIndex || i - 1 === activeIndex ? "  " : ` ${thinSep} `;
		}
		const color = palette[i % palette.length];
		const fg = theme.getFgAnsi(color);
		if (i !== activeIndex) {
			track += `${fg}${segment.label}${SGR_FG_RESET}`;
			continue;
		}
		const bg = fg.replace("\x1b[38;", "\x1b[48;");
		const label = `${bg}${theme.getContrastFgAnsi(color)}\x1b[1m ${segment.label} ${SGR_INTENSITY_RESET}${SGR_BG_RESET}`;
		track += `${fg}${capLeft}${label}${fg}${capRight}${SGR_FG_RESET}`;
	}
	return track;
}

export function renderSliderLines(
	segments: Array<TrackSegment & { detail?: string }>,
	activeIndex: number,
	caption?: string,
): string[] {
	const track = renderSegmentTrack(segments, activeIndex);
	const leftArrow = theme.fg(activeIndex > 0 ? "accent" : "dim", theme.nav.prev);
	const rightArrow = theme.fg(activeIndex < segments.length - 1 ? "accent" : "dim", theme.nav.next);
	const captionText = caption ? `${theme.fg("dim", caption)}  ` : "";
	const trackLine = `${captionText}${leftArrow}  ${track}  ${rightArrow}`;
	const detail = segments[activeIndex]?.detail;
	if (!detail) return [trackLine];
	return [trackLine, `  ${theme.fg("dim", theme.tree.hook)} ${theme.fg("muted", detail)}`];
}
