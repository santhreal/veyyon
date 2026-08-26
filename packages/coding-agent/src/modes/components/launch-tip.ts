/**
 * The tip a single launch is allowed to force into the welcome card. Separate module because `main.ts`
 * needs to SET the tip before any mode is chosen; importing `welcome.ts` would drag `@veyyon/tui`, the
 * theme, and shimmer into every launch's boot graph. The state is module-level: `main.ts` writes it,
 * `WelcomeComponent.tip` reads it, one owner.
 */

import { APP_NAME } from "@veyyon/utils";

/**
 * The tip this launch must show instead of a random one. Forced rather than corpus-added because the
 * launch after an update is the ONLY launch where this is worth the slot.
 */
let forcedTip: string | undefined;

/**
 * Make the next welcome render show `tip` in place of a random one.
 */
export function setLaunchTip(tip: string): void {
	forcedTip = tip;
}

/**
 * The forced tip, if pending, clearing it on the way out. Read-and-clear is one operation: reading
 * without clearing would repeat the announcement on every welcome render.
 */
export function takeLaunchTip(): string | undefined {
	const tip = forcedTip;
	forcedTip = undefined;
	return tip;
}

/** Drop a pending forced tip. Exists so a test cannot leak one into the next. */
export function clearLaunchTip(): void {
	forcedTip = undefined;
}

/**
 * The one-line hint shown on the first launch after an update. Carries WHAT (version), WHERE
 * (`/changelog`), and that auto-update is CONTROLLABLE in `/settings`.
 */
export function updateInstalledTip(version: string): string {
	return `Updated to ${APP_NAME} ${version} · /changelog · roll back or turn auto-update off in /settings`;
}
