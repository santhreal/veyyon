/** The launch card, painted before the runtime graph is loaded. `main.ts` imports the whole agent runtime at module scope — the SDK, the */

import { $env, getProjectDir, VERSION } from "@veyyon/utils";
import type { Args } from "../cli/args";
import { applySessionWorkdir, applyStartupCwd } from "../cli/startup-cwd";
import { Settings } from "../config/settings";
import { paintFirstFrame, shouldPaintFirstFrame } from "../modes/first-frame";
import { CURRENT_SETUP_VERSION, resolveOnboardingGeneration } from "../modes/setup-version";
import { initTheme } from "../modes/theme/theme";
import { shouldShowStartupSplash } from "../startup-splash";

import { type StartupPrologue, setStartupPrologue } from "./prologue-handoff";

/** True only for a bare interactive launch that lands on the home screen. Read from argv alone, before settings exist, because the whole point is to */
export function shouldPrepaintLaunchCard(parsed: Args): boolean {
	if (parsed.version || parsed.export !== undefined) return false;
	if (parsed.print || parsed.mode !== undefined) return false;
	return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
/** Settle cwd, settings and the theme, then paint the card. `applyStartupCwd` runs before `Settings.init` because settings discovery is */
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
		// `TUI.start` composes the frame and queues the write with `setImmediate` rather than writing it, so the card is NOT on screen when
		const flushed = Promise.withResolvers<void>();
		setImmediate(flushed.resolve);
		await flushed.promise;
	}

	const prologue: StartupPrologue = { settings, workdirApplied, showStartupSplash };
	setStartupPrologue(prologue);
	return prologue;
}
