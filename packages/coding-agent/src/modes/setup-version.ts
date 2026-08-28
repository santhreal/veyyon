import { readGlobalOnboardingVersionSafe, readLegacyProfileSetupVersion } from "@veyyon/utils/dirs";
import type { Settings } from "../config/settings";

export const CURRENT_SETUP_VERSION = 1;

export interface OnboardingGeneration {
	version: number;
	unreadable: boolean;
}

export function resolveOnboardingGeneration(settings: Settings): OnboardingGeneration {
	let unreadable = settings.quarantinedFiles.length > 0 || readGlobalOnboardingVersionSafe().unreadable;

	const machineWide = settings.get("onboardingVersion");
	if (machineWide > 0) return { version: machineWide, unreadable };

	const activeProfile = settings.get("setupVersion");

	const acrossProfiles = readLegacyProfileSetupVersion();
	if (acrossProfiles.unreadable) unreadable = true;

	const legacy = Math.max(activeProfile, acrossProfiles.version ?? 0);
	if (legacy > 0) {
		settings.set("onboardingVersion", legacy);
		return { version: legacy, unreadable };
	}

	return { version: 0, unreadable };
}
