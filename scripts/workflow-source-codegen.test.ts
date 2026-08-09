// WHY: `packages/coding-agent/src/export/html/index.ts` imports the gitignored
// `tool-views.generated.js` with `{ type: "text" }`, which Bun resolves at module
// PARSE time. A job that runs repository TypeScript on a fresh checkout without
// materializing that artifact does not fail at the HTML export: every suite whose
// import graph touches it dies before its first assertion with "Cannot find
// module", and the job blames the suite.
//
// That is exactly how `Checks / Global-state leaks (changed suites)` went red: it
// ran a bare `bun install --frozen-lockfile`, so the tracer reported "loaded, but
// its own tests failed (no leak verdict)" for a changed suite and leak-checked
// nothing at all. The composite `./.github/actions/bun-install` is the one place
// that install plus codegen live together.
//
// THE CLASS this closes: any job in either workflow that runs repository
// TypeScript must reach the codegen, and the job list is READ OFF the workflow
// files rather than written here, so a NEW job added with a bare `bun install` is
// red on arrival instead of degrading a gate in silence.
//
// WHAT IT DOES NOT CATCH: a job that materializes the artifact by some other
// means this test does not recognise (it accepts the composite, an explicit
// `gen:tool-views` run, or a job that runs no repository TypeScript at all), and
// it says nothing about whether the codegen output is correct.

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const WORKFLOWS = path.resolve(import.meta.dir, "..", ".github", "workflows");

interface WorkflowStep {
	readonly uses?: string;
	readonly run?: string;
	readonly name?: string;
}

interface WorkflowJob {
	readonly steps?: readonly WorkflowStep[];
}

interface Workflow {
	readonly jobs?: Record<string, WorkflowJob>;
}

function loadWorkflow(file: string): Workflow {
	return Bun.YAML.parse(fs.readFileSync(path.join(WORKFLOWS, file), "utf8")) as Workflow;
}

/**
 * A step that runs repository suites: `bun test` in any spelling (directly, or
 * through the sandbox runner, or via a `bun run` script whose name is a test
 * bucket), or the leak tracer, which spawns one `bun test` per file.
 *
 * The file list those commands take is an argument, so a job that runs a narrow
 * subset today runs a wider one tomorrow. The requirement is therefore about
 * running suites at all, not about which paths a step names now.
 */
function runsRepositorySuites(step: WorkflowStep): boolean {
	if (step.run === undefined) return false;
	return (
		/\bbun\s+test\b/.test(step.run) ||
		/\bbun\s+run\s+(ci:)?test\b/.test(step.run) ||
		/\bbun\s+run\s+test:/.test(step.run) ||
		step.run.includes("find-test-leaks.ts") ||
		step.run.includes("check-test-memory.ts")
	);
}

function usesInstallComposite(step: WorkflowStep): boolean {
	return step.uses === "./.github/actions/bun-install";
}

function generatesToolViews(step: WorkflowStep): boolean {
	return step.run !== undefined && step.run.includes("gen:tool-views");
}

describe("workflow jobs that run repository TypeScript reach the source codegen", () => {
	const files = fs
		.readdirSync(WORKFLOWS)
		.filter(name => name.endsWith(".yml"))
		.sort();

	it("finds the workflows to check", () => {
		expect(files).toContain("checks.yml");
		expect(files).toContain("ci.yml");
	});

	for (const file of files) {
		const workflow = loadWorkflow(file);
		const jobs = Object.entries(workflow.jobs ?? {});

		for (const [jobId, job] of jobs) {
			const steps = job.steps ?? [];
			if (!steps.some(runsRepositorySuites)) continue;

			it(`${file}: ${jobId} materializes tool-views.generated.js`, () => {
				const reaches = steps.some(step => usesInstallComposite(step) || generatesToolViews(step));
				expect(
					reaches,
					`${file}:${jobId} runs repository suites, so it must use ./.github/actions/bun-install ` +
						"or run gen:tool-views; otherwise any suite reaching src/export/html dies at parse time",
				).toBe(true);
			});
		}
	}
});
