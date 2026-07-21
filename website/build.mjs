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
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildBlog } from "./tools/gen-blog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

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
