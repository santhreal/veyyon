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
 * settings UI and the CLI can never disagree. A key here need not be a knob:
 * `onboardingVersion` is machine-wide state the app writes, and it gets the same
 * one-owner guarantee while staying out of the panel. It stays out because its `ui`
 * block says `hidden: true`, not because it is a number without options: that used to
 * hide it as a side effect of the UI adapter dropping optionless numbers, and those
 * render now.
 *
 * MACHINE LIMITS. The `machine.*` rows are the first group on the tab. They cap
 * what every veyyon process on this machine may consume TOGETHER — every
 * session, every profile, every concurrently running veyyon — and they are here
 * rather than beside their per-session counterparts on Resources because the
 * scope is the thing that differs: Resources writes the active profile, these
 * write ~/.veyyon/config.yml. Held per profile a machine limit would be a limit
 * each copy applied to itself, and the machine would get the sum. The Resources
 * tab opens with a row pointing here, and settings search spans tabs.
 */

// Owners, not the `@veyyon/utils` barrel: 1 module against 74.
import {
	DEFAULT_PROFILE_DIR_NAME,
	GLOBAL_RESOURCE_LIMITS,
	readGlobalAuthBrokerSafe,
	readGlobalDefaultProfileSafe,
	readGlobalOnboardingVersionSafe,
	readGlobalProfileSharingSafe,
	readGlobalResourceLimitSafe,
	writeGlobalAuthBrokerToken,
	writeGlobalAuthBrokerUrl,
	writeGlobalDefaultProfile,
	writeGlobalOnboardingVersion,
	writeGlobalProfileSharing,
	writeGlobalResourceLimit,
} from "@veyyon/utils/dirs";

/**
 * What the settings UI shows for a stored auth-broker token. The plaintext is
 * NEVER read back into any UI model ("never log secrets"); saving this exact
 * mask leaves the stored token untouched, so an operator can open and close
 * the field without destroying the secret.
 */
export const AUTH_BROKER_TOKEN_MASK = "********";

export const GLOBAL_SETTINGS = {
	"machine.cpuLimitCores": {
		type: "number",
		default: 0,
		ui: {
			tab: "global",
			scope: "global",
			group: "Machine Limits",
			label: "Machine CPU Limit",
			description:
				"Maximum CPU every veyyon process on this machine may use TOGETHER, in cores (0 = no limit). Stored in ~/.veyyon/config.yml rather than in a profile, so it covers every profile and every veyyon running at once, which is what makes it a machine limit: held per profile, two profiles would read their own copy and the machine would get the sum. Each session's budget group is created INSIDE this one, so on Linux the kernel caps the whole subtree and no combination of sessions can exceed it. A per-session limit larger than this one is bounded by it and does not raise it. The machine tier therefore needs a parent that delegates two levels; a host that delegates one, such as a container whose cgroup root holds processes, still holds per-session limits and reports the machine tier as unheld. Where the kernel cannot hold it, a notice says so once at startup rather than reporting a cap that does not exist.",
			keywords: ["cpu", "global", "machine", "limit", "quota", "cgroup", "cores", "budget", "all"],
			options: [
				{ value: "0", label: "Off", description: "Default" },
				{ value: "1", label: "1 core" },
				{ value: "2", label: "2 cores" },
				{ value: "4", label: "4 cores" },
				{ value: "8", label: "8 cores" },
				{ value: "16", label: "16 cores" },
				{ value: "32", label: "32 cores" },
			],
		},
	},

	"machine.memoryLimitGb": {
		type: "number",
		default: 0,
		ui: {
			tab: "global",
			scope: "global",
			group: "Machine Limits",
			label: "Machine Memory Limit",
			description:
				"Maximum memory every veyyon process on this machine may hold together, in gigabytes (0 = no limit). Stored in ~/.veyyon/config.yml, so it spans profiles and concurrent veyyon instances. Every session budget group sits inside this one, so on Linux this is cgroup v2 memory.max on the parent, with memory.swap.max pinned to 0 so the cap is the whole anonymous footprint rather than a resident cap a process escapes by swapping. The kernel reclaims, then OOM-kills, inside the subtree once the total is reached — whichever process the kernel picks, with no warning and no chance to finish. Set it where an OOM kill is preferable to the machine swapping. Where no memory controller is delegated the cap cannot be held, and a notice says so once at startup.",
			keywords: ["memory", "ram", "global", "machine", "limit", "oom", "cgroup", "gb", "all"],
			options: [
				{ value: "0", label: "Off", description: "Default" },
				{ value: "2", label: "2 GB" },
				{ value: "4", label: "4 GB" },
				{ value: "8", label: "8 GB" },
				{ value: "16", label: "16 GB" },
				{ value: "32", label: "32 GB" },
				{ value: "64", label: "64 GB" },
				{ value: "128", label: "128 GB" },
			],
		},
	},

	"machine.writeBudgetGb": {
		type: "number",
		default: 0,
		ui: {
			tab: "global",
			scope: "global",
			group: "Machine Limits",
			label: "Machine Write Budget",
			description:
				"Cumulative gigabytes every veyyon process on this machine may WRITE before further writes are refused (0 = no limit). Stored in ~/.veyyon/config.yml, so it spans profiles and concurrent veyyon instances. Unlike CPU and memory this is a total that accumulates, not a level: it counts bytes written since the machine budget was last reset, across every session, and refuses new commands and harness writes once the total is reached. A write budget is the one limit no kernel enforces on its own — cgroup io accounting MEASURES bytes and caps rate, not a lifetime total — so this is a refusal, and work already writing runs to completion.",
			keywords: ["disk", "write", "global", "machine", "budget", "gb", "io", "quota", "all"],
			options: [
				{ value: "0", label: "Off", description: "Default" },
				{ value: "5", label: "5 GB" },
				{ value: "10", label: "10 GB" },
				{ value: "25", label: "25 GB" },
				{ value: "50", label: "50 GB" },
				{ value: "100", label: "100 GB" },
				{ value: "250", label: "250 GB" },
			],
		},
	},

	"machine.maxProcesses": {
		type: "number",
		default: 0,
		ui: {
			tab: "global",
			scope: "global",
			group: "Machine Limits",
			label: "Machine Max Processes",
			description:
				"Hard cap on how many processes every veyyon on this machine may have alive at once (0 = no limit). Stored in ~/.veyyon/config.yml, so it spans profiles and concurrent veyyon instances. Every session budget group sits inside this one, so on Linux this is cgroup v2 pids.max on the parent and the kernel refuses the fork itself once the subtree is full, whichever session asked. Where pids is not delegated the cap is a refusal at the spawn path instead, and a notice says so once at startup.",
			keywords: ["processes", "pids", "fork", "global", "machine", "limit", "cap", "bomb", "all"],
			options: [
				{ value: "0", label: "Off", description: "Default" },
				{ value: "64", label: "64 processes" },
				{ value: "128", label: "128 processes" },
				{ value: "256", label: "256 processes" },
				{ value: "512", label: "512 processes" },
				{ value: "1024", label: "1024 processes" },
				{ value: "2048", label: "2048 processes" },
			],
		},
	},

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
				"When on (the default), every profile reads one machine-wide set of provider logins. Turn off to give each profile its own private credential store. Changing this setting shuts down the active session; restart is required before any further model dispatch.",
		},
	},

	// A number with no `options` has no UI representation by design (see
	// UiNumber), so this carries the global scope and stays out of the panel: it
	// is written by the setup wizard, not chosen. It lives here rather than in
	// the profile store because a human onboards once per MACHINE. Held per
	// profile, `--profile <name>` read the schema default and re-ran onboarding
	// for a user who had long since finished it.
	onboardingVersion: {
		type: "number",
		default: 0,
		ui: {
			tab: "global",
			scope: "global",
			group: "Profiles",
			// Not a knob. This is what the app writes when setup finishes, and an operator
			// editing it would either skip onboarding or re-run it. It kept itself out of
			// the panel by being an optionless number, which the UI adapter used to drop;
			// now that such a number renders as a text box, the intent has to be stated.
			// The label and description stay so the generated reference still explains the
			// key someone finds in ~/.veyyon/config.yml.
			hidden: true,
			label: "Onboarding Version",
			description:
				"Setup generation this machine has already completed. Stored in ~/.veyyon/config.yml, so switching profile or working directory never re-runs onboarding.",
		},
	},

	authBrokerUrl: {
		type: "string",
		default: "",
		ui: {
			tab: "global",
			scope: "global",
			group: "Auth Broker",
			label: "Auth Broker URL",
			description:
				"Base URL of the auth broker that mints provider credentials for this machine. Stored in ~/.veyyon/config.yml under auth.broker.url; empty disables broker discovery via config.",
		},
	},

	authBrokerToken: {
		type: "string",
		default: "",
		ui: {
			tab: "global",
			scope: "global",
			group: "Auth Broker",
			label: "Auth Broker Token",
			description:
				"Bearer token for the auth broker. Write-only: a stored token shows as a mask and is never echoed. Enter a new value to replace it, leave the mask to keep it, or clear the field to delete it.",
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
 *
 * A global-scoped setting need not be declared in this file: what makes a path
 * global is `scope: "global"` plus an entry here, not which domain file it was
 * written in. Every one of them is declared here today.
 */
export const GLOBAL_SETTING_BINDINGS: Record<string, GlobalSettingBinding> = {
	// Derived from the limit list rather than written out four times: a new
	// resource adds one entry there and is bound here without another edit.
	...Object.fromEntries(
		GLOBAL_RESOURCE_LIMITS.map((limit): [string, GlobalSettingBinding] => [
			`machine.${limit}`,
			{
				read: () => readGlobalResourceLimitSafe(limit),
				write: value => {
					const parsed = typeof value === "number" ? value : Number(value);
					if (!Number.isFinite(parsed) || parsed < 0) {
						throw new Error(`machine.${limit} must be a non-negative number of units, or 0 for no limit.`);
					}
					writeGlobalResourceLimit(limit, parsed);
				},
			},
		]),
	),
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
	authBrokerUrl: {
		read: () => readGlobalAuthBrokerSafe().url ?? "",
		write: value => {
			writeGlobalAuthBrokerUrl(typeof value === "string" ? value : undefined);
		},
	},
	onboardingVersion: {
		// Absent and unreadable both read as 0 here, because a settings VALUE has
		// no way to say "unknown". The onboarding gate does not use this read to
		// decide: it calls readGlobalOnboardingVersionSafe directly for the
		// `unreadable` flag, so a corrupt global config skips onboarding instead of
		// looking like a fresh install. This read exists so `veyyon config get` and
		// the settings layer report the same value the gate acts on.
		read: () => readGlobalOnboardingVersionSafe().version ?? 0,
		write: value => {
			writeGlobalOnboardingVersion(typeof value === "number" && Number.isFinite(value) ? value : undefined);
		},
	},
	authBrokerToken: {
		// Presence only — the plaintext never reaches a UI model.
		read: () => (readGlobalAuthBrokerSafe().tokenSet ? AUTH_BROKER_TOKEN_MASK : ""),
		write: value => {
			const text = typeof value === "string" ? value.trim() : "";
			// Saving the untouched mask must keep the stored secret, or merely
			// opening the field would destroy the token.
			if (text === AUTH_BROKER_TOKEN_MASK) return;
			writeGlobalAuthBrokerToken(text.length > 0 ? text : undefined);
		},
	},
};
