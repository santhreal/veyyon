/**
 * Argument reading shared by the proof-render scripts.
 *
 * The renderers under `scripts/demos/render-*.ts` exist to put a real component
 * on screen for a VHS capture, so they all take the same shape of argument: a
 * theme, a width, and a variant or two. Each one hand-rolled the same
 * `indexOf("--name")` lookup, and copies of an argument reader drift in exactly
 * the way that ruins a proof — one script defaulting to a different width than
 * another makes two captures incomparable, and nothing about the images says
 * why.
 */

/** The value after `--name`, or `fallback` when the flag is absent. */
export function flag(name: string, fallback: string, argv: readonly string[] = process.argv): string {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

/** Whether `--name` is present at all. */
export function hasFlag(name: string, argv: readonly string[] = process.argv): boolean {
	return argv.includes(`--${name}`);
}

/**
 * The capture width in columns.
 *
 * One default across every proof script, so two captures taken for the same
 * change are the same size and can be compared side by side.
 */
export function renderWidth(argv: readonly string[] = process.argv): number {
	return Number(flag("width", "100", argv));
}

/**
 * Bring up the theme (and settings, when the component needs them) for a capture.
 *
 * Order is the whole reason this exists. `Settings.init` applies the CONFIGURED
 * theme, so a script that initialised the theme first had it silently replaced
 * by whatever theme the capturing machine happens to use — and the resulting
 * image looks like a real render, just of the wrong theme. That is how a
 * "light-ground" settings capture came out in titanium and produced a defect
 * report for a near-black selection slab that the light theme does not have.
 *
 * Both slots get the same theme on purpose: the render must not depend on the
 * capturing terminal's background luminance, which is the variable the tapes
 * are deliberately changing.
 *
 * Pass `settings: true` for any component that reads `Settings`.
 */
export async function initRender(themeName: string, options: { settings?: boolean } = {}): Promise<void> {
	const { initTheme } = await import("../../packages/coding-agent/src/modes/theme/theme");
	if (options.settings) {
		const { Settings } = await import("../../packages/coding-agent/src/config/settings");
		await Settings.init({ inMemory: true });
	}
	await initTheme(false, "unicode", false, themeName, themeName);
}
