/**
 * The names of every environment variable that redirects where veyyon keeps its files. A leaf: no imports.
 *
 * WHY THE NAMES LIVE APART FROM THE RESOLVER THAT READS THEM. Two modules need this list and one of them
 * runs before the other exists. `dirs.ts` reads the variables to resolve its paths; `dotenv-home.ts` needs
 * to know which keys out of a user's `$HOME/.env` are allowed to be applied BEFORE `dirs.ts` loads, because
 * those are the ones that decide what its paths are. `dirs.ts` imports `dotenv-home.ts`, so the list cannot
 * live in `dirs.ts` without a cycle, and it must not be written down twice: a key present in one copy and
 * missing from the other is a `.env` line that works for the resolver and not for the loader, or the
 * reverse.
 *
 * WHY THE PROFILE KEY IS IN ITS OWN GROUP AND OUT OF {@link DIR_LOCATION_ENV_KEYS}. `VEYYON_PROFILE`
 * selects WHICH profile is active, which is a different kind of decision from where a profile's files sit,
 * and it is deliberately NOT honoured from a `.env`. Two reasons, and the first is enough on its own: the
 * profile decides where `<configRoot>/.env` and `<agentDir>/.env` ARE, so letting one of those files (or a
 * home file read in the same phase) choose the profile is circular. The second is that this was already the
 * behaviour -- `refreshDirsFromEnv()` rebuilds the resolver with the profile it already had -- so a `.env`
 * that set `VEYYON_PROFILE` never switched profiles, and starting to honour it would silently move a user's
 * whole tree. The profile comes from the real environment or the CLI.
 */

/** Env key accepted for the agent-dir override. */
export const AGENT_DIR_ENV_KEYS: readonly string[] = ["VEYYON_CODING_AGENT_DIR"];

/** Env key accepted for the config-dir-name override. */
export const CONFIG_DIR_ENV_KEYS: readonly string[] = ["VEYYON_CONFIG_DIR"];

/** Env key that selects the active profile. Read from the real environment only; see the note above. */
export const PROFILE_ENV_KEYS: readonly string[] = ["VEYYON_PROFILE"];

/**
 * The XDG base directories veyyon honours on Linux, which move the config, data, state and cache roots.
 *
 * `XDG_CONFIG_HOME` is included even though the resolver reads it through a different path than the other
 * three: all four decide where files go, which is the only property this list is about.
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
 * The keys `dotenv-home.ts` may apply from `$HOME/.env` before the resolver loads: everything that decides
 * WHERE a directory is, and nothing else.
 *
 * This is an allow-list rather than a block-list on purpose. Phase one runs before almost anything, and
 * whatever it puts into `Bun.env` is inherited by every subprocess veyyon spawns, including the sandboxed
 * evaluator. A user's `.env` holds API keys, so applying all of it that early would hand credentials to
 * processes that have no business with them -- `packages/coding-agent/src/eval/js/process-entry.ts` takes a
 * subpath import specifically to avoid that, and its test pins it. The rest of the file is applied by
 * `env.ts`, which is what a program imports when it wants the environment.
 */
export const DIR_LOCATION_ENV_KEYS: readonly string[] = [
	...AGENT_DIR_ENV_KEYS,
	...CONFIG_DIR_ENV_KEYS,
	...XDG_BASE_ENV_KEYS,
];
