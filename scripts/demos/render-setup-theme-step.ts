/**
 * Print the setup wizard's theme step as ANSI, for the render proofs.
 *
 * The step cannot be captured by running `vey setup`: it writes to the real
 * profile and it opens on whatever theme the machine already has, so a capture
 * would differ on every machine and would leave a config behind. This mounts the
 * real scene against a throwaway profile and drives it with the same keys a user
 * presses, so every ground and every state comes out identical everywhere.
 *
 * Usage:
 *
 *     bun scripts/demos/render-setup-theme-step.ts --toggles colorblind,ascii
 *       | bun scripts/demos/render-proof.ts --out /tmp/proof/setup-theme --width 90
 *
 * `--toggles` is a comma-separated list of `colorblind` and `ascii`, so a proof
 * can show the modifiers off, one on, or both. They are toggles that compose
 * with whichever theme is selected; they used to be rows that ENDED the step
 * without a theme ever being picked.
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { themeSetupScene } from "../../packages/coding-agent/src/modes/setup-wizard/scenes/theme";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";
import { setAnsiPolicy } from "../../packages/tui/src/index";
import { flag, renderWidth } from "./render-args";

const width = renderWidth();
const themeName = flag("theme", "titanium");
const toggles = flag("toggles", "")
	.split(",")
	.map(name => name.trim())
	.filter(name => name.length > 0);

/** Row index of each toggle in the curated list, which the digit keys address. */
const TOGGLE_ROW: Record<string, number> = { colorblind: 4, ascii: 5 };

await initTheme(false, "unicode", false, themeName, themeName);
setAnsiPolicy("full");

const root = mkdtempSync(join(tmpdir(), "veyyon-setup-proof-"));
const agentDir = join(root, "agent");
const projectDir = join(root, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });

try {
	const settings = await Settings.init({ cwd: projectDir, agentDir });
	const scene = themeSetupScene.mount({
		ctx: { settings, ui: { invalidate: () => {} } } as never,
		requestRender: () => {},
		finish: () => {},
		setFocus: () => {},
		restoreFocus: () => {},
	});

	for (const name of toggles) {
		const row = TOGGLE_ROW[name];
		if (row === undefined) throw new Error(`unknown toggle "${name}"; expected colorblind or ascii`);
		// The digit shortcut puts the cursor on a row without depending on where
		// the scene opened, then enter flips the toggle.
		scene.handleInput?.(String(row + 1));
		scene.handleInput?.("\r");
		// The flip repaints from the scene's own state and then applies the
		// preview, which reloads a theme from disk. Wait for that before painting.
		await new Promise(resolve => setTimeout(resolve, 120));
	}

	process.stdout.write(`${scene.render(width).join("\n")}\n`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
