/**
 * Every `gh` call in a checkout-less job names the repository it talks to.
 *
 * v1.0.45 was tagged, drafted, and then never published. Its publish job ran
 * `gh release download` with no `--repo`, in a job with no `actions/checkout`.
 * `gh` resolves an unnamed repository by asking git, there was no git
 * repository on that runner, and the step died with
 * `failed to run git: fatal: not a git repository`. Six releases, v1.0.40
 * through v1.0.45, sat as unpublished drafts behind that one missing flag.
 *
 * That specific call was later rewritten as `gh api
 * "repos/$GITHUB_REPOSITORY/..."`, which spells the repository out and never
 * touches git. Nothing stopped the shape from coming back, so this is the
 * standing gate. It reads the workflows as YAML data and fails when a job with
 * neither a checkout nor `GH_REPO` in scope runs a `gh` subcommand that would
 * fall back to git.
 *
 * If this regresses, a release is tagged, drafted, and then silently never
 * published. The publish job is last in the chain, so nothing downstream goes
 * red, and you find out from a failing website build weeks later.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

interface WorkflowStep {
	name?: string;
	id?: string;
	uses?: string;
	run?: string;
	env?: Record<string, unknown>;
}

interface WorkflowJob {
	env?: Record<string, unknown>;
	steps?: WorkflowStep[];
}

interface WorkflowDocument {
	env?: Record<string, unknown>;
	jobs?: Record<string, WorkflowJob>;
}

/** One `gh` invocation, with the two things that could supply its repository. */
interface GhCall {
	workflow: string;
	job: string;
	step: string;
	command: string;
	/** Did an `actions/checkout` step already run, leaving a git repository behind? */
	checkedOut: boolean;
	/** Is `GH_REPO` set at workflow, job, or step scope? */
	ghRepo: boolean;
}

/**
 * `gh` command groups that resolve the current repository when no `--repo` is
 * given, and therefore shell out to git in a checkout-less job.
 *
 * `api` is deliberately absent. It only consults git when the path uses the
 * `{owner}`/`{repo}` placeholders, so {@link isViolation} judges it by the path
 * instead of by the group.
 */
const REPO_SCOPED_GROUPS: Record<string, true> = {
	browse: true,
	cache: true,
	issue: true,
	label: true,
	pr: true,
	release: true,
	ruleset: true,
	run: true,
	secret: true,
	variable: true,
	workflow: true,
};

/** Is `GH_REPO` set to something usable at this scope? An empty value is not. */
function ghRepoIn(env: Record<string, unknown> | undefined): boolean {
	const value = env?.GH_REPO;
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Drop whole-line comments, then join shell line continuations, so a command
 * spread over several lines is judged as one command. A `--repo` on the second
 * line still counts, and a `gh` inside a comment does not.
 *
 * Comments go first: a comment ending in `\` would otherwise swallow the real
 * command on the line below it.
 */
function flatten(script: string): string {
	const withoutComments = script
		.split("\n")
		.map(line => (/^\s*#/.test(line) ? "" : line))
		.join("\n");
	// `\` continues a line in bash, a backtick continues one in pwsh.
	return withoutComments.replace(/[\\`][ \t]*\r?\n[ \t]*/g, " ");
}

/**
 * Split a script into command segments, respecting quotes.
 *
 * The quote tracking is the point. `gh run list --jq '.[] | .id' --repo "$R"`
 * has a `|` that is data, not a pipe; splitting on it would drop the `--repo`
 * that follows and report a violation that is not there.
 */
function segments(script: string): string[] {
	const found: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < script.length; i++) {
		const ch = script[i]!;
		if (ch === "\\" && quote !== "'") {
			current += ch + (script[i + 1] ?? "");
			i++;
			continue;
		}
		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === ";" || ch === "\n" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
			found.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	found.push(current);
	return found;
}

/**
 * The `gh` command in this segment with the shell noise in front of it removed,
 * or null when the segment does not invoke `gh`.
 *
 * The noise is real: `existing=$(gh issue list …)` leaves `gh issue list …` in
 * its own segment, pwsh writes `$assetId = gh api …` with no substitution, and
 * `[ -z "$id" ] || gh api …` puts a bare command after an operator.
 */
function commandOf(segment: string): string | null {
	let text = segment.trim();
	for (;;) {
		const before = text;
		text = text
			.replace(/^[!`]\s*/, "")
			.replace(/^(?:then|else|elif|do|if|not)\s+/, "")
			.replace(/^\$?[A-Za-z_][\w:.]*\s*=\s*/, "");
		if (text === before) break;
	}
	return /^gh(\s|$)/.test(text) ? text : null;
}

/** Every `gh` invocation a workflow runs, whether or not its repository is named. */
function ghCalls(workflow: string, doc: WorkflowDocument): GhCall[] {
	const calls: GhCall[] = [];
	const workflowGhRepo = ghRepoIn(doc.env);
	for (const [job, definition] of Object.entries(doc.jobs ?? {})) {
		const jobGhRepo = workflowGhRepo || ghRepoIn(definition.env);
		let checkedOut = false;
		for (const step of definition.steps ?? []) {
			// Order matters. A `gh` step above the checkout has no git repository
			// yet, so a checkout further down the job does not rescue it.
			if (typeof step.uses === "string" && /actions\/checkout(?:@|$)/.test(step.uses)) {
				checkedOut = true;
				continue;
			}
			if (typeof step.run !== "string") continue;
			for (const segment of segments(flatten(step.run))) {
				const command = commandOf(segment);
				if (!command) continue;
				calls.push({
					workflow,
					job,
					step: step.name ?? step.id ?? "(unnamed)",
					command: command.replace(/\s+/g, " ").trim(),
					checkedOut,
					ghRepo: jobGhRepo || ghRepoIn(step.env),
				});
			}
		}
	}
	return calls;
}

/**
 * Would this call ask git which repository it is in, on a runner where no git
 * repository exists?
 *
 * A checkout or `GH_REPO` answers the question before `gh` has to ask it.
 * `--repo`/`-R` names the repository outright. `gh api` names it in the path,
 * so `repos/$GITHUB_REPOSITORY/releases` is explicit while
 * `repos/{owner}/{repo}/releases` is filled in from git. `--org`/`--user` scope
 * a command away from repositories altogether.
 */
function isViolation(call: GhCall): boolean {
	if (call.checkedOut || call.ghRepo) return false;
	const command = call.command;
	if (/(?:^|\s)(?:--repo|-R)(?:[=\s]|$)/.test(command)) return false;
	const group = command.split(/\s+/)[1] ?? "";
	if (group === "api") return /\{owner\}|\{repo\}/.test(command);
	if (!REPO_SCOPED_GROUPS[group]) return false;
	return !/(?:^|\s)--(?:org|user)(?:[=\s]|$)/.test(command);
}

/** Run the checker over a workflow written inline. */
function check(yaml: string, workflow = "fixture.yml"): GhCall[] {
	return ghCalls(workflow, Bun.YAML.parse(yaml) as WorkflowDocument).filter(isViolation);
}

const REAL_WORKFLOWS = fs
	.readdirSync(WORKFLOWS_DIR)
	.filter(name => name.endsWith(".yml") || name.endsWith(".yaml"))
	.sort()
	.map(name => ({
		name,
		doc: Bun.YAML.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, name), "utf8")) as WorkflowDocument,
	}));

const REAL_CALLS = REAL_WORKFLOWS.flatMap(({ name, doc }) => ghCalls(name, doc));

describe("gh calls in checkout-less jobs name their repository", () => {
	it("holds across every workflow in the repo", () => {
		expect(REAL_CALLS.filter(isViolation)).toEqual([]);
	});

	/**
	 * The census the gate guards. Running `gh` where no git repository exists is
	 * the exact shape that stalled v1.0.45, so the set of jobs doing it is small
	 * and worth reviewing by hand. Add an entry only after checking that every
	 * `gh` call in the new job names its repository.
	 */
	it("is watching the jobs that really do run gh without a checkout", () => {
		const exposed = [
			...new Set(
				REAL_CALLS.filter(call => !call.checkedOut && !call.ghRepo).map(call => `${call.workflow}::${call.job}`),
			),
		].sort();
		expect(exposed).toEqual([
			"ci.yml::release_github_publish",
			"ci.yml::release_github_verify",
			"ci.yml::release_github_verify_linux",
			"ci.yml::release_github_verify_windows",
			"ci.yml::release_train_alert",
			"release.yml::release_failed_alert",
		]);
	});

	/**
	 * Proves the clean result above is earned rather than vacuous. Strip the
	 * explicit repositories out of the real ci.yml and every checkout-less job
	 * that runs `gh` lights up. A checker that quietly parsed nothing, or that
	 * stopped recognising `gh`, would report nothing here.
	 */
	it("flags the real workflows once their explicit repositories are removed", () => {
		const real = fs.readFileSync(path.join(WORKFLOWS_DIR, "ci.yml"), "utf8");
		const stripped = real
			.replaceAll("repos/$env:GITHUB_REPOSITORY/", "repos/{owner}/{repo}/")
			.replaceAll("repos/$GITHUB_REPOSITORY/", "repos/{owner}/{repo}/")
			.replaceAll(' --repo "$GITHUB_REPOSITORY"', "");
		const jobs = [...new Set(check(stripped, "ci.yml").map(call => call.job))].sort();
		expect(jobs).toEqual([
			"release_github_publish",
			"release_github_verify",
			"release_github_verify_linux",
			"release_github_verify_windows",
			"release_train_alert",
		]);
	});
});

describe("the checker", () => {
	/** The v1.0.45 shape: no checkout, `gh release download` with no repository. */
	it("catches the call that stalled v1.0.45", () => {
		const violations = check(
			`name: publish
jobs:
  release_github_publish:
    runs-on: ubuntu-latest
    steps:
      - name: Download the draft assets
        env:
          GH_TOKEN: t
        run: |
          set -euo pipefail
          gh release download "$TAG" --dir out
`,
			"v1.0.45.yml",
		);
		expect(violations).toEqual([
			{
				workflow: "v1.0.45.yml",
				job: "release_github_publish",
				step: "Download the draft assets",
				command: 'gh release download "$TAG" --dir out',
				checkedOut: false,
				ghRepo: false,
			},
		]);
	});

	it("accepts the same call in a job that checks out the repo", () => {
		expect(
			check(`name: publish
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: gh release download "$TAG" --dir out
`),
		).toEqual([]);
	});

	it("accepts the same call in a job that sets GH_REPO", () => {
		expect(
			check(`name: publish
jobs:
  publish:
    runs-on: ubuntu-latest
    env:
      GH_REPO: owner/repo
    steps:
      - run: gh release download "$TAG" --dir out
`),
		).toEqual([]);
	});

	it("accepts an explicit --repo, including on a continued line", () => {
		expect(
			check(`name: publish
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: |
          gh release download "$TAG" \\
            --repo "$GITHUB_REPOSITORY" --dir out
`),
		).toEqual([]);
	});

	/**
	 * A checkout below a `gh` step does not help that step: the workspace is
	 * still empty when `gh` asks git where it is.
	 */
	it("catches a gh call that runs before the checkout in its own job", () => {
		expect(
			check(`name: publish
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: gh run list --limit 1
      - uses: actions/checkout@v6
`).map(call => call.command),
		).toEqual(["gh run list --limit 1"]);
	});

	/**
	 * `gh api` is the safe rewrite only when the path spells the repository out.
	 * The `{owner}`/`{repo}` placeholders are filled in from git, so they carry
	 * the identical failure.
	 */
	it("tells an explicit gh api path apart from one using {owner}/{repo}", () => {
		expect(
			check(`name: publish
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: gh api "repos/$GITHUB_REPOSITORY/releases/1/assets"
`),
		).toEqual([]);
		expect(
			check(`name: publish
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: gh api "repos/{owner}/{repo}/releases/1/assets"
`).map(call => call.command),
		).toEqual(['gh api "repos/{owner}/{repo}/releases/1/assets"']);
	});

	/**
	 * The `|` inside a jq filter is data. Treating it as a pipe would truncate
	 * the command before its `--repo` and report a violation that is not there,
	 * which is how a gate like this gets switched off.
	 */
	it("does not mistake a pipe inside a quoted jq filter for a command break", () => {
		expect(
			check(`name: publish
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: gh run list --json databaseId --jq '.[] | .databaseId' --repo "$GITHUB_REPOSITORY"
`),
		).toEqual([]);
	});

	/** A commented-out command is not a command. */
	it("ignores gh inside a comment", () => {
		expect(
			check(`name: publish
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: |
          # gh release download "$TAG" --dir out is what broke v1.0.45
          echo ok
`),
		).toEqual([]);
	});
});
