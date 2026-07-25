import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai";

/**
 * An `AuthStorage` backed by a throwaway database under `dir`, for any test that
 * builds a real `createAgentSession`.
 *
 * WHY EVERY SESSION TEST NEEDS THIS. `createAgentSession` falls back to
 * `discoverAuthStorage` when no `authStorage` is supplied, and that walks to the
 * machine-wide shared store at `<home>/.veyyon/shared-auth/agent.db`. Opening it
 * is not read-only: sqlite creates and writes the file, and
 * `seedSharedCredentialStore` may copy credentials into it.
 *
 * Under the shipped runner that resolves to a sandbox, not to real credentials:
 * `scripts/ci-test-ts.ts` spawns every chunk with `HOME=<sandbox>`. So the point
 * of this helper is NOT that the gate is unsafe. It is that the isolation is
 * ambient, and ambient isolation disappears the moment you run a suite the way
 * suites are actually run during development: `bun test path/to/file`, with no
 * runner and no sandbox home. Nine suites failed exactly that way.
 *
 * Passing the storage explicitly makes a suite hermetic by construction instead
 * of by environment, and it is the documented option
 * (`CreateAgentSessionOptions.authStorage`, "Default: discoverAuthStorage").
 * Note that assigning `process.env.HOME` mid-process does NOT help: Bun resolves
 * `os.homedir()` once at start, so only a spawn-time HOME (or this helper) works.
 *
 * THE TRAP THIS ALSO CLOSES: `discoverAuthStorage(someTempDir)` reads as
 * isolated and is not. Its argument sets only the PER-PROFILE dir, while
 * credential sharing, on by default, routes the store to the machine-wide
 * `getSharedAuthDir()`, which ignores that argument entirely. A suite that
 * carefully passed a temp dir still opened the real store. Use this instead.
 *
 * Lives here rather than being inlined per suite so the reasoning above is
 * stated once: nine suites had independently omitted `authStorage`, and a copied
 * one-liner with no explanation is how the tenth omits it too.
 *
 * @param dir A directory the suite owns and deletes. The db is created inside it.
 */
export function isolatedAuthStorage(dir: string): Promise<AuthStorage> {
	return AuthStorage.create(path.join(dir, "isolated-auth.db"));
}
