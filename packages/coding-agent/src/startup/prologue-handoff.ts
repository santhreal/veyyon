/** The slot the startup prologue hands to `runRootCommand`. Deliberately a leaf: the only import is a type, so `main.ts` can read the */

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

/** The prologue this process already ran, once. Clears on read: a second `runRootCommand` in the same process builds its own */
export function takeStartupPrologue(): StartupPrologue | undefined {
	const prologue = shared;
	shared = undefined;
	return prologue;
}
