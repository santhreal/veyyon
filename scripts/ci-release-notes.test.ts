import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	compareVersions,
	enumerateChangelogVersions,
	formatCommitSummary,
	groupCommitsByType,
	mergePackageSection,
} from "./ci-release-notes";

const FIXTURE = [
	"# Changelog",
	"",
	"## [Unreleased]",
	"",
	"### Added",
	"",
	"- Unreleased entry not in any tag yet.",
	"",
	"## [15.13.0] - 2026-06-14",
	"",
	"### Fixed",
	"",
	"- Fixed unknown `--`-prefixed flags being silently consumed as prompt text.",
	"- Fixed something only in 15.13.0.",
	"",
	"### Removed",
	"",
	"- Removed a deprecated thing in 15.13.0.",
	"",
	"## [15.12.6] - 2026-06-14",
	"",
	"### Breaking Changes",
	"",
	"- Removed `writeLine`/`writeLineSync` from the public SessionStorageWriter contract.",
	"",
	"### Added",
	"",
	"- Added package-level exports for session context.",
	"",
	"## [15.12.5] - 2026-06-13",
	"",
	"### Changed",
	"",
	"- Changed terminal resize handling to paint only the visible viewport.",
	"",
	"### Fixed",
	"",
	"- Fixed unknown `--`-prefixed flags being silently consumed as prompt text.",
	"",
	"## [15.12.4] - 2026-06-13",
	"",
	"### Added",
	"",
	"- Predates the silent-tag window; must not appear when floor=15.12.4.",
	"",
].join("\n");

describe("compareVersions", () => {
	it("orders semver tags numerically across all components", () => {
		expect(compareVersions("15.12.5", "15.13.0") < 0).toBe(true);
		expect(compareVersions("v15.13.0", "15.12.6") > 0).toBe(true);
		expect(compareVersions("15.12.6", "15.12.6") === 0).toBe(true);
		// Numeric (not lexicographic) — 15.2.0 < 15.13.0.
		expect(compareVersions("15.2.0", "15.13.0") < 0).toBe(true);
	});

	it("orders a prerelease against released versions instead of calling everything equal", () => {
		// REGRESSION: this comparator used to match `X.Y.Z` only and return 0 for
		// anything else, meaning "same version". A prerelease target compared equal
		// to every released version, so mergePackageSection selected the whole
		// changelog and the release notes for an rc contained the entire history.
		expect(compareVersions("1.2.1-rc.1", "1.2.0") > 0).toBe(true);
		expect(compareVersions("1.2.1-rc.1", "1.2.1") < 0).toBe(true);
		expect(compareVersions("1.0.0", "1.2.1-rc.1") < 0).toBe(true);
		expect(compareVersions("1.2.1-rc.1", "1.2.1-rc.1") === 0).toBe(true);
	});
});

describe("mergePackageSection with a prerelease target", () => {
	it("selects no released section for a prerelease that has none of its own", () => {
		// The concrete failure the comparator bug produced: every released section
		// compared equal to the rc target and was merged into its notes.
		const changelog = ["## [1.2.0]", "### Added", "- older feature", "", "## [1.1.0]", "### Added", "- oldest"].join(
			"\n",
		);

		expect(mergePackageSection(changelog, null, "1.2.1-rc.1")).toBe("");
	});

	it("still selects the range below a prerelease when a floor is given", () => {
		const changelog = ["## [1.2.0]", "### Added", "- newer", "", "## [1.1.0]", "### Added", "- older"].join("\n");

		const merged = mergePackageSection(changelog, "1.1.0", "1.2.1-rc.1");

		expect(merged).toContain("- newer");
		expect(merged).not.toContain("- older");
	});
});

describe("enumerateChangelogVersions", () => {
	it("returns every semver heading in document order, skipping Unreleased", () => {
		const spans = enumerateChangelogVersions(FIXTURE);
		expect(spans.map(s => s.version)).toEqual(["15.13.0", "15.12.6", "15.12.5", "15.12.4"]);
	});

	it("bounds each span by the next `## [` heading (Unreleased included as boundary)", () => {
		const spans = enumerateChangelogVersions(FIXTURE);
		const lines = FIXTURE.split("\n");
		for (const span of spans) {
			expect(lines[span.start]).toMatch(/^## \[\d+\.\d+\.\d+\]/);
			// Body never bleeds into the next heading.
			for (let i = span.start + 1; i < span.end; i++) {
				expect(lines[i].startsWith("## [")).toBe(false);
			}
		}
	});
});

describe("mergePackageSection", () => {
	it("includes every silent-tag section above floor up to target inclusive", () => {
		const merged = mergePackageSection(FIXTURE, "15.12.4", "15.13.0");
		// 15.12.6 and 15.12.5 unique fingerprints must land.
		expect(merged).toContain("Removed `writeLine`/`writeLineSync` from the public SessionStorageWriter contract.");
		expect(merged).toContain("Added package-level exports for session context.");
		expect(merged).toContain("Changed terminal resize handling to paint only the visible viewport.");
		// 15.12.4 entry stays excluded — it is the floor.
		expect(merged).not.toContain("Predates the silent-tag window");
		// Unreleased never leaks.
		expect(merged).not.toContain("Unreleased entry");
	});

	it("dedupes bullets flattened forward into multiple versions", () => {
		const merged = mergePackageSection(FIXTURE, "15.12.4", "15.13.0");
		const dupRegex = /Fixed unknown `--`-prefixed flags being silently consumed as prompt text\./g;
		expect(merged.match(dupRegex)?.length).toBe(1);
	});

	it("groups bullets under the canonical category order regardless of source-version order", () => {
		const merged = mergePackageSection(FIXTURE, "15.12.4", "15.13.0");
		// Expected canonical order: Breaking Changes → Added → Changed → Fixed → Removed.
		const headings = [...merged.matchAll(/^### (.+)$/gm)].map(m => m[1]);
		expect(headings).toEqual(["Breaking Changes", "Added", "Changed", "Fixed", "Removed"]);
	});

	it("floor=null reproduces single-version (legacy) extraction for the target", () => {
		const merged = mergePackageSection(FIXTURE, null, "15.13.0");
		expect(merged).toContain("Fixed something only in 15.13.0");
		expect(merged).toContain("Removed a deprecated thing in 15.13.0");
		// Anything below the target stays out when no floor is set.
		expect(merged).not.toContain("writeLine");
		expect(merged).not.toContain("Added package-level exports");
	});

	it("returns empty string when no version in the requested range carries body content", () => {
		const empty = ["# Changelog", "", "## [15.13.0] - 2026-06-14", "", "## [15.12.6] - 2026-06-14"].join("\n");
		expect(mergePackageSection(empty, "15.12.5", "15.13.0")).toBe("");
	});

	it("never emits a category with only blank/whitespace bullets after dedup", () => {
		// If 15.13.0 already pulled the only Fixed bullet, an older section
		// contributing the identical bullet must not produce an empty
		// `### Fixed` heading by itself.
		const merged = mergePackageSection(FIXTURE, "15.12.4", "15.13.0");
		expect(merged).not.toMatch(/### Fixed\s*\n\s*(### |$)/);
	});
});

describe("ci-release-notes.ts must run without a workspace install", () => {
	it("imports no @veyyon/* workspace package (release_github does not `bun install`)", () => {
		// The release_github job ("Publish GitHub release") checks out the repo and
		// sets up bun but does NOT run `bun install`, so the workspace symlinks
		// node_modules/@veyyon/* do not exist. A bare workspace import in this
		// script crashes the job with "Cannot find module '@veyyon/...'" and blocks
		// the publish — it did on the FIRST release_github run to complete (v1.0.20:
		// `import { compareSemver } from "@veyyon/utils/semver"`), so nothing shipped.
		// Cross-package helpers must be imported by relative path (semver.ts is
		// self-contained, so a direct file import resolves with no install).
		const src = fs.readFileSync(path.join(import.meta.dir, "ci-release-notes.ts"), "utf8");
		const workspaceImports = [...src.matchAll(/\bfrom\s+["'](@veyyon\/[^"']+)["']/g)].map(m => m[1]);
		expect(workspaceImports).toEqual([]);
	});
});

// The commit-history summary is the answer to "400 commits since forking says
// nothing more than a one-line changelog": with straight-to-main pushes there
// are few PRs for `generate_release_notes` and only a handful of hand-written
// CHANGELOG bullets, so the release body was near-empty even when dozens of real
// commits landed. `groupCommitsByType`/`formatCommitSummary` derive a grouped
// overview from the commit range so every release reflects its actual work. These
// tests lock the grouping, ordering, dedup, breaking/other fallbacks, and the
// "commits-only release still gets a body" guarantee.
describe("groupCommitsByType", () => {
	it("buckets conventional-commit types under their headings in canonical order", () => {
		// Input order is deliberately shuffled across types to prove the OUTPUT
		// order is HEADING_ORDER (Features, Fixes, Performance, ...), not input order.
		const sections = groupCommitsByType([
			"fix(onboarding): run the setup wizard on first install only",
			"perf(scan): reuse the prefilter buffer across files",
			"feat(rollback): add an interactive version picker",
			"docs: document get.veyyon.dev install",
			"feat: aggregate release notes from commits",
		]);
		expect(sections.map(s => s.heading)).toEqual(["Features", "Fixes", "Performance", "Documentation"]);
		expect(sections[0].subjects).toEqual([
			"feat(rollback): add an interactive version picker",
			"feat: aggregate release notes from commits",
		]);
		expect(sections[1].subjects).toEqual(["fix(onboarding): run the setup wizard on first install only"]);
	});

	it("routes a `!` breaking marker to Breaking Changes above every other section", () => {
		// `feat!:`/`fix(x)!:` mean a breaking change regardless of base type, and a
		// release's breaking notes must lead. Assert both the routing and the order.
		const sections = groupCommitsByType(["feat(api)!: drop the legacy writeLine contract", "fix: correct a typo"]);
		expect(sections.map(s => s.heading)).toEqual(["Breaking Changes", "Fixes"]);
		expect(sections[0].subjects).toEqual(["feat(api)!: drop the legacy writeLine contract"]);
	});

	it("puts non-conventional subjects in Other changes so nothing is dropped", () => {
		// A bare subject with no `type:` prefix must still appear — dropping it would
		// silently hide real work from the release notes.
		const sections = groupCommitsByType(["Merge branch mess", "wip stuff", "fix: real fix"]);
		expect(sections.map(s => s.heading)).toEqual(["Fixes", "Other changes"]);
		expect(sections.find(s => s.heading === "Other changes")?.subjects).toEqual(["Merge branch mess", "wip stuff"]);
	});

	it("deduplicates identical subjects and ignores blank lines", () => {
		// A cherry-pick or forward-merge repeats a subject; git output can carry blank
		// lines. Neither may produce a duplicate or empty bullet.
		const sections = groupCommitsByType(["fix: dup me", "", "  ", "fix: dup me", "fix: distinct"]);
		expect(sections).toHaveLength(1);
		expect(sections[0].subjects).toEqual(["fix: dup me", "fix: distinct"]);
	});

	it("maps build and ci to one Build & CI section and chore/style to Chores", () => {
		const sections = groupCommitsByType([
			"ci: pin the runner",
			"build: bump the native toolchain",
			"chore: tidy deps",
			"style: reformat",
		]);
		expect(sections.map(s => s.heading)).toEqual(["Build & CI", "Chores"]);
		expect(sections[0].subjects).toEqual(["ci: pin the runner", "build: bump the native toolchain"]);
		expect(sections[1].subjects).toEqual(["chore: tidy deps", "style: reformat"]);
	});
});

describe("formatCommitSummary", () => {
	it("renders a count line with the floor version and grouped bullets", () => {
		const body = formatCommitSummary(
			["feat: add a picker", "fix: stop re-onboarding", "fix: stop re-onboarding"],
			"1.0.22",
		);
		expect(body).toBe(
			[
				"## What changed",
				"",
				"_2 commits since v1.0.22._",
				"",
				"### Features",
				"",
				"- feat: add a picker",
				"",
				"### Fixes",
				"",
				"- fix: stop re-onboarding",
			].join("\n"),
		);
	});

	it("uses the singular 'commit' and omits the since-clause for the first release", () => {
		const body = formatCommitSummary(["feat: first ever"], null);
		expect(body).toContain("_1 commit._");
		expect(body).not.toContain("since");
	});

	it("returns an empty string when there are no commits, so the caller can skip it", () => {
		expect(formatCommitSummary([], "1.0.22")).toBe("");
		expect(formatCommitSummary(["", "   "], "1.0.22")).toBe("");
	});
});

// Adversarial and boundary cases for the type parser. Commit subjects in the
// wild are messy: uppercase types, colons inside the description, nested
// parens in the scope, unknown-but-conventional-looking prefixes, and the
// `revert`/`perf` families. Each of these has silently mis-bucketed a commit in
// other changelog generators; these lock the exact bucket so a parser change
// can't quietly move real work into "Other changes" (or drop it).
describe("groupCommitsByType adversarial parsing", () => {
	it("lowercases the type so an uppercase prefix still buckets correctly", () => {
		// A `Fix:`/`FEAT:` subject is still a fix/feature; the type match must be
		// case-insensitive or the commit lands in Other changes.
		const sections = groupCommitsByType(["Fix: uppercase type", "FEAT: shouty feature"]);
		expect(sections.map(s => s.heading)).toEqual(["Features", "Fixes"]);
	});

	it("keeps a colon inside the description without splitting the subject", () => {
		// The description itself often contains a colon ("fix: parse a:b pairs").
		// Only the FIRST `:` after the type/scope delimits; the rest is prose.
		const sections = groupCommitsByType(["fix: parse key:value pairs correctly"]);
		expect(sections[0].heading).toBe("Fixes");
		expect(sections[0].subjects).toEqual(["fix: parse key:value pairs correctly"]);
	});

	it("handles a scope containing parentheses-adjacent text and a breaking bang together", () => {
		const sections = groupCommitsByType(["refactor(core-api)!: collapse the two settings layers"]);
		expect(sections.map(s => s.heading)).toEqual(["Breaking Changes"]);
		expect(sections[0].subjects).toEqual(["refactor(core-api)!: collapse the two settings layers"]);
	});

	it("routes revert commits to a Reverts section", () => {
		const sections = groupCommitsByType(["revert: undo the risky prefilter change", "feat: keep this"]);
		expect(sections.map(s => s.heading)).toEqual(["Features", "Reverts"]);
	});

	it("treats an unknown conventional-looking prefix as Other, not as a new heading", () => {
		// `wip:`/`hotfix:` look conventional but are not in the type table. They must
		// fall to Other changes, never invent an ad-hoc heading.
		const sections = groupCommitsByType(["wip: half-done thing", "hotfix: urgent patch"]);
		expect(sections.map(s => s.heading)).toEqual(["Other changes"]);
		expect(sections[0].subjects).toEqual(["wip: half-done thing", "hotfix: urgent patch"]);
	});

	it("does not treat a bare word without a colon as a typed commit", () => {
		// "feat something" (no colon) is not a conventional commit; it is prose and
		// belongs in Other changes so the `feat` prefix can't smuggle it into Features.
		const sections = groupCommitsByType(["feat something with no colon"]);
		expect(sections.map(s => s.heading)).toEqual(["Other changes"]);
	});
});

// End-to-end: the unit tests above cover the pure grouping/merging, but nothing
// exercises `summarizeCommitRange` (the real `git log` call) or `main()`'s
// assembly of curated sections + commit summary + the "commits-only still gets a
// body" path. This suite builds a throwaway tagged git repo with real commits
// and package changelogs and runs the ACTUAL script, so a regression in the git
// invocation, the range boundaries, the section ordering, or the empty-body
// guard is caught here — the parts a pure-function test structurally cannot see.
describe("ci-release-notes end-to-end against a real tagged git repo", () => {
	const scriptPath = path.join(import.meta.dir, "ci-release-notes.ts");
	let repo: string;

	function git(args: string[], cwd: string): void {
		const res = Bun.spawnSync({
			cmd: ["git", ...args],
			cwd,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@example.com",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@example.com",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		if (res.exitCode !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
		}
	}

	function commit(subject: string): void {
		git(["commit", "--allow-empty", "-m", subject], repo);
	}

	/** Run the real generator in `repo` with an explicit floor, return the body. */
	function runNotes(target: string, floor: string): { code: number; body: string; stderr: string } {
		const out = path.join(repo, "notes.md");
		const res = Bun.spawnSync({
			cmd: ["bun", scriptPath, target, out],
			cwd: repo,
			env: { ...process.env, VEYYON_RELEASE_NOTES_FLOOR: floor },
			stdout: "pipe",
			stderr: "pipe",
		});
		const body = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
		return { code: res.exitCode, body, stderr: res.stderr.toString() };
	}

	beforeEach(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-notes-e2e-"));
		git(["init", "-q", "-b", "main"], repo);
		fs.mkdirSync(path.join(repo, "packages", "alpha"), { recursive: true });
		fs.writeFileSync(path.join(repo, "packages", "alpha", "package.json"), JSON.stringify({ name: "@veyyon/alpha" }));
	});

	afterEach(() => {
		fs.rmSync(repo, { recursive: true, force: true });
	});

	function writeChangelog(body: string): void {
		fs.writeFileSync(path.join(repo, "packages", "alpha", "CHANGELOG.md"), body);
	}

	it("emits curated sections then the commit summary for the (floor, target] range", () => {
		writeChangelog(
			[
				"# Changelog",
				"",
				"## [1.1.0]",
				"",
				"### Added",
				"",
				"- Added a shiny flag.",
				"",
				"## [1.0.0]",
				"",
				"### Added",
				"",
				"- Initial release.",
				"",
			].join("\n"),
		);
		git(["add", "-A"], repo);
		commit("feat: initial alpha release"); // this is AT v1.0.0, must be excluded
		git(["tag", "v1.0.0"], repo);
		commit("feat(cli): add a shiny flag");
		commit("fix(parser): stop dropping trailing args");
		commit("docs: explain the shiny flag");
		commit("chore: bump version to 1.1.0");
		git(["tag", "v1.1.0"], repo);

		const { code, body, stderr } = runNotes("v1.1.0", "1.0.0");
		expect(code).toBe(0);
		expect(stderr).not.toContain("Skipping the commit summary"); // git range resolved

		// Curated section from the changelog leads.
		expect(body).toContain("## @veyyon/alpha");
		expect(body).toContain("- Added a shiny flag.");
		// The commit summary follows and reflects exactly the 4 in-range commits.
		expect(body).toContain("## What changed");
		expect(body).toContain("_4 commits since v1.0.0._");
		expect(body).toContain("- feat(cli): add a shiny flag");
		expect(body).toContain("- fix(parser): stop dropping trailing args");
		expect(body).toContain("- docs: explain the shiny flag");
		// The v1.0.0 commit is at the floor and must NOT appear.
		expect(body).not.toContain("initial alpha release");
		// Ordering: curated package section precedes the derived summary.
		expect(body.indexOf("## @veyyon/alpha")).toBeLessThan(body.indexOf("## What changed"));
	});

	it("still writes a real body from commits alone when no changelog bullet exists", () => {
		// The "400 commits says nothing" case: a release whose changelog has no
		// in-range section. The body must NOT be empty — it carries the commit summary.
		writeChangelog(["# Changelog", "", "## [1.0.0]", "", "### Added", "", "- Initial release.", ""].join("\n"));
		git(["add", "-A"], repo);
		commit("chore: seed");
		git(["tag", "v1.0.0"], repo);
		commit("feat: a feature with no changelog entry");
		commit("fix: a fix with no changelog entry");
		git(["tag", "v1.1.0"], repo);

		const { code, body } = runNotes("v1.1.0", "1.0.0");
		expect(code).toBe(0);
		expect(body).not.toBe("");
		expect(body).toContain("## What changed");
		expect(body).toContain("_2 commits since v1.0.0._");
		expect(body).toContain("- feat: a feature with no changelog entry");
		// No curated package section, because no in-range changelog bullet exists.
		expect(body).not.toContain("## @veyyon/alpha");
	});

	it("degrades LOUDLY when the git range fails, still publishing curated sections (Law 10)", () => {
		// The commit summary is additive context, not a primary mechanism, so a git
		// failure (here: the target tag ref does not exist, as on a shallow checkout)
		// must NOT crash the release and must NOT silently drop to a smaller body. It
		// must warn loudly with the fetch-depth fix and still emit the curated
		// changelog section, so the release always publishes with real notes.
		writeChangelog(
			["# Changelog", "", "## [1.1.0]", "", "### Added", "", "- A curated bullet.", "", "## [1.0.0]", ""].join("\n"),
		);
		git(["add", "-A"], repo);
		commit("feat: seed");
		git(["tag", "v1.0.0"], repo);
		// Deliberately do NOT create the v1.1.0 tag, so `git log v1.0.0..v1.1.0` fails.

		const { code, body, stderr } = runNotes("v1.1.0", "1.0.0");
		expect(code).toBe(0); // release still succeeds
		expect(stderr).toContain("Skipping the commit summary");
		expect(stderr).toContain("fetch-depth: 0"); // the actionable fix is named
		expect(body).toContain("- A curated bullet."); // curated notes still ship
		expect(body).not.toContain("## What changed"); // summary skipped, not faked
	});

	it("writes an empty body only when there are neither changelog bullets nor commits in range", () => {
		// floor == target means an empty commit range and no new changelog section.
		writeChangelog(["# Changelog", "", "## [1.0.0]", "", "### Added", "", "- Initial release.", ""].join("\n"));
		git(["add", "-A"], repo);
		commit("chore: seed");
		git(["tag", "v1.0.0"], repo);

		const { code, body } = runNotes("v1.0.0", "1.0.0");
		expect(code).toBe(0);
		expect(body).toBe("");
	});
});
