/** The one owner of how the composer footline spaces things out. The footline shows a variable number of independent states, and the reader's */
import { getThemeEpoch, theme } from "../../theme/theme";

// Separator strings are pure functions of the theme. Cache them by epoch so
// the `theme.fg("dim", …)` concatenation runs once per theme swap, not once
// per frame. The epoch bumps on every theme change (see theme.ts).
let sepEpoch = -1;
let stateSep = "";
let segmentSep = "";

function ensureSeparators(): void {
	const epoch = getThemeEpoch();
	if (epoch === sepEpoch) return;
	sepEpoch = epoch;
	const d = theme.sep.dot.trim();
	stateSep = theme.fg("dim", ` ${d} `);
	segmentSep = theme.fg("dim", `  ${d}  `);
}

/** Between two independent states inside one segment: `! YOLO · Goal 12K/50K`. One space either side — narrower than the segment separator, wider than the */
export function stateSeparator(): string {
	ensureSeparators();
	return stateSep;
}

/** Between two segments of the footline: `gpt-5 · ! YOLO · Goal · 3`. Two spaces either side. The extra cell on each side is what makes the outer */
export function segmentSeparator(): string {
	ensureSeparators();
	return segmentSep;
}

/** Join independent states with {@link stateSeparator}, dropping the ones that are not active. */
export function joinStates(...states: (string | null | undefined | false)[]): string {
	const sep = stateSeparator();
	let result = "";
	for (let i = 0; i < states.length; i++) {
		const state = states[i];
		if (typeof state === "string" && state !== "") {
			if (result) result += sep;
			result += state;
		}
	}
	return result;
}
