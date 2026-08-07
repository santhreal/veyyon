import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Every direct `bun test` in `.github` runs inside the test sandbox.
 *
 * WHY THIS SUITE EXISTS. `bun test` in this repository refuses to run unless it
 * can prove the operator's home is unreachable (see
 * `packages/utils/test/helpers/sandbox-gate.ts`). The refusal is unconditional
 * and deliberately has no escape hatch, so a step that calls `bun test` on a
 * bare runner exits 1 before its first assertion.
 *
 * When that gate landed it was rolled out to the jobs someone was thinking
 * about, the heavy test buckets in `ci.yml` and `checks.yml`, and not to the
 * long tail. Seven invocations across four workflows were left calling `bun
 * test` directly: the `Docs` workflow went red immediately, `checks.yml`'s
 * leak-check job went red with it, and two nightlies were left to fail unwatched
 * because nobody reads a green-by-default schedule. Every one of those jobs
 * reported a failure that had nothing to do with what it was gating.
 *
 * Per-job opt-in is what failed. Adding a workflow is exactly the moment nobody
 * is thinking about a preload contract in another package, so the rule is
 * enforced here instead of remembered: route the command through
 * `scripts/test-sandbox/run.sh`, which establishes the boundary the gate looks
 * for, and the job also needs a `--build` step ahead of it on a fresh runner.
 *
 * Scope, deliberately narrow. This checks a LITERAL `bun test` in a `run:`
 * script. `bun run ci:test:*` and `bun run test:scripts` are already routed
 * inside `package.json`, so they are correct as written and are not the shape
 * that broke.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");
const ACTIONS_DIR = path.join(REPO_ROOT, ".github", "actions");

/** The entry point that establishes the boundary the gate checks for. */
const SANDBOX_ENTRYPOINT = "test-sandbox/run.sh";

interface ActionsStep {
	name?: string;
	run?: string;
}

interface ActionsDocument {
	jobs?: Record<string, { steps?: ActionsStep[] }>;
	runs?: { steps?: ActionsStep[] };
}

/** One `run:` step, identified the way a failure message should name it. */
interface RunStep {
	file: string;
	job: string;
	name: string;
	script: string;
}

/** A `bun test` that never reaches the sandbox. This is the whole finding. */
interface Violation {
	step: string;
	command: string;
}

/**
 * A shell line with its trailing comment removed.
 *
 * Required, not cosmetic: the steps this suite guards carry comments that quote
 * the very command being checked ("Every `bun test` in this repo refuses..."),
 * so a checker that read comments would report the explanation as the offence
 * and every routed step as a violation.
 */
function stripComment(line: string): string {
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (quote) {
			if (ch === "\\" && quote === '"') i += 1;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
	}
	return line;
}

/**
 * Is this line invoking `bun test`?
 *
 * Anchored on a command boundary so a path that merely contains the word (for
 * example `scripts/test-sandbox/find-test-leaks.ts`) is not mistaken for one.
 */
function invokesBunTest(line: string): boolean {
	return /(^|[\s;&(|])bun\s+test(\s|$)/.test(line);
}

function stepsOf(file: string, doc: ActionsDocument): RunStep[] {
	const found: RunStep[] = [];
	for (const [job, definition] of Object.entries(doc.jobs ?? {})) {
		for (const step of definition.steps ?? []) {
			if (typeof step.run !== "string") continue;
			found.push({ file, job, name: step.name ?? "(unnamed)", script: step.run });
		}
	}
	for (const step of doc.runs?.steps ?? []) {
		if (typeof step.run !== "string") continue;
		found.push({ file, job: "runs", name: step.name ?? "(unnamed)", script: step.run });
	}
	return found;
}

function violations(steps: readonly RunStep[]): Violation[] {
	const found: Violation[] = [];
	for (const step of steps) {
		for (const raw of step.script.split("\n")) {
			const line = stripComment(raw);
			if (!invokesBunTest(line)) continue;
			if (line.includes(SANDBOX_ENTRYPOINT)) continue;
			found.push({ step: `${step.file}::${step.job}::${step.name}`, command: line.trim() });
		}
	}
	return found;
}

/** Run the checker over a workflow written inline. */
function check(yaml: string, file = "fixture.yml"): Violation[] {
	return violations(stepsOf(file, Bun.YAML.parse(yaml) as ActionsDocument));
}

const REAL_STEPS: RunStep[] = [
	...fs
		.readdirSync(WORKFLOWS_DIR)
		.filter(name => name.endsWith(".yml") || name.endsWith(".yaml"))
		.sort()
		.flatMap(name =>
			stepsOf(name, Bun.YAML.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, name), "utf8")) as ActionsDocument),
		),
	...fs
		.readdirSync(ACTIONS_DIR, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort()
		.flatMap(name => {
			const manifest = path.join(ACTIONS_DIR, name, "action.yml");
			if (!fs.existsSync(manifest)) return [];
			return stepsOf(`actions/${name}`, Bun.YAML.parse(fs.readFileSync(manifest, "utf8")) as ActionsDocument);
		}),
];

describe("every `bun test` in .github runs inside the test sandbox", () => {
	it("holds across every workflow and composite action in the repo", () => {
		expect(violations(REAL_STEPS)).toEqual([]);
	});

	/**
	 * Proves the clean result above is earned rather than vacuous, twice over: a
	 * checker that parsed nothing would report no steps, and one that had stopped
	 * recognising the command would report no invocations. The list is exact so
	 * that adding a suite to CI is a visible edit here rather than a silent one.
	 */
	it("actually parsed the workflows and found their `bun test` invocations", () => {
		expect(REAL_STEPS.length).toBeGreaterThan(100);
		const invoking = REAL_STEPS.filter(step =>
			step.script.split("\n").some(line => invokesBunTest(stripComment(line))),
		);
		expect(invoking.map(step => `${step.file}::${step.job}::${step.name}`).sort()).toEqual([
			"checks.yml::test-leaks::Tracer self-tests",
			"docs.yml::doc-examples::Docs examples match the real CLI",
			"docs.yml::link-check::Check the package maps cover every package",
			"docs.yml::link-check::Checker self-tests",
			"hashline-soak.yml::seed-soak::Run the full seed corpus",
			"leak-sweep.yml::memory::Gate self-tests",
			"leak-sweep.yml::sweep::Tracer self-tests",
		]);
	});

	it("reports a bare `bun test` step, which is the shape that broke four workflows", () => {
		const found = check(`
jobs:
  docs:
    steps:
      - name: Checker self-tests
        run: bun test scripts/check-doc-links.test.ts
`);
		expect(found).toEqual([
			{ step: "fixture.yml::docs::Checker self-tests", command: "bun test scripts/check-doc-links.test.ts" },
		]);
	});

	it("accepts the same command routed through the sandbox entry point", () => {
		const found = check(`
jobs:
  docs:
    steps:
      - name: Checker self-tests
        run: bash scripts/test-sandbox/run.sh bun test scripts/check-doc-links.test.ts
`);
		expect(found).toEqual([]);
	});

	/**
	 * The comment strip is load-bearing rather than tidiness. Every routed step in
	 * this repository explains the gate directly above the command, and several of
	 * those explanations contain the words being matched.
	 */
	it("does not read a comment that merely mentions the command as an invocation", () => {
		const found = check(`
jobs:
  docs:
    steps:
      - name: Build the test sandbox image
        run: |
          # Every \`bun test\` in this repo refuses to run outside the sandbox.
          bash scripts/test-sandbox/run.sh --build
`);
		expect(found).toEqual([]);
	});

	/**
	 * `bun run ci:test:*` and `bun run test:scripts` route through the sandbox
	 * inside package.json. Reporting them would be a false finding, and the
	 * response to a noisy gate is to delete it.
	 */
	it("leaves the package.json recipes alone, since they route through the sandbox already", () => {
		const found = check(`
jobs:
  tests:
    steps:
      - name: Workspace test suite
        run: bun run ci:test:ts:workspace
      - name: Repo script gates
        run: bun run test:scripts
`);
		expect(found).toEqual([]);
	});

	/**
	 * A path that contains the word "test" is not an invocation. Getting this
	 * wrong would report the leak tracer's own sweep step, which is a script run
	 * rather than a `bun test`.
	 */
	it("does not mistake a path containing the word test for the command", () => {
		const found = check(`
jobs:
  sweep:
    steps:
      - name: Sweep every test tree
        run: bash scripts/test-sandbox/run.sh bun scripts/test-sandbox/find-test-leaks.ts packages scripts
`);
		expect(found).toEqual([]);
	});
});
