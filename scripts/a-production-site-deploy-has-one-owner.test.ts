/**
 * Deploying veyyon.dev and get.veyyon.dev happens in one place.
 *
 * WHY THIS SUITE EXISTS. Three jobs deploy the site — `site.yml` on a push to main,
 * `ci.yml`'s `release_site` before the draft release becomes visible, and its
 * `release_site_finalize` after publication — and each one spelled out the whole
 * sequence: the `veyyon` project, the `veyyon-get` project, the credential
 * environment for both, and the digest check that proves get.veyyon.dev serves this
 * repository's install script. A change to any of it had to be made in three files.
 *
 * THE CLASS this closes: a second copy of the deploy sequence. The failure it
 * produced is on the record — `site.yml` triggered on `scripts/install.sh` and
 * deployed only veyyon.dev, so an installer change updated the docs about the
 * installer and left get.veyyon.dev serving a script hundreds of lines behind main,
 * because the second project was named in one file and not the other. The sequence
 * is now `.github/actions/deploy-cloudflare-site`, and every `.github/**` file is
 * read off disk here rather than listed, so a fourth deploy site, or a workflow that
 * reaches for `website/deploy.mjs` on its own, is red on arrival.
 *
 * WHAT IT DOES NOT CATCH. A deploy invoked from outside `.github/**` (the
 * `site:deploy` package script is exactly that, and is meant to be — an operator
 * deploying by hand is not CI drift). It also cannot tell whether the Pages projects
 * the action names still exist, or whether a token in scope can write to them.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const GITHUB_DIR = path.join(REPO_ROOT, ".github");
const DEPLOY_ACTION = path.join(GITHUB_DIR, "actions", "deploy-cloudflare-site", "action.yml");
const DEPLOY_ACTION_REF = "./.github/actions/deploy-cloudflare-site";

interface YamlFile {
	/** Path relative to the repository root, which is what a failure message needs. */
	name: string;
	text: string;
}

function githubYamlFiles(): YamlFile[] {
	const found: YamlFile[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))
				found.push({ name: path.relative(REPO_ROOT, full), text: fs.readFileSync(full, "utf8") });
		}
	};
	walk(GITHUB_DIR);
	return found;
}

const files = githubYamlFiles();
const action = fs.readFileSync(DEPLOY_ACTION, "utf8");
const others = files.filter(f => path.resolve(REPO_ROOT, f.name) !== DEPLOY_ACTION);

/** Every file naming a thing, so a failure says which file to open. */
function filesContaining(needle: string, scope: YamlFile[] = others): string[] {
	return scope.filter(f => f.text.includes(needle)).map(f => f.name);
}

describe("a production site deploy has one owner", () => {
	it("scans the whole .github tree, and the action is part of it", () => {
		// Names, not a count: this is the corpus every case below reads, so a walk
		// that silently returned nothing cannot pass.
		expect(files.map(f => f.name)).toContain(path.relative(REPO_ROOT, DEPLOY_ACTION));
		expect(files.filter(f => f.name.startsWith(".github/workflows/")).length).toBeGreaterThan(1);
	});

	it("invokes the Pages deployer nowhere else", () => {
		expect(filesContaining("website/deploy.mjs")).toEqual([]);
		expect(action).toContain("website/deploy.mjs --skip-build");
	});

	it("names the install-endpoint project nowhere else", () => {
		// The project name and the tree it publishes are one decision, and
		// `website/deploy.mjs` refuses a name it does not know. A second spelling in
		// CI is the drift that left get.veyyon.dev behind main.
		expect(filesContaining("VEYYON_PAGES_PROJECT")).toEqual([]);
		expect(filesContaining("veyyon-get")).toEqual([]);
		expect(action).toContain("VEYYON_PAGES_PROJECT: veyyon-get");
	});

	it("verifies the served installers from the deploy sequence itself", () => {
		// The check has to travel with the deploy that could have broken it. A job
		// that deploys the endpoint and leaves the digest check to someone else is
		// how a stale deployment stops being release-blocking.
		expect(filesContaining("verify-deployed-installers")).toEqual([]);
		expect(action).toContain("bun scripts/verify-deployed-installers.ts");
	});

	it("hands the action both credentials at every call site", () => {
		const callers = filesContaining(DEPLOY_ACTION_REF);
		expect(callers.sort()).toEqual([".github/workflows/ci.yml", ".github/workflows/site.yml"]);
		for (const caller of callers) {
			const text = others.find(f => f.name === caller)?.text ?? "";
			// One `with:` block per call, each carrying both secrets. Counted rather
			// than merely present, because ci.yml calls the action twice and one of
			// the two losing its credentials is a mid-release failure.
			const calls = text.split(DEPLOY_ACTION_REF).length - 1;
			// biome-ignore lint/suspicious/noTemplateCurlyInString: "${{ secrets.… }}" is the GitHub Actions expression being matched
			expect(text.split("cf-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}").length - 1).toBe(calls);
			// biome-ignore lint/suspicious/noTemplateCurlyInString: "${{ secrets.… }}" is the GitHub Actions expression being matched
			expect(text.split("cf-account-id: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}").length - 1).toBe(calls);
		}
	});

	it("declares the install endpoint on by default, so omitting the input deploys it", () => {
		// The dangerous default is the other way round: a caller that forgets the
		// input would silently stop publishing the install script. Only the
		// post-publication changelog rebuild opts out, and it says so.
		expect(action).toMatch(/install-endpoint:[\s\S]*?default: "true"/);
		const ci = others.find(f => f.name === ".github/workflows/ci.yml")?.text ?? "";
		expect(ci.split('install-endpoint: "false"').length - 1).toBe(1);
	});

	it("never verifies the endpoint by grepping for a shebang", () => {
		// The shape check is what let the drift through: it passed on any script
		// starting with `#!`, including the one the previous release had published.
		// If it reappears beside the digest check, the weaker one is the one
		// somebody trusts.
		expect(filesContaining('check_script "https://get.veyyon.dev"', files)).toEqual([]);
	});
});
