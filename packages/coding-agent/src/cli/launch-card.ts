/**
 * The launch card, painted before the runtime graph is loaded.
 *
 * `main.ts` imports the whole agent runtime at module scope — the SDK, the
 * model registry, the builtin slash commands, the system-prompt loader, the
 * subagent reviver. Evaluating that graph costs ~0.7s in the compiled binary,
 * and until this module existed `commands/launch.ts` awaited `import("../main")`
 * before anything reached the terminal, so the operator watched a blank screen
 * for the whole of it and the card arrived at ~760ms.
 *
 * Nothing the card draws needs any of that. The sun, the wordmark, the version
 * and the resting composer need settings and a theme, and both are cheap:
 * measured on a compiled binary that imports only this path, `Settings.init` is
 * 4ms, `initTheme` is 1ms and `paintFirstFrame` is 8ms, for a card on screen
 * 60ms after exec. Keystrokes are live from that moment — `paintFirstFrame`
 * installs the typeahead gate that buffers, echoes and later replays them into
 * the mounted composer.
 *
 * So the prologue runs here, ahead of the runtime import, and it ends AT the
 * paint rather than just before it. An earlier attempt moved settings, cwd and
 * stdin ahead of the runtime import but left `paintFirstFrame` behind it; the
 * card still waited for the runtime graph and the change measured as a wash.
 * The paint is the thing that has to move.
 *
 * `main.ts` does not repeat this work: it adopts the handoff through
 * {@link takeStartupPrologue}. The handoff is single-use rather than a cache,
 * because a second in-process `runRootCommand` (a test harness, a relaunch)
 * must not inherit the first caller's settings, theme and painted screen.
 */

import { $env, getProjectDir, VERSION } from "@veyyon/utils";
import { Settings } from "../config/settings";
import { CURRENT_SETUP_VERSION, resolveOnboardingGeneration } from "../modes/setup-version";
import { paintFirstFrame, shouldPaintFirstFrame } from "../modes/terminal/first-frame";
import { shouldShowStartupSplash } from "../startup-splash";
import { initTheme } from "../theme/theme";
import type { Args } from "./args";
import { type StartupPrologue, setStartupPrologue } from "./prologue-handoff";
import { applySessionWorkdir, applyStartupCwd } from "./startup-cwd";

/**
 * True only for a bare interactive launch that lands on the home screen.
 *
 * Read from argv alone, before settings exist, because the whole point is to
 * decide without loading anything. A run that exits early (`--version`,
 * `--export`), prints (`--print`, a piped prompt) or speaks a protocol never
 * paints a card, and must not pay for settings or a theme here. Piped stdin
 * needs no separate test: `autoPrint` requires input on stdin, and stdin is a
 * TTY on this path.
 */
export function shouldPrepaintLaunchCard(parsed: Args): boolean {
	if (parsed.version || parsed.export !== undefined) return false;
	if (parsed.print || parsed.mode !== undefined) return false;
	return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
/**
 * Settle cwd, settings and the theme, then paint the card.
 *
 * `applyStartupCwd` runs before `Settings.init` because settings discovery is
 * cwd-relative, and `applySessionWorkdir` runs after it because the profile
 * layer it reads only exists once settings are loaded. That is the same order
 * `runRootCommand` used; it moved here whole rather than being split.
 */
export async function runStartupPrologue(parsed: Args, forceSetupWizard = false): Promise<StartupPrologue> {
	// Defaults only: CLI symbols need a theme before settings are readable.
	await initTheme();
	await applyStartupCwd(parsed);

	const settings = await Settings.init({ cwd: getProjectDir(), configFiles: parsed.config });
	const workdirApplied = await applySessionWorkdir(settings, parsed.cwd);

	await initTheme(
		true,
		settings.get("symbolPreset"),
		settings.get("colorBlindMode"),
		settings.get("theme.dark"),
		settings.get("theme.light"),
	);

	const resuming = Boolean(parsed.continue || parsed.resume || parsed.fork);
	const showStartupSplash = shouldShowStartupSplash({
		configured: settings.get("startup.showSplash"),
		isInteractive: true,
		resuming,
		quiet: settings.get("startup.quiet"),
		timing: Boolean($env.VEYYON_TIMING),
		stdinIsTTY: process.stdin.isTTY,
		stdoutIsTTY: process.stdout.isTTY,
	});

	const onboarding = resolveOnboardingGeneration(settings);
	const paint = shouldPaintFirstFrame({
		isInteractive: true,
		protocolMode: false,
		quiet: settings.get("startup.quiet"),
		splash: showStartupSplash,
		setupWizard: forceSetupWizard || (!onboarding.unreadable && onboarding.version < CURRENT_SETUP_VERSION),
		stdinIsTTY: process.stdin.isTTY,
		stdoutIsTTY: process.stdout.isTTY,
		resuming,
	});
	if (paint) {
		paintFirstFrame(VERSION);
		// `TUI.start` composes the frame and queues the write with `setImmediate`
		// rather than writing it, so the card is NOT on screen when
		// `paintFirstFrame` returns. The caller's very next statement is
		// `import("../main")`, whose module evaluation holds the loop for about
		// 200ms; without this yield the composed frame waits behind it and the
		// card lands at ~310ms having been ready at ~115ms. One turn suffices:
		// the render was queued first and the check phase is FIFO.
		const flushed = Promise.withResolvers<void>();
		setImmediate(flushed.resolve);
		await flushed.promise;
	}

	const prologue: StartupPrologue = { settings, workdirApplied, showStartupSplash };
	setStartupPrologue(prologue);
	return prologue;
}
