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

/** Escape HTML, then re-render strong emphasis, `inline code`, and [text](url) links. */
export function renderInline(text) {
	const codeSpans = [];
	let out = text.replace(/`([^`]+)`/g, (_match, code) => {
		const index = codeSpans.push(code) - 1;
		return `\0${index}\0`;
	});
	out = out
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
	// **text** → strong. Code spans are held aside so their literal Markdown stays literal.
	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	// [text](url) → anchor (upstream oh-my-pi links already stripped by rebrand).
	out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_m, label, url) => {
		const safeUrl = url.replace(/"/g, "&quot;");
		return `<a href="${safeUrl}">${label}</a>`;
	});
	return out.replace(/\0(\d+)\0/g, (_match, index) => {
		const code = codeSpans[Number(index)]
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
		return `<span class="inline">${code}</span>`;
	});
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
 * prerelease) and throws on network, HTTP, or payload failure.
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
 * Establish the publication record used by a deploy build. `--no-github` is an
 * explicit offline rendering mode; every normal build fails closed when GitHub
 * cannot say which versions are actually published.
 */
export async function resolvePublicationState(
	repo,
	{ noGithub = false, fetchReleases = fetchGitHubReleases } = {},
) {
	if (noGithub) return null;
	try {
		return await fetchReleases(repo);
	} catch (error) {
		throw new Error(
			`changelog: could not establish GitHub publication state for ${repo}: ${error.message}. ` +
				"Refusing to generate deployable release metadata; use --no-github only for an intentional offline build.",
			{ cause: error },
		);
	}
}

/**
 * Reconcile parsed CHANGELOG releases against published GitHub Releases.
 * Annotates each release with `{ published, githubUrl, publishedDate }` and
 * returns `{ releases, unmatchedPublished }` where `unmatchedPublished` is any
 * published GitHub release with no CHANGELOG entry (a coherence bug to surface
 * loudly, never drop).
 *
 * @param ghReleases raw GitHub release objects, or `null` only when an explicit
 *   offline build skipped lookup. Normal deploy builds never reconcile unknown
 *   publication state.
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

/**
 * Render one section of a release: its tag and every bullet it has.
 *
 * EVERY bullet is rendered, always. Sections past six bullets used to hide the
 * rest behind a `N more` toggle, which put the longest releases -- the ones with
 * the most to say -- behind a click, and hid them from find-in-page and from
 * anything reading the page without running its JavaScript. A changelog exists
 * to be read; a release that shipped 23 fixes should show 23 fixes.
 */
function renderSection(sec) {
	const { cls, label } = tagFor(sec.name);
	const items = sec.items.map(it => `\t\t\t\t<li>${renderInline(rebrand(it))}</li>`);
	return [
		`\t\t\t<div class="sec">`,
		`\t\t\t\t<span class="tag ${cls}">${label}</span>`,
		`\t\t\t\t<ul class="notes">`,
		items.join("\n"),
		`\t\t\t\t</ul>`,
		`\t\t\t</div>`,
	].join("\n");
}

/**
 * The id a release card carries, and the fragment that links to it. Dots are
 * not usable in a URL fragment the way a version writes them, so `1.0.47`
 * becomes `v1-0-47`.
 *
 * Exported because the deployment proof (`scripts/verify-deployed-changelog.ts`)
 * looks the card up by this id on the live page. It used to restate the format
 * itself, guessed `id="1.0.47"`, and so could never find a card: every release
 * after the anchor took this shape failed its own publication check while the
 * site it was checking was correct.
 */
export function releaseAnchor(version) {
	return `v${version.replace(/\./g, "-")}`;
}

export function renderRelease(rel, { isLatest } = {}) {
	const anchor = releaseAnchor(rel.version);
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

/** Keep a Changelog section order. Anything unrecognised sorts after these, alphabetically. */
const SECTION_ORDER = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

function sectionRank(name) {
	const index = SECTION_ORDER.indexOf(name);
	return index === -1 ? SECTION_ORDER.length : index;
}

/** Compare two version strings newest-first; `Unreleased` always sorts first. */
function compareVersionsDesc(a, b) {
	if (a === b) return 0;
	if (a.toLowerCase() === "unreleased") return -1;
	if (b.toLowerCase() === "unreleased") return 1;
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) return db - da;
	}
	return a < b ? 1 : -1;
}

/**
 * Take the veyyon releases from one package's entries, dropping inherited
 * upstream history.
 *
 * The cut is POSITIONAL, not a per-entry test, and that distinction is the whole
 * subtlety here. Veyyon restarted its version line at 1.0.0 after forking at
 * 16.5.2, so the two lines cannot be separated by comparing numbers: 1.0.37 is
 * numerically below every 16.x upstream version while being much newer. A
 * per-entry "major below the fork major" rule looks like it handles that and
 * does not, because upstream's own history descends through 15.x, 14.x and
 * further down. Those all satisfy "major below 16" and came flooding back in,
 * inflating the root changelog to fifteen thousand lines of another project's
 * releases.
 *
 * What is actually true is an ordering fact: each changelog is newest-first, so
 * veyyon's releases are the contiguous run at the top and everything from the
 * first upstream entry onward is inherited. So scan from the top and stop dead
 * at the first entry at or above the fork major. `buildChangelogHtml` cuts the
 * website's list the same way, by index, for the same reason.
 *
 * A package with no veyyon release of its own yields only its `Unreleased`
 * section, which is correct: most packages have not been cut since the fork.
 */
function veyyonEntries(entries, forkPointVersion) {
	const forkMajor = Number(forkPointVersion.split(".")[0]);
	const kept = [];
	for (const entry of entries) {
		if (entry.version.toLowerCase() === "unreleased") {
			kept.push(entry);
			continue;
		}
		if (Number(entry.version.split(".")[0]) >= forkMajor) break;
		kept.push(entry);
	}
	return kept;
}

/**
 * Render the repo-root `CHANGELOG.md` by aggregating EVERY package changelog.
 *
 * The root file is what a visitor reads on the GitHub repo page, so it is the
 * product's changelog, not one package's. It used to be generated from
 * `packages/coding-agent/CHANGELOG.md` alone, which meant a fix recorded in any
 * other package was dropped the moment anyone regenerated it: the collab-web IME
 * fix had to be hand-added to the root and was deleted again by the next run.
 * A changelog that silently loses entries is worse than none, because the reader
 * has no way to tell that what they are looking at is incomplete.
 *
 * Entries are merged by product release version and then by section, in Keep a
 * Changelog order. The first source owns the release train. Other packages
 * contribute `Unreleased` work and entries whose version exists in that lead
 * changelog. This matters because extracted package changelogs contain inherited
 * history first and newer Veyyon package releases appended after it.
 *
 * Bullets keep their text verbatim and are not tagged with a package name: a
 * reader of the product changelog wants to know what changed, not which internal
 * package it landed in. `coding-agent` is listed first within each section
 * because it is the product; the rest follow in the order given.
 *
 * Upstream issue links are stripped by {@link rebrand}, the same as on the
 * website. A link from veyyon's own changelog into another project's issue
 * tracker sends the reader somewhere that cannot answer their question. The
 * per-package changelogs keep those links as the engineering record.
 *
 * Pre-fork history is collapsed into one {@link upstreamNoteMarkdown} credit
 * rather than replayed, so the root shows veyyon's releases only.
 *
 * Pure: a function of the supplied sources. The writer
 * (`scripts/sync-root-changelog.ts`) and the drift guard both call it, so the
 * on-disk file can be checked against a regenerated copy with a byte comparison.
 *
 * @param sources Either a single changelog's markdown (the historical shape,
 *   kept so existing callers and tests do not have to change) or an ordered list
 *   of `{ name, md }` package changelogs.
 */
/** Says where entries belong, at the top of the file people mistake for the source. */
const ROOT_GENERATED_BANNER =
	"> **Generated file.** This changelog is assembled from every `packages/*/CHANGELOG.md`. Add your entry to the Unreleased section of the changelog for the package you changed, then run `bun scripts/sync-root-changelog.ts`. An entry written here is deleted by the next regeneration.";

export function renderRootChangelog(sources, { forkPointVersion = FORK_POINT_VERSION } = {}) {
	const list = typeof sources === "string" ? [{ name: "coding-agent", md: sources }] : sources;
	const leadEntries = veyyonEntries(parseAllEntries(list[0]?.md ?? ""), forkPointVersion);
	const productVersions = new Set(
		leadEntries
			.filter(entry => entry.version.toLowerCase() !== "unreleased")
			.map(entry => normalizeVersion(entry.version)),
	);

	// version -> section name -> bullets, insertion-ordered by the source list so
	// the first package listed contributes its bullets first.
	const byVersion = new Map();
	const dates = new Map();
	for (const [index, { md }] of list.entries()) {
		const entries =
			index === 0
				? leadEntries
				: parseAllEntries(md).filter(
						entry =>
							entry.version.toLowerCase() === "unreleased" ||
							productVersions.has(normalizeVersion(entry.version)),
					);
		for (const entry of entries) {
			const sections = byVersion.get(entry.version) ?? new Map();
			byVersion.set(entry.version, sections);
			// The date is the release's, not a package's, so the first one wins and
			// a package that omitted it cannot blank it.
			if (entry.date && !dates.has(entry.version)) dates.set(entry.version, entry.date);
			for (const section of entry.sections) {
				const items = sections.get(section.name) ?? [];
				sections.set(section.name, items);
				for (const item of section.items) {
					const rebranded = rebrand(item).trim();
					// The same fix written into two packages' changelogs is one entry to
					// a reader; deduping is what keeps the merge from reading as noise.
					if (rebranded && !items.includes(rebranded)) items.push(rebranded);
				}
			}
		}
	}

	// The banner is load-bearing, not decoration. This file looks hand-written and it is the
	// first changelog a visitor opens, so contributors wrote entries straight into it and the
	// next regeneration deleted them. `sync-root-changelog.ts` refuses to write over an
	// unclaimed bullet now, which catches it, but only AFTER the entry has been written in the
	// wrong place -- twice in one day. Saying so at the top is the part that stops it happening.
	const parts = ["# Changelog", "", ROOT_GENERATED_BANNER, ""];
	for (const version of [...byVersion.keys()].sort(compareVersionsDesc)) {
		const sections = byVersion.get(version);
		const date = dates.get(version);
		parts.push(date ? `## [${version}] - ${date}` : `## [${version}]`, "");
		const names = [...sections.keys()].sort((a, b) => sectionRank(a) - sectionRank(b) || a.localeCompare(b));
		for (const name of names) {
			const items = sections.get(name);
			if (!items.length) continue;
			parts.push(`### ${name}`, "");
			for (const item of items) parts.push(`- ${item}`);
			parts.push("");
		}
	}

	return `${parts.join("\n").trimEnd()}\n\n${upstreamNoteMarkdown(forkPointVersion)}\n`;
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
	// Unconditional. The credit used to be gated on upstream entries still being
	// present in the source changelog, so stripping that inherited history from the
	// file silently removed the attribution from the page too. Veyyon is a fork
	// whether or not we still carry the pre-fork entries, and the note is where a
	// reader is told where the project came from.
	parts.push(upstreamNote(forkPointVersion));
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

/**
 * Published releases that predate this gate and have no CHANGELOG entry.
 *
 * EMPTY, so the gate is unconditional: any published release without an entry
 * fails the build. Keep it that way. The list may only shrink, never grow, and
 * `reportUndocumentedReleases` says so in the message it throws.
 *
 * It held eight versions until 2026-07-25. A warning had not been enough: every
 * build printed one, exited 0, and the gap grew until a user could install eight
 * versions the changelog did not describe, reported as "600 commits and it
 * mentions almost nothing". Failing outright would have broken the site deploy
 * over a backlog that predated the check, so the list grandfathered exactly
 * those versions while a release outside it failed immediately. It emptied when
 * the backfill landed: `## [1.0.0]` through `## [1.0.36]` were reconstructed from
 * git history, one section per version, each dated by the `chore: bump version`
 * commit that cut it.
 */
export const UNDOCUMENTED_RELEASE_BASELINE = Object.freeze([]);

/**
 * Fail on a published release the CHANGELOG does not describe, unless it is one
 * of the grandfathered {@link UNDOCUMENTED_RELEASE_BASELINE} versions.
 *
 * Exported so the gate is testable without a network round trip: it takes the
 * reconciliation's unmatched list, nothing else.
 *
 * Also reports a baseline entry that no longer appears — a version whose entry
 * has landed. That is not a failure, it is the ratchet asking to be tightened,
 * and saying so is what keeps the list from ossifying into permanent noise.
 */
export function reportUndocumentedReleases(unmatchedPublished, baseline = UNDOCUMENTED_RELEASE_BASELINE) {
	const grandfathered = new Set(baseline);
	const unexpected = unmatchedPublished.filter(r => !grandfathered.has(r.version));
	if (unexpected.length) {
		throw new Error(
			`changelog: ${unexpected.length} published GitHub release(s) have no CHANGELOG entry: ` +
				`${unexpected.map(r => `v${r.version}`).join(", ")}. ` +
				"Add them to packages/coding-agent/CHANGELOG.md. " +
				"A release is not documented until its entry exists; do not add it to UNDOCUMENTED_RELEASE_BASELINE, " +
				"which is a shrinking list of pre-existing gaps and not a place to park new ones.",
		);
	}
	const stillMissing = unmatchedPublished.map(r => r.version);
	if (stillMissing.length) {
		console.warn(
			`changelog: ${stillMissing.length} grandfathered release(s) still undocumented: ` +
				`${stillMissing.map(v => `v${v}`).join(", ")}. Backfill them and shrink UNDOCUMENTED_RELEASE_BASELINE.`,
		);
	}
	const landed = baseline.filter(v => !stillMissing.includes(v));
	if (landed.length) {
		console.log(
			`changelog: ${landed.length} baseline release(s) are now documented (${landed.map(v => `v${v}`).join(", ")}). ` +
				"Remove them from UNDOCUMENTED_RELEASE_BASELINE.",
		);
	}
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
		ghReleases = await resolvePublicationState(repo);
		console.log(`changelog: fetched ${ghReleases.length} GitHub release(s) from ${repo}`);
	}

	const { releases, unmatchedPublished } = reconcile(all, ghReleases);
	reportUndocumentedReleases(unmatchedPublished);

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
