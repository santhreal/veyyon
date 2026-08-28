/**
 * The slot the startup prologue hands to `runRootCommand`.
 *
 * Deliberately a leaf: the only import is a type, so `main.ts` can read the
 * handoff without pulling `startup/launch-card` and, through it, the 582-module
 * first-frame paint graph into its own static import graph. That matters
 * because the bundler chunks by graph -- when `main.ts` imported the painter
 * directly, `import("../startup/launch-card")` in `commands/launch.ts` dragged
 * part of the runtime chunk along with it and the card cost 310ms instead of
 * the 60ms the paint path costs on its own.
 *
 * Keep it that way. Anything with a runtime import belongs in `launch-card.ts`.
 */

import type { Settings } from "../config/settings";

/** What the prologue resolved, handed to `runRootCommand` so it repeats none of it. */
export interface StartupPrologue {
	readonly settings: Settings;
	readonly workdirApplied: boolean;
	readonly showStartupSplash: boolean;
}

let shared: StartupPrologue | undefined;

/** Record what the prologue settled, for the `runRootCommand` that follows it. */
export function setStartupPrologue(prologue: StartupPrologue): void {
	shared = prologue;
}

/**
 * The prologue this process already ran, once.
 *
 * Clears on read: a second `runRootCommand` in the same process builds its own
 * cwd, settings and screen rather than inheriting a handoff that is no longer
 * true of the terminal.
 */
export function takeStartupPrologue(): StartupPrologue | undefined {
	const prologue = shared;
	shared = undefined;
	return prologue;
}
