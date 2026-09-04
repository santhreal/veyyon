/**
 * WHY: a mnemopi test process must not be able to write into the home it runs
 * under, whatever any individual suite remembers to do.
 *
 * The incident: `Test TS workspace fast` went red with
 *
 *     expect(homeRootsAMnemopiRunCouldCreate()).toEqual(rootsBefore)
 *     +   ".hermes",
 *         ".veyyon",
 *
 * reported by `useMnemopiTestEnv()`'s `afterAll` in a suite that had isolated
 * itself correctly. Only 18 of 109 suites call that helper, and under
 * `--parallel` the file that creates the directory and the file that notices it
 * are different processes, so the guard names a witness and never the culprit.
 * It moved between runs and between commits, which is the worst shape a red gate
 * can have: nobody can tell whether their change caused it.
 *
 * The class this closes is not "one suite forgot the helper". It is that
 * isolation was opt-in at all. `test/helpers/home-isolation.ts` is preloaded for
 * every mnemopi test process (`bunfig.toml`), so `MNEMOPI_HOME` points at a temp
 * directory before the first suite is linked, and this file is the assertion
 * that it is true of the AMBIENT environment rather than of a helper somebody
 * called. The resolver inventory is discovered from the modules at run time, so
 * a root added next year is swept without anyone remembering this file.
 *
 * WHAT IT DOES NOT CATCH: a write that spells its path inline instead of going
 * through a resolver, and a path taken from `os.homedir()` directly rather than
 * from `mnemopiHome()` — that one is the subject of
 * `home-derived-roots-answer-to-one-lever.test.ts`, and the `afterAll` guard
 * remains the live detector for it.
 *
 * Deliberately does NOT call `useMnemopiTestEnv()`: the helper would set
 * `MNEMOPI_HOME` itself and the sweep would pass on the strength of the very
 * opt-in this file exists to stop depending on.
 */

import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { pathResolvers } from "./helpers/home-path-resolvers";

describe("the ambient environment of a mnemopi test process", () => {
	/**
	 * NON-VACUITY, twice over: the preload ran, and the sweep below has an
	 * inventory to sweep. An empty inventory satisfies every assertion here.
	 */
	it("carries an isolated MNEMOPI_HOME and a discoverable set of resolvers", () => {
		const home = process.env.MNEMOPI_HOME;
		expect(home, "the home-isolation preload must set MNEMOPI_HOME").toBeString();
		expect(String(home).startsWith(homedir())).toBe(false);
		expect(pathResolvers().length).toBeGreaterThanOrEqual(10);
	});

	/**
	 * The invariant itself, at the choke point every root passes through, against
	 * the environment the process is actually running in. A resolver added to any
	 * of the swept modules is covered the day it lands.
	 */
	it("puts every home-derived root outside the ambient home", () => {
		const ambient = process.env as Record<string, string>;
		const inside = pathResolvers()
			.map(([name, resolve]) => [name, String(resolve(ambient))] as const)
			.filter(([, resolved]) => resolved.startsWith(homedir()))
			.map(([name, resolved]) => `${name} -> ${resolved}`);

		expect(inside).toEqual([]);
	});
});
