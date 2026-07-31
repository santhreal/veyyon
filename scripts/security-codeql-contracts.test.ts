import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
interface WorkflowStep {
	name?: string;
	with?: Record<string, unknown>;
}
interface CodeqlScope {
	scope: string;
	paths: string;
}
interface SecurityWorkflow {
	jobs: {
		codeql: {
			name: string;
			"timeout-minutes": number;
			strategy: {
				"fail-fast": boolean;
				matrix: { include: CodeqlScope[] };
			};
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
	 * One whole-repository CodeQL database left its final data-flow queries
	 * running past every deadline, including without incremental analysis. The
	 * matrix keeps each complete product boundary small enough to finish while
	 * preserving one required security result for every shipped source root.
	 */
	it("partitions shipped sources into independent fail-closed analyses", async () => {
		const workflow = await loadYaml<SecurityWorkflow>(".github/workflows/security.yml");
		const job = workflow.jobs.codeql;
		const initialize = job.steps.find(step => step.name === "Initialize CodeQL");
		const analyze = job.steps.find(step => step.name === "Analyze");
		if (!initialize?.with || !analyze?.with) {
			throw new Error("Security workflow must initialize and analyze every CodeQL scope");
		}
		// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression fixture.
		expect(job.name).toBe("SAST (CodeQL JS/TS, ${{ matrix.scope }})");
		expect(job["timeout-minutes"]).toBe(90);
		expect(job.strategy["fail-fast"]).toBe(false);
		expect(job.strategy.matrix.include.map(entry => entry.scope)).toEqual(["application", "libraries", "operations"]);
		const scannedPaths = job.strategy.matrix.include.flatMap(entry => JSON.parse(entry.paths) as string[]).toSorted();
		expect(scannedPaths).toEqual(
			[
				"packages/agent",
				"packages/ai",
				"packages/argot",
				"packages/catalog",
				"packages/coding-agent",
				"packages/collab-web",
				"packages/hashline",
				"packages/metaharness",
				"packages/mnemopi",
				"packages/natives",
				"packages/stats",
				"packages/swarm-extension",
				"packages/tool-render",
				"packages/tui",
				"packages/utils",
				"packages/wire",
				"scripts",
				"tools",
				"types",
				"website",
			].toSorted(),
		);
		expect(initialize.with.queries).toBeUndefined();
		expect(initialize.with["config-file"]).toBeUndefined();
		// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression fixture.
		expect(analyze.with.category).toBe("/language:javascript-typescript/${{ matrix.scope }}");
	});
	/**
	 * Tests, fixtures, demos, and benchmark packages do not enter the shipped
	 * application graphs. The inline config applies the same exclusion policy
	 * to every matrix scope without three drifting configuration files.
	 */
	it("applies one non-shipped exclusion policy to every scope", async () => {
		const workflow = await loadYaml<SecurityWorkflow>(".github/workflows/security.yml");
		const initialize = workflow.jobs.codeql.steps.find(step => step.name === "Initialize CodeQL");
		const inlineConfig = initialize?.with?.config;
		if (typeof inlineConfig !== "string") throw new Error("CodeQL must use an inline matrix configuration");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression fixture.
		const config = Bun.YAML.parse(inlineConfig.replace("${{ matrix.paths }}", "[]")) as CodeqlConfig;
		expect(config.paths).toEqual([]);
		expect(config["paths-ignore"]).toEqual([
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
		]);
	});
});
