export const AGENT_DIR_ENV_KEYS: readonly string[] = ["VEYYON_CODING_AGENT_DIR"];

export const CONFIG_DIR_ENV_KEYS: readonly string[] = ["VEYYON_CONFIG_DIR"];

export const PROFILE_ENV_KEYS: readonly string[] = ["VEYYON_PROFILE"];

export const SANDBOX_MARKER_ENV_KEY = "VEYYON_TEST_SANDBOX";

export const XDG_BASE_ENV_KEYS: readonly string[] = [
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
];

export const DIR_OVERRIDE_ENV_KEYS: readonly string[] = [
	...AGENT_DIR_ENV_KEYS,
	...PROFILE_ENV_KEYS,
	...CONFIG_DIR_ENV_KEYS,
];

export const DIR_LOCATION_ENV_KEYS: readonly string[] = [
	...AGENT_DIR_ENV_KEYS,
	...CONFIG_DIR_ENV_KEYS,
	...XDG_BASE_ENV_KEYS,
];
