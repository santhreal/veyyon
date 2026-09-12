import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateReleaseVersionAuthorities } from "./release";
import { memberTopLevels } from "./workspace-layout";

const version = "1.2.3";
const roots: string[] = [];

interface FixtureOptions {
	workspaces?: string[] | { packages: string[]; catalog?: Record<string, string> };
	cargoMembers?: string[];
	extraFiles?: Record<string, string>;
	extraCargoPackages?: Array<{ name: string; manifestPath: string; version?: string }>;
}

async function fixture(options?: FixtureOptions): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-release-authorities-"));
	roots.push(root);

	const pkgWorkspaces = options?.workspaces ?? {
		packages: ["packages/*"],
		catalog: { "@veyyon/public": version },
	};
	const cargoMembers = options?.cargoMembers ?? ["natives/*"];

	const extraCargoPackages = options?.extraCargoPackages ?? [];
	let cargoLockPackages = `version = 4\n\n[[package]]\nname = "veyyon-core"\nversion = "${version}"\n`;
	for (const pkg of extraCargoPackages) {
		cargoLockPackages += `\n[[package]]\nname = "${pkg.name}"\nversion = "${pkg.version ?? version}"\n`;
	}

	const files: Record<string, string> = {
		"package.json": JSON.stringify({ workspaces: pkgWorkspaces }),
		"packages/public/package.json": JSON.stringify({ name: "@veyyon/public", version }),
		"packages/private/package.json": JSON.stringify({ name: "@veyyon/private", version: "9.9.9", private: true }),
		"bun.lock": JSON.stringify({
			workspaces: {
				"packages/public": { name: "@veyyon/public", version },
				"packages/coding-agent": { name: "@veyyon/coding-agent", version },
				"packages/private": { name: "@veyyon/private", version: "9.9.9" },
			},
		}),
		"Cargo.toml": `[workspace]\nmembers = ${JSON.stringify(cargoMembers)}\n\n[workspace.package]\nversion = "${version}"\n`,
		"natives/core/Cargo.toml": '[package]\nname = "veyyon-core"\nversion.workspace = true\n',
		"Cargo.lock": cargoLockPackages,
		"natives/core/src/lib.rs": '#[napi(js_name = "__veyyonNativesV1_2_3")]\nfn sentinel() {}\n',
		"packages/coding-agent/package.json": JSON.stringify({ name: "@veyyon/coding-agent", version }),
		"packages/coding-agent/CHANGELOG.md": `# Changelog\n\n## [Unreleased]\n\n## [${version}] - 2026-01-01\n\n### Fixed\n\n- Something.\n`,
		...(options?.extraFiles ?? {}),
	};

	await Promise.all(
		Object.entries(files).map(async ([relPath, content]) => {
			const absPath = path.join(root, relPath);
			await fs.mkdir(path.dirname(absPath), { recursive: true });
			await Bun.write(absPath, content);
		}),
	);

	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("prepared release version authorities", () => {
	/** A coherent tree accepts one tuple while ignoring private package versions that are not released. */
	it("accepts synchronized public package, lockfile, Cargo, and sentinel authorities", async () => {
		const root = await fixture();
		await expect(validateReleaseVersionAuthorities(root, version, `v${version}`)).resolves.toBeUndefined();
	});

	/** Each independently published JavaScript authority must reject a stale version before the tag push. */
	it("rejects stale package manifests, catalog pins, and Bun workspace locks", async () => {
		const cases: Array<[string, (root: string) => Promise<unknown>]> = [
			[
				"public package @veyyon/public",
				root =>
					Bun.write(
						path.join(root, "packages/public/package.json"),
						JSON.stringify({ name: "@veyyon/public", version: "1.2.2" }),
					),
			],
			[
				"workspace catalog pin @veyyon/public",
				async root => {
					const manifest = await Bun.file(path.join(root, "package.json")).json();
					manifest.workspaces.catalog["@veyyon/public"] = "1.2.2";
					return Bun.write(path.join(root, "package.json"), JSON.stringify(manifest));
				},
			],
			[
				"bun.lock workspace packages/public",
				async root => {
					const lock = await Bun.file(path.join(root, "bun.lock")).json();
					lock.workspaces["packages/public"].version = "1.2.2";
					return Bun.write(path.join(root, "bun.lock"), JSON.stringify(lock));
				},
			],
		];

		for (const [message, mutate] of cases) {
			const root = await fixture();
			await mutate(root);
			await expect(validateReleaseVersionAuthorities(root, version, `v${version}`)).rejects.toThrow(message);
		}
	});

	/** Rust workspace metadata, lock entries, and the exported native sentinel must advance together. */
	it("rejects stale Cargo and native sentinel authorities", async () => {
		const cases: Array<[string, string, string]> = [
			[
				"Cargo workspace",
				"Cargo.toml",
				'[workspace]\nmembers = ["natives/*"]\n\n[workspace.package]\nversion = "1.2.2"\n',
			],
			[
				"Cargo.lock package veyyon-core",
				"Cargo.lock",
				'version = 4\n\n[[package]]\nname = "veyyon-core"\nversion = "1.2.2"\n',
			],
			[
				"native sentinel __veyyonNativesV1_2_2",
				"natives/core/src/lib.rs",
				'#[napi(js_name = "__veyyonNativesV1_2_2")]\nfn sentinel() {}\n',
			],
		];

		for (const [message, relativePath, content] of cases) {
			const root = await fixture();
			await Bun.write(path.join(root, relativePath), content);
			await expect(validateReleaseVersionAuthorities(root, version, `v${version}`)).rejects.toThrow(message);
		}
	});

	/** A valid tree still refuses a malformed or mismatched immutable tag identity. */
	it("rejects tags that do not identify the prepared strict semver", async () => {
		const root = await fixture();
		await expect(validateReleaseVersionAuthorities(root, version, "v1.2.2")).rejects.toThrow(
			'expected tag "v1.2.2" does not identify version "1.2.3"',
		);
		await expect(validateReleaseVersionAuthorities(root, version, "latest")).rejects.toThrow(
			'expected tag "latest" is not a strict v-prefixed semver tag',
		);
	});

	/**
	 * The changelog section is the authority whose absence has actually shipped: v1.0.38 through
	 * v1.0.46 were each tagged at a tree with no `## [x.y.z]` section, published binaries and a
	 * GitHub release, and only then went red in `release_site_finalize`, because the website
	 * generator refuses to build a published release it cannot describe. Both spellings of the
	 * fault are here — the section missing, and the whole file missing — because a tree that
	 * loses the file reads as "nothing to describe" just as loudly.
	 */
	it("rejects a version the release-notes changelog does not describe", async () => {
		const withoutSection = await fixture();
		await Bun.write(
			path.join(withoutSection, "packages/coding-agent/CHANGELOG.md"),
			"# Changelog\n\n## [Unreleased]\n\n## [1.2.2] - 2026-01-01\n\n### Fixed\n\n- Something older.\n",
		);
		await expect(validateReleaseVersionAuthorities(withoutSection, version, `v${version}`)).rejects.toThrow(
			'packages/coding-agent/CHANGELOG.md has no "## [1.2.3]" section',
		);

		const withoutFile = await fixture();
		await fs.rm(path.join(withoutFile, "packages/coding-agent/CHANGELOG.md"));
		await expect(validateReleaseVersionAuthorities(withoutFile, version, `v${version}`)).rejects.toThrow(
			"packages/coding-agent/CHANGELOG.md is missing",
		);
	});

	/**
	 * Parameterized coverage across all actual workspace roots plus a synthetic unknown root.
	 * Proves that:
	 * 1. Coherent sentinel consumers are accepted.
	 * 2. Stale sentinel consumers in any discovered root are rejected with exact diagnostics.
	 * 3. Historical .test.ts fixtures with past sentinels are excluded and accepted.
	 */
	const workspaceRoots = [...new Set([...memberTopLevels(), "synthetic"])].sort();

	for (const memberRoot of workspaceRoots) {
		it(`validates native sentinel authorities in discovered workspace root ${memberRoot}`, async () => {
			const memberPattern = memberRoot === "kernel" ? "kernel" : `${memberRoot}/*`;
			const memberDir = memberRoot === "kernel" ? "kernel" : `${memberRoot}/member`;
			const consumerFile = `${memberDir}/src/consumer.ts`;
			const testFixtureFile = `${memberDir}/test/fixture.test.ts`;

			// 1. Coherent sentinel in consumer source is accepted alongside historical test fixtures
			const root = await fixture({
				workspaces: { packages: ["packages/*", memberPattern], catalog: { "@veyyon/public": version } },
				extraFiles: {
					[`${memberDir}/package.json`]: JSON.stringify({
						name: `@veyyon/${memberRoot}-member`,
						version: "0.0.0",
						private: true,
					}),
					[consumerFile]: 'import { sentinel } from "native"; const s = "__veyyonNativesV1_2_3";\n',
					[testFixtureFile]: 'const historical = "__veyyonNativesV1_0_0";\n',
				},
			});
			await expect(validateReleaseVersionAuthorities(root, version, `v${version}`)).resolves.toBeUndefined();

			// 2. Stale sentinel in consumer source is rejected
			await fs.writeFile(
				path.join(root, consumerFile),
				'import { sentinel } from "native"; const s = "__veyyonNativesV1_2_2";\n',
			);
			await expect(validateReleaseVersionAuthorities(root, version, `v${version}`)).rejects.toThrow(
				`native sentinel __veyyonNativesV1_2_2 in ${consumerFile} disagrees with expected __veyyonNativesV1_2_3`,
			);
		});
	}

	/** Relocated host harnesses (render-stress-harness.ts, render-stress-subprocess.ts) must be scanned. */
	it("detects stale native sentinels in relocated hosts stress harnesses", async () => {
		const harnessPath = "hosts/terminal/engine/test/render-stress-harness.ts";
		const subprocessPath = "hosts/terminal/engine/test/render-stress-subprocess.ts";

		const root = await fixture({
			workspaces: {
				packages: ["packages/*", "hosts/terminal/engine"],
				catalog: { "@veyyon/public": version },
			},
			extraFiles: {
				"hosts/terminal/engine/package.json": JSON.stringify({
					name: "@veyyon/terminal-engine",
					version: "0.0.0",
					private: true,
				}),
				[harnessPath]: 'const sentinel = "__veyyonNativesV1_2_3";\n',
				[subprocessPath]: 'const sentinel = "__veyyonNativesV1_2_3";\n',
			},
		});
		await expect(validateReleaseVersionAuthorities(root, version, `v${version}`)).resolves.toBeUndefined();

		await fs.writeFile(path.join(root, harnessPath), 'const sentinel = "__veyyonNativesV1_2_2";\n');
		await expect(validateReleaseVersionAuthorities(root, version, `v${version}`)).rejects.toThrow(
			`native sentinel __veyyonNativesV1_2_2 in ${harnessPath} disagrees with expected __veyyonNativesV1_2_3`,
		);
	});

	/** Both array and object workspace formats in package.json must be supported. */
	it("supports both array and object workspaces syntaxes in package.json", async () => {
		const arrayRoot = await fixture({
			workspaces: ["packages/*", "custom/*"],
			extraFiles: {
				"custom/addon/package.json": JSON.stringify({
					name: "@veyyon/custom-addon",
					version: "0.0.0",
					private: true,
				}),
				"custom/addon/src/consumer.ts": 'const sentinel = "__veyyonNativesV1_2_2";\n',
			},
		});
		await expect(validateReleaseVersionAuthorities(arrayRoot, version, `v${version}`)).rejects.toThrow(
			"native sentinel __veyyonNativesV1_2_2 in custom/addon/src/consumer.ts disagrees with expected __veyyonNativesV1_2_3",
		);

		const objectRoot = await fixture({
			workspaces: {
				packages: ["packages/*", "custom/*"],
				catalog: { "@veyyon/public": version },
			},
			extraFiles: {
				"custom/addon/package.json": JSON.stringify({
					name: "@veyyon/custom-addon",
					version: "0.0.0",
					private: true,
				}),
				"custom/addon/src/consumer.ts": 'const sentinel = "__veyyonNativesV1_2_2";\n',
			},
		});
		await expect(validateReleaseVersionAuthorities(objectRoot, version, `v${version}`)).rejects.toThrow(
			"native sentinel __veyyonNativesV1_2_2 in custom/addon/src/consumer.ts disagrees with expected __veyyonNativesV1_2_3",
		);
	});

	/** Nested and literal members declared in package.json workspaces must be included. */
	it("scans nested and literal workspace members", async () => {
		const root = await fixture({
			workspaces: {
				packages: ["packages/*", "clients/python/veybot/web", "nested/deep/pkg"],
				catalog: { "@veyyon/public": version },
			},
			extraFiles: {
				"clients/python/veybot/web/package.json": JSON.stringify({
					name: "veybot-web",
					version: "0.0.0",
					private: true,
				}),
				"clients/python/veybot/web/src/bridge.ts": 'const s = "__veyyonNativesV1_2_2";\n',
				"nested/deep/pkg/package.json": JSON.stringify({
					name: "nested-deep",
					version: "0.0.0",
					private: true,
				}),
				"nested/deep/pkg/src/index.ts": 'const s = "__veyyonNativesV1_2_3";\n',
			},
		});
		await expect(validateReleaseVersionAuthorities(root, version, `v${version}`)).rejects.toThrow(
			"native sentinel __veyyonNativesV1_2_2 in clients/python/veybot/web/src/bridge.ts disagrees with expected __veyyonNativesV1_2_3",
		);
	});

	/** Rust-only workspace roots and additional Cargo crates must be scanned and validated. */
	it("scans Rust-only roots and rejects stale native sentinels in Cargo crates", async () => {
		const crateFile = "crates/extra/src/lib.rs";
		const root = await fixture({
			cargoMembers: ["natives/*", "crates/*"],
			extraCargoPackages: [{ name: "extra-crate", manifestPath: "crates/extra/Cargo.toml" }],
			extraFiles: {
				"crates/extra/Cargo.toml": '[package]\nname = "extra-crate"\nversion.workspace = true\n',
				[crateFile]: '#[napi(js_name = "__veyyonNativesV1_2_3")]\nfn extra() {}\n',
			},
		});
		await expect(validateReleaseVersionAuthorities(root, version, `v${version}`)).resolves.toBeUndefined();

		await fs.writeFile(path.join(root, crateFile), '#[napi(js_name = "__veyyonNativesV1_2_2")]\nfn extra() {}\n');
		await expect(validateReleaseVersionAuthorities(root, version, `v${version}`)).rejects.toThrow(
			`native sentinel __veyyonNativesV1_2_2 in ${crateFile} disagrees with expected __veyyonNativesV1_2_3`,
		);
	});
});
