/**
 * Locks the PR changelog gate (scripts/require-changelog.ts). The gate exists so
 * a source change can never merge without propagating to that package's
 * `## [Unreleased]` changelog section — the mechanical guarantee behind
 * "adding a feature always reaches the changelog" once outside contributors,
 * not just maintainers, are opening PRs. Every branch that decides pass/fail is
 * asserted on real values here: which files count as shipped source and whether
 * the Unreleased section actually gained an entry. There is no skip marker to
 * test, and the case that used to prove one waived the whole range is now the
 * case that proves un-logged source is flagged no matter what a commit message
 * says. If any of these regressed, the gate would either wave through un-logged
 * features or block honest PRs, and one of these cases goes red.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	type ChangelogPackage,
	discoverPackages,
	evaluateChangelogRequirement,
	shippedSourceChanges,
	unreleasedGainedEntry,
} from "./require-changelog";

const PACKAGES: ChangelogPackage[] = [
	{ dir: "packages/coding-agent", name: "@veyyon/coding-agent" },
	{ dir: "packages/ai", name: "@veyyon/ai" },
];

describe("shippedSourceChanges", () => {
	it("counts source files under the package and ignores unrelated packages", () => {
		const changed = [
			"packages/coding-agent/src/task/executor.ts",
			"packages/ai/src/provider.ts",
			"scripts/release.ts",
		];
		expect(shippedSourceChanges("packages/coding-agent", changed)).toEqual([
			"packages/coding-agent/src/task/executor.ts",
		]);
	});

	it("does not let a prefix package swallow a sibling with a longer name", () => {
		// `packages/ai` must not match `packages/ai-extras/...`; the trailing slash
		// in the prefix is what prevents it, and this asserts that boundary.
		const changed = ["packages/ai-extras/src/thing.ts"];
		expect(shippedSourceChanges("packages/ai", changed)).toEqual([]);
	});

	it("treats tests, fixtures, docs, and metadata as non-shipping", () => {
		const changed = [
			"packages/ai/test/provider.test.ts",
			"packages/ai/src/provider.spec.ts",
			"packages/ai/__mocks__/net.ts",
			"packages/ai/__snapshots__/x.snap",
			"packages/ai/fixtures/sample.json",
			"packages/ai/README.md",
			"packages/ai/package.json",
			"packages/ai/tsconfig.json",
			"packages/ai/tsconfig.build.json",
		];
		expect(shippedSourceChanges("packages/ai", changed)).toEqual([]);
	});

	it("still counts a real source file next to ignored ones", () => {
		const changed = ["packages/ai/test/provider.test.ts", "packages/ai/src/provider.ts"];
		expect(shippedSourceChanges("packages/ai", changed)).toEqual(["packages/ai/src/provider.ts"]);
	});

	it("counts a non-config json data file under src as source", () => {
		// Data (catalog tables, rule files) drives shipped behavior; only
		// package.json and tsconfig*.json are exempted, not all json.
		const changed = ["packages/ai/src/models.json"];
		expect(shippedSourceChanges("packages/ai", changed)).toEqual(["packages/ai/src/models.json"]);
	});
});

describe("unreleasedGainedEntry", () => {
	it("is true when a new bullet is added", () => {
		expect(unreleasedGainedEntry(["- Old."], ["- Old.", "- New feature."])).toBe(true);
	});

	it("is true when an existing bullet is reworded (new wording is a fresh string)", () => {
		expect(unreleasedGainedEntry(["- Old wording."], ["- New wording."])).toBe(true);
	});

	it("is false when nothing changed", () => {
		expect(unreleasedGainedEntry(["- Same."], ["- Same."])).toBe(false);
	});

	it("is false when a bullet was only deleted", () => {
		// Removing an entry while touching source must NOT satisfy the gate.
		expect(unreleasedGainedEntry(["- A.", "- B."], ["- A."])).toBe(false);
	});

	it("is true when a duplicate bullet's count increases", () => {
		expect(unreleasedGainedEntry(["- Dup."], ["- Dup.", "- Dup."])).toBe(true);
	});

	it("is true from an empty base (a brand-new package's first entry)", () => {
		expect(unreleasedGainedEntry([], ["- First entry."])).toBe(true);
	});
});

describe("evaluateChangelogRequirement", () => {
	const baseEmpty = new Map<string, string[]>([
		["packages/coding-agent", []],
		["packages/ai", []],
	]);

	function headWith(dir: string, bullets: string[]): Map<string, string[]> {
		const head = new Map<string, string[]>([
			["packages/coding-agent", []],
			["packages/ai", []],
		]);
		head.set(dir, bullets);
		return head;
	}

	it("flags a source change with no changelog entry, naming the file to edit", () => {
		const violations = evaluateChangelogRequirement({
			changedFiles: ["packages/coding-agent/src/task/executor.ts"],
			packages: PACKAGES,
			baseUnreleased: baseEmpty,
			headUnreleased: headWith("packages/coding-agent", []),
		});
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatchObject({
			dir: "packages/coding-agent",
			name: "@veyyon/coding-agent",
			changelogPath: "packages/coding-agent/CHANGELOG.md",
			sourceFiles: ["packages/coding-agent/src/task/executor.ts"],
		});
	});

	it("passes when the touched package added an Unreleased bullet", () => {
		const violations = evaluateChangelogRequirement({
			changedFiles: ["packages/coding-agent/src/task/executor.ts"],
			packages: PACKAGES,
			baseUnreleased: baseEmpty,
			headUnreleased: headWith("packages/coding-agent", ["- Fixed the streaming display seam."]),
		});
		expect(violations).toEqual([]);
	});

	it("does not require an entry when the base already carried the same bullet (prior PR) and this PR added none", () => {
		// Two PRs merge before a release: PR #2 touches source but the Unreleased
		// section is non-empty only because PR #1 filled it. The gate must still
		// fire, because head did not GAIN a bullet over base.
		const carried = ["- Entry from an earlier merged PR."];
		const base = new Map<string, string[]>([
			["packages/coding-agent", carried],
			["packages/ai", []],
		]);
		const violations = evaluateChangelogRequirement({
			changedFiles: ["packages/coding-agent/src/task/executor.ts"],
			packages: PACKAGES,
			baseUnreleased: base,
			headUnreleased: headWith("packages/coding-agent", carried),
		});
		expect(violations).toHaveLength(1);
		expect(violations[0]?.dir).toBe("packages/coding-agent");
	});

	it("passes a test-only change with no source and no changelog", () => {
		const violations = evaluateChangelogRequirement({
			changedFiles: ["packages/coding-agent/test/executor.test.ts"],
			packages: PACKAGES,
			baseUnreleased: baseEmpty,
			headUnreleased: headWith("packages/coding-agent", []),
		});
		expect(violations).toEqual([]);
	});

	it("flags un-logged source no matter what the commit messages say", () => {
		// The gate used to read commit messages for a `[skip changelog]` marker, and a
		// bare one waived every package in the range. It reads no messages at all now,
		// so there is nothing a commit can say to make this pass but a changelog entry.
		const violations = evaluateChangelogRequirement({
			changedFiles: ["packages/coding-agent/src/task/executor.ts", "packages/ai/src/provider.ts"],
			packages: PACKAGES,
			baseUnreleased: baseEmpty,
			headUnreleased: headWith("packages/coding-agent", []),
		});
		expect(violations.map(v => v.dir).sort()).toEqual(["packages/ai", "packages/coding-agent"]);
	});

	it("passes cleanly when a PR touches only scripts and docs, not packages", () => {
		const violations = evaluateChangelogRequirement({
			changedFiles: ["scripts/release.ts", "AGENTS.md", "README.md"],
			packages: PACKAGES,
			baseUnreleased: baseEmpty,
			headUnreleased: baseEmpty,
		});
		expect(violations).toEqual([]);
	});
});

/**
 * End-to-end: run the real `scripts/require-changelog.ts` against a throwaway git
 * repo, so the whole shell — base resolution, the three-dot diff, per-package
 * changelog reads, skip-marker parsing, and the process exit code — is proven
 * together, not just the pure core. This is the artifact that would catch a
 * plumbing regression the unit tests cannot see (a wrong git invocation, a bad
 * exit code, a base ref that silently resolves to nothing).
 */
describe("require-changelog.ts end to end against a real repo", () => {
	const scriptPath = path.join(import.meta.dir, "require-changelog.ts");

	async function makeRepo(): Promise<{ root: string; git: (...a: string[]) => ReturnType<typeof $> }> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "clog-gate-"));
		const git = (...args: string[]) =>
			$`git ${args}`
				.cwd(root)
				.quiet()
				.env({
					...process.env,
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_SYSTEM: "/dev/null",
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@t",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@t",
				});
		await git("init", "-b", "main");
		await Bun.write(path.join(root, "packages/foo/package.json"), JSON.stringify({ name: "@scope/foo" }));
		await Bun.write(
			path.join(root, "packages/foo/CHANGELOG.md"),
			["# Changelog", "", "## [Unreleased]", "", "## [1.0.0] - 2026-01-01", "", "### Added", "", "- Base.", ""].join(
				"\n",
			),
		);
		await Bun.write(path.join(root, "packages/foo/src/index.ts"), "export const v = 1;\n");
		await git("add", "-A");
		await git("commit", "-m", "base");
		return { root, git };
	}

	function run(root: string, base: string) {
		return $`bun ${scriptPath}`
			.cwd(root)
			.env({ ...process.env, CHANGELOG_BASE: base })
			.quiet()
			.nothrow();
	}

	it("exits nonzero and names the package when source changes without a changelog entry", async () => {
		const { root, git } = await makeRepo();
		try {
			const base = (await git("rev-parse", "HEAD").text()).trim();
			await Bun.write(path.join(root, "packages/foo/src/index.ts"), "export const v = 2;\n");
			await git("add", "-A");
			await git("commit", "-m", "change source, forget changelog");

			const result = await run(root, base);
			expect(result.exitCode).toBe(1);
			const err = result.stderr.toString();
			expect(err).toContain("packages/foo/CHANGELOG.md");
			expect(err).toContain("@scope/foo");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("exits zero when the same source change adds an Unreleased bullet", async () => {
		const { root, git } = await makeRepo();
		try {
			const base = (await git("rev-parse", "HEAD").text()).trim();
			await Bun.write(path.join(root, "packages/foo/src/index.ts"), "export const v = 2;\n");
			await Bun.write(
				path.join(root, "packages/foo/CHANGELOG.md"),
				[
					"# Changelog",
					"",
					"## [Unreleased]",
					"",
					"### Changed",
					"",
					"- Bumped the value.",
					"",
					"## [1.0.0] - 2026-01-01",
					"",
					"### Added",
					"",
					"- Base.",
					"",
				].join("\n"),
			);
			await git("add", "-A");
			await git("commit", "-m", "change source with changelog");

			const result = await run(root, base);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString()).toContain("ok");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("exits nonzero for un-logged source even when a commit message asks to skip", async () => {
		// The exact message that used to buy a pass. It buys nothing now, and this is
		// the e2e half of the removal: the parser is gone, so the marker is just text.
		const { root, git } = await makeRepo();
		try {
			const base = (await git("rev-parse", "HEAD").text()).trim();
			await Bun.write(path.join(root, "packages/foo/src/index.ts"), "export const v = 2;\n");
			await git("add", "-A");
			await git("commit", "-m", "internal refactor\n\n[skip changelog]");

			const result = await run(root, base);
			expect(result.exitCode).toBe(1);
			expect(result.stderr.toString()).toContain("packages/foo/CHANGELOG.md");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("exits nonzero when the base ref cannot be resolved, never silently passing", async () => {
		const { root } = await makeRepo();
		try {
			const result = await run(root, "origin/does-not-exist");
			expect(result.exitCode).toBe(1);
			expect(result.stderr.toString()).toContain("cannot resolve base ref");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

/**
 * `discoverPackages` decides WHICH packages the gate covers, so a package it quietly leaves out is
 * a package whose source ships with no changelog requirement at all. That is exactly what happened:
 * `argot` and `@veyyon/tool-render` were publishable with no `CHANGELOG.md`, the old code skipped
 * them with a bare `continue`, and nothing anywhere said the gate was incomplete. These lock the
 * replacement rule — publishable means gated, and the only way out is `"private": true`.
 */
describe("discoverPackages", () => {
	async function makeTree(
		packages: Array<{ dir: string; manifest: Record<string, unknown>; changelog?: string }>,
	): Promise<string> {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "clog-discover-"));
		for (const pkg of packages) {
			await Bun.write(path.join(root, "packages", pkg.dir, "package.json"), JSON.stringify(pkg.manifest));
			if (pkg.changelog !== undefined) {
				await Bun.write(path.join(root, "packages", pkg.dir, "CHANGELOG.md"), pkg.changelog);
			}
		}
		return root;
	}

	const CHANGELOG = ["# Changelog", "", "## [Unreleased]", ""].join("\n");

	it("returns every publishable package that has a changelog, in path order", async () => {
		const root = await makeTree([
			{ dir: "zed", manifest: { name: "@scope/zed" }, changelog: CHANGELOG },
			{ dir: "alpha", manifest: { name: "@scope/alpha" }, changelog: CHANGELOG },
		]);
		try {
			expect(await discoverPackages(root)).toEqual([
				{ dir: "packages/alpha", name: "@scope/alpha" },
				{ dir: "packages/zed", name: "@scope/zed" },
			]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("throws and names the missing file when a publishable package has no changelog", async () => {
		const root = await makeTree([
			{ dir: "gated", manifest: { name: "@scope/gated" }, changelog: CHANGELOG },
			{ dir: "ungated", manifest: { name: "@scope/ungated" } },
		]);
		try {
			await expect(discoverPackages(root)).rejects.toThrow("packages/ungated/CHANGELOG.md (@scope/ungated)");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("lists every missing changelog at once rather than stopping at the first", async () => {
		const root = await makeTree([
			{ dir: "one", manifest: { name: "@scope/one" } },
			{ dir: "two", manifest: { name: "@scope/two" } },
		]);
		try {
			await discoverPackages(root);
			throw new Error("expected discoverPackages to reject");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("packages/one/CHANGELOG.md (@scope/one)");
			expect(message).toContain("packages/two/CHANGELOG.md (@scope/two)");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("leaves a private package alone, changelog or not, because it is never published", async () => {
		const root = await makeTree([
			{ dir: "internal", manifest: { name: "@scope/internal", private: true } },
			{ dir: "shipped", manifest: { name: "@scope/shipped" }, changelog: CHANGELOG },
		]);
		try {
			expect(await discoverPackages(root)).toEqual([{ dir: "packages/shipped", name: "@scope/shipped" }]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("falls back to the directory when a manifest has no name, so the message still points somewhere", async () => {
		const root = await makeTree([{ dir: "nameless", manifest: {} }]);
		try {
			await expect(discoverPackages(root)).rejects.toThrow("packages/nameless/CHANGELOG.md (packages/nameless)");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
