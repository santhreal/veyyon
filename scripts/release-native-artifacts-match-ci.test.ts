/**
 * The native half of the release manifest, which nothing was checking.
 *
 * `REQUIRED_RELEASE_ASSET_NAMES` is the exact list of files a release must
 * publish, and it names two kinds: the application binaries (`veyyon-linux-x64`)
 * and the native addons (`veyyon_natives.linux-x64-modern.node`). The binaries
 * are pinned against ci.yml's build matrix by
 * `release-binaries-bytecode.test.ts`, but that check filters on
 * `name.startsWith("veyyon-")` and the addons are spelled with an UNDERSCORE, so
 * every one of them fell out of the filter. The native half was guarded by
 * nothing.
 *
 * That matters because the same six targets are written out by hand in two
 * places with two different spellings: the manifest here as
 * `veyyon_natives.<target>.node`, and ci.yml's prior-build lookup as
 * `veyyon-natives-<target>-h${hash}`. Nothing derived either from the other, so
 * adding a target to one and not the other produces a release that either
 * publishes an asset no job builds or silently ships without one the installer
 * expects.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { REQUIRED_RELEASE_ASSET_NAMES } from "./release-policy";

const ciYaml = await Bun.file(path.join(import.meta.dir, "..", ".github", "workflows", "ci.yml")).text();

/** `veyyon_natives.linux-x64-modern.node` -> `linux-x64-modern`. */
const manifestTargets = REQUIRED_RELEASE_ASSET_NAMES.filter(
	name => name.startsWith("veyyon_natives.") && !name.endsWith(".sha256"),
).map(name => name.slice("veyyon_natives.".length, -".node".length));

/** `"veyyon-natives-linux-x64-modern-h${hash}"` -> `linux-x64-modern`. */
const ciTargets = [...ciYaml.matchAll(/"veyyon-natives-([\w-]+)-h\$\{hash\}"/g)].map(match => match[1]!);

describe("native release artifacts", () => {
	test("the manifest and ci.yml name the same native targets", () => {
		// Both lists are hand-written in different spellings, so the only thing
		// keeping them together is this comparison.
		expect(manifestTargets.length).toBeGreaterThan(0);
		expect(ciTargets.length).toBeGreaterThan(0);
		expect([...new Set(manifestTargets)].sort()).toEqual([...new Set(ciTargets)].sort());
	});

	test("every native addon ships the checksum sidecar the installer requires", () => {
		// install.sh and install.ps1 refuse an asset whose published .sha256 is
		// missing, so an addon listed without its sidecar fails the install rather
		// than the release.
		const missing = manifestTargets
			.map(target => `veyyon_natives.${target}.node.sha256`)
			.filter(sidecar => !REQUIRED_RELEASE_ASSET_NAMES.includes(sidecar));

		expect(missing).toEqual([]);
	});

	test("ci.yml lists each native target once, so a duplicate cannot mask a missing one", () => {
		// The required-artifact arrays are checked with `grep -qFx` in a loop. A
		// repeated name still passes that loop while the target it displaced is
		// never looked for.
		expect(ciTargets).toEqual([...new Set(ciTargets)]);
	});
});
