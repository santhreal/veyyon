/**
 * The release gate's two proofs: which tag may publish, and what a publication owes.
 *
 * WHY THIS SUITE EXISTS. A release is a tag an operator pushes by hand, so `releaseTagRefusal` is
 * the only thing standing between a mistyped ref and a published binary. The failure it prevents
 * happened live: `v1.0.28` through `v1.0.35` were each tagged before `ci.yml` had tested their sha,
 * two red tests killed every publish downstream, and `releases/latest` sat at `v1.0.27` while the
 * tags marched on. Under the tag-push model that cannot recur by construction — the commit reaches
 * main first and main's CI tests it — but only if the tag is genuinely on main, which is exactly
 * the one fact this refusal establishes.
 *
 * Every branch is pinned by name rather than covered in aggregate, and the blind case is pinned
 * hardest: a comparison the API could not produce must refuse, never pass.
 */

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type MainComparison,
	REQUIRED_RELEASE_ASSET_NAMES,
	type ReleaseTagFacts,
	releaseTagRefusal,
	verifyPublishedReleaseAssets,
} from "./release-policy.ts";

const MAIN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("a tag may publish only from main", () => {
	const at = (mainComparison: MainComparison | undefined): ReleaseTagFacts => ({
		tag: "v1.2.3",
		sha: MAIN,
		checkedOutSha: MAIN,
		mainComparison,
	});

	/**
	 * `ahead` means the tagged commit carries something main does not, so no run of
	 * CI on main ever tested this tree. This is the tag-a-local-branch case, and it
	 * is the whole reason the check exists.
	 */
	it("refuses a tag holding commits main does not have", () => {
		const refusal = releaseTagRefusal(at("ahead"));
		expect(refusal).toContain("v1.2.3");
		expect(refusal).toContain("not on main");
		expect(refusal).toContain("ahead");
	});

	/**
	 * `diverged` is `ahead` plus a rewrite: the tag shares no tip with main. It must
	 * refuse for the same reason, and must not be mistaken for the benign `behind`.
	 */
	it("refuses a tag on a branch that diverged from main", () => {
		expect(releaseTagRefusal(at("diverged"))).toContain("diverged");
	});

	/**
	 * The two publishable shapes. `identical` is tagging main's tip; `behind` is
	 * tagging an older main commit after main moved on, which is ordinary when a
	 * release is prepared and main advances before the tag is pushed. Both name a
	 * commit that reached main and was therefore tested there.
	 */
	it("accepts a tag at main's tip and a tag on an older main commit", () => {
		expect(releaseTagRefusal(at("identical"))).toBeUndefined();
		expect(releaseTagRefusal(at("behind"))).toBeUndefined();
	});

	/**
	 * Blindness is refusal. When the compare API returns something this code does
	 * not understand, the honest answer is that the tag's relationship to main is
	 * unknown — and an unknown relationship must not publish. Passing here would
	 * turn every future API change into a silent hole in the only gate.
	 */
	it("refuses when the comparison could not be established", () => {
		const refusal = releaseTagRefusal(at(undefined));
		expect(refusal).toContain("could not establish");
		expect(refusal).toContain("v1.2.3");
	});

	/**
	 * The tag names the version the binaries will report, so a ref that is not
	 * strict `vX.Y.Z` is refused before anything else is even looked at.
	 */
	it("refuses a ref that is not strict vX.Y.Z semver", () => {
		for (const tag of ["v1.2", "1.2.3", "v1.2.3-rc.1", "release-1.2.3"]) {
			expect(releaseTagRefusal({ tag, sha: MAIN, checkedOutSha: MAIN, mainComparison: "identical" })).toContain(
				"strict vX.Y.Z semver",
			);
		}
	});

	/**
	 * Every later fact is read from the checkout, so a checkout that is not the
	 * commit being published makes all of them describe the wrong tree. Refusing
	 * here is what stops the on-main proof from being asserted about a different
	 * commit than the one the tag points at.
	 */
	it("refuses when the checkout is not the commit being published", () => {
		const other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		expect(
			releaseTagRefusal({ tag: "v1.2.3", sha: MAIN, checkedOutSha: other, mainComparison: "identical" }),
		).toContain("does not match");
		expect(
			releaseTagRefusal({ tag: "v1.2.3", sha: MAIN, checkedOutSha: undefined, mainComparison: "identical" }),
		).toContain("could not read the checked-out HEAD");
	});
});

describe("published asset manifest", () => {
	it("accepts exactly the complete five-platform binary and native-addon set with sidecars", () => {
		const result = verifyPublishedReleaseAssets(REQUIRED_RELEASE_ASSET_NAMES);
		expect(result).toEqual({ ok: true, missing: [], unexpected: [] });
	});

	it("fails when either binary platform previously omitted from verification is absent", () => {
		for (const missing of ["veyyon-darwin-x64", "veyyon-linux-arm64"]) {
			const result = verifyPublishedReleaseAssets(REQUIRED_RELEASE_ASSET_NAMES.filter(name => name !== missing));
			expect(result.ok).toBe(false);
			expect(result.missing).toContain(missing);
		}
	});

	it("fails when any checksum sidecar or required native addon is absent", () => {
		for (const missing of [
			"veyyon-linux-arm64.sha256",
			"veyyon_natives.darwin-arm64.node",
			"veyyon_natives.win32-x64-baseline.node.sha256",
		]) {
			const result = verifyPublishedReleaseAssets(REQUIRED_RELEASE_ASSET_NAMES.filter(name => name !== missing));
			expect(result.ok).toBe(false);
			expect(result.missing).toContain(missing);
		}
	});

	it("rejects distribution assets outside the exact manifest", () => {
		const result = verifyPublishedReleaseAssets([...REQUIRED_RELEASE_ASSET_NAMES, "veyyon-linux-riscv64"]);
		expect(result.ok).toBe(false);
		expect(result.unexpected).toEqual(["veyyon-linux-riscv64"]);
	});

	it("fails closed when GitHub publication state cannot be queried", async () => {
		// The stub has to be executable, and the sandbox mounts the system tmpdir
		// noexec — so it goes under node_modules, which is inside the workspace and
		// is never source. mkdtemp keeps concurrent runs from colliding.
		const bin = mkdtempSync(join(REPO_ROOT, "node_modules", ".release-gate-gh-"));
		const fakeGh = join(bin, "gh");
		writeFileSync(fakeGh, "#!/bin/sh\necho publication unavailable >&2\nexit 9\n");
		chmodSync(fakeGh, 0o755);

		const proc = Bun.spawn(["bun", "scripts/release.ts", "verify-assets", "v1.2.3"], {
			cwd: REPO_ROOT,
			env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		rmSync(bin, { recursive: true, force: true });
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("could not establish publication state");
	});
});
