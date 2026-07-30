// Tests for the website changelog generator's parsing + GitHub-release
// reconciliation. The generator auto-syncs two sources of truth (the repo
// CHANGELOG and the published GitHub Releases); these assert the reconciliation
// reconciliation: a version is "published" only when GitHub says so, finalized-but-
// unpublished versions are "pending", and a published release missing from the
// CHANGELOG is surfaced, never silently dropped.

import { describe, expect, it } from "bun:test";
// @ts-expect-error — plain .mjs module, no types; imported for its exports.
import * as gen from "./gen-changelog.mjs";

const SAMPLE = `# Changelog

## [Unreleased]

### Added

- An unreleased veyyon change staged for the next release.

## [1.1.0] - 2026-08-02

### Added

- A second veyyon feature.

## [1.0.0] - 2026-08-01

### Added

- The first veyyon release.

### Fixed

- Fixed \`omp config list\` truncation and the omp:// scheme autocomplete.

## [16.5.2] - 2026-07-14

### Changed

- Inherited upstream change ([#1234](https://github.com/can1357/oh-my-pi/pull/1234)).

## [16.5.1] - 2026-07-10

### Fixed

- Older inherited fix.
`;

describe("parseReleases", () => {
	it("parses versions/dates/sections newest-first and drops Unreleased", () => {
		const rels = gen.parseReleases(SAMPLE);
		expect(rels.map((r: any) => r.version)).toEqual(["1.1.0", "1.0.0", "16.5.2", "16.5.1"]);
		expect(rels[0].date).toBe("2026-08-02");
		const v100 = rels.find((r: any) => r.version === "1.0.0");
		expect(v100.sections.map((s: any) => s.name)).toEqual(["Added", "Fixed"]);
		expect(v100.sections[0].items).toEqual(["The first veyyon release."]);
	});
});

describe("parseUnreleased", () => {
	it("returns the Unreleased block's sections so upcoming veyyon news can render", () => {
		const u = gen.parseUnreleased(SAMPLE);
		expect(u.version.toLowerCase()).toBe("unreleased");
		expect(u.sections[0].name).toBe("Added");
		expect(u.sections[0].items).toEqual(["An unreleased veyyon change staged for the next release."]);
	});

	it("returns null when there is no Unreleased content", () => {
		expect(gen.parseUnreleased("# Changelog\n\n## [1.0.0] - 2026-08-01\n\n### Added\n\n- x\n")).toBeNull();
	});
});

describe("rebrand", () => {
	it("rewrites omp CLI/scheme tokens and strips upstream oh-my-pi links", () => {
		expect(gen.rebrand("run `omp config list` now")).toBe("run `vey config list` now");
		expect(gen.rebrand("the omp:// scheme")).toBe("the veyyon:// scheme");
		expect(gen.rebrand("asset omp-linux-x64 shipped")).toBe("asset veyyon-linux-x64 shipped");
		expect(gen.rebrand("a change ([#1234](https://github.com/can1357/oh-my-pi/pull/1234))")).toBe("a change");
	});
	it("leaves .omp config paths untouched", () => {
		expect(gen.rebrand("~/.omp/agent")).toBe("~/.omp/agent");
	});
});

describe("renderInline", () => {
	it("renders Markdown strong emphasis while keeping code literal and escaped", () => {
		expect(gen.renderInline("Enable **Auto-upload Grievances**; keep `**literal**` and **<unsafe>** escaped.")).toBe(
			'Enable <strong>Auto-upload Grievances</strong>; keep <span class="inline">**literal**</span> and <strong>&lt;unsafe&gt;</strong> escaped.',
		);
	});
});

describe("normalizeVersion / compareVersions", () => {
	it("strips a leading v and compares numerically", () => {
		expect(gen.normalizeVersion("v1.2.3")).toBe("1.2.3");
		expect(gen.compareVersions("1.0.0", "16.5.2")).toBe(-1);
		expect(gen.compareVersions("v1.10.0", "1.9.0")).toBe(1);
		expect(gen.compareVersions("16.5.2", "v16.5.2")).toBe(0);
	});
});

describe("publication-state resolution", () => {
	it("returns the GitHub release record used to classify published versions", async () => {
		const releases = [{ tag_name: "v1.0.0", published_at: "2026-08-01T00:00:00Z" }];
		const seen: string[] = [];
		const actual = await gen.resolvePublicationState("owner/repo", {
			fetchReleases: async (repo: string) => {
				seen.push(repo);
				return releases;
			},
		});
		expect(actual).toBe(releases);
		expect(seen).toEqual(["owner/repo"]);
	});

	it("fails closed when GitHub cannot establish publication state", async () => {
		const outcome = gen.resolvePublicationState("owner/repo", {
			fetchReleases: async () => {
				throw new Error("API unavailable");
			},
		});
		await expect(outcome).rejects.toThrow("Refusing to generate deployable release metadata");
	});

	it("allows an explicit offline build without pretending it queried GitHub", async () => {
		let called = false;
		const actual = await gen.resolvePublicationState("owner/repo", {
			noGithub: true,
			fetchReleases: async () => {
				called = true;
				return [];
			},
		});
		expect(actual).toBeNull();
		expect(called).toBe(false);
	});
});

describe("reconcile", () => {
	const rels = gen.parseReleases(SAMPLE);

	it("marks only versions with a published (non-draft) GitHub release as published", () => {
		const gh = [
			{ tag_name: "v1.0.0", published_at: "2026-08-01T12:00:00Z", html_url: "https://github.com/santhreal/veyyon/releases/tag/v1.0.0", draft: false },
			{ tag_name: "v1.1.0", published_at: null, draft: true }, // still a draft → not published
		];
		const { releases } = gen.reconcile(rels, gh);
		const v100 = releases.find((r: any) => r.version === "1.0.0");
		const v110 = releases.find((r: any) => r.version === "1.1.0");
		expect(v100.published).toBe(true);
		expect(v100.publishedDate).toBe("2026-08-01");
		expect(v100.githubUrl).toContain("/releases/tag/v1.0.0");
		expect(v110.published).toBe(false); // finalized in CHANGELOG, not published → pending
		expect(v110.githubUrl).toBeNull();
	});

	it("does not flag inherited upstream tags (<= fork point) as coherence failures", () => {
		const gh = [{ tag_name: "v16.5.2", published_at: "2026-07-14T00:00:00Z", html_url: "u", draft: false }];
		const { unmatchedPublished } = gen.reconcile(rels, gh);
		expect(unmatchedPublished).toEqual([]);
	});

	it("surfaces a published release above the fork point that has no CHANGELOG entry", () => {
		const gh = [{ tag_name: "v2.0.0", published_at: "2026-09-01T00:00:00Z", html_url: "u", draft: false }];
		const { unmatchedPublished } = gen.reconcile(rels, gh);
		expect(unmatchedPublished.map((r: any) => r.version)).toEqual(["2.0.0"]);
	});

	it("with a null lookup marks nothing published or pending (no false availability)", () => {
		const { releases } = gen.reconcile(rels, null);
		expect(releases.every((r: any) => r.published === null)).toBe(true);
	});
});

describe("buildChangelogHtml", () => {
	const rels = gen.parseReleases(SAMPLE);
	const unreleased = gen.parseUnreleased(SAMPLE);

	it("shows only veyyon releases as cards; pre-fork history is a credit note, never upstream cards", () => {
		const gh = [{ tag_name: "v1.0.0", published_at: "2026-08-01T00:00:00Z", html_url: "u", draft: false }];
		const { releases } = gen.reconcile(rels, gh);
		const { html, veyyonCount, upstreamCount } = gen.buildChangelogHtml(releases);
		expect(veyyonCount).toBe(2); // 1.1.0, 1.0.0
		expect(upstreamCount).toBe(2); // 16.5.2, 16.5.1 exist but are NOT rendered as cards
		// No oh-my-pi version card is ever emitted.
		expect(html).not.toContain('id="v16-5-2"');
		expect(html).not.toContain('id="v16-5-1"');
		expect(html).not.toContain("Inherited from oh-my-pi");
		// Instead, a single provenance note links upstream for the pre-fork history.
		expect(html).toContain('class="upstream-note"');
		expect(html).toContain("fork of");
		expect(html).toContain("https://github.com/can1357/oh-my-pi/releases");
		// 1.1.0 is newer but unpublished → pending; 1.0.0 is the published latest.
		expect(html).toContain('id="v1-0-0"');
		const v110Block = html.slice(html.indexOf('id="v1-1-0"'), html.indexOf('id="v1-0-0"'));
		expect(v110Block).toContain("pending release");
		expect(v110Block).not.toContain(">latest<");
	});

	it("renders the Unreleased block first when passed, with a 'next release' pill", () => {
		const { releases } = gen.reconcile(rels, null);
		const { html, hasUnreleased } = gen.buildChangelogHtml(releases, { unreleased });
		expect(hasUnreleased).toBe(true);
		expect(html.indexOf('id="unreleased"')).toBeGreaterThan(-1);
		// The Unreleased card is above the first cut release card.
		expect(html.indexOf('id="unreleased"')).toBeLessThan(html.indexOf('id="v1-1-0"'));
		const uBlock = html.slice(html.indexOf('id="unreleased"'), html.indexOf('id="v1-1-0"'));
		expect(uBlock).toContain("next release");
		expect(uBlock).toContain("An unreleased veyyon change staged for the next release.");
		// It carries no version-derived GitHub link.
		expect(uBlock).not.toContain("gh-link");
	});

	it("emits a View-on-GitHub link only for published releases", () => {
		const gh = [{ tag_name: "v1.0.0", published_at: "2026-08-01T00:00:00Z", html_url: "https://gh/v1.0.0", draft: false }];
		const { releases } = gen.reconcile(rels, gh);
		const { html } = gen.buildChangelogHtml(releases);
		const v100Block = html.slice(html.indexOf('id="v1-0-0"'));
		expect(v100Block).toContain('class="gh-link" href="https://gh/v1.0.0"');
	});

	it("prefers the GitHub publish date over the CHANGELOG date for published releases", () => {
		const gh = [{ tag_name: "v1.0.0", published_at: "2026-08-05T00:00:00Z", html_url: "u", draft: false }];
		const { releases } = gen.reconcile(rels, gh);
		const { html } = gen.buildChangelogHtml(releases);
		const v100Block = html.slice(html.indexOf('id="v1-0-0"'), html.indexOf("upstream-note"));
		expect(v100Block).toContain("2026-08-05"); // GitHub date, not the 2026-08-01 CHANGELOG date
		expect(v100Block).not.toContain("2026-08-01");
	});

	it("still emits the upstream note when no pre-fork entry remains", () => {
		// This asserted the opposite until 2026-07-25, and that contract is what
		// made the attribution disappear: the credit was gated on inherited
		// entries still sitting in the source changelog, so stripping them removed
		// the note as a side effect with nothing reporting it. The fork is a fact
		// about the project, not about the contents of one file.
		const noFork = gen.parseReleases("# Changelog\n\n## [1.1.0] - 2026-08-02\n\n### Added\n\n- b\n\n## [1.0.0] - 2026-08-01\n\n### Added\n\n- a\n");
		const { releases } = gen.reconcile(noFork, null);
		const { html, upstreamCount } = gen.buildChangelogHtml(releases);
		expect(upstreamCount).toBe(0);
		expect(html).toContain("upstream-note");
	});
});

describe("every bullet is rendered", () => {
	/**
	 * Sections past six bullets used to hide the rest behind a `N more` toggle.
	 * That put the longest releases -- the ones with the most to say -- behind a
	 * click, and hid them from find-in-page and from anything reading the page
	 * without running its JavaScript. A changelog exists to be read.
	 */
	const many = Array.from({ length: 23 }, (_, i) => `- Fixed thing number ${i + 1}.`).join("\n");
	const source = ["# Changelog", "", "## [1.0.0] - 2026-08-01", "", "### Fixed", "", many, ""].join("\n");

	it("renders all 23 bullets of a long section, not the first six", () => {
		const { html } = gen.buildChangelogHtml(gen.parseReleases(source));
		for (let i = 1; i <= 23; i++) {
			expect(html).toContain(`Fixed thing number ${i}.`);
		}
		// Counted, not merely present: a toggle that still rendered the hidden
		// bullets inside a <details> would satisfy the loop above.
		expect(html.split("<li>").length - 1).toBe(23);
	});

	it("emits no collapse toggle at any section length", () => {
		// The exact markup the old path produced. Named explicitly so a
		// reintroduction fails here rather than being noticed on the live site.
		const { html } = gen.buildChangelogHtml(gen.parseReleases(source));
		expect(html).not.toContain("<details>");
		expect(html).not.toContain("<summary>");
		expect(html).not.toContain('class="more"');
		expect(html).not.toContain("more</summary>");
	});

	it("still renders a short section unchanged", () => {
		// The cut applied only past a threshold, so a fix that removed the
		// threshold by removing the bullets would pass the tests above.
		const short = ["# Changelog", "", "## [1.0.0] - 2026-08-01", "", "### Added", "", "- One thing.", "- Another thing.", ""].join("\n");
		const { html } = gen.buildChangelogHtml(gen.parseReleases(short));
		expect(html).toContain("One thing.");
		expect(html).toContain("Another thing.");
		expect(html.split("<li>").length - 1).toBe(2);
	});
});

describe("the fork credit is unconditional", () => {
	/**
	 * The credit used to be emitted only when the source changelog still carried
	 * pre-fork entries. Stripping that inherited history from the file therefore
	 * removed the attribution from the page as a side effect, with nothing
	 * reporting it. Veyyon is a fork whether or not those entries are still
	 * carried, and the note is where a reader learns where the project came from.
	 */
	it("renders the credit even when no upstream entry remains in the source", () => {
		const veyyonOnly = ["# Changelog", "", "## [1.0.0] - 2026-08-01", "", "### Added", "", "- A thing.", ""].join("\n");
		const { html, upstreamCount } = gen.buildChangelogHtml(gen.parseReleases(veyyonOnly));
		expect(upstreamCount).toBe(0);
		expect(html).toContain('class="upstream-note"');
		expect(html).toContain("https://github.com/can1357/oh-my-pi/releases");
		expect(html).toContain("Can Boluk");
	});
});

describe("upstreamNote", () => {
	it("credits and links oh-my-pi at the fork point instead of replaying its releases", () => {
		const note = gen.upstreamNote("16.5.2");
		expect(note).toContain('class="upstream-note"');
		expect(note).toContain("oh-my-pi</a> 16.5.2");
		expect(note).toContain("https://github.com/can1357/oh-my-pi/releases");
		expect(note).not.toContain("release-head"); // it is a note, not a version card
	});
});

describe("upstreamNoteMarkdown", () => {
	it("credits oh-my-pi in Markdown with the same facts as the HTML note", () => {
		const note = gen.upstreamNoteMarkdown("16.5.2");
		expect(note).toContain("## Upstream history");
		expect(note).toContain("[oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk)");
		expect(note).toContain("[oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases)");
	});

	it("shares its fork facts with the HTML note so the two can never disagree", () => {
		// Regression guard: the credit line was duplicated as two literal strings.
		// Both notes must now name the same author, license, and URLs.
		const html = gen.upstreamNote("16.5.2");
		const md = gen.upstreamNoteMarkdown("16.5.2");
		for (const fact of ["16.5.2", "MIT", "Can Boluk", "https://github.com/can1357/oh-my-pi/releases"]) {
			expect(html).toContain(fact);
			expect(md).toContain(fact);
		}
	});
});

describe("renderRootChangelog", () => {
	it("keeps only veyyon's own entries and drops the pre-fork upstream release cards", () => {
		// The website shows veyyon releases + a credit note, never upstream cards.
		// The repo-root CHANGELOG must make the identical cut so GitHub's repo page
		// matches veyyon.dev/changelog.
		const root = gen.renderRootChangelog(SAMPLE);
		expect(root).toContain("## [Unreleased]");
		expect(root).toContain("## [1.1.0] - 2026-08-02");
		expect(root).toContain("## [1.0.0] - 2026-08-01");
		// Pre-fork upstream versions and their bullets are credited, not replayed.
		expect(root).not.toContain("## [16.5.2]");
		expect(root).not.toContain("## [16.5.1]");
		expect(root).not.toContain("Inherited upstream change");
		expect(root).not.toContain("Older inherited fix");
	});

	it("rebrands veyyon entries into Veyyon's voice (omp → vey, omp:// → veyyon://)", () => {
		const root = gen.renderRootChangelog(SAMPLE);
		expect(root).toContain("Fixed `vey config list` truncation and the veyyon:// scheme autocomplete.");
		expect(root).not.toContain("omp config list");
		expect(root).not.toContain("omp://");
	});

	it("ends with the Markdown upstream-history credit for the fork point", () => {
		const root = gen.renderRootChangelog(SAMPLE);
		expect(root.trimEnd().endsWith("for it.")).toBe(true);
		expect(root).toContain("## Upstream history");
		expect(root).toContain("[oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk)");
		// The credit's own oh-my-pi link must survive the rebrand's link stripping,
		// which only targets `[#123](…oh-my-pi…)` issue refs, not this named link.
		expect(root).toContain("[oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases)");
	});

	it("starts with the `# Changelog` title carried over from the source", () => {
		expect(gen.renderRootChangelog(SAMPLE).startsWith("# Changelog\n")).toBe(true);
	});

	/**
	 * The root file says it is generated, right where somebody about to edit it will look.
	 *
	 * WHY THIS IS ASSERTED. The root changelog reads like a hand-written file and it is the first
	 * one a contributor opens, so entries got written directly into it -- twice in a single day --
	 * and the next regeneration deletes them. `sync-root-changelog.ts` refuses to overwrite a
	 * bullet no package claims, which catches the mistake, but only after the writing. The banner
	 * is the half that prevents it, and it has to name the actual destination and the command, or
	 * it is a warning without a way forward.
	 */
	it("says it is generated and where entries belong instead", () => {
		const root = gen.renderRootChangelog(SAMPLE);
		const banner = root.split("\n")[2];

		expect(banner.startsWith("> **Generated file.**")).toBe(true);
		expect(banner).toContain("packages/*/CHANGELOG.md");
		expect(banner).toContain("bun scripts/sync-root-changelog.ts");
		// Above the first release heading, so it cannot be scrolled past.
		expect(root.indexOf(banner)).toBeLessThan(root.indexOf("## [Unreleased]"));
	});

	/**
	 * And the banner is not mistaken for a changelog entry. The orphan check parses `- ` bullets
	 * under `## [Unreleased]`; a banner that parsed as one would make every regeneration report a
	 * bullet no package claims and refuse to write, which is the guard eating itself.
	 */
	it("writes the banner as a blockquote, not a bullet", () => {
		const root = gen.renderRootChangelog(SAMPLE);
		const bannerLine = root.split("\n").find(line => line.includes("**Generated file.**"));

		expect(bannerLine?.startsWith("-")).toBe(false);
		expect(bannerLine?.startsWith(">")).toBe(true);
	});

	it("keeps the whole file when there is no fork heading (all-veyyon history)", () => {
		// Defensive: a source with no upstream merge is entirely veyyon's, so nothing
		// is dropped; the credit note is still appended for provenance.
		const preFork = "# Changelog\n\n## [1.0.0] - 2026-08-01\n\n### Added\n\n- First veyyon release.\n";
		const root = gen.renderRootChangelog(preFork);
		expect(root).toContain("## [1.0.0] - 2026-08-01");
		expect(root).toContain("First veyyon release.");
		expect(root).toContain("## Upstream history");
	});

	it("is deterministic: rendering the same source twice yields identical bytes", () => {
		// The drift guard relies on this — it regenerates and byte-compares.
		expect(gen.renderRootChangelog(SAMPLE)).toBe(gen.renderRootChangelog(SAMPLE));
	});
});

describe("fetchGitHubReleases", () => {
	it("throws (never returns an empty list) on a non-OK response so the caller can fall back loudly", async () => {
		const fake = async () => ({ ok: false, status: 503, statusText: "Service Unavailable" });
		await expect(gen.fetchGitHubReleases("santhreal/veyyon", { fetchImpl: fake as any })).rejects.toThrow("503");
	});

	it("parses a well-formed release array", async () => {
		const fake = async () => ({ ok: true, status: 200, json: async () => [{ tag_name: "v1.0.0", published_at: "2026-08-01T00:00:00Z", html_url: "u", draft: false }] });
		const out = await gen.fetchGitHubReleases("santhreal/veyyon", { fetchImpl: fake as any });
		expect(out).toHaveLength(1);
		expect(out[0].tag_name).toBe("v1.0.0");
	});
});

describe("spliceIntoPage", () => {
	it("replaces content between the markers and errors when they are missing", () => {
		const page = "A<!--CHANGELOG:START-->OLD<!--CHANGELOG:END-->B";
		const out = gen.spliceIntoPage(page, "NEW");
		expect(out).toContain("NEW");
		expect(out).not.toContain("OLD");
		expect(out.startsWith("A<!--CHANGELOG:START-->")).toBe(true);
		expect(() => gen.spliceIntoPage("no markers", "x")).toThrow("markers");
	});
});
