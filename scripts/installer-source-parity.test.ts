import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Locks the two source-install scripts to the SAME provisioning contract.
 *
 * Why this suite exists (F2): `install.sh --source` (install_via_bun) eagerly
 * generates BOTH gitignored build artifacts a fresh clone lacks — the
 * tool-views bundle (`gen:tool-views`, run from packages/collab-web) and the
 * native addon (`packages/natives run ensure`) — so it hands over a complete,
 * bootable tree. `install.ps1 -Source` (Install-FromSource) used to run only
 * `bun install` and skip both, so a Windows source install shipped an
 * incomplete tree: the native addon was missing and the first launch either
 * limped through the launcher self-heal or died at boot (the exact
 * user-hit 2026-07-24 native-load failure, but on the install path). These
 * tests fail loudly if the two installers drift apart on either step, so the
 * Windows source path can never silently regress to install-only again.
 */

const repoRoot = path.resolve(import.meta.dir, "..");
const installSh = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8");
const installPs1 = fs.readFileSync(path.join(repoRoot, "scripts", "install.ps1"), "utf8");

/** Provisioning steps every source install must run, in order, after `bun install`. */
const SOURCE_PROVISION_STEPS = [
	{ label: "workspace install", marker: "bun install" },
	{ label: "tool-views bundle", marker: "bun --cwd=packages/collab-web run gen:tool-views" },
	{ label: "native addon", marker: "bun --cwd=packages/natives run ensure" },
];

describe("source-install provisioning parity between install.sh and install.ps1", () => {
	for (const script of [
		{ name: "install.sh", body: installSh },
		{ name: "install.ps1", body: installPs1 },
	]) {
		it(`${script.name} runs every source-provisioning step`, () => {
			for (const step of SOURCE_PROVISION_STEPS) {
				expect(script.body, `${script.name} is missing the ${step.label} step (${step.marker})`).toContain(
					step.marker,
				);
			}
		});

		it(`${script.name} runs the steps in order (install -> tool-views -> native)`, () => {
			// Order matters: tool-views and the native ensure both run against the
			// installed workspace, so they must come AFTER `bun install`. A script
			// that ran ensure before install would provision against an empty tree.
			const indices = SOURCE_PROVISION_STEPS.map(step => script.body.indexOf(step.marker));
			for (let i = 1; i < indices.length; i++) {
				expect(indices[i]).toBeGreaterThan(indices[i - 1]);
			}
		});
	}

	it("both installers generate tool-views from packages/collab-web, not another package", () => {
		// The generator lives in collab-web; a copy that pointed at coding-agent or
		// collab-agent would silently generate nothing and ship a stale bundle.
		for (const body of [installSh, installPs1]) {
			expect(body).toContain("bun --cwd=packages/collab-web run gen:tool-views");
			expect(body).not.toContain("bun --cwd=packages/coding-agent run gen:tool-views");
		}
	});

	it("both installers fail loudly (non-zero) when a provisioning step fails", () => {
		// A silent-fallback guard (Law 10): each step must abort the install on
		// failure, never continue and hand over a half-provisioned tree. install.sh
		// uses `|| die`; install.ps1 checks `$LASTEXITCODE -ne 0` and throws.
		expect(installSh).toContain("bun --cwd=packages/collab-web run gen:tool-views ) \\");
		expect(installSh).toMatch(/bun --cwd=packages\/natives run ensure \) \\\n\s*\|\| die/);
		const ps1AfterInstall = installPs1.slice(installPs1.indexOf("Install-FromSource"));
		const genIdx = ps1AfterInstall.indexOf("gen:tool-views");
		const ensureIdx = ps1AfterInstall.indexOf("packages/natives run ensure");
		// A `throw` on $LASTEXITCODE follows each provisioning call.
		expect(ps1AfterInstall.indexOf("LASTEXITCODE -ne 0", genIdx)).toBeGreaterThan(genIdx);
		expect(ps1AfterInstall.indexOf("LASTEXITCODE -ne 0", ensureIdx)).toBeGreaterThan(ensureIdx);
	});
});
