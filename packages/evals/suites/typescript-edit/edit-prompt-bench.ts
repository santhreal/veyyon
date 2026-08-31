/// <reference types="./bun-imports.d.ts" />

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import { extractBenchmarkFixtures } from "./argot-bench";
import { discoverSharedInfra, InProcessClient, type SharedInfra } from "./in-process-client";
import { type EditTask, loadTasksFromDir } from "./tasks";
import { verifyExpectedFileSubset } from "./verify";

interface TaskOutcome {
	id: string;
	passed: boolean;
	inputTokens: number;
	outputTokens: number;
	durationMs: number;
	error?: string;
}

interface BenchReport {
	label: string;
	model: string;
	editToolDescriptionTokens: number;
	passed: number;
	total: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	tasks: TaskOutcome[];
}

async function prepareWorkdir(task: EditTask): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `edit-prompt-bench-${task.id}-`));
	await fs.cp(task.inputDir, dir, { recursive: true });
	return dir;
}

async function editToolDescriptionTokens(client: InProcessClient): Promise<number> {
	const state = await client.getState();
	const editTool = state.dumpTools?.find(tool => tool.name === "edit");
	if (!editTool) return 0;
	return Math.ceil(editTool.description.length / 4);
}

async function runTask(task: EditTask, model: string, shared: SharedInfra): Promise<TaskOutcome> {
	const cwd = await prepareWorkdir(task);
	const client = new InProcessClient({ cwd, model, shared, tools: ["read", "edit", "write"] });
	const startedAt = performance.now();
	try {
		await client.start();
		await client.prompt(task.prompt);
		const stats = await client.getSessionStats();
		const verification = await verifyExpectedFileSubset(task.expectedDir, cwd, task.files);
		return {
			id: task.id,
			passed: verification.success,
			inputTokens: stats.tokens.input,
			outputTokens: stats.tokens.output,
			durationMs: performance.now() - startedAt,
		};
	} catch (error) {
		return {
			id: task.id,
			passed: false,
			inputTokens: 0,
			outputTokens: 0,
			durationMs: performance.now() - startedAt,
			error: errorMessage(error),
		};
	} finally {
		await client.dispose();
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

function parseArgs(argv: string[]): { model: string; label: string; json?: string; limit?: number } {
	let model = "";
	let label = "run";
	let json: string | undefined;
	let limit: number | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--model") model = argv[++i];
		else if (arg === "--label") label = argv[++i];
		else if (arg === "--json") json = argv[++i];
		else if (arg === "--limit") limit = Number(argv[++i]);
	}
	if (!model) throw new Error("--model is required (e.g. --model cursor/cursor-grok-4.5-medium)");
	return { model, label, json, limit };
}

async function main(): Promise<void> {
	const { model, label, json, limit } = parseArgs(process.argv.slice(2));
	const fixtures = await extractBenchmarkFixtures();
	try {
		const all = await loadTasksFromDir(fixtures.dir);
		const tasks = limit ? all.slice(0, limit) : all;
		const shared = await discoverSharedInfra();

		console.log(`label=${label} model=${model} tasks=${tasks.length}`);

		const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-prompt-probe-"));
		const probe = new InProcessClient({ cwd: probeDir, model, shared, tools: ["read", "edit", "write"] });
		await probe.start();
		const descriptionTokens = await editToolDescriptionTokens(probe);
		await probe.dispose();
		await fs.rm(probeDir, { recursive: true, force: true });
		console.log(`edit tool description: ~${descriptionTokens} tokens\n`);

		const outcomes: TaskOutcome[] = [];
		for (const task of tasks) {
			const outcome = await runTask(task, model, shared);
			outcomes.push(outcome);
			const mark = outcome.passed ? "PASS" : "FAIL";
			const detail = outcome.error ? ` (${outcome.error})` : "";
			console.log(
				`  ${mark}  ${outcome.id}  in=${outcome.inputTokens} out=${outcome.outputTokens} ${outcome.durationMs.toFixed(0)}ms${detail}`,
			);
		}

		const report: BenchReport = {
			label,
			model,
			editToolDescriptionTokens: descriptionTokens,
			passed: outcomes.filter(o => o.passed).length,
			total: outcomes.length,
			totalInputTokens: outcomes.reduce((sum, o) => sum + o.inputTokens, 0),
			totalOutputTokens: outcomes.reduce((sum, o) => sum + o.outputTokens, 0),
			tasks: outcomes,
		};

		console.log(
			`\n${label}: ${report.passed}/${report.total} passed, ` +
				`input ${report.totalInputTokens}, output ${report.totalOutputTokens}, ` +
				`edit description ~${descriptionTokens} tok`,
		);

		if (json) {
			await fs.writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
			console.log(`wrote ${json}`);
		}
	} finally {
		await fixtures.cleanup();
	}
}

await main();
