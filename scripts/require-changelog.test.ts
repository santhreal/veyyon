/**
 * Locks the PR changelog gate (scripts/require-changelog.ts). The gate exists so
 * a source change can never merge without propagating to that package's
 * `## [Unreleased]` changelog section — the mechanical guarantee behind
 * "adding a feature always reaches the changelog" once outside contributors,
 * not just maintainers, are opening PRs. Every branch that decides pass/fail is
 * asserted on real values here: which files count as shipped source, whether the
 * Unreleased section actually gained an entry, and how the `[skip changelog]`
 * escape hatch is parsed and scoped. If any of these regressed, the gate would
 * either wave through un-logged features or block honest PRs, and one of these
 * cases goes red.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	type ChangelogPackage,
	evaluateChangelogRequirement,
	parseSkipMarkers,
	parseUnreleasedBullets,
	resolveSkipDirs,
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

describe("parseUnreleasedBullets", () => {
	it("collects only bullets under Unreleased, stopping at the next release heading", () => {
		const content = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"",
			"- Unreleased one.",
			"- Unreleased two.",
			"",
			"## [1.0.0] - 2026-01-01",
			"",
			"### Added",
			"",
			"- Released, must be ignored.",
			"",
		].join("\n");
		expect(parseUnreleasedBullets(content)).toEqual(["- Unreleased one.", "- Unreleased two."]);
	});

	it("returns empty for an Unreleased section with only headings", () => {
		const content = ["# Changelog", "", "## [Unreleased]", "", "## [1.0.0] - 2026-01-01", ""].join("\n");
		expect(parseUnreleasedBullets(content)).toEqual([]);
	});

	it("returns empty for a missing or empty changelog (a new package at base)", () => {
		expect(parseUnreleasedBullets("")).toEqual([]);
	});
});

describe("parseSkipMarkers", () => {
	it("detects a bare global skip", () => {
		const result = parseSkipMarkers("chore: internal refactor\n\n[skip changelog]");
		expect(result.skipAll).toBe(true);
		expect([...result.skipTokens]).toEqual([]);
	});

	it("detects a scoped skip with a colon", () => {
		const result = parseSkipMarkers("refactor internals [skip changelog: coding-agent]");
		expect(result.skipAll).toBe(false);
		expect([...result.skipTokens]).toEqual(["coding-agent"]);
	});

	it("accepts the hyphenated spelling and parenthesized scope", () => {
		const result = parseSkipMarkers("[skip-changelog(packages/ai)]");
		expect([...result.skipTokens]).toEqual(["packages/ai"]);
	});

	it("collects multiple scoped skips and no global when all are scoped", () => {
		const result = parseSkipMarkers("a [skip changelog: ai]\nb [skip changelog: coding-agent]");
		expect(result.skipAll).toBe(false);
		expect([...result.skipTokens].sort()).toEqual(["ai", "coding-agent"]);
	});

	it("finds no markers in an ordinary message", () => {
		const result = parseSkipMarkers("feat: add a real feature with a changelog entry");
		expect(result.skipAll).toBe(false);
		expect([...result.skipTokens]).toEqual([]);
	});
});

describe("resolveSkipDirs", () => {
	it("resolves a token by bare basename, full dir, and package name", () => {
		expect([...resolveSkipDirs(["coding-agent"], PACKAGES)]).toEqual(["packages/coding-agent"]);
		expect([...resolveSkipDirs(["packages/ai"], PACKAGES)]).toEqual(["packages/ai"]);
		expect([...resolveSkipDirs(["@veyyon/ai"], PACKAGES)]).toEqual(["packages/ai"]);
	});

	it("ignores a token that matches no package", () => {
		expect([...resolveSkipDirs(["nonexistent"], PACKAGES)]).toEqual([]);
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
			skipAll: false,
			skipDirs: new Set(),
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
			skipAll: false,
			skipDirs: new Set(),
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
			skipAll: false,
			skipDirs: new Set(),
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
			skipAll: false,
			skipDirs: new Set(),
		});
		expect(violations).toEqual([]);
	});

	it("waives the whole PR under a global skip even with un-logged source", () => {
		const violations = evaluateChangelogRequirement({
			changedFiles: ["packages/coding-agent/src/task/executor.ts", "packages/ai/src/provider.ts"],
			packages: PACKAGES,
			baseUnreleased: baseEmpty,
			headUnreleased: headWith("packages/coding-agent", []),
			skipAll: true,
			skipDirs: new Set(),
		});
		expect(violations).toEqual([]);
	});

	it("waives only the scoped package and still flags the other", () => {
		const violations = evaluateChangelogRequirement({
			changedFiles: ["packages/coding-agent/src/task/executor.ts", "packages/ai/src/provider.ts"],
			packages: PACKAGES,
			baseUnreleased: baseEmpty,
			headUnreleased: baseEmpty,
			skipAll: false,
			skipDirs: new Set(["packages/coding-agent"]),
		});
		expect(violations).toHaveLength(1);
		expect(violations[0]?.dir).toBe("packages/ai");
	});

	it("flags every offending package when several change source without entries", () => {
		const violations = evaluateChangelogRequirement({
			changedFiles: ["packages/coding-agent/src/a.ts", "packages/ai/src/b.ts"],
			packages: PACKAGES,
			baseUnreleased: baseEmpty,
			headUnreleased: baseEmpty,
			skipAll: false,
			skipDirs: new Set(),
		});
		expect(violations.map(v => v.dir).sort()).toEqual(["packages/ai", "packages/coding-agent"]);
	});

	it("passes cleanly when a PR touches only scripts and docs, not packages", () => {
		const violations = evaluateChangelogRequirement({
			changedFiles: ["scripts/release.ts", "AGENTS.md", "README.md"],
			packages: PACKAGES,
			baseUnreleased: baseEmpty,
			headUnreleased: baseEmpty,
			skipAll: false,
			skipDirs: new Set(),
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

	it("exits zero when a [skip changelog] marker waives an un-logged source change", async () => {
		const { root, git } = await makeRepo();
		try {
			const base = (await git("rev-parse", "HEAD").text()).trim();
			await Bun.write(path.join(root, "packages/foo/src/index.ts"), "export const v = 2;\n");
			await git("add", "-A");
			await git("commit", "-m", "internal refactor\n\n[skip changelog]");

			const result = await run(root, base);
			expect(result.exitCode).toBe(0);
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
