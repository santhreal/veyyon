/**
 * Print the composer's metadata footline, one preset per row.
 *
 * The footline is the surface where a separator change is hardest to judge from
 * source: the question is never "which characters divide the segments" but "does the
 * line read as standing state on the left and live values on the right", and that is
 * a thing you see. Rendering all four presets at one width puts them side by side, so
 * a change to the grammar can be compared against the presets it does NOT apply to.
 *
 * Run:
 *     bun scripts/demos/render-status-footline.ts --width 100 |
 *       bun scripts/demos/render-proof.ts --out /tmp/footline --width 100
 *
 * The session is a stub, and deliberately a FIXED one: real values would make two
 * renders differ because the git branch moved or the clock advanced, and a proof you
 * cannot re-take identically is not a proof.
 *
 * Two segments still read the machine rather than the session, and it is worth knowing
 * WHICH before comparing two proofs: `hostname` (`full` and `nerd` only) reports the
 * real host, `profile` reports the active profile, and `git` reports the repository this
 * runs in. Setting `VEYYON_PROFILE` here would not help: the directory resolution is
 * cached at import. A note goes to stderr so nobody reads a hostname or profile
 * difference as a change to the footline itself.
 */
import { StatusLineComponent } from "../../packages/coding-agent/src/modes/terminal/components/status-line/component";
import { STATUS_LINE_PRESETS } from "../../packages/coding-agent/src/modes/terminal/components/status-line/presets";
import type { StatusLinePreset } from "../../packages/coding-agent/src/modes/terminal/components/status-line/types";
import { theme } from "../../packages/coding-agent/src/theme/theme";
import { createStubStatusSession, renderDemo } from "./render-args";

const presets = Object.keys(STATUS_LINE_PRESETS) as StatusLinePreset[];

await renderDemo(
	({ width }) => {
		const lines: string[] = [];
		for (const preset of presets) {
			const statusLine = new StatusLineComponent(createStubStatusSession());
			statusLine.updateSettings({ preset });
			lines.push(theme.fg("dim", `${preset}:`));
			lines.push(statusLine.renderQuietLine(width) ?? theme.fg("error", "(no footline rendered)"));
			lines.push("");
		}
		lines.push(theme.fg("dim", "footline, viewing an agent:"));
		const statusLine = new StatusLineComponent(createStubStatusSession());
		statusLine.setSession(createStubStatusSession(), "designer-3");
		lines.push(statusLine.renderQuietLine(width) ?? theme.fg("error", "(no footline rendered)"));
		lines.push("");
		console.error(
			"note: the `hostname` (full, nerd), `profile` and `git` segments read this machine, so " +
				"those parts differ between hosts and profiles; everything else comes from the fixed stub.",
		);
		return lines;
	},
	{ settings: true },
);
