/**
 * Names of env vars redirecting veyyon file locations. Leaf module with no imports.
 * Shared by `dirs.ts` (path resolution) and `dotenv-home.ts` (early `$HOME/.env` filtering).
 * `VEYYON_PROFILE` selects the active profile and is excluded from `.env` loading to prevent cycles.
 */

/** Env key accepted for the agent-dir override. */
export const AGENT_DIR_ENV_KEYS: readonly string[] = ["VEYYON_CODING_AGENT_DIR"];

/** Env key accepted for the config-dir-name override. */
export const CONFIG_DIR_ENV_KEYS: readonly string[] = ["VEYYON_CONFIG_DIR"];

/** Env key that selects the active profile. Read from the real environment only; see the note above. */
export const PROFILE_ENV_KEYS: readonly string[] = ["VEYYON_PROFILE"];

/**
 * The marker the test sandbox guest sets, and the only thing that may authorise a config root
 * inside the operator's home.
 *
 * It belongs with the keys above rather than in the test helpers because both sides of the rule need
 * it and they live in different halves of the repository. `dirs.ts` reads it to decide whether a
 * `VEYYON_CONFIG_DIR` that resolves under `os.homedir()` is a disposable guest home or the operator's
 * real one, and `packages/utils/test/helpers/sandbox-gate.ts` reads it to refuse to run at all. A
 * second copy of the name is a gate that opens on one spelling and not the other.
 *
 * Unlike every key above it, this one does NOT redirect anything, so it is deliberately absent from
 * {@link DIR_OVERRIDE_ENV_KEYS} and {@link DIR_LOCATION_ENV_KEYS}: a test that strips directory
 * overrides from a child environment must not strip the child's proof that it is sandboxed, and a
 * `$HOME/.env` must never be able to grant it.
 */
export const SANDBOX_MARKER_ENV_KEY = "VEYYON_TEST_SANDBOX";

/**
 * XDG directories honoured on Linux. `XDG_CONFIG_HOME` sets shell completions only; data/state/cache move roots.
 */
export const XDG_BASE_ENV_KEYS: readonly string[] = [
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
];

/**
 * Every env key that redirects veyyon directory resolution (agent dir, profile, config-dir name).
 *
 * Tests spawning children that must resolve dirs from a controlled location (e.g. `XDG_*` pointing at a
 * temp root) strip these so overrides inherited from the developer/CI environment cannot leak in.
 */
export const DIR_OVERRIDE_ENV_KEYS: readonly string[] = [
	...AGENT_DIR_ENV_KEYS,
	...PROFILE_ENV_KEYS,
	...CONFIG_DIR_ENV_KEYS,
];

/**
 * Keys `dotenv-home.ts` may apply from `$HOME/.env` before path resolution (directory locations only).
 */
export const DIR_LOCATION_ENV_KEYS: readonly string[] = [
	...AGENT_DIR_ENV_KEYS,
	...CONFIG_DIR_ENV_KEYS,
	...XDG_BASE_ENV_KEYS,
];
