/**
 * Onboarding "generation" gate, keyed to the app's MAJOR semver.
 *
 * The setup/welcome wizard re-runs onboarding once per MAJOR release: a fresh
 * install onboards, and after that only a major version bump (1.x -> 2.0) shows
 * it again. Minor and patch updates never re-onboard. This is automated — the
 * value is derived from the shipped app version (`VERSION`), so a normal CI
 * version bump to a new major advances the gate with no code change. There is no
 * hand-maintained integer to forget.
 *
 * Kept dependency-free (only the `VERSION` string constant) so the cold-launch
 * gate in `main.ts` can answer "is the stored setup generation stale?" without
 * statically importing the full wizard — every scene plus the overlay component
 * and their TUI deps.
 */

import { VERSION } from "@veyyon/utils";

/**
 * The MAJOR component of a semver string, or 0 when it cannot be parsed. A
 * pre-1.0 build (`0.x`) reports major 0, the same as a never-onboarded install,
 * so 0.x users onboard once and are not re-onboarded within the 0.x line.
 */
export function setupMajorFromVersion(version: string): number {
	const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
	return Number.isFinite(major) && major >= 0 ? major : 0;
}

/** The current onboarding generation = the app's major version. */
export const CURRENT_SETUP_VERSION: number = setupMajorFromVersion(VERSION);
