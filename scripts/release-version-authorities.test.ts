import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateReleaseVersionAuthorities } from "./release";

const version = "1.2.3";
const roots: string[] = [];

async function fixture(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-release-authorities-"));
	roots.push(root);
	await Promise.all([
		Bun.write(
			path.join(root, "package.json"),
			JSON.stringify({
				workspaces: { packages: ["packages/*"], catalog: { "@veyyon/public": version } },
			}),
		),
		Bun.write(path.join(root, "packages/public/package.json"), JSON.stringify({ name: "@veyyon/public", version })),
		Bun.write(
			path.join(root, "packages/private/package.json"),
			JSON.stringify({ name: "@veyyon/private", version: "9.9.9", private: true }),
		),
		Bun.write(
			path.join(root, "bun.lock"),
			JSON.stringify({
				workspaces: {
					"packages/public": { name: "@veyyon/public", version },
					"packages/private": { name: "@veyyon/private", version: "9.9.9" },
				},
			}),
		),
		Bun.write(
			path.join(root, "Cargo.toml"),
			`[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "${version}"\n`,
		),
		Bun.write(
			path.join(root, "crates/core/Cargo.toml"),
			'[package]\nname = "veyyon-core"\nversion.workspace = true\n',
		),
		Bun.write(
			path.join(root, "Cargo.lock"),
			`version = 4\n\n[[package]]\nname = "veyyon-core"\nversion = "${version}"\n`,
		),
		Bun.write(
			path.join(root, "crates/core/src/lib.rs"),
			'#[napi(js_name = "__veyyonNativesV1_2_3")]\nfn sentinel() {}\n',
		),
	]);
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
				'[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "1.2.2"\n',
			],
			[
				"Cargo.lock package veyyon-core",
				"Cargo.lock",
				'version = 4\n\n[[package]]\nname = "veyyon-core"\nversion = "1.2.2"\n',
			],
			[
				"native sentinel __veyyonNativesV1_2_2",
				"crates/core/src/lib.rs",
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
});
