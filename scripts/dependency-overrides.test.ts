import { describe, expect, it } from "bun:test";
import path from "node:path";

/**
 * A pinned dependency override must be installable.
 *
 * `bunfig.toml` sets `install.minimumReleaseAge = 3 days`, which refuses any
 * version published inside that window. `package.json` `overrides` pins exact
 * or minimum versions, and those pins are usually security bumps whose whole
 * point is the FRESH release. The two rules contradict each other: on 2026-07-24
 * `brace-expansion` was pinned to `^5.0.8` for GHSA-mh99-v99m-4gvg while 5.0.8
 * was ~40 hours old, so every resolve-from-scratch died with
 *
 *     error: No version matching "brace-expansion" found for specifier "^5.0.8"
 *             (blocked by minimum-release-age: 259200 seconds)
 *
 * which blocked the release train for the rest of the age window and would have
 * broken a fresh `bun install` for any contributor.
 *
 * The rule this file enforces: an override is a reviewed decision and therefore
 * outranks the age heuristic, so every override key is also listed in
 * `minimumReleaseAgeExcludes`. Adding a pin without the exclusion fails here
 * instead of failing days later on whoever installs without a lockfile.
 */

const ROOT = path.join(import.meta.dir, "..");

async function overrideNames(): Promise<string[]> {
	const pkg = (await Bun.file(path.join(ROOT, "package.json")).json()) as {
		overrides?: Record<string, string>;
	};
	return Object.keys(pkg.overrides ?? {});
}

/**
 * Read `install.minimumReleaseAgeExcludes` out of bunfig.toml. Parsed with a
 * narrow line match rather than a TOML library because this file is the guard:
 * it must not depend on a dependency to check the dependency rules.
 */
async function ageExcludes(): Promise<string[]> {
	const text = await Bun.file(path.join(ROOT, "bunfig.toml")).text();
	const line = text.split("\n").find(l => l.trimStart().startsWith("minimumReleaseAgeExcludes"));
	if (!line) throw new Error("bunfig.toml has no install.minimumReleaseAgeExcludes line");
	return [...line.matchAll(/"([^"]+)"/g)].map(m => m[1]!);
}

describe("pinned dependency overrides stay installable", () => {
	it("has overrides to check, so this suite cannot pass vacuously", async () => {
		// If `overrides` is ever emptied the loop below would assert nothing while
		// still reporting green.
		const names = await overrideNames();
		expect(names.length).toBeGreaterThan(0);
		expect(names).toContain("brace-expansion"); // the pin this rule came from
	});

	it("excludes every override from the minimum-release-age gate", async () => {
		const names = await overrideNames();
		const excludes = await ageExcludes();
		const missing = names.filter(name => !excludes.includes(name));
		expect(missing).toEqual([]);
	});

	it("still applies the age gate to everything else", async () => {
		// The exclusion list is the exception, not a way to disable the policy: the
		// gate itself must stay on, and the list must stay close to the overrides
		// rather than growing into a blanket opt-out.
		const text = await Bun.file(path.join(ROOT, "bunfig.toml")).text();
		expect(text).toContain("minimumReleaseAge = 259200");
		const excludes = await ageExcludes();
		const names = await overrideNames();
		// Only the two type packages are excluded for their own reason (they
		// republish constantly and carry no runtime code).
		const extra = excludes.filter(name => !names.includes(name));
		expect(extra).toEqual(["@types/bun", "bun-types"]);
	});

	it("keeps the release from re-resolving the graph it was told to pin", async () => {
		// The other half of the same incident: `scripts/release.ts` used to delete
		// bun.lock before installing, so every cut re-resolved the whole registry
		// and inherited exactly this class of failure. The lockfile is also what CI
		// builds under --frozen-lockfile, so the release must keep it.
		const release = await Bun.file(path.join(ROOT, "scripts/release.ts")).text();
		expect(release).not.toContain("rm -f bun.lock");
	});
});
