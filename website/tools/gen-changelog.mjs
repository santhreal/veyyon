#!/usr/bin/env node
/**
 * Generate the website changelog from the real CHANGELOG (single source of
 * truth), so the page can never drift from what actually shipped.
 *
 *   node website/tools/gen-changelog.mjs
 *
 * Source: packages/coding-agent/CHANGELOG.md (Keep a Changelog format).
 * Target: the region between <!--CHANGELOG:START--> and <!--CHANGELOG:END-->
 *         in website/changelog.html.
 *
 * The upstream changelog is written in oh-my-pi's voice — `omp` commands and
 * links to can1357/oh-my-pi issues. Those are rebranded / stripped here so the
 * public page speaks as Veyyon. Provenance still lives on the History section
 * and the full CHANGELOG on GitHub.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const CHANGELOG = join(REPO, "packages", "coding-agent", "CHANGELOG.md");
const PAGE = join(HERE, "..", "changelog.html");

/** How many recent releases to render; the rest live in the full history. */
const MAX_RELEASES = 14;
/** Collapse a section's bullets behind a "show all" toggle past this many. */
const COLLAPSE_AFTER = 6;
/**
 * The oh-my-pi version veyyon forked from. Every changelog entry at this version
 * and older is inherited upstream history, not a veyyon release; veyyon's own
 * release line starts at 1.0.0 and its entries are added above the fork point in
 * the source CHANGELOG. In file order the first `## [16.5.2]` therefore marks the
 * boundary: releases before it are veyyon's, releases from it down are upstream.
 */
const FORK_POINT_VERSION = "16.5.2";

/** Map a changelog section heading to a tag class + short label. */
function tagFor(section) {
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
function rebrand(text) {
	return (
		text
			// Drop trailing "([#1234](…oh-my-pi…) follow-up)" style provenance notes.
			.replace(/\s*\(\[#\d+\]\(https?:\/\/[^)]*oh-my-pi[^)]*\)[^)]*\)/g, "")
			// Drop bare upstream issue/PR links, keeping nothing.
			.replace(/\[#\d+\]\(https?:\/\/[^)]*oh-my-pi[^)]*\)/g, "")
			// Internal URI scheme was renamed omp:// → veyyon:// (omp:// is a legacy alias).
			// Run before the bare-command rule (omp:// has no trailing space, so the
			// command rule would miss it anyway, but keep the intent explicit).
			.replace(/\bomp:\/\//g, "veyyon://")
			// Release binary assets were `omp-<platform>-<arch>` → `veyyon-…`.
			.replace(/\bomp-(windows|linux|darwin|macos)\b/g, "veyyon-$1")
			// `omp <subcommand>` as a CLI command → `vey`, whether backticked or bare
			// prose. `\bomp ` also matches `` `omp `` (backtick is a word boundary), so
			// the leading backtick is preserved. Leaves `.omp` config-dir paths alone.
			.replace(/\bomp /g, "vey ")
			.replace(/`omp`/g, "`vey`")
	);
}

/** Escape HTML, then re-render `inline code` and [text](url) links. */
function renderInline(text) {
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

/** Parse the changelog into an ordered list of releases. */
function parseReleases(md) {
	const lines = md.split("\n");
	const releases = [];
	let cur = null;
	let section = null;
	let bullet = null;

	const flushBullet = () => {
		if (cur && section && bullet !== null) {
			section.items.push(bullet.trim());
		}
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
			const version = relMatch[1].trim();
			cur = { version, date: (relMatch[2] || "").trim(), sections: [] };
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
	return releases.filter(r => r.version.toLowerCase() !== "unreleased");
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

function renderRelease(rel, { isLatest, isUpstream }) {
	const anchor = `v${rel.version.replace(/\./g, "-")}`;
	const date = rel.date ? `<span class="date">${rel.date}</span>` : "";
	const sections = rel.sections.map(renderSection).join("\n");
	const cls = `release${isLatest ? " latest" : ""}${isUpstream ? " upstream" : ""}`;
	return [
		`\t\t<article class="${cls}">`,
		`\t\t\t<div class="release-head">`,
		`\t\t\t\t<h2 id="${anchor}"><a href="#${anchor}">${rel.version}</a></h2>`,
		`\t\t\t\t${date}`,
		isLatest ? `\t\t\t\t<span class="pill">latest</span>` : "",
		isUpstream ? `\t\t\t\t<span class="pill upstream">oh-my-pi</span>` : "",
		`\t\t\t</div>`,
		sections,
		`\t\t</article>`,
	]
		.filter(Boolean)
		.join("\n");
}

/** Banner separating veyyon's own releases from inherited upstream history. */
function upstreamDivider() {
	return [
		`\t\t<div class="upstream-divider">`,
		`\t\t\t<h2>Inherited from oh-my-pi</h2>`,
		`\t\t\t<p>Everything below predates the fork (upstream <a href="https://github.com/can1357/oh-my-pi">can1357/oh-my-pi</a>, MIT). These are not veyyon releases — veyyon's own line starts at 1.0.0.</p>`,
		`\t\t</div>`,
	].join("\n");
}

function main() {
	const md = readFileSync(CHANGELOG, "utf8");
	const all = parseReleases(md);
	if (!all.length) throw new Error("no releases parsed from CHANGELOG");

	// File order is newest-first; the first entry at the fork point (and everything
	// after) is inherited upstream history. Everything before it is veyyon's own.
	const forkIdx = all.findIndex(r => r.version === FORK_POINT_VERSION);
	const veyyon = forkIdx === -1 ? all : all.slice(0, forkIdx);
	const upstream = forkIdx === -1 ? [] : all.slice(forkIdx);

	// Always show veyyon's full line, then fill the remaining budget with upstream
	// history so the boundary is never hidden by the release cap.
	const upstreamShown = upstream.slice(0, Math.max(0, MAX_RELEASES - veyyon.length));

	const parts = [];
	for (let i = 0; i < veyyon.length; i++) {
		parts.push(renderRelease(veyyon[i], { isLatest: i === 0, isUpstream: false }));
	}
	if (upstreamShown.length) {
		parts.push(upstreamDivider());
		for (const rel of upstreamShown) {
			parts.push(renderRelease(rel, { isLatest: false, isUpstream: true }));
		}
	}
	const body = parts.join("\n");
	const releases = [...veyyon, ...upstreamShown];

	const page = readFileSync(PAGE, "utf8");
	const start = "<!--CHANGELOG:START-->";
	const end = "<!--CHANGELOG:END-->";
	const si = page.indexOf(start);
	const ei = page.indexOf(end);
	if (si === -1 || ei === -1) {
		throw new Error(`changelog.html is missing ${start} / ${end} markers`);
	}
	const next = `${page.slice(0, si + start.length)}\n${body}\n\t\t${page.slice(ei)}`;
	writeFileSync(PAGE, next);
	const latestVeyyon = veyyon[0]?.version ?? "none yet";
	console.log(
		`changelog: wrote ${veyyon.length} veyyon release(s) (latest ${latestVeyyon}) + ${upstreamShown.length} inherited oh-my-pi entries`,
	);
}

main();
