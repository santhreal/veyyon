/**
 * Print the product's bars twice: once at the whole-cell resolution they had, once at the eight
 * steps per column they have now, plus the download bar's travel frame by frame.
 *
 * The question a resolution change raises cannot be answered from an assertion. An assertion proves
 * the ramp is monotone and the row is still exactly as wide; only an image says whether a value that
 * moved by three percent is visibly somewhere else. The two arms are rendered in one pass so the
 * pair is a DIFFERENTIAL: the same ratios, the same width, the same theme, with only the
 * quantisation differing — and the BEFORE arm is the sweep where nothing moves for four rows at a
 * time, which is the defect.
 *
 * Run:
 *     bun scripts/demos/render-sub-cell-bars.ts --width 76 |
 *       bun scripts/demos/render-proof.ts --out /tmp/bars --width 76 --scale 3
 *
 * Both grounds matter and `render-proof.ts` takes both: the track glyph is a light shade and the
 * fill a solid one, so a ramp that reads as travel on the operator's grey page can read as a solid
 * slab on black.
 */

import { MotionClock } from "@veyyon/utils/motion";
import { TinyTitleDownloadProgressComponent } from "../../packages/coding-agent/src/modes/terminal/components/chrome/tiny-title-download-progress";
import { formatUsageWindowLine, renderAsciiBar } from "../../packages/coding-agent/src/slash-commands/helpers/format";
import { theme } from "../../packages/coding-agent/src/theme/theme";
import { renderDemo } from "./render-args";

const BAR_WIDTH = 10;
const CREEP = [0.3, 0.33, 0.36, 0.39, 0.42, 0.45, 0.48, 0.51];

function wholeCellBar(ratio: number, cells: number): string {
	const filled = Math.round(ratio * cells);
	return "█".repeat(filled) + "░".repeat(Math.max(0, cells - filled));
}

await renderDemo(
	({ width }) => {
		const lines: string[] = [
			theme.fg("dim", `before — one step per column, ${BAR_WIDTH} columns, 30% to 51% in 3% steps:`),
			...CREEP.map(r => `  [${wholeCellBar(r, BAR_WIDTH)}] ${Math.round(r * 100)}%`),
			"",
			theme.fg("dim", "after — eight steps per column, the same ratios:"),
			...CREEP.map(r => `  ${renderAsciiBar(r, BAR_WIDTH)}`),
			"",
			theme.fg("dim", "the /account usage windows, as both account surfaces print them:"),
			`  ${formatUsageWindowLine("5 Hour", 0.36, BAR_WIDTH)}`,
			`  ${formatUsageWindowLine("7 Day", 0.4, BAR_WIDTH)}`,
			`  ${formatUsageWindowLine("Daily · Anthropic", 0.712, BAR_WIDTH)}`,
			"",
			theme.fg("dim", "the tiny-model download bar walking from 40% to 65%, every 3rd frame:"),
		];
		const clock = new MotionClock({ autoTick: false });
		const download = new TinyTitleDownloadProgressComponent("lfm2-700m", { requestRender: () => {}, clock });
		download.update({ modelKey: "lfm2-700m", status: "progress", progress: 40 });
		lines.push(download.render(width)[1] ?? "");
		download.update({ modelKey: "lfm2-700m", status: "progress", progress: 65 });
		for (let frame = 0; frame < 60 && clock.liveCount > 0; frame++) {
			clock.tick((frame + 1) * (1000 / 60));
			if (frame % 3 === 2) lines.push(download.render(width)[1] ?? "");
		}
		lines.push(download.render(width)[1] ?? "");
		download.dispose();
		lines.push("");
		return lines;
	},
	{ settings: true },
);
