import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
interface WorkflowStep {
	name?: string;
	with?: Record<string, unknown>;
}

interface SecurityWorkflow {
	jobs: {
		codeql: {
			"timeout-minutes": number;
			steps: WorkflowStep[];
		};
	};
}

interface CodeqlConfig {
	paths: string[];
	"paths-ignore": string[];
}

async function loadYaml<T>(relativePath: string): Promise<T> {
	return Bun.YAML.parse(await Bun.file(path.join(repoRoot, relativePath)).text()) as T;
}

describe("Security CodeQL production-source boundary", () => {
	/**
	 * CodeQL previously evaluated data-flow queries across more than 1,200 test
	 * files and exhausted GitHub's six-hour job limit. The production-only graph
	 * still needs more than 55 minutes for the full security-and-quality suite,
	 * so the workflow keeps a three-hour hard deadline without aborting a healthy
	 * analysis halfway through its data-flow queries.
	 */
	it("loads the bounded production config and has an explicit deadline", async () => {
		const workflow = await loadYaml<SecurityWorkflow>(".github/workflows/security.yml");
		const job = workflow.jobs.codeql;
		const initialize = job.steps.find(step => step.name === "Initialize CodeQL");
		if (!initialize?.with) throw new Error("Security workflow must initialize CodeQL with repository config");

		expect(job["timeout-minutes"]).toBe(180);
		expect(initialize.with["config-file"]).toBe("./.github/codeql/codeql-config.yml");
		expect(initialize.with.queries).toBe("security-and-quality");
	});

	/**
	 * The scope keeps every shipped TypeScript and JavaScript root, including
	 * release and deployment scripts, while excluding test-only graphs that do
	 * not enter the distributed binary or website.
	 */
	it("scans every production root and excludes non-shipped test graphs", async () => {
		const config = await loadYaml<CodeqlConfig>(".github/codeql/codeql-config.yml");

		expect(config.paths).toEqual(["packages", "scripts", "website", "tools", "types"]);
		expect(config["paths-ignore"]).toEqual(
			expect.arrayContaining([
				"**/test/**",
				"**/tests/**",
				"**/__tests__/**",
				"**/fixtures/**",
				"**/*.test.ts",
				"**/*.test.tsx",
				"**/*.spec.ts",
				"**/*.spec.tsx",
				"**/*.bench.ts",
				"scripts/demos/**",
			]),
		);
	});
});
