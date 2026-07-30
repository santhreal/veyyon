#!/usr/bin/env node
/**
 * Deploy the website to Cloudflare Pages. The single canonical deploy path —
 * before this, the wrangler invocation lived only in someone's shell history.
 *
 *   node website/deploy.mjs            # deploy the main site (project: veyyon)
 *   node website/deploy.mjs --dry-run  # build + print the command, don't deploy
 *   node website/deploy.mjs --skip-build # deploy a tree built earlier in this job
 *
 * What it does:
 *  1. Runs `build.mjs` (regenerates changelog.html, stages install scripts,
 *     runs the brand check — a failing brand check aborts the deploy).
 *  2. Publishes `website/` to `veyyon`, or staged `website-get/` to `veyyon-get`.
 *
 * Auth: Wrangler may use its cached login. In CI, set `CLOUDFLARE_API_TOKEN`
 * to a Pages-edit token and optionally set `CLOUDFLARE_ACCOUNT_ID`.
 *
 * Two Pages projects back the site: `veyyon` serves veyyon.dev from `website/`,
 * and `veyyon-get` serves get.veyyon.dev from `website-get/`. Select the latter
 * with `VEYYON_PAGES_PROJECT=veyyon-get`.
 *
 * The handbook (`website/docs` → `docs/handbook/book`) is a symlink. Rebuild it
 * with `mdbook build` in `docs/handbook` first. Deployment copies the tree with
 * symlinks dereferenced so Wrangler hashes the rebuilt handbook files.
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertNewDeployment,
	findExternalNodeExecutable,
	stageDeployTree,
} from "./deploy-staging.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const HERE = path.dirname(SCRIPT_PATH);
const WRANGLER_VERSION = "4.114.0";
const dryRun = process.argv.includes("--dry-run");
const skipBuild = process.argv.includes("--skip-build");
const project = process.env.VEYYON_PAGES_PROJECT || "veyyon";

// `bun run` otherwise executes this `node` script inside Bun, whose child-process
// compatibility layer can return before Wrangler's network work completes.
if (typeof Bun !== "undefined") {
	const nodeExecutable = findExternalNodeExecutable();
	const environment = {
		...process.env,
		PATH: [path.dirname(nodeExecutable), process.env.PATH].filter(Boolean).join(path.delimiter),
	};
	delete environment.BUN_BE_BUN;
	const child = Bun.spawn([nodeExecutable, SCRIPT_PATH, ...process.argv.slice(2)], {
		env: environment,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	process.exit(await child.exited);
}
if (project !== "veyyon" && project !== "veyyon-get") {
	console.error(`error: unknown Pages project '${project}'; expected 'veyyon' or 'veyyon-get'`);
	process.exit(1);
}
const deployDirectory = project === "veyyon-get" ? path.join(HERE, "..", "website-get") : HERE;

function latestProductionDeploymentId() {
	const output = execFileSync(
		"npx",
		[
			"--yes",
			`wrangler@${WRANGLER_VERSION}`,
			"pages",
			"deployment",
			"list",
			"--project-name",
			project,
			"--environment",
			"production",
			"--json",
		],
		{ encoding: "utf8" },
	);
	const deployments = JSON.parse(output);
	const id = deployments[0]?.Id;
	if (typeof id !== "string" || !id) {
		throw new Error(`Cloudflare Pages returned no production deployments for '${project}'`);
	}
	return id;
}


// 1. Build unless this job already ran the canonical builder and its gates.
if (!skipBuild) {
	execFileSync(process.execPath, [path.join(HERE, "build.mjs")], { stdio: "inherit" });
}

const args = [
	"pages",
	"deploy",
	".",
	"--project-name",
	project,
	"--branch",
	"main",
	"--commit-dirty=true",
	"--skip-caching",
];
if (dryRun) {
	console.log(
		`dry run — would stage '${deployDirectory}' with symlinks dereferenced, then deploy to Pages project '${project}':\n  npx --yes wrangler@${WRANGLER_VERSION} ${args.join(" ")}`,
	);
	process.exit(0);
}

const previousDeploymentId = latestProductionDeploymentId();
const staged = stageDeployTree(deployDirectory);
try {
	console.log(`Deploying staged ${path.basename(deployDirectory)}/ to Cloudflare Pages project '${project}'…`);
	execFileSync("npx", ["--yes", `wrangler@${WRANGLER_VERSION}`, ...args], {
		cwd: staged.directory,
		stdio: "inherit",
	});
	const deploymentId = assertNewDeployment(previousDeploymentId, latestProductionDeploymentId(), project);
	console.log(`deploy OK (${deploymentId})`);
} finally {
	staged.cleanup();
}
