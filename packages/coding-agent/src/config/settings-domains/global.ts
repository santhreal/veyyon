/**
 * Global domain slice of SETTINGS_SCHEMA — cross-profile settings stored in
 * `~/.veyyon/config.yml`, composed in ../settings-schema.ts and surfaced under
 * the "Global" tab.
 *
 * Unlike every other domain, these values are NOT persisted in the active
 * profile's `agent/config.yml`. Each key here has a matching entry in
 * {@link GLOBAL_SETTING_BINDINGS}; the Settings singleton routes get/set for a
 * `scope: "global"` path through that binding (which delegates to the canonical
 * `@veyyon/utils` global-config readers/writers) instead of the profile store.
 * That keeps exactly one owner for each value — the global config file — so the
 * settings UI and the CLI can never disagree.
 */

import {
	DEFAULT_PROFILE_DIR_NAME,
	readGlobalDefaultProfileSafe,
	readGlobalProfileSharingSafe,
	writeGlobalDefaultProfile,
	writeGlobalProfileSharing,
} from "@veyyon/utils";

export const GLOBAL_SETTINGS = {
	defaultProfile: {
		type: "string",
		default: DEFAULT_PROFILE_DIR_NAME,
		ui: {
			tab: "global",
			scope: "global",
			group: "Profiles",
			label: "Default Profile",
			description:
				"Profile used when no --profile flag or VEYYON_PROFILE is set. Stored in ~/.veyyon/config.yml. Use the profile name (`default` clears the override).",
		},
	},

	profileSharing: {
		type: "boolean",
		default: true,
		ui: {
			tab: "global",
			scope: "global",
			group: "Credentials",
			label: "Share Credentials Across Profiles",
			description:
				"When on (the default), every profile reads one machine-wide set of provider logins. Turn off to give each profile its own private credential store.",
		},
	},
} as const;

/** Read/write handlers for a `scope: "global"` setting path. */
export interface GlobalSettingBinding {
	read(): unknown;
	/** Persist a new value. May throw on invalid input; the caller surfaces the error. */
	write(value: unknown): void;
}

/**
 * Maps each global-scoped setting path to the canonical `@veyyon/utils`
 * reader/writer for that value. The Settings singleton consults this instead of
 * the profile store for these paths, so there is one source of truth per value.
 * Keyed by string (not SettingPath) to avoid a type cycle with SETTINGS_SCHEMA.
 */
export const GLOBAL_SETTING_BINDINGS: Record<string, GlobalSettingBinding> = {
	defaultProfile: {
		read: () => readGlobalDefaultProfileSafe() ?? DEFAULT_PROFILE_DIR_NAME,
		write: value => {
			// An empty string or the default profile name clears the override.
			const name = typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
			writeGlobalDefaultProfile(name);
		},
	},
	profileSharing: {
		read: () => readGlobalProfileSharingSafe(),
		write: value => {
			writeGlobalProfileSharing(value !== false);
		},
	},
};
