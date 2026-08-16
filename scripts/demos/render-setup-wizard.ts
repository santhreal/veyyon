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
 * `--phase` is `scene` (default) or `splash`. `--scene` names the step to show
 * (`providers`, `subagents`, `glyphs`, `theme`, `import`); the wizard is walked
 * to it with its own forward key, so the progress breadcrumb reads as a user
 * sees it. `--rows` sets the viewport height, which the overlay reads from the
 * terminal to fill edge to edge; that filler is exactly where a hardcoded ground
 * shows up as a slab, so the proof needs it.
 *
 * `--hover <text>` points the mouse at the first cell of `<text>` in the frame
 * the component just painted and renders again, so a hover proof shows the real
 * band the component paints under a pointer rather than a mock of it.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { agentsSetupScene } from "../../packages/coding-agent/src/modes/setup-wizard/scenes/agents";
import { glyphSetupScene } from "../../packages/coding-agent/src/modes/setup-wizard/scenes/glyph";
import { importSetupScene } from "../../packages/coding-agent/src/modes/setup-wizard/scenes/import";
import { providersSetupScene } from "../../packages/coding-agent/src/modes/setup-wizard/scenes/providers";
import { themeSetupScene } from "../../packages/coding-agent/src/modes/setup-wizard/scenes/theme";
import type { SetupScene, SetupWizardContext } from "../../packages/coding-agent/src/modes/setup-wizard/scenes/types";
import { SetupWizardComponent } from "../../packages/coding-agent/src/modes/setup-wizard/wizard-overlay";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";
import { setAnsiPolicy } from "../../packages/tui/src/index";
import { flag, renderWidth } from "./render-args";

const width = renderWidth();
const rows = Number.parseInt(flag("rows", "30"), 10);
const themeName = flag("theme", "titanium");
const phase = flag("phase", "scene");
const sceneName = flag("scene", "theme");
const hoverText = flag("hover", "");

// The real onboarding order, so the progress breadcrumb in a proof reads exactly
// as a user sees it. Padding the list with repeats of one scene made the
// breadcrumb say "Subagents › Glyphs › Glyphs › Glyphs".
const SCENES: readonly SetupScene[] = [
	providersSetupScene,
	agentsSetupScene,
	glyphSetupScene,
	themeSetupScene,
	importSetupScene,
];

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
		// The providers scene reads auth state to mark which providers are already
		// connected. A throwaway profile has none, and the proof must not read the
		// real machine's credentials, so it answers "nothing is signed in".
		session: {
			modelRegistry: {
				authStorage: {
					hasAuth: () => false,
					has: () => false,
					getCredentialOrigin: () => undefined,
				},
				getAvailable: () => [],
			},
		},
		openInBrowser: () => {},
		showError: () => {},
		ui: {
			terminal: { rows },
			requestRender: () => {},
			setFocus: () => {},
			invalidate: () => {},
		},
	} as unknown as SetupWizardContext;

	const targetIndex = SCENES.findIndex(candidate => (candidate.stepLabel ?? candidate.id).toLowerCase() === sceneName);
	if (targetIndex < 0) {
		const names = SCENES.map(candidate => (candidate.stepLabel ?? candidate.id).toLowerCase()).join(", ");
		throw new Error(`unknown scene "${sceneName}"; expected one of ${names}`);
	}
	// A scene that discovers its rows (subagents, import) fills them in
	// `shouldRun`, so the proof runs every gate before mounting or those lists
	// render empty.
	for (const candidate of SCENES) {
		await candidate.shouldRun?.(ctx);
	}
	const component = new SetupWizardComponent(ctx, SCENES);
	void component.run();

	if (phase === "scene") {
		// Enter leaves the splash; the dissolve into the scene runs for
		// SCENE_TRANSITION_MS before the overlay settles on the scene phase.
		component.handleInput("\r");
		await sleep(700);
		// `→` is the wizard's step-forward key, so this walks to the requested
		// scene the way a user reaches it, keeping the breadcrumb state honest.
		for (let step = 0; step < targetIndex; step++) {
			component.handleInput("\x1b[C");
			await sleep(500);
		}
	} else if (phase !== "splash") {
		throw new Error(`unknown phase "${phase}"; expected scene or splash`);
	}

	let frame = component.render(width);
	if (hoverText) {
		// The overlay is fullscreen, so a frame row index IS the screen row the
		// component hit-tests against, and the pointer can be aimed from the frame
		// the component itself just produced instead of a guessed coordinate.
		const row = frame.findIndex(line => stripVTControlCharacters(line).includes(hoverText));
		if (row < 0) throw new Error(`--hover text "${hoverText}" is not in the frame`);
		const col = stripVTControlCharacters(frame[row] ?? "").indexOf(hoverText);
		component.handleInput(`\x1b[<35;${col + 1};${row + 1}M`);
		frame = component.render(width);
	}
	component.dispose();
	process.stdout.write(`${frame.join("\n")}\n`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
