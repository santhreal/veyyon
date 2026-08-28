import { visibleWidth } from "@veyyon/tui/utils";
import type { ComposerOracleFrameState, OracleFailure } from "./types";

/**
 * Guarantee 8: noHorizontalOverflow
 * Every rendered row in the terminal grid must have visible character width <= terminal width.
 */
export function checkNoHorizontalOverflow(state: ComposerOracleFrameState): OracleFailure | null {
	for (let r = 0; r < state.viewportLines.length; r++) {
		const line = state.viewportLines[r] ?? "";
		const width = visibleWidth(line);
		if (width > state.width) {
			return {
				oracle: "noHorizontalOverflow",
				message: `Row ${r} has visible width ${width} exceeding terminal width ${state.width}: '${line}'.`,
				details: { row: r, visibleWidth: width, terminalWidth: state.width, line },
			};
		}
	}
	return null;
}
