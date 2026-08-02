/**
 * Print a full `SetupWizardComponent` frame as ANSI, for the render proofs.
 *
 * The wizard cannot be captured by running `vey setup`: it writes to the real
 * profile, it animates, and it opens on whatever state the machine already has.
 * This drives the REAL overlay component (not a mock-up of its layout) against a
 * throwaway profile, waits out the splash-to-scene dissolve, and prints the one
 * frame the component itself produced, so the ground, the padding and the footer
 * in the image are the component's own bytes on every machine.
 *
 * Usage:
 *
 *     env -u NO_COLOR FORCE_COLOR=3 bun scripts/demos/render-setup-wizard.ts --width 100
 *       | bun scripts/demos/render-proof.ts --out /tmp/wizard --width 100 --scale 3
 *
 * `--phase` is `scene` (default) or `splash`. `--rows` sets the viewport height,
 * which the overlay reads from the terminal to fill edge to edge; that filler is
 * exactly where a hardcoded ground shows up as a slab, so the proof needs it.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { glyphSetupScene } from "../../packages/coding-agent/src/modes/setup-wizard/scenes/glyph";
import { themeSetupScene } from "../../packages/coding-agent/src/modes/setup-wizard/scenes/theme";
import type { SetupWizardContext } from "../../packages/coding-agent/src/modes/setup-wizard/scenes/types";
import { SetupWizardComponent } from "../../packages/coding-agent/src/modes/setup-wizard/wizard-overlay";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";
import { setAnsiPolicy } from "../../packages/tui/src/index";
import { flag, renderWidth } from "./render-args";

const width = renderWidth();
const rows = Number.parseInt(flag("rows", "30"), 10);
const themeName = flag("theme", "titanium");
const phase = flag("phase", "scene");

/** Let the overlay's own timer run: it drives the splash and the dissolve. */
function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

await initTheme(false, "unicode", false, themeName, themeName);
setAnsiPolicy("full");

const root = mkdtempSync(join(tmpdir(), "veyyon-wizard-proof-"));
const agentDir = join(root, "agent");
const projectDir = join(root, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });

try {
	const settings = await Settings.init({ cwd: projectDir, agentDir });
	const ctx = {
		settings,
		ui: {
			terminal: { rows },
			requestRender: () => {},
			setFocus: () => {},
			invalidate: () => {},
		},
	} as unknown as SetupWizardContext;

	// Two scenes so the step dots render; only the first is mounted here.
	const component = new SetupWizardComponent(ctx, [themeSetupScene, glyphSetupScene]);
	void component.run();

	if (phase === "scene") {
		// Enter leaves the splash; the dissolve into the scene runs for
		// SCENE_TRANSITION_MS before the overlay settles on the scene phase.
		component.handleInput("\r");
		await sleep(700);
	} else if (phase !== "splash") {
		throw new Error(`unknown phase "${phase}"; expected scene or splash`);
	}

	const frame = component.render(width);
	component.dispose();
	process.stdout.write(`${frame.join("\n")}\n`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
