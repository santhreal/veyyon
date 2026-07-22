#!/usr/bin/env node
/**
 * Generate the website changelog, auto-synced from two sources of truth:
 *
 *   1. the repo CHANGELOG (`packages/coding-agent/CHANGELOG.md`, Keep a Changelog)
 *      — the curated, human-written release notes; the same text the GitHub
 *      release body is generated from (`scripts/ci-release-notes.ts`);
 *   2. the published GitHub Releases (`repos/<owner>/<repo>/releases`) — the
 *      authoritative record of what actually shipped: real publish dates, the
 *      release permalink, and *which* versions are genuinely available.
 *
 *   node website/tools/gen-changelog.mjs                 # reconcile against GitHub
 *   node website/tools/gen-changelog.mjs --no-github     # CHANGELOG only (offline)
 *   node website/tools/gen-changelog.mjs --repo owner/name
 *
 * Reconciliation: a version is shown with a "View on
 * GitHub" link and its real publish date only once GitHub has actually
 * published it; a version finalized in the CHANGELOG but not yet published is
 * marked `pending` (never presented as installable). A published release with
 * no CHANGELOG entry is reported loudly rather than silently dropped.
 *
 * Target: the region between <!--CHANGELOG:START--> and <!--CHANGELOG:END-->
 *         in website/changelog.html.
 *
 * The upstream (pre-fork) entries are written in oh-my-pi's voice — `omp`
 * commands and links to can1357/oh-my-pi issues. Those are rebranded / stripped
 * here so the public page speaks as Veyyon; provenance stays on the History
 * section and the full CHANGELOG on GitHub.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const CHANGELOG = join(REPO_ROOT, "packages", "coding-agent", "CHANGELOG.md");
const PAGE = join(HERE, "..", "changelog.html");

/** How many recent releases to render; the rest live in the full history. */
export const MAX_RELEASES = 14;
/** Collapse a section's bullets behind a "show all" toggle past this many. */
export const COLLAPSE_AFTER = 6;
/**
 * The oh-my-pi version veyyon forked from. Every changelog entry at this version
 * and older is inherited upstream history, not a veyyon release; veyyon's own
 * release line starts at 1.0.0 and its entries are added above the fork point in
 * the source CHANGELOG. In file order the first `## [16.5.2]` therefore marks the
 * boundary: releases before it are veyyon's, releases from it down are upstream.
 */
export const FORK_POINT_VERSION = "16.5.2";
/** Default repo the published-release reconciliation queries. */
export const DEFAULT_REPO = "santhreal/veyyon";

/**
 * The upstream project's identifying facts, in ONE place. Both provenance notes
 * (the HTML {@link upstreamNote} on the website and the markdown
 * {@link upstreamNoteMarkdown} on the repo-root CHANGELOG) read from these, so
 * the credit line can never drift between the two surfaces.
 */
export const UPSTREAM_REPO_URL = "https://github.com/can1357/oh-my-pi";
export const UPSTREAM_RELEASES_URL = `${UPSTREAM_REPO_URL}/releases`;
export const UPSTREAM_AUTHOR = "Can Boluk";
export const UPSTREAM_LICENSE = "MIT";

/** Map a changelog section heading to a tag class + short label. */
export function tagFor(section) {
	const s = section.toLowerCase();
	if (s.startsWith("breaking")) return { cls: "break", label: "Breaking" };
	if (s === "added" || s === "new features") return { cls: "add", label: "Added" };
	if (s === "changed" || s === "improved") return { cls: "chg", label: "Changed" };
	if (s === "fixed") return { cls: "fix", label: "Fixed" };
	if (s === "removed" || s === "deprecated") return { cls: "rm", label: section };
	if (s === "security") return { cls: "sec", label: "Security" };
	return { cls: "chg", label: section };
}

/** Rebrand upstream prose into Veyyon's voice and drop upstream links. */
export function rebrand(text) {
	return (
		text
			// Drop trailing "([#1234](…oh-my-pi…) follow-up)" style provenance notes.
			.replace(/\s*\(\[#\d+\]\(https?:\/\/[^)]*oh-my-pi[^)]*\)[^)]*\)/g, "")
			// Drop bare upstream issue/PR links, keeping nothing.
			.replace(/\[#\d+\]\(https?:\/\/[^)]*oh-my-pi[^)]*\)/g, "")
			// Internal URI scheme was renamed omp:// → veyyon://.
			.replace(/\bomp:\/\//g, "veyyon://")
			// Release binary assets were `omp-<platform>-<arch>` → `veyyon-…`.
			.replace(/\bomp-(windows|linux|darwin|macos)\b/g, "veyyon-$1")
			// `omp <subcommand>` as a CLI command → `vey`, whether backticked or bare.
			.replace(/\bomp /g, "vey ")
			.replace(/`omp`/g, "`vey`")
	);
}

/** Escape HTML, then re-render `inline code` and [text](url) links. */
export function renderInline(text) {
	let out = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
	// [text](url) → anchor (upstream oh-my-pi links already stripped by rebrand).
	out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_m, label, url) => {
		const safeUrl = url.replace(/"/g, "&quot;");
		return `<a href="${safeUrl}">${label}</a>`;
	});
	// `code` → <span class="inline">
	out = out.replace(/`([^`]+)`/g, '<span class="inline">$1</span>');
	return out;
}

/**
 * Parse the changelog into an ordered (newest-first) list of entries, INCLUDING
 * the `## [Unreleased]` block (kept as `version: "Unreleased"`). Callers that
 * only want cut releases use `parseReleases`; the upcoming-release block is read
 * via `parseUnreleased`.
 */
export function parseAllEntries(md) {
	const lines = md.split("\n");
	const releases = [];
	let cur = null;
	let section = null;
	let bullet = null;

	const flushBullet = () => {
		if (cur && section && bullet !== null) section.items.push(bullet.trim());
		bullet = null;
	};
	const flushSection = () => {
		flushBullet();
		if (cur && section && section.items.length) cur.sections.push(section);
		section = null;
	};

	for (const raw of lines) {
		const relMatch = raw.match(/^## \[([^\]]+)\]\s*(?:-\s*(.+))?$/);
		if (relMatch) {
			flushSection();
			if (cur) releases.push(cur);
			cur = { version: relMatch[1].trim(), date: (relMatch[2] || "").trim(), sections: [] };
			continue;
		}
		if (!cur) continue;
		const secMatch = raw.match(/^### (.+)$/);
		if (secMatch) {
			flushSection();
			section = { name: secMatch[1].trim(), items: [] };
			continue;
		}
		if (!section) continue;
		const bulletMatch = raw.match(/^-\s+(.*)$/);
		if (bulletMatch) {
			flushBullet();
			bullet = bulletMatch[1];
		} else if (bullet !== null && raw.trim()) {
			bullet += ` ${raw.trim()}`;
		} else if (bullet !== null) {
			flushBullet();
		}
	}
	flushSection();
	if (cur) releases.push(cur);
	return releases;
}

/** Parse the changelog into an ordered (newest-first) list of cut releases. */
export function parseReleases(md) {
	return parseAllEntries(md).filter(r => r.version.toLowerCase() !== "unreleased");
}

/**
 * The `## [Unreleased]` block — veyyon's changes staged for the next release —
 * or `null` when it has no content. Rendered at the top of the page so there is
 * always real veyyon news even before the first version is cut.
 */
export function parseUnreleased(md) {
	const u = parseAllEntries(md).find(r => r.version.toLowerCase() === "unreleased");
	return u && u.sections.length ? u : null;
}

/** Normalize a CHANGELOG version or a git tag to a bare `X.Y.Z` key. */
export function normalizeVersion(v) {
	return String(v).trim().replace(/^v/i, "");
}

/**
 * Fetch published GitHub Releases for `owner/repo`. Public repos need no auth.
 * Returns the raw release objects (tag_name, published_at, html_url, draft,
 * prerelease). Throws on network/HTTP failure so the caller can decide whether
 * to fall back loudly — never a silent empty list.
 */
export async function fetchGitHubReleases(repo, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
	const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const headers = { Accept: "application/vnd.github+json", "User-Agent": "veyyon-site-changelog" };
		if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
		const res = await fetchImpl(url, { headers, signal: controller.signal });
		if (!res.ok) throw new Error(`GitHub releases API ${res.status} ${res.statusText}`);
		const json = await res.json();
		if (!Array.isArray(json)) throw new Error("GitHub releases API did not return an array");
		return json;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Reconcile parsed CHANGELOG releases against published GitHub Releases.
 * Annotates each release with `{ published, githubUrl, publishedDate }` and
 * returns `{ releases, unmatchedPublished }` where `unmatchedPublished` is any
 * published GitHub release with no CHANGELOG entry (a coherence bug to surface
 * loudly, never drop).
 *
 * @param ghReleases raw GitHub release objects, or `null` when the lookup was
 *   skipped/failed — in that mode nothing is marked published or pending, so the
 *   page never falsely claims (or denies) availability from missing data.
 */
export function reconcile(releases, ghReleases) {
	if (ghReleases == null) {
		return { releases: releases.map(r => ({ ...r, published: null, githubUrl: null, publishedDate: "" })), unmatchedPublished: [] };
	}
	const publishedByVersion = new Map();
	for (const gh of ghReleases) {
		if (!gh || gh.draft || !gh.published_at || !gh.tag_name) continue;
		publishedByVersion.set(normalizeVersion(gh.tag_name), {
			publishedDate: String(gh.published_at).slice(0, 10),
			githubUrl: gh.html_url || "",
			prerelease: Boolean(gh.prerelease),
		});
	}
	const changelogVersions = new Set(releases.map(r => normalizeVersion(r.version)));
	const annotated = releases.map(r => {
		const hit = publishedByVersion.get(normalizeVersion(r.version));
		return {
			...r,
			published: Boolean(hit),
			githubUrl: hit ? hit.githubUrl : null,
			publishedDate: hit ? hit.publishedDate : "",
		};
	});
	// A published release with no CHANGELOG entry means the two sources disagree.
	// Every version veyyon cuts finalizes its CHANGELOG section (scripts/release.ts),
	// and the CHANGELOG also carries the inherited upstream entries, so any
	// published version absent from it is a genuine coherence failure to surface.
	const unmatchedPublished = [];
	for (const [version, meta] of publishedByVersion) {
		if (changelogVersions.has(version)) continue;
		unmatchedPublished.push({ version, ...meta });
	}
	return { releases: annotated, unmatchedPublished };
}

/** Compare two `X.Y.Z` versions numerically; returns -1/0/1. */
export function compareVersions(a, b) {
	const pa = normalizeVersion(a).split(".").map(n => parseInt(n, 10) || 0);
	const pb = normalizeVersion(b).split(".").map(n => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	return 0;
}

function renderSection(sec) {
	const { cls, label } = tagFor(sec.name);
	const items = sec.items.map(it => `\t\t\t\t<li>${renderInline(rebrand(it))}</li>`);
	const visible = items.slice(0, COLLAPSE_AFTER).join("\n");
	const hidden = items.slice(COLLAPSE_AFTER);
	const more =
		hidden.length > 0
			? `\n\t\t\t\t<li class="more"><details><summary>${hidden.length} more</summary><ul>\n${hidden.join("\n")}\n\t\t\t\t</ul></details></li>`
			: "";
	return [
		`\t\t\t<div class="sec">`,
		`\t\t\t\t<span class="tag ${cls}">${label}</span>`,
		`\t\t\t\t<ul class="notes">`,
		visible + more,
		`\t\t\t\t</ul>`,
		`\t\t\t</div>`,
	].join("\n");
}

export function renderRelease(rel, { isLatest } = {}) {
	const anchor = `v${rel.version.replace(/\./g, "-")}`;
	// Publish date (GitHub) wins over the CHANGELOG date when the release is live.
	const shownDate = rel.published && rel.publishedDate ? rel.publishedDate : rel.date;
	const date = shownDate ? `<span class="date">${shownDate}</span>` : "";
	const sections = rel.sections.map(renderSection).join("\n");
	const cls = `release${isLatest ? " latest" : ""}`;
	// A veyyon release finalized in the CHANGELOG but not yet on GitHub is pending
	// (never presented as installable). `published === null` = lookup skipped, so
	// no availability marker either way.
	const isPending = rel.published === false;
	const ghLink = rel.published && rel.githubUrl ? `\t\t\t\t<a class="gh-link" href="${rel.githubUrl}">View on GitHub ↗</a>` : "";
	return [
		`\t\t<article class="${cls}">`,
		`\t\t\t<div class="release-head">`,
		`\t\t\t\t<h2 id="${anchor}"><a href="#${anchor}">${rel.version}</a></h2>`,
		`\t\t\t\t${date}`,
		isLatest ? `\t\t\t\t<span class="pill">latest</span>` : "",
		isPending ? `\t\t\t\t<span class="pill pending">pending release</span>` : "",
		ghLink,
		`\t\t\t</div>`,
		sections,
		`\t\t</article>`,
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * Render the `[Unreleased]` block as the top "Unreleased" card — veyyon's
 * changes staged for the next release. No version number or GitHub link (nothing
 * is published yet); a "next release" pill marks it as upcoming.
 */
export function renderUnreleased(unreleased) {
	const sections = unreleased.sections.map(renderSection).join("\n");
	return [
		`\t\t<article class="release unreleased">`,
		`\t\t\t<div class="release-head">`,
		`\t\t\t\t<h2 id="unreleased"><a href="#unreleased">Unreleased</a></h2>`,
		`\t\t\t\t<span class="pill pending">next release</span>`,
		`\t\t\t</div>`,
		sections,
		`\t\t</article>`,
	].join("\n");
}

/**
 * Provenance note for the pre-fork history. Veyyon forked oh-my-pi at the fork
 * point; earlier versions are upstream's, not veyyon releases, so the page links
 * to them instead of replaying them as veyyon changelog cards.
 */
export function upstreamNote(forkPointVersion = FORK_POINT_VERSION) {
	return [
		`\t\t<div class="upstream-note">`,
		`\t\t\t<p>Veyyon is a fork of <a href="${UPSTREAM_REPO_URL}">oh-my-pi</a> ${forkPointVersion} (${UPSTREAM_LICENSE}, by ${UPSTREAM_AUTHOR}). Everything before the fork is upstream history, not a veyyon release. See <a href="${UPSTREAM_RELEASES_URL}">oh-my-pi's releases</a> for it.</p>`,
		`\t\t</div>`,
	].join("\n");
}

/**
 * The same provenance credit as {@link upstreamNote}, rendered as a Markdown
 * section for the repo-root CHANGELOG. Same wording, same fork facts; the HTML
 * page and the GitHub-rendered markdown therefore say exactly the same thing
 * about what is upstream and where to read it.
 */
export function upstreamNoteMarkdown(forkPointVersion = FORK_POINT_VERSION) {
	return [
		`## Upstream history`,
		``,
		`Veyyon is a fork of [oh-my-pi](${UPSTREAM_REPO_URL}) ${forkPointVersion} (${UPSTREAM_LICENSE}, by ${UPSTREAM_AUTHOR}). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](${UPSTREAM_RELEASES_URL}) for it.`,
	].join("\n");
}

/**
 * Render the repo-root `CHANGELOG.md` from the canonical source
 * (`packages/coding-agent/CHANGELOG.md`), so GitHub's repo page shows the same
 * changelog the website does, in Veyyon's voice.
 *
 * The rule matches the website exactly: keep only veyyon's own entries (the file
 * head above the first `## [<forkPointVersion>]` heading — `Unreleased` plus
 * every cut veyyon release), rebrand them, and collapse all pre-fork upstream
 * history into one {@link upstreamNoteMarkdown} credit rather than replaying it.
 * Everything flows through {@link rebrand}, so there is exactly one definition of
 * the omp→veyyon transform for both the HTML page and this file.
 *
 * Pure: a function of the source text only. The writer
 * (`scripts/sync-root-changelog.ts`) and the drift guard both call it, so the
 * on-disk file can be checked against a regenerated copy with a byte comparison.
 */
export function renderRootChangelog(sourceMd, { forkPointVersion = FORK_POINT_VERSION } = {}) {
	const escaped = forkPointVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const forkHeading = new RegExp(`^## \\[${escaped}\\]`, "m");
	const match = forkHeading.exec(sourceMd);
	// The head is every veyyon entry (title + Unreleased + cut releases). With no
	// fork heading present, the whole file predates any upstream merge and is all
	// veyyon's — keep it entire rather than silently dropping content.
	const head = (match ? sourceMd.slice(0, match.index) : sourceMd).trimEnd();
	const note = upstreamNoteMarkdown(forkPointVersion);
	return `${rebrand(head)}\n\n${note}\n`;
}

/**
 * Build the inner changelog HTML from reconciled releases. The page shows ONLY
 * veyyon's own releases (never upstream oh-my-pi release cards): the fork point
 * splits the list, veyyon's line renders as cards, and everything at/below the
 * fork point is collapsed into a single provenance note (`upstreamNote`) that
 * links to oh-my-pi for the pre-fork history. The `[Unreleased]` block renders
 * first as an "Unreleased" card so there is real veyyon news before 1.0.0 is
 * cut. The "latest" pill goes to the newest *published* veyyon release (or, when
 * the GitHub lookup was skipped, the newest veyyon CHANGELOG entry).
 */
export function buildChangelogHtml(reconciledReleases, { unreleased = null, forkPointVersion = FORK_POINT_VERSION, maxReleases = MAX_RELEASES } = {}) {
	const forkIdx = reconciledReleases.findIndex(r => r.version === forkPointVersion);
	const veyyonAll = forkIdx === -1 ? reconciledReleases : reconciledReleases.slice(0, forkIdx);
	const upstreamCount = forkIdx === -1 ? 0 : reconciledReleases.length - forkIdx;
	const veyyon = veyyonAll.slice(0, maxReleases);

	// "latest" = newest published veyyon release. If none are published (or the
	// lookup was skipped), fall back to the newest veyyon CHANGELOG entry only
	// when we have no published signal at all.
	const anyPublishedSignal = veyyon.some(r => r.published === true) || veyyon.some(r => r.published === false);
	const latestIdx = (() => {
		const firstPublished = veyyon.findIndex(r => r.published === true);
		if (firstPublished !== -1) return firstPublished;
		if (!anyPublishedSignal) return veyyon.length ? 0 : -1; // lookup skipped → mark newest
		return -1; // published signal exists but nothing published yet → no latest
	})();

	const parts = [];
	if (unreleased) parts.push(renderUnreleased(unreleased));
	for (let i = 0; i < veyyon.length; i++) {
		parts.push(renderRelease(veyyon[i], { isLatest: i === latestIdx, isUpstream: false }));
	}
	// Upstream (pre-fork) history is credited + linked, never replayed as cards.
	if (upstreamCount > 0) parts.push(upstreamNote(forkPointVersion));
	return { html: parts.join("\n"), veyyonCount: veyyon.length, upstreamCount, hasUnreleased: Boolean(unreleased), latestIdx };
}

/** Splice the built HTML into the page between the CHANGELOG markers. */
export function spliceIntoPage(pageHtml, bodyHtml) {
	const start = "<!--CHANGELOG:START-->";
	const end = "<!--CHANGELOG:END-->";
	const si = pageHtml.indexOf(start);
	const ei = pageHtml.indexOf(end);
	if (si === -1 || ei === -1) throw new Error(`changelog.html is missing ${start} / ${end} markers`);
	return `${pageHtml.slice(0, si + start.length)}\n${bodyHtml}\n\t\t${pageHtml.slice(ei)}`;
}

/** Resolve the owner/repo to reconcile against, from flag → env → git → default. */
export function resolveRepo(argv = process.argv) {
	const flagIdx = argv.indexOf("--repo");
	if (flagIdx !== -1 && argv[flagIdx + 1]) return argv[flagIdx + 1];
	if (process.env.VEYYON_SITE_REPO) return process.env.VEYYON_SITE_REPO;
	if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
	try {
		const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
		const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
		if (m) return m[1];
	} catch {
		// no git / no origin — fall through to the default below.
	}
	return DEFAULT_REPO;
}

async function main() {
	const argv = process.argv;
	const noGithub = argv.includes("--no-github");
	const repo = resolveRepo(argv);

	const md = readFileSync(CHANGELOG, "utf8");
	const all = parseReleases(md);
	if (!all.length) throw new Error("no releases parsed from CHANGELOG");

	let ghReleases = null;
	if (noGithub) {
		console.warn("changelog: --no-github set — building from CHANGELOG only; no publish dates or GitHub links.");
	} else {
		try {
			ghReleases = await fetchGitHubReleases(repo);
			console.log(`changelog: fetched ${ghReleases.length} GitHub release(s) from ${repo}`);
		} catch (err) {
			// LOUD, recall-preserving fallback (never silent): the page still builds
			// from the CHANGELOG, but without publish dates/links, and we say so.
			console.warn(`changelog: WARNING — could not reach GitHub releases for ${repo} (${err.message}). ` + "Building from CHANGELOG only; publish dates and 'View on GitHub' links are omitted. " + "Pass --no-github to silence this intentionally.");
			ghReleases = null;
		}
	}

	const { releases, unmatchedPublished } = reconcile(all, ghReleases);
	if (unmatchedPublished.length) {
		// Coherence failure between the two sources — surface it, do not hide it.
		console.warn(`changelog: WARNING — ${unmatchedPublished.length} published GitHub release(s) have no CHANGELOG entry: ` + unmatchedPublished.map(r => `v${r.version}`).join(", ") + ". Add them to packages/coding-agent/CHANGELOG.md.");
	}

	const unreleased = parseUnreleased(md);
	const { html, veyyonCount, upstreamCount, hasUnreleased } = buildChangelogHtml(releases, { unreleased });
	const next = spliceIntoPage(readFileSync(PAGE, "utf8"), html);
	writeFileSync(PAGE, next);

	const publishedCount = releases.slice(0, veyyonCount).filter(r => r.published).length;
	const latestVeyyon = veyyonCount ? releases[0].version : "none cut yet";
	console.log(`changelog: wrote ${veyyonCount} veyyon release card(s) (${publishedCount} published, latest ${latestVeyyon})` + `${hasUnreleased ? " + an Unreleased block" : ""}; ${upstreamCount} pre-fork oh-my-pi version(s) credited via the upstream note, not shown as cards`);
}

// Run only when invoked directly (not when imported by the test suite).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
