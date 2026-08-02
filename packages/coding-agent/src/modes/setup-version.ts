/**
 * Onboarding "generation" gate.
 *
 * Onboarding runs on the FIRST install and never again. Every update — patch,
 * minor, OR major — leaves an already-onboarded user untouched: their stored
 * setup generation already matches the current one, so `selectSetupScenes`
 * returns nothing and the wizard never re-fires. This is a deliberate product
 * rule: updating veyyon must never drop you back into the setup wizard, the same
 * way a macOS update never re-runs its setup assistant.
 *
 * The gate is a single FIXED integer, intentionally NOT derived from the app
 * version. A returning user's stored `setupVersion` (written when they first
 * onboarded) is >= this value, so the gate skips them forever; a fresh install
 * starts at the default 0, which is below it, so onboarding runs once and then
 * persists the current generation.
 *
 * When a future release genuinely needs an EXISTING user to see one new setup
 * step, do NOT bump this integer — that re-onboards the entire base in full.
 * Instead give that single scene a `shouldRun` guard that detects the missing
 * configuration, so only the users who lack it see only that one step. This
 * constant moves only for a deliberate, wholesale re-onboard of every existing
 * user, which should be vanishingly rare.
 *
 * Kept light so the cold-launch gate in `main.ts` can answer "is the stored setup
 * generation stale?" without statically importing the full wizard — every scene
 * plus the overlay component and their TUI deps. The only runtime dependency is
 * the global-config reader, which `main.ts` already pulls in.
 */

import { readGlobalOnboardingVersionSafe } from "@veyyon/utils/dirs";
import type { Settings } from "../config/settings";

/**
 * The current onboarding generation. Fixed, not version-derived: a fresh install
 * (stored 0) is below it and onboards once; every onboarded user is at or above
 * it and is never re-onboarded by any update. Bump ONLY to force a full
 * re-onboard of every existing user (avoid — prefer a per-scene `shouldRun`).
 */
export const CURRENT_SETUP_VERSION = 1;

/** Where a machine stands with onboarding, and whether that answer is trustworthy. */
export interface OnboardingGeneration {
	/** Setup generation already completed on this machine. 0 means never onboarded. */
	version: number;
	/**
	 * True when a config file this answer depends on exists but could not be read
	 * or parsed, so `version` is a fallback rather than an observation.
	 *
	 * A caller MUST NOT onboard in this case. The schema default is 0, which is
	 * byte-identical to a genuine fresh install, so a settings file that failed to
	 * parse used to hand the gate a confident "this user is new" and run the whole
	 * wizard against a machine that had been set up for months.
	 */
	unreadable: boolean;
}

/**
 * Resolve the onboarding generation, migrating the legacy per-profile value on
 * the way.
 *
 * Reads the machine-wide `onboardingVersion` first. When that is unset it falls
 * back to the retired per-profile `setupVersion`, and if THAT says the user has
 * onboarded it promotes the value into the global store immediately, so the
 * fallback is consulted once per machine and never again. Without the promotion
 * the relocation from profile scope to global scope would re-onboard every
 * existing user exactly once, since they all hold a completed profile value and
 * an empty global one.
 *
 * Absent in BOTH is the only genuine first install.
 */
export function resolveOnboardingGeneration(settings: Settings): OnboardingGeneration {
	// Either file can hide the answer: the profile store is quarantined on a parse
	// failure, and the global config throws out of its own reader. Both mean "we do
	// not know", which is not the same as "new machine".
	const unreadable = settings.quarantinedFiles.length > 0 || readGlobalOnboardingVersionSafe().unreadable;

	const machineWide = settings.get("onboardingVersion");
	if (machineWide > 0) return { version: machineWide, unreadable };

	const perProfile = settings.get("setupVersion");
	if (perProfile > 0) {
		settings.set("onboardingVersion", perProfile);
		return { version: perProfile, unreadable };
	}

	return { version: 0, unreadable };
}
