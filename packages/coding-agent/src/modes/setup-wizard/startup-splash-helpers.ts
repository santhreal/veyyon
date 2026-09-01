import type { InteractiveModeContext } from "../types";

/** The splash draws into the root UI and reads nothing else, so it asks for that one member instead of the 215-member `InteractiveModeContext`. See */
export type StartupSplashContext = Pick<InteractiveModeContext, "ui">;

export interface RunStartupSplashOptions {
	readonly durationMs?: number;
	readonly tickMs?: number;
	readonly now?: () => number;
}
