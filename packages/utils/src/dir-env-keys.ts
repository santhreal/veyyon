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
 * The XDG base directories veyyon honours on Linux, grouped because a user who relocates one of them
 * usually writes all four into the same `$HOME/.env`.
 *
 * Only three of them move a veyyon root. `dirs.ts` reads `XDG_DATA_HOME`, `XDG_STATE_HOME` and
 * `XDG_CACHE_HOME`, and redirects the data, state and cache categories under `$XDG_*_HOME/veyyon` once
 * that directory exists. `XDG_CONFIG_HOME` is NOT read by the resolver and does not move the config root:
 * the config root is always `$HOME/<VEYYON_CONFIG_DIR or .veyyon>`. That is deliberate, not an omission.
 * The variable is set on most Linux desktops, so honouring it would relocate the profiles, the
 * credentials, the onboarding record and the auth-broker token of every existing user at once, and veyyon
 * would come up looking like a fresh install.
 *
 * It is listed anyway because it still decides where veyyon puts files, which is the only property this
 * list is about: the profile alias and the shell completions veyyon installs go under
 * `$XDG_CONFIG_HOME/fish` when it is set (`packages/coding-agent/src/cli/profile-alias.ts` and
 * `.../cli/completion-refresh.ts`). Dropping it would leave one directory-location key in a user's
 * `$HOME/.env` arriving later than its three siblings, for no gain.
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
