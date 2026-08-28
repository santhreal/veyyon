/** Onboarding "generation" gate. Onboarding runs on the FIRST install and never again. Every update — patch, */

import { readGlobalOnboardingVersionSafe, readLegacyProfileSetupVersion } from "@veyyon/utils/dirs";
import type { Settings } from "../config/settings";

/** The current onboarding generation. Fixed, not version-derived: a fresh install (stored 0) is below it and onboards once; every onboarded user is at or above */
export const CURRENT_SETUP_VERSION = 1;

/** Where a machine stands with onboarding, and whether that answer is trustworthy. */
export interface OnboardingGeneration {
	/** Setup generation already completed on this machine. 0 means never onboarded. */
	version: number;
	/** True when a config file this answer depends on exists but could not be read or parsed, so `version` is a fallback rather than an observation. */
	unreadable: boolean;
}

/** Resolve the onboarding generation, migrating the legacy per-profile value on the way. */
export function resolveOnboardingGeneration(settings: Settings): OnboardingGeneration {
	// Either file can hide the answer: the profile store is quarantined on a parse
	// failure, and the global config throws out of its own reader. Both mean "we do
	// not know", which is not the same as "new machine".
	let unreadable = settings.quarantinedFiles.length > 0 || readGlobalOnboardingVersionSafe().unreadable;

	const machineWide = settings.get("onboardingVersion");
	if (machineWide > 0) return { version: machineWide, unreadable };

	// The ACTIVE profile's retired value, already merged into this instance. Kept as one input among several because it is the one the cross-profile scan
	const activeProfile = settings.get("setupVersion");

	// ...and every other profile on the machine. The highest wins, so the result is the same whichever profile is active. A profile whose file exists but cannot
	const acrossProfiles = readLegacyProfileSetupVersion();
	if (acrossProfiles.unreadable) unreadable = true;

	const legacy = Math.max(activeProfile, acrossProfiles.version ?? 0);
	if (legacy > 0) {
		settings.set("onboardingVersion", legacy);
		return { version: legacy, unreadable };
	}

	return { version: 0, unreadable };
}
