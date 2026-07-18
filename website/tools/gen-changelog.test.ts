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

describe("normalizeVersion / compareVersions", () => {
	it("strips a leading v and compares numerically", () => {
		expect(gen.normalizeVersion("v1.2.3")).toBe("1.2.3");
		expect(gen.compareVersions("1.0.0", "16.5.2")).toBe(-1);
		expect(gen.compareVersions("v1.10.0", "1.9.0")).toBe(1);
		expect(gen.compareVersions("16.5.2", "v16.5.2")).toBe(0);
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

	it("emits no upstream note when there is no pre-fork history", () => {
		const noFork = gen.parseReleases("# Changelog\n\n## [1.1.0] - 2026-08-02\n\n### Added\n\n- b\n\n## [1.0.0] - 2026-08-01\n\n### Added\n\n- a\n");
		const { releases } = gen.reconcile(noFork, null);
		const { html, upstreamCount } = gen.buildChangelogHtml(releases);
		expect(upstreamCount).toBe(0);
		expect(html).not.toContain("upstream-note");
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
