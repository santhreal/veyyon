/**
 * The module-global state the leak tracer watches, beyond the environment.
 *
 * Kept apart from `global-state-leak-tracer.ts` on purpose: that module is
 * imported by `scripts/find-test-leaks.ts` outside a test runner, and it must not
 * drag `dirs.ts` (or anything else being probed) into that process.
 *
 * Only `@veyyon/utils` is probed here. The resolver is where the state that
 * silently changes every later file's paths actually lives, and importing a
 * heavier package into every traced process would risk the diagnostic itself
 * initialising state it is supposed to be observing.
 */
import { __preProfileAgentDirForTests, getActiveProfile, getAgentDir, getProjectDir } from "../../src/dirs";
import { registerLeakProbe } from "./global-state-leak-tracer";

/**
 * `setProfile("work")` with no restore leaves every later file resolving under
 * `profiles/work/`, and putting the environment back does NOT undo it: the active
 * profile is module state, which is why `enterIsolatedConfigRoot`'s restore
 * re-derives it rather than only refreshing paths.
 */
registerLeakProbe("activeProfile", () => getActiveProfile() ?? "(default)");

/** The resolved agent dir, which `setAgentDir` changes in module state as well as
 *  in the environment. */
registerLeakProbe("agentDir", () => getAgentDir());

/** `setProjectDir` also moves `process.cwd()`, so a suite that changes the project
 *  root and does not restore it breaks every relative path after it. */
registerLeakProbe("projectDir", () => getProjectDir());

/**
 * The pre-profile agent-dir baseline. It is INVISIBLE in the environment and in every
 * other probe here — `setAgentDir` overwrites it, and nothing about the resolved agent
 * dir or the active profile reveals the change. What it decides is where
 * `setProfile(undefined)` lands, so a suite that leaves it pointing at its own deleted
 * temp dir breaks the next file that returns to the default profile, and the report would
 * name a path that no test in that file ever mentioned.
 */
registerLeakProbe("preProfileAgentDir", () => __preProfileAgentDirForTests() ?? "(none)");
