import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyReleaseToChangelog } from "./release.ts";
import {
	assertPreparedReleaseChangelogs,
	assertReleaseIsDocumented,
	type PackageChangelog,
	preparedReleaseChangelogFailures,
	RELEASE_NOTES_CHANGELOG,
	undocumentedReleaseFailures,
} from "./release-policy.ts";

/**
 * Pins the changelog-roll contract: turning `## [Unreleased]` into a dated
 * `## [version]` entry when a release cuts.
 *
 * Why this suite exists: the previous roll inserted a fresh `## [Unreleased]`
 * anchored to the `# Changelog\n\n` title. In `packages/hashline/CHANGELOG.md`
 * the `## [Unreleased]` section lives BELOW a fork-notice blockquote, so the
 * title-anchored insert put a second `[Unreleased]` ABOVE the fork notice and
 * renamed the real (below-notice) one to the version — stranding the actual
 * bullets in a version section, while the empty top `[Unreleased]` read as
 * "nothing to document". The net effect: a "released" version that carried the
 * changes but never published, and no way to cut the next one. These
 * tests lock the fork-notice ordering, the no-empty-version rule, and the
 * newest-first section order so that regression can't return silently.
 */

const DATE = "2026-07-23";

describe("applyReleaseToChangelog", () => {
	it("keeps [Unreleased] below a fork-notice blockquote and inserts the version under it", () => {
		// The exact hashline shape that broke: blockquote, then [Unreleased] with a bullet.
		const before = [
			"# Changelog",
			"",
			"> **Fork notice.** Veyyon is a source fork of oh-my-pi.",
			"",
			"## [Unreleased]",
			"",
			"### Fixed",
			"",
			"- Large-range edits are now linear, not quadratic.",
			"",
			"## [16.5.0] - 2026-07-13",
			"",
			"### Fixed",
			"",
			"- An earlier upstream fix.",
			"",
		].join("\n");

		const after = applyReleaseToChangelog(before, "1.0.18", DATE);

		// The fork notice stays at the very top, right under the title.
		expect(after.indexOf("> **Fork notice.**")).toBeLessThan(after.indexOf("## [Unreleased]"));
		// A single [Unreleased], and it sits BELOW the fork notice, not above it.
		expect(after.match(/## \[Unreleased\]/g)).toHaveLength(1);
		// The new dated version lands directly under [Unreleased] and above the prior version.
		const unreleasedAt = after.indexOf("## [Unreleased]");
		const newVersionAt = after.indexOf("## [1.0.18] - 2026-07-23");
		const priorVersionAt = after.indexOf("## [16.5.0]");
		expect(unreleasedAt).toBeLessThan(newVersionAt);
		expect(newVersionAt).toBeLessThan(priorVersionAt);
		// The real bullet moved with the version section, not left in [Unreleased].
		expect(after.indexOf("- Large-range edits are now linear")).toBeGreaterThan(newVersionAt);
		expect(after.indexOf("- Large-range edits are now linear")).toBeLessThan(priorVersionAt);
	});

	it("preserves the [Unreleased] header for the next cycle above the new version (no fork notice)", () => {
		const before = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"",
			"- A new flag.",
			"",
			"## [1.0.0] - 2026-01-01",
			"",
			"- First.",
			"",
		].join("\n");

		const after = applyReleaseToChangelog(before, "1.0.1", DATE);

		expect(after.match(/## \[Unreleased\]/g)).toHaveLength(1);
		expect(after.indexOf("## [Unreleased]")).toBeLessThan(after.indexOf("## [1.0.1] - 2026-07-23"));
		expect(after.indexOf("## [1.0.1] - 2026-07-23")).toBeLessThan(after.indexOf("## [1.0.0] - 2026-01-01"));
		expect(after).toContain("- A new flag.");
	});

	it("creates no version entry when [Unreleased] has no bullets", () => {
		// An empty [Unreleased] must never mint a dated section: that is exactly the
		// phantom-version bug. A dispatched release rolls every package's changelog, so
		// the roll must not fabricate content for a package that has none.
		const before = ["# Changelog", "", "## [Unreleased]", "", "## [1.0.0] - 2026-01-01", "", "- First.", ""].join(
			"\n",
		);

		const after = applyReleaseToChangelog(before, "1.0.1", DATE);

		expect(after).not.toContain("## [1.0.1]");
		expect(after.match(/## \[Unreleased\]/g)).toHaveLength(1);
	});

	it("drops a pre-existing empty dated version section", () => {
		// A prior failed roll can leave an empty `## [x] - date`; the next roll must
		// clean it so the file never accretes hollow version headers.
		const before = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"- Real change.",
			"",
			"## [1.0.5] - 2026-06-01",
			"",
			"## [1.0.4] - 2026-05-01",
			"",
			"- Older real change.",
			"",
		].join("\n");

		const after = applyReleaseToChangelog(before, "1.0.6", DATE);

		expect(after).not.toContain("## [1.0.5] - 2026-06-01");
		expect(after).toContain("## [1.0.6] - 2026-07-23");
		expect(after).toContain("## [1.0.4] - 2026-05-01");
	});

	it("mints no version for a [Unreleased] with only a header and no bullets (gate parity)", () => {
		// The divergence this locks out: release.ts once used a looser "any
		// non-whitespace" check, so a stray `### Fixed` header (no bullets) would
		// create a hollow version section for THIS package when another package's
		// real bullets triggered the cut. The release gate counts bullets, so the
		// roll must too — a header alone is not releasable content.
		const before = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Fixed",
			"",
			"## [1.0.0] - 2026-01-01",
			"",
			"- First.",
			"",
		].join("\n");

		const after = applyReleaseToChangelog(before, "1.0.1", DATE);

		expect(after).not.toContain("## [1.0.1]");
		expect(after.match(/## \[Unreleased\]/g)).toHaveLength(1);
	});

	it("is a no-op transform when there is no [Unreleased] section at all", () => {
		const before = ["# Changelog", "", "## [1.0.0] - 2026-01-01", "", "- First.", ""].join("\n");
		expect(applyReleaseToChangelog(before, "1.0.1", DATE)).toBe(before);
	});
});

/**
 * The gate that refuses to cut a version nothing describes.
 *
 * WHY THIS SUITE EXISTS. `[Unreleased]` was drained by the v1.0.39 release and nobody refilled it, so
 * the roll above wrote no version section for v1.0.44, v1.0.45 or v1.0.46: three consecutive releases
 * were tagged and published with no changelog entry at all, while six (v1.0.40 through v1.0.45) sat
 * as unpublished drafts. Nothing in the cut noticed. The failure surfaced in the website build
 * (`reportUndocumentedReleases` in `website/tools/gen-changelog.mjs`, which reconciles published
 * releases against `packages/coding-agent/CHANGELOG.md`), which is to say it surfaced only after
 * v1.0.46 was already public and no longer fixable by not shipping it.
 *
 * If these regress, a release cuts with an empty changelog again and the first person to learn about
 * it is a user reading a version that documents nothing.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NEXT = "1.0.47";

function notes(content: string): PackageChangelog {
	return { path: RELEASE_NOTES_CHANGELOG, name: "@veyyon/coding-agent", content };
}

const EMPTY_UNRELEASED = [
	"# Changelog",
	"",
	"## [Unreleased]",
	"",
	"## [1.0.46] - 2026-08-01",
	"",
	"- Shipped.",
	"",
].join("\n");

describe("the release changelog gate", () => {
	/** The exact file the website reconciles published releases against; a rename here is the bug. */
	it("gates on the changelog the release notes and the changelog page are built from", async () => {
		expect(RELEASE_NOTES_CHANGELOG).toBe("packages/coding-agent/CHANGELOG.md");
		expect(await Bun.file(join(REPO_ROOT, RELEASE_NOTES_CHANGELOG)).exists()).toBe(true);
	});

	/** The v1.0.44/45/46 state exactly: an empty [Unreleased] and no section for the version. */
	it("refuses a version with an empty [Unreleased], naming the package and the fix", () => {
		expect(undocumentedReleaseFailures(NEXT, [notes(EMPTY_UNRELEASED)])).toEqual([
			'@veyyon/coding-agent (packages/coding-agent/CHANGELOG.md) has no bullet under "## [Unreleased]" and no "## [1.0.47]" section.',
		]);

		let message = "";
		try {
			assertReleaseIsDocumented(NEXT, [notes(EMPTY_UNRELEASED)]);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toBe(
			"Release 1.0.47 has nothing to document:\n" +
				'- @veyyon/coding-agent (packages/coding-agent/CHANGELOG.md) has no bullet under "## [Unreleased]" ' +
				'and no "## [1.0.47]" section.\n' +
				'Write the entry under "## [Unreleased]" in packages/coding-agent/CHANGELOG.md, land it on main, ' +
				"then dispatch the release again. There is no skip marker for this: a release publishes npm " +
				"packages, a git tag and a GitHub release under 1.0.47, and every one of them is a promise that " +
				"the changelog says what changed.",
		);
	});

	/** A category heading with no bullet under it is not content, and the gate counts the same
	 * entries `unreleasedEntries` counts. A stray `### Fixed` must not buy a release. */
	it("refuses an [Unreleased] that holds only a category heading", () => {
		const headingOnly = ["# Changelog", "", "## [Unreleased]", "", "### Fixed", "", "## [1.0.46] - 2026-08-01"].join(
			"\n",
		);
		expect(undocumentedReleaseFailures(NEXT, [notes(headingOnly)])).toHaveLength(1);
	});

	/** The happy path, end to end over the real roll: a bullet becomes a dated section, and the
	 * post-condition the cut checks after writing the tree is satisfied by what the roll wrote. */
	it("promotes a populated [Unreleased] and the prepared tree then carries the version section", () => {
		const before = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Fixed",
			"",
			"- Release cuts now refuse an undocumented version.",
			"",
			"## [1.0.46] - 2026-08-01",
			"",
			"- Shipped.",
			"",
		].join("\n");

		expect(undocumentedReleaseFailures(NEXT, [notes(before)])).toEqual([]);

		const after = applyReleaseToChangelog(before, NEXT, DATE);

		expect(after).toContain("## [1.0.47] - 2026-07-23");
		expect(after.indexOf("## [Unreleased]")).toBeLessThan(after.indexOf("## [1.0.47] - 2026-07-23"));
		expect(after.indexOf("## [1.0.47] - 2026-07-23")).toBeLessThan(after.indexOf("## [1.0.46] - 2026-08-01"));
		expect(after).toContain("- Release cuts now refuse an undocumented version.");
		expect(preparedReleaseChangelogFailures(NEXT, [notes(after)])).toEqual([]);
	});

	/** Most packages ship nothing in a given release, and packages like `metaharness` own no
	 * changelog at all. Neither may block a cut: the gate is about the version being documented
	 * somewhere a reader will find it, not about every package having something to say. */
	it("passes a release where only the release-notes changelog has an entry", () => {
		const documented = ["# Changelog", "", "## [Unreleased]", "", "- A real change.", ""].join("\n");
		const quiet: PackageChangelog = {
			path: "packages/hashline/CHANGELOG.md",
			name: "@veyyon/hashline",
			content: ["# Changelog", "", "## [Unreleased]", "", "## [1.0.40] - 2026-07-28", "", "- Old."].join("\n"),
		};

		expect(undocumentedReleaseFailures(NEXT, [notes(documented), quiet])).toEqual([]);
		const prepared = notes(applyReleaseToChangelog(documented, NEXT, DATE));
		expect(preparedReleaseChangelogFailures(NEXT, [prepared, quiet])).toEqual([]);
	});

	/** Recovery path: a cut whose bump commit landed before publication failed is re-run against a
	 * tree whose entry is already written and whose [Unreleased] is legitimately empty again. */
	it("passes a re-cut of a version whose section is already written", () => {
		const recut = ["# Changelog", "", "## [Unreleased]", "", `## [${NEXT}] - 2026-08-02`, "", "- The entry."].join(
			"\n",
		);
		expect(undocumentedReleaseFailures(NEXT, [notes(recut)])).toEqual([]);
		expect(preparedReleaseChangelogFailures(NEXT, [notes(recut)])).toEqual([]);
	});

	/** The other half of the post-condition: bullets the roll failed to promote (the hashline
	 * fork-notice bug) would ship inside the version while still reading as unreleased. */
	it("refuses a prepared tree that left bullets stranded under [Unreleased]", () => {
		const stranded: PackageChangelog = {
			path: "packages/hashline/CHANGELOG.md",
			name: "@veyyon/hashline",
			content: ["# Changelog", "", "## [Unreleased]", "", "- Never promoted.", "", `## [${NEXT}] - 2026-08-02`].join(
				"\n",
			),
		};
		const documented = notes(
			["# Changelog", "", "## [Unreleased]", "", `## [${NEXT}] - 2026-08-02`, "", "- The entry."].join("\n"),
		);

		expect(preparedReleaseChangelogFailures(NEXT, [documented, stranded])).toEqual([
			'@veyyon/hashline (packages/hashline/CHANGELOG.md) still has 1 bullet(s) under "## [Unreleased]" after ' +
				"the changelog roll, so they would ship inside 1.0.47 undocumented.",
		]);
		expect(() => assertPreparedReleaseChangelogs(NEXT, [documented, stranded])).toThrow(
			"Release 1.0.47 was prepared without a changelog entry:",
		);
	});

	/**
	 * The refusal has to land before the cut touches anything. v1.0.44's cut bumped every manifest,
	 * committed, tagged and pushed on its way to publishing an undocumented version; a gate that ran
	 * after the bump would only have left a half-cut tree behind.
	 *
	 * Driven by spawning the real `scripts/prerelease.ts` against a throwaway repo, so the evidence is
	 * the state on disk: the manifest still holds the old version, there is no bump commit, and there
	 * is no new tag. It used to import a `cmdRelease` export from `scripts/release.ts`, which stopped
	 * existing when preparation moved out of CI and onto the operator's machine. That did not fail
	 * loudly, it failed as a missing export inside a spawned driver, so the gate this test names has
	 * been unguarded since. Spawning the entry point cannot rot the same way: there is no internal
	 * name to go stale, and the thing under test is what an operator actually runs.
	 */
	it("refuses before writing the version bump, committing or tagging", async () => {
		const repo = mkdtempSync(join(tmpdir(), "release-changelog-gate-repo-"));
		mkdirSync(join(repo, "packages", "coding-agent"), { recursive: true });
		const manifestPath = join(repo, "packages", "coding-agent", "package.json");
		const changelogPath = join(repo, "packages", "coding-agent", "CHANGELOG.md");
		writeFileSync(manifestPath, `${JSON.stringify({ name: "@veyyon/coding-agent", version: "1.0.46" }, null, 2)}\n`);
		writeFileSync(changelogPath, `${EMPTY_UNRELEASED}\n`);

		const git = (...args: string[]) =>
			Bun.spawnSync(
				["git", "-c", "user.email=gate@test", "-c", "user.name=gate", "-c", "commit.gpgsign=false", ...args],
				{
					cwd: repo,
				},
			);
		git("init", "-b", "main");
		git("add", "-A");
		git("commit", "-m", "init");
		git("tag", "v1.0.46");

		const cut = Bun.spawn(["bun", join(REPO_ROOT, "scripts", "prerelease.ts"), "patch"], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(cut.stdout).text(),
			new Response(cut.stderr).text(),
			cut.exited,
		]);
		const output = `${stdout}\n${stderr}`;

		expect(exitCode, output).toBe(1);
		expect(output).toContain(
			'@veyyon/coding-agent (packages/coding-agent/CHANGELOG.md) has no bullet under "## [Unreleased]" and no ' +
				'"## [1.0.47]" section.',
		);

		expect(JSON.parse(await Bun.file(manifestPath).text()).version).toBe("1.0.46");
		expect(await Bun.file(changelogPath).text()).toBe(`${EMPTY_UNRELEASED}\n`);
		expect(git("tag", "--list").stdout.toString().trim()).toBe("v1.0.46");
		expect(git("log", "--format=%s").stdout.toString().trim()).toBe("init");
		expect(git("status", "--porcelain").stdout.toString().trim()).toBe("");
	}, 60_000);
});
