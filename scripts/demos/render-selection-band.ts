/**
 * Print a list pane's rows twice: once with the flat band this product painted, once with the
 * directional band it paints now.
 *
 * The question a band change raises cannot be answered from source or from an assertion. An
 * assertion can prove the ramp is monotone and the width is unchanged; only an image says whether
 * the row reads as a surface the cursor is resting on rather than as a rectangle somebody drew. The
 * two halves are rendered in one pass so the pair is a DIFFERENTIAL: the same rows, the same width,
 * the same theme, with only the paint differing.
 *
 * Run:
 *     bun scripts/demos/render-selection-band.ts --width 60 |
 *       bun scripts/demos/render-proof.ts --out /tmp/band --width 60 --scale 3
 *
 * Both grounds matter and `render-proof.ts` takes both. The trailing end of the ramp is a mix into
 * the ground the row sits on, so on a black ground it dissolves and on a grey one it lands on the
 * operator's own page — one ground answers half the question.
 */
import { Ellipsis, truncateToWidth } from "@veyyon/tui";
import { hoverBandAt, selectionBand } from "../../packages/coding-agent/src/modes/components/selector-helpers";
import { setDetectedTerminalGround } from "../../packages/coding-agent/src/modes/theme/ground-tints";
import { theme } from "../../packages/coding-agent/src/modes/theme/theme";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
/**
 * The ground the ramp resolves into. Declared rather than detected: a proof script has no terminal
 * to ask, and taking the theme's declared black would mix every ramp toward a colour the operator's
 * terminal is not showing.
 */
const ground = flag("ground", "#1e2127");
await initRender(themeName, { settings: true });
setDetectedTerminalGround(ground);

/** The rows a real picker paints: a label, a right-aligned hint, and one row that overflows. */
const ROWS: readonly string[] = [
	"  claude-sonnet-4-5              200k ctx",
	"  gpt-5-codex                    400k ctx",
	"  gemini-3-pro-preview             1M ctx",
	"  a model whose name runs past the end of the row it is drawn on",
];

/** The flat band, spelled out here rather than imported: it is the BEFORE arm and must not move. */
function flatBand(line: string): string {
	return theme.bg("selectedBg", truncateToWidth(line, width, Ellipsis.Omit, true));
}

const lines: string[] = [];

lines.push(theme.fg("dim", `before — one flat fill of selectedBg, on ${ground}:`));
for (const [index, row] of ROWS.entries()) {
	lines.push(index === 1 ? flatBand(row) : truncateToWidth(row, width, Ellipsis.Omit, true));
}
lines.push("");

lines.push(theme.fg("dim", "after — accent leading cell, eased ramp toward the ground:"));
for (const [index, row] of ROWS.entries()) {
	lines.push(index === 1 ? selectionBand(row, width) : truncateToWidth(row, width, Ellipsis.Omit, true));
}
lines.push("");

// The hover fade, every frame of it on one screen. A settled hover is the selection band itself, so
// the last row of this block is the same bytes as the selected row above it.
lines.push(theme.fg("dim", "a hover arriving, strength 0.2 to 1:"));
for (const strength of [0.2, 0.4, 0.6, 0.8, 1]) {
	lines.push(hoverBandAt(`  a row the pointer is arriving at, at ${strength}`, width, strength));
}
lines.push("");

process.stdout.write(`${lines.join("\n")}\n`);
