// WHY: a vendored GPUI crate has no `[workspace]` above it, so every
// `workspace = true` field in its manifest must be inlined and every
// intra-closure dependency must point at a sibling path, or the crate does not
// resolve. The closure must also stay out of the workspace `members` and out of
// `cargo fmt --all`, or the Rust gate lints, formats and tests 23 third-party
// crates. Does not catch a crate the closure needs that CRATES_TO_VENDOR omits;
// `cargo build` does.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CRATES_TO_VENDOR, formatDependencyLine, resolveDependency, rewriteManifest } from "./vendor-gpui";

const WORKSPACE_PACKAGE = { edition: "2024", license: "GPL-3.0-or-later", version: "0.1.0" };
const WORKSPACE_DEPS = {
	gpui_wgpu: { path: "crates/gpui_wgpu" },
	collections: { path: "crates/collections" },
	anyhow: "1.0.0",
	wgpu: { version: "27", "default-features": false, features: ["wgsl"] },
	scap: { git: "https://example.invalid/scap", rev: "abc", package: "zed-scap", "default-features": false },
} as const;

describe("rewriteManifest", () => {
	test("inlines package fields and rewrites closure and external dependencies", () => {
		const manifest = [
			"[package]",
			'name = "gpui"',
			"version.workspace = true",
			"edition.workspace = true",
			"license.workspace = true",
			"",
			"[lints]",
			"workspace = true",
			"",
			"[dependencies]",
			"anyhow.workspace = true",
			'collections = { workspace = true, features = ["test-support"] }',
			"gpui_wgpu = { workspace = true, optional = true }",
			'wgpu = { workspace = true, features = ["naga"] }',
			"",
			"[target.'cfg(target_os = \"linux\")'.dependencies.scap]",
			"workspace = true",
			"optional = true",
			"",
			"[dev-dependencies]",
			"util.workspace = true",
			'rand = "0.9"',
		].join("\n");

		const rewritten = rewriteManifest(manifest, "gpui", WORKSPACE_PACKAGE, WORKSPACE_DEPS);
		const parsed = Bun.TOML.parse(rewritten) as {
			package: Record<string, unknown>;
			lints?: unknown;
			dependencies: Record<string, unknown>;
			"dev-dependencies": Record<string, unknown>;
		};

		expect(rewritten).not.toContain("workspace = true");
		expect(parsed.package).toEqual({ name: "gpui", version: "0.1.0", edition: "2024", license: "GPL-3.0-or-later" });
		expect(parsed.lints).toBeUndefined();
		expect(parsed.dependencies).toEqual({
			anyhow: "1.0.0",
			collections: { path: "../collections", features: ["test-support"] },
			gpui_wgpu: { path: "../gpui_wgpu", optional: true },
			wgpu: { version: "27", "default-features": false, features: ["wgsl", "naga"] },
			scap: {
				git: "https://example.invalid/scap",
				rev: "abc",
				package: "zed-scap",
				"default-features": false,
				optional: true,
			},
		});
		expect(parsed["dev-dependencies"]).toEqual({ rand: "0.9" });
	});

	test("a workspace dependency the root does not declare fails loud", () => {
		expect(() => resolveDependency("missing", { workspace: true }, WORKSPACE_DEPS)).toThrow(
			"Workspace dependency 'missing' not found",
		);
		expect(() =>
			rewriteManifest('[package]\nname = "x"\nhomepage.workspace = true\n', "x", WORKSPACE_PACKAGE, WORKSPACE_DEPS),
		).toThrow("Workspace package key 'homepage' not found");
	});

	test("a plain version renders as a string and a table keeps key order", () => {
		expect(formatDependencyLine("anyhow", { version: "1" })).toBe('anyhow = "1"');
		expect(formatDependencyLine("wgpu", { features: ["a"], version: "27", "default-features": false })).toBe(
			'wgpu = { version = "27", default-features = false, features = ["a"] }',
		);
	});
});

describe("the vendored closure", () => {
	const repoRoot = path.resolve(import.meta.dirname, "..");

	test("is excluded from the workspace and formatter and present on disk at the recorded commit", async () => {
		const rootToml = Bun.TOML.parse(await fs.readFile(path.join(repoRoot, "Cargo.toml"), "utf8")) as {
			workspace: { exclude: string[] };
		};
		const excluded = new Set(rootToml.workspace.exclude);
		const notExcluded = CRATES_TO_VENDOR.map(c => `crates/vendor/${c.name}`).filter(p => !excluded.has(p));
		expect(notExcluded).toEqual([]);

		const rustfmt = Bun.TOML.parse(await fs.readFile(path.join(repoRoot, "rustfmt.toml"), "utf8")) as {
			ignore: string[];
		};
		const ignored = new Set(rustfmt.ignore);
		const formatted = CRATES_TO_VENDOR.map(c => `crates/vendor/${c.name}/**`).filter(p => !ignored.has(p));
		expect(formatted).toEqual([]);

		const rev = (await fs.readFile(path.join(repoRoot, "crates/vendor/GPUI_VENDOR_REV"), "utf8")).trim();
		expect(rev).toMatch(/^[0-9a-f]{40}$/);

		for (const crate of CRATES_TO_VENDOR) {
			const manifest = await fs.readFile(path.join(repoRoot, "crates/vendor", crate.name, "Cargo.toml"), "utf8");
			expect(manifest, crate.name).not.toContain("workspace = true");
			const parsed = Bun.TOML.parse(manifest) as { workspace?: Record<string, unknown> };
			expect(parsed.workspace, crate.name).toEqual({});
		}
	});
});
