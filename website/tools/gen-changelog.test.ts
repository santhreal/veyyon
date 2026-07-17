// Tests for the website changelog generator's parsing + GitHub-release
// reconciliation. The generator auto-syncs two sources of truth (the repo
// CHANGELOG and the published GitHub Releases); these assert the reconciliation
// is honest — a version is "published" only when GitHub says so, finalized-but-
// unpublished versions are "pending", and a published release missing from the
// CHANGELOG is surfaced, never silently dropped.

import { describe, expect, it } from "bun:test";
// @ts-expect-error — plain .mjs module, no types; imported for its exports.
import * as gen from "./gen-changelog.mjs";

const SAMPLE = `# Changelog

## [Unreleased]

### Added

- A pending unreleased line that must never render.

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

	it("splits at the fork point and gives 'latest' to the newest PUBLISHED veyyon release", () => {
		const gh = [{ tag_name: "v1.0.0", published_at: "2026-08-01T00:00:00Z", html_url: "u", draft: false }];
		const { releases } = gen.reconcile(rels, gh);
		const { html, veyyonCount, upstreamShownCount } = gen.buildChangelogHtml(releases);
		expect(veyyonCount).toBe(2); // 1.1.0, 1.0.0
		expect(upstreamShownCount).toBe(2); // 16.5.2, 16.5.1
		// 1.1.0 is newer but unpublished → pending; 1.0.0 is the published latest.
		expect(html).toContain('id="v1-0-0"');
		expect(html.indexOf("pending release")).toBeGreaterThan(-1);
		const v110Block = html.slice(html.indexOf('id="v1-1-0"'), html.indexOf('id="v1-0-0"'));
		expect(v110Block).toContain("pending release");
		expect(v110Block).not.toContain(">latest<");
		expect(html).toContain("Inherited from oh-my-pi");
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
		const v100Block = html.slice(html.indexOf('id="v1-0-0"'), html.indexOf("Inherited"));
		expect(v100Block).toContain("2026-08-05"); // GitHub date, not the 2026-08-01 CHANGELOG date
		expect(v100Block).not.toContain("2026-08-01");
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
