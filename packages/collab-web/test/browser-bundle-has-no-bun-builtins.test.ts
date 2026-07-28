import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { moduleReach, moduleSpecifiersIn, withoutComments } from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution } from "@veyyon/utils/module-reach-workspace";

/**
 * Nothing the browser bundle reaches may import a Bun builtin.
 *
 * `bun build` for the browser refuses one outright — "Browser build cannot
 * import Bun builtin" — and takes the whole web client down with it. That is a
 * correct gate and a slow one: it needs a full install and a full bundle, it
 * runs in one CI job, and by the time it speaks the commit is already on main.
 * It happened exactly that way: `packages/utils/src/json.ts` grew an
 * `import { YAML } from "bun"` for one config-parsing helper, which is a
 * perfectly ordinary thing to write in a package that mostly runs under Bun, and
 * `json.ts` is on the client's graph. The web build was red on main until the
 * helper moved to its own module.
 *
 * So this walks the same static graph the bundler does, from the client's own
 * entry points, and fails in milliseconds naming the file and the import. The
 * fix is always the same shape: move the Bun-only code into a module the browser
 * does not reach, rather than making the browser tolerate it.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const CLIENT_DIR = path.join(REPO_ROOT, "packages/collab-web/src");

/**
 * Specifiers a browser bundle cannot resolve. `bun:*` covers `bun:test`,
 * `bun:sqlite` and the rest; bare `bun` is the builtin the regression used.
 */
function isBunBuiltin(specifier: string): boolean {
	return specifier === "bun" || specifier.startsWith("bun:");
}

/** Every `.ts`/`.tsx` module under the client, which is what the bundle roots at. */
function clientEntries(): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (/\.tsx?$/.test(entry.name)) found.push(full);
		}
	};
	walk(CLIENT_DIR);
	return found.sort();
}

/** Every module statically reachable from the client, the entries included. */
function reachedByClient(): string[] {
	const resolution = workspaceModuleReachResolution(REPO_ROOT);
	const reached = new Set<string>();
	for (const entry of clientEntries()) {
		for (const file of moduleReach(entry, resolution)) reached.add(file);
	}
	return [...reached].sort();
}

describe("the collab web client's import graph", () => {
	/**
	 * The control: if the walk resolved nothing, every assertion below would pass
	 * against an empty set, which is the shape a broken resolution takes.
	 */
	it("reaches modules outside the client itself", () => {
		const reached = reachedByClient();
		expect(reached.length).toBeGreaterThan(50);
		expect(reached.some(file => file.includes(`${path.sep}packages${path.sep}utils${path.sep}`))).toBe(true);
	});

	it("imports no Bun builtin anywhere on it", () => {
		const offenders: string[] = [];
		for (const file of reachedByClient()) {
			let source: string;
			try {
				source = fs.readFileSync(file, "utf8");
			} catch {
				continue;
			}
			for (const specifier of moduleSpecifiersIn(withoutComments(source))) {
				if (isBunBuiltin(specifier)) {
					offenders.push(`${path.relative(REPO_ROOT, file)} imports ${JSON.stringify(specifier)}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * The specific module the regression landed in, asserted by name as well as by
	 * the sweep above. `json.ts` holds the JSON helpers half the workspace uses,
	 * so it is the module most likely to grow a Bun-only convenience again, and a
	 * named case says why in the failure message rather than leaving the next
	 * reader to work out what `json.ts` has to do with the web client.
	 */
	it("keeps @veyyon/utils json helpers free of Bun builtins, since the client reaches them", () => {
		const json = path.join(REPO_ROOT, "packages/utils/src/json.ts");
		const specifiers = moduleSpecifiersIn(withoutComments(fs.readFileSync(json, "utf8")));
		expect(specifiers.filter(isBunBuiltin)).toEqual([]);
	});
});
