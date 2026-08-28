/** The tip a single launch is allowed to force into the welcome card, and the text of the one tip that uses it. */

import { APP_NAME } from "@veyyon/utils";

/** The tip this launch must show instead of a random one. The post-update notice used to be its own transcript block above the welcome card: a second piece of */
let forcedTip: string | undefined;

/** Make the next welcome render show `tip` in place of a random one. One-shot: {@link takeLaunchTip} clears it, so a second welcome in the same process (`/welcome`, a */
export function setLaunchTip(tip: string): void {
	forcedTip = tip;
}

/** The forced tip, if one is pending, clearing it on the way out. Read-and-clear is one operation on purpose: a caller that read without clearing would repeat the */
export function takeLaunchTip(): string | undefined {
	const tip = forcedTip;
	forcedTip = undefined;
	return tip;
}

/** Drop a pending forced tip. Exists so a test cannot leak one into the next. */
export function clearLaunchTip(): void {
	forcedTip = undefined;
}

/** The one-line hint shown on the first launch after an update. It has to carry three things and stay one line: WHAT happened (the version, so the number in a bug */
export function updateInstalledTip(version: string): string {
	return `Updated to ${APP_NAME} ${version} · /changelog · roll back or turn auto-update off in /settings`;
}
