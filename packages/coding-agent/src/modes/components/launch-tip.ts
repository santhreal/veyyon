/**
 * The tip a single launch is allowed to force into the welcome card, and the text of the one tip that
 * uses it.
 *
 * WHY THIS IS ITS OWN MODULE. The state and the message live next to the component that renders them, in
 * `welcome.ts`, which is the natural home right up to the point where `main.ts` needs to SET the tip
 * after an update. `main.ts` runs before any mode is chosen, so importing `welcome.ts` for two functions
 * put a `modes/components` module -- and with it `@veyyon/tui`, the theme, the shimmer machinery and the
 * sun mark -- into the static boot graph of every launch, including `-p`, `--rpc` and ACP runs that never
 * render a welcome card. Nothing here needs any of that: the forced tip is one `string | undefined` and
 * the message is one template.
 *
 * The state stays a module-level binding rather than becoming a parameter because both ends are already
 * process-global and far apart -- `main.ts` writes it during startup, `WelcomeComponent.tip` reads it on
 * the first render, and nothing in between has a reason to carry it. Keeping ONE owner is what matters:
 * `welcome.ts` reads the tip through {@link takeLaunchTip} instead of holding a second copy.
 */

import { APP_NAME } from "@veyyon/utils";

/**
 * The tip this launch must show instead of a random one.
 *
 * The post-update notice used to be its own transcript block above the welcome card: a second piece of
 * chrome saying a small thing, in a place reserved for conversation. It is a tip in every respect -- one
 * line, once, about something you can do next -- so it belongs in the slot that already exists for
 * exactly that, and the card stays one card.
 *
 * "Forced" rather than "added to the corpus" because the launch after an update is the ONLY launch where
 * this is worth the slot. A weighted entry would show it at random for weeks and miss the launch it was
 * written for.
 */
let forcedTip: string | undefined;

/**
 * Make the next welcome render show `tip` in place of a random one.
 *
 * One-shot: {@link takeLaunchTip} clears it, so a second welcome in the same process (`/welcome`, a
 * resumed session) gets the ordinary rotation rather than repeating a stale announcement.
 */
export function setLaunchTip(tip: string): void {
	forcedTip = tip;
}

/**
 * The forced tip, if one is pending, clearing it on the way out.
 *
 * Read-and-clear is one operation on purpose: a caller that read without clearing would repeat the
 * announcement on every welcome the process renders afterwards, which is the bug the one-shot rule exists
 * to prevent.
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
 * The one-line hint shown on the first launch after an update.
 *
 * It has to carry three things and stay one line: WHAT happened (the version, so the number in a bug
 * report is the one you are running), WHERE the notes are, and -- the part that was missing entirely --
 * that this is CONTROLLABLE. Auto-update has been switchable in `/settings` all along and nothing ever
 * said so, which is why updates felt like something done to you.
 */
export function updateInstalledTip(version: string): string {
	return `Updated to ${APP_NAME} ${version} · /changelog · roll back or turn auto-update off in /settings`;
}
