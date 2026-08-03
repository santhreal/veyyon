/**
 * A script run by a job that never installs must not import a workspace package by name.
 *
 * This has stranded a release twice, in two different scripts, and the only defense between the two
 * was a comment. v1.0.20: `release_github` ran `ci-release-notes.ts`, which imported
 * `@veyyon/utils/semver`. The job checks out and sets up bun but does NOT `bun install`, so the
 * workspace symlink `node_modules/@veyyon/utils` does not exist, and bun exited with
 * `Cannot find module '@veyyon/utils/semver'` before the generator produced a line. That script was
 * fixed by importing `../packages/utils/src/semver.ts` directly, and the reason was written into a
 * comment above the import.
 *
 * A comment protects the file it is in. v1.0.39 died the same way in a DIFFERENT file:
 * `Resolve release metadata` ran `scripts/release.ts`, which imports the same
 * `@veyyon/utils/semver`, and the run failed with the identical message. The tag was pushed, no
 * release object was ever created, and because that job also gated the release-train alert, nothing
 * reported it. That job now installs, so the tree is currently clean; this gate is what makes the
 * cleanliness durable rather than a coincidence between two fixes.
 *
 * WHY A STATIC IMPORT WALK AND NOT A SPAWN. Running each script with the workspace symlinks hidden
 * would be the behavioral check, but it would also EXECUTE release tooling, and several of these
 * scripts talk to GitHub or write files on import. The failure being prevented is purely a
 * resolution failure, decided by the import graph before a single statement runs, so the graph is
 * the honest thing to assert over. The walk follows relative imports transitively, because the
 * offending specifier is usually one hop away from the entry point rather than in it.
 *
 * TWO WAYS TO SATISFY THIS GATE, both fine: import the source file by relative path (what
 * `ci-release-notes.ts` does), or add an install step to the job (what `release_metadata` now does).
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");

interface WorkflowStep {
	uses?: string;
	run?: string;
	name?: string;
}

interface WorkflowJob {
	steps?: WorkflowStep[];
}

interface WorkflowDocument {
	jobs?: Record<string, WorkflowJob>;
}

/** A script reached by a job, named for the message a failure would produce. */
interface ScriptUse {
	workflow: string;
	job: string;
	script: string;
	/** The workspace specifier that would fail to resolve, if there is one. */
	specifier: string | null;
}

const rootManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
	scripts?: Record<string, string>;
};
const ROOT_SCRIPTS = rootManifest.scripts ?? {};

/**
 * Which `scripts/*.ts` files a shell block reaches.
 *
 * `bun run <name>` is followed through the root manifest, because that indirection is how most jobs
 * invoke tooling and a check that only saw literal `scripts/x.ts` paths would miss them. It is
 * followed TRANSITIVELY, not one level: 17 root scripts call `bun run` themselves, and
 * `ci:test:full` reaches `ci-test-ts.ts` only through `ci:test:ts`, two hops from the workflow. A
 * one-level walk returned nothing for that job and would have reported a clean result for a script
 * it never opened, which is the same vacuous-pass this file is written to prevent.
 *
 * `seen` guards the cycle a manifest can express even though this one does not.
 */
function scriptsReachedBy(command: string, seen = new Set<string>()): string[] {
	const found = new Set<string>();
	for (const match of command.matchAll(/scripts\/([\w./-]+\.ts)/g)) found.add(match[1] as string);
	for (const match of command.matchAll(/bun run ([\w:-]+)/g)) {
		const name = match[1] as string;
		if (seen.has(name)) continue;
		seen.add(name);
		for (const inner of scriptsReachedBy(ROOT_SCRIPTS[name] ?? "", seen)) found.add(inner);
	}
	return [...found];
}

/**
 * Does this job leave `node_modules` populated before it runs anything?
 *
 * Either spelling counts: a literal `bun install`, or the local composite action that wraps it.
 * A job that installs may import whatever it likes, so it is simply out of scope here.
 */
function jobInstalls(job: WorkflowJob): boolean {
	return (job.steps ?? []).some(
		step => (step.run ?? "").includes("bun install") || (step.uses ?? "").includes("bun-install"),
	);
}

/**
 * The first workspace specifier reachable from a script, or null.
 *
 * Relative imports are followed so a specifier one hop in is still caught, which is the common
 * shape: an entry point imports a local helper and the helper reaches the package. `node:` builtins
 * and third-party packages are irrelevant, since those resolve from bun's own runtime or fail
 * identically with or without an install.
 */
function workspaceSpecifierReachedBy(relative: string, seen = new Set<string>()): string | null {
	const file = path.join(SCRIPTS_DIR, relative);
	if (seen.has(file) || !fs.existsSync(file)) return null;
	seen.add(file);
	const source = fs.readFileSync(file, "utf8");
	const workspace = source.match(/from\s+"(@veyyon\/[\w./-]+)"/);
	if (workspace) return workspace[1] as string;
	for (const local of source.matchAll(/from\s+"(\.[\w./-]+)"/g)) {
		const target = path.relative(SCRIPTS_DIR, path.resolve(path.dirname(file), local[1] as string));
		const reached = workspaceSpecifierReachedBy(target, seen);
		if (reached) return reached;
	}
	return null;
}

/** Every script invocation that happens without an install, across every workflow. */
function collectUses(documents: { name: string; doc: WorkflowDocument }[]): ScriptUse[] {
	const uses: ScriptUse[] = [];
	for (const { name, doc } of documents) {
		for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
			if (jobInstalls(job)) continue;
			for (const step of job.steps ?? []) {
				for (const script of scriptsReachedBy(step.run ?? "")) {
					uses.push({
						workflow: name,
						job: jobId,
						script,
						specifier: workspaceSpecifierReachedBy(script),
					});
				}
			}
		}
	}
	return uses;
}

const REAL_WORKFLOWS = fs
	.readdirSync(WORKFLOWS_DIR)
	.filter(name => name.endsWith(".yml") || name.endsWith(".yaml"))
	.sort()
	.map(name => ({
		name,
		doc: Bun.YAML.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, name), "utf8")) as WorkflowDocument,
	}));

const REAL_USES = collectUses(REAL_WORKFLOWS);

describe("scripts run without an install resolve every import", () => {
	it("holds across every workflow in the repo", () => {
		const unresolvable = REAL_USES.filter(use => use.specifier !== null).map(
			use => `${use.workflow}::${use.job} runs scripts/${use.script}, which imports ${use.specifier}`,
		);
		expect(unresolvable).toEqual([]);
	});

	/**
	 * The gate has to be looking at something. A discovery bug that matched no job would make the
	 * assertion above pass forever while checking nothing, which is the failure mode this whole file
	 * exists to prevent one level down.
	 */
	it("actually found install-free jobs to check", () => {
		expect(REAL_USES.length).toBeGreaterThan(0);
	});
});

describe("the checker", () => {
	const workflow = (steps: string) => [
		{
			name: "fixture.yml",
			doc: Bun.YAML.parse(`jobs:\n  probe:\n    steps:\n${steps}`) as WorkflowDocument,
		},
	];

	/** The v1.0.39 shape exactly: no install, and a script that names a workspace package. */
	it("catches a workspace import in an install-free job", () => {
		const uses = collectUses(workflow(`      - run: bun scripts/release.ts verify-tag v1.0.0 sha n a\n`));
		expect(uses.map(use => use.specifier)).toEqual(["@veyyon/utils/semver"]);
	});

	/** The same script is fine once the job installs, which is how release_metadata was repaired. */
	it("ignores a job that installs first", () => {
		const uses = collectUses(
			workflow(
				`      - run: bun install --frozen-lockfile\n      - run: bun scripts/release.ts verify-tag v1.0.0 sha n a\n`,
			),
		);
		expect(uses).toEqual([]);
	});

	/** And once through the composite action, which is the spelling most jobs use. */
	it("ignores a job that installs through the local action", () => {
		const uses = collectUses(
			workflow(
				`      - uses: ./.github/actions/bun-install\n      - run: bun scripts/release.ts verify-tag v1.0.0 sha n a\n`,
			),
		);
		expect(uses).toEqual([]);
	});

	/** The repaired script stays clean: it reaches semver by relative path, so nothing is named. */
	it("passes the script that was fixed by importing the source directly", () => {
		const uses = collectUses(workflow(`      - run: bun scripts/ci-release-notes.ts v1.0.0\n`));
		expect(uses).toHaveLength(1);
		expect(uses[0]?.specifier).toBeNull();
	});

	/** `bun run <name>` is the usual spelling, and a checker blind to it would miss most jobs. */
	it("follows bun run through the root manifest", () => {
		const uses = collectUses(workflow(`      - run: bun run changelog:check\n`));
		expect(uses.map(use => use.script)).toEqual(["require-changelog.ts"]);
	});

	/**
	 * Two hops, which a one-level walk got wrong. `ci:test:full` names no script itself and reaches
	 * `ci-test-ts.ts` only through `ci:test:ts`, so a checker that stopped at the first indirection
	 * reported nothing for it and passed while reading no source at all.
	 */
	it("follows bun run through a second hop", () => {
		const uses = collectUses(workflow(`      - run: bun run ci:test:full\n`));
		expect(uses.map(use => use.script)).toContain("ci-test-ts.ts");
	});
});
