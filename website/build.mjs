#!/usr/bin/env node
/**
 * Build the deployable website/ tree for Cloudflare Pages.
 *
 *   node website/build.mjs
 *
 * Steps:
 *  1. Regenerate changelog.html from the real CHANGELOG (single source of truth).
 *  2. Stage the install scripts at the site root so `veyyon.dev/install.sh` and
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

// 1. Changelog.
execFileSync(process.execPath, [join(HERE, "tools", "gen-changelog.mjs")], { stdio: "inherit" });

// 2. Install scripts → site root (build artifacts; real source lives in scripts/).
for (const name of ["install.sh", "install.ps1"]) {
	const src = join(REPO, "scripts", name);
	const dst = join(HERE, name);
	copyFileSync(src, dst);
	console.log(`staged ${name}`);
}

// Sanity: the pages must not leak the old product name (only the MIT oh-my-pi
// attribution and clearly-marked OMP_ legacy env aliases are allowed).
const OFFENDERS = /\bomp[ -]|omp\.exe|%LOCALAPPDATA%\\omp\b/i;
for (const page of ["index.html", "features.html", "models.html", "install.html", "changelog.html"]) {
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
