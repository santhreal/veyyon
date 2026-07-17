#!/usr/bin/env node
/**
 * Deploy the website to Cloudflare Pages. The single canonical deploy path —
 * before this, the wrangler invocation lived only in someone's shell history.
 *
 *   node website/deploy.mjs            # deploy the main site (project: veyyon)
 *   node website/deploy.mjs --dry-run  # build + print the command, don't deploy
 *
 * What it does:
 *  1. Runs `build.mjs` (regenerates changelog.html, stages install scripts,
 *     runs the brand check — a failing brand check aborts the deploy).
 *  2. Publishes the `website/` tree to the `veyyon` Cloudflare Pages project.
 *
 * Auth: set `CLOUDFLARE_API_TOKEN` (a Pages-edit token; the account is resolved
 * from the token, or set `CLOUDFLARE_ACCOUNT_ID`). On the Santh hosts the token
 * lives in `/credentials/.env` as `CF_PAGES_API_TOKEN` — export it first:
 *   export CLOUDFLARE_API_TOKEN="$CF_PAGES_API_TOKEN"
 *
 * Two Pages projects back the site: `veyyon` serves veyyon.dev (this deploy),
 * and `veyyon-get` serves get.veyyon.dev (the `curl | sh` install endpoint).
 * Override the target with `VEYYON_PAGES_PROJECT` to deploy the latter.
 *
 * The handbook (website/docs → docs/handbook/book) is a symlink; rebuild it with
 * `mdbook build` in docs/handbook first if the docs changed.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dryRun = process.argv.includes("--dry-run");
const project = process.env.VEYYON_PAGES_PROJECT || "veyyon";

if (!dryRun && !process.env.CLOUDFLARE_API_TOKEN) {
	console.error(
		"error: CLOUDFLARE_API_TOKEN is not set.\n" +
			"  export CLOUDFLARE_API_TOKEN=\"$CF_PAGES_API_TOKEN\"   # token lives in /credentials/.env\n" +
			"  (or pass --dry-run to build and preview the command without deploying)",
	);
	process.exit(1);
}

// 1. Build (regenerate + brand-check). A failed brand check exits non-zero here.
execFileSync(process.execPath, [join(HERE, "build.mjs")], { stdio: "inherit" });

// 2. Deploy the built tree.
const args = ["wrangler@latest", "pages", "deploy", HERE, "--project-name", project, "--branch", "main", "--commit-dirty=true"];
if (dryRun) {
	console.log(`dry run — would deploy to Pages project '${project}':\n  bunx ${args.join(" ")}`);
	process.exit(0);
}
console.log(`Deploying website/ to Cloudflare Pages project '${project}'…`);
execFileSync("bunx", args, { stdio: "inherit" });
console.log("deploy OK");
