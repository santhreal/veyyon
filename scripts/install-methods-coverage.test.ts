import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Locks the release gate to the install methods veyyon actually ships, and locks
 * the npm topology out for good.
 *
 * veyyon is distributed GitHub-only through two channels: the prebuilt binary
 * (`curl | sh`) and a source checkout (`install.sh --source`). It is not on npm
 * or bun and never will be — the workspace pins its own packages with
 * `workspace:*` and `catalog:` protocols, which resolve only inside a checkout,
 * so a registry install could not work even if one were published.
 *
 * `scripts/install-tests/run-ci.sh` used to pack every workspace package, write
 * bun `overrides` pointing each dep at a tarball, `bun add` the set, and smoke
 * the result — reproducing a published npm topology no user could ever install
 * through. That simulation was pure cost: its hand-kept package lists drifted
 * from the real manifests twice and silently gated EVERY release (BACKLOG
 * ARGOT-1 / PREPACK-1), because `install_methods` is a hard dependency of
 * `release_binary`. It is gone, along with the publish orchestration that
 * existed only to serve it.
 *
 * These tests fail if any of it comes back, and if the gate stops covering
 * either real channel.
 */

const repoRoot = path.resolve(import.meta.dir, "..");
const runCiPath = path.join(repoRoot, "scripts", "install-tests", "run-ci.sh");
const runCi = fs.readFileSync(runCiPath, "utf8");

/** Files that existed only to build or publish the npm/tarball topology. */
const removedNpmMachinery = [
	"scripts/ci-release-publish.ts",
	"scripts/fix-dts-extensions.ts",
	"scripts/fix-dts-extensions.test.ts",
	"scripts/install-tests/tarball.dockerfile",
	"packages/natives/scripts/gen-npm-packages.ts",
	"packages/natives/test/npm-packages.test.ts",
];

describe("the release gate covers both shipped install channels", () => {
	it("smokes the prebuilt binary a curl | sh install puts on PATH", () => {
		expect(runCi).toContain("Binary install smoke");
		expect(runCi).toContain("cp packages/coding-agent/dist/vey");
		expect(runCi).toContain('smoke_cli "$BINARY_DIR/veyyon"');
	});

	it("smokes the committed source launcher install.sh --source symlinks onto PATH", () => {
		// `bun link` alone does not exercise the launcher, so a broken launcher
		// could pass the gate and still break every source install.
		expect(runCi).toContain("packages/coding-agent/scripts/veyyon");
		expect(runCi).toContain('smoke_cli "$LAUNCHER"');
	});

	it("fails loudly when the source launcher is missing rather than skipping it", () => {
		// Law 10: a missing launcher must fail the gate, never silently reduce
		// coverage to the binary channel.
		expect(runCi).toContain("source launcher missing or not executable");
	});

	it("runs the installer helper unit tests before the build-heavy smokes", () => {
		const helpers = runCi.indexOf("functions.test.sh");
		const build = runCi.indexOf("bun --cwd=packages/natives run build");
		expect(helpers).toBeGreaterThan(-1);
		expect(build).toBeGreaterThan(helpers);
	});
});

describe("the npm/tarball topology stays deleted", () => {
	it("the gate packs no tarballs and writes no bun overrides", () => {
		for (const banned of ["bun pm pack", "pkg.overrides", "find_tarball", "_tgz", "for pkg in "]) {
			expect(runCi, `run-ci.sh must not reintroduce \`${banned}\``).not.toContain(banned);
		}
	});

	it("the gate no longer imports the publish orchestration", () => {
		expect(runCi).not.toContain("ci-release-publish");
		expect(runCi).not.toContain("applyPublishBin");
		expect(runCi).not.toContain("prepareNativeCorePackage");
		expect(runCi).not.toContain("gen:npm");
	});

	it("every file that existed only to publish to npm is gone", () => {
		for (const rel of removedNpmMachinery) {
			expect(fs.existsSync(path.join(repoRoot, rel)), `${rel} should not exist`).toBe(false);
		}
	});

	it("no manifest still offers an npm-packaging script", () => {
		const natives = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "packages", "natives", "package.json"), "utf8"),
		) as { scripts?: Record<string, string> };
		expect(natives.scripts?.["gen:npm"]).toBeUndefined();
	});

	it("the podman runner no longer builds a tarball image", () => {
		const podman = fs.readFileSync(path.join(repoRoot, "scripts", "install-tests", "run-podman.sh"), "utf8");
		expect(podman).not.toContain("tarball.dockerfile");
		// The two real channels keep their images.
		expect(podman).toContain("binary.dockerfile");
		expect(podman).toContain("source.dockerfile");
	});

	it("npm appears in the gate only where it is being denied", () => {
		// A stray `npm` mention would signal the topology creeping back; the only
		// allowed use is prose explaining why there is no registry channel.
		for (const line of runCi.split("\n")) {
			if (!/\bnpm\b/.test(line)) continue;
			expect(line.trimStart().startsWith("#"), `unexpected npm usage: ${line.trim()}`).toBe(true);
		}
	});
});
