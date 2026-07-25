#!/usr/bin/env node
/**
 * Build the deployable website/ tree for Cloudflare Pages.
 *
 *   node website/build.mjs
 *
 * Steps:
 *  1. Regenerate changelog.html from the real CHANGELOG (single source of truth).
 *  2. Render the blog from website/blog/*.md and fold published posts into the
 *     sitemap. Drafts render (for a review link) but stay out of the sitemap.
 *  3. Stage the install scripts at the site root so `veyyon.dev/install.sh` and
 *     `veyyon.dev/install.ps1` resolve. Source of truth stays in scripts/; the
 *     copies here are gitignored build artifacts.
 *
 * The handbook (website/docs) is a symlink to docs/handbook/book — rebuild it
 * with `mdbook build` in docs/handbook before deploying if the docs changed.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildBlog } from "./tools/gen-blog.mjs";
import { renderNav } from "./tools/nav.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

// 0. Navigation. The hand-authored pages each carry two header navs (desktop plus
// the mobile disclosure) and a footer nav, which used to be nine hand-copied
// blocks that drifted: 404.html lost the Blog link and nobody noticed. The links
// now live in tools/nav.mjs and get written into each page's <!--NAV:START--> /
// <!--NAV:END--> region here, so adding a link is a one-line change and no page
// can fall behind. `current` marks aria-current="page" for that page's own link.
// A page whose markers are missing is a hard error: silently skipping it is how
// the drift happened in the first place.
const NAV_PAGES = [
	{ file: "index.html", current: undefined },
	{ file: "features.html", current: "features" },
	{ file: "models.html", current: "models" },
	{ file: "install.html", current: "install" },
	{ file: "changelog.html", current: "changelog" },
	{ file: "404.html", current: undefined },
];
for (const { file, current } of NAV_PAGES) {
	const path = join(HERE, file);
	const html = readFileSync(path, "utf8");
	let regions = 0;
	const next = html.replace(
		/([ \t]*)<!--NAV:START-->[\s\S]*?<!--NAV:END-->/g,
		(_match, indent, offset, whole) => {
			regions++;
			// The footer nav carries no Get-started button; the two header navs do.
			// The footer is the last region on the page, inside <footer class="site">.
			const cta = !whole.slice(0, offset).includes('<footer class="site">');
			const body = renderNav({ prefix: "./", current, cta, indent: `${indent}  ` });
			return `${indent}<!--NAV:START-->\n${body}\n${indent}<!--NAV:END-->`;
		},
	);
	if (regions !== 3) {
		console.error(
			`${file}: expected 3 <!--NAV:START-->/<!--NAV:END--> regions (desktop, mobile, footer), found ${regions}`,
		);
		process.exit(1);
	}
	if (next !== html) writeFileSync(path, next);
}
console.log(`nav: wrote ${NAV_PAGES.length * 3} nav region(s) from tools/nav.mjs`);

// 1. Changelog.
execFileSync(process.execPath, [join(HERE, "tools", "gen-changelog.mjs")], { stdio: "inherit" });

// 2. Blog → HTML, then reconcile the sitemap's blog region with what published.
const { publishedUrls, indexUrl } = buildBlog();
{
	const path = join(HERE, "sitemap.xml");
	const xml = readFileSync(path, "utf8");
	const urls = [indexUrl, ...publishedUrls]
		.map((u) => `  <url><loc>${u}</loc><priority>0.6</priority></url>`)
		.join("\n");
	const region = `<!--BLOG:START-->\n${urls}\n  <!--BLOG:END-->`;
	const next = xml.replace(/<!--BLOG:START-->[\s\S]*?<!--BLOG:END-->/, region);
	if (next === xml && !/<!--BLOG:START-->/.test(xml)) {
		console.error("sitemap.xml is missing the <!--BLOG:START-->/<!--BLOG:END--> markers");
		process.exit(1);
	}
	writeFileSync(path, next);
	console.log(`sitemap: ${publishedUrls.length} published post(s) + blog index`);
}

// 3. Install scripts → site root (build artifacts; real source lives in scripts/).
for (const name of ["install.sh", "install.ps1"]) {
	const src = join(REPO, "scripts", name);
	const dst = join(HERE, name);
	copyFileSync(src, dst);
	console.log(`staged ${name}`);
}

// 3b. get.veyyon.dev is the `curl -fsSL https://get.veyyon.dev | sh` endpoint. It
// deploys to a SEPARATE Pages project (veyyon-get) from a SEPARATE tree so its
// root can serve install.sh while veyyon.dev's root serves the marketing site.
// They cannot share one tree: Cloudflare Pages _redirects has no hostname
// matching, so a `/  /install.sh 200` rewrite in the shared website/ tree would
// also hijack veyyon.dev's homepage. This tree holds only the two install
// scripts and a plain root rewrite, so there is no index.html to serve at the
// root and no way to pipe HTML into sh. Gitignored build artifact; ci.yml
// deploys website-get/ to the veyyon-get project.
const GET = join(REPO, "website-get");
mkdirSync(GET, { recursive: true });
for (const name of ["install.sh", "install.ps1"]) {
	copyFileSync(join(REPO, "scripts", name), join(GET, name));
}
writeFileSync(join(GET, "_redirects"), "/  /install.sh  200\n");
console.log("staged website-get/ (get.veyyon.dev root -> install.sh)");

// Sanity: the pages must not leak the old product name (only the MIT oh-my-pi
// attribution and clearly-marked OMP_ legacy env aliases are allowed).
const OFFENDERS = /\bomp[ -]|omp\.exe|%LOCALAPPDATA%\\omp\b/i;
const pages = ["index.html", "features.html", "models.html", "install.html", "changelog.html", "blog/index.html", "blog/argot.html"];
for (const page of pages) {
	const html = readFileSync(join(HERE, page), "utf8");
	const bad = html.split("\n").filter(l => OFFENDERS.test(l) && !/oh-my-pi/.test(l));
	if (bad.length) {
		console.error(`brand check FAILED in ${page}:\n  ${bad[0].trim().slice(0, 120)}`);
		process.exit(1);
	}
}
// install.sh/.ps1 are veyyon-branded already; no rewrite needed.
writeFileSync(join(HERE, ".buildinfo"), "built\n");
console.log("website build OK");
