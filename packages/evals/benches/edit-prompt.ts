/**
 * Edit-prompt cost/quality bench.
 *
 * The `edit` tool's description is the single largest thing Veyyon sends: about
 * 2,000 tokens of patch-language prose against a 27-token schema, shipped on
 * every request forever. Some of it is provably redundant, the `<critical>`
 * block summarises rules stated in full a few lines above. Deleting redundant
 * prose from a tool description is nevertheless the most dangerous kind of
 * saving, because repetition inside a `<critical>` block is an EMPHASIS
 * mechanism: the model may be complying because the rule was said twice.
 *
 * So the prune is not a judgement call, it is a measurement. This bench runs the
 * real edit fixtures through a real model and reports the two numbers that
 * decide it: how many tasks still pass, and what the turn cost. Run it before
 * the prune, prune, run it again. A prune that loses tasks is reverted, whatever
 * it saved.
 *
 * Deliberately NOT a test. It needs a live model and costs money, so a test that
 * ran it would either be skipped in CI forever or make CI pay per commit. It is
 * a tool you point at a model when you are about to change the prompt.
 *
 *   bun packages/evals/src/suites/typescript-edit/edit-prompt-bench.ts \
 *     --model cursor/cursor-grok-4.5-medium --label before --json runs/before.json
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import { discoverSharedInfra, InProcessClient, type SharedInfra } from "../backends/in-process/client";
import { type FlagGrammar, flagCount, parseFlags, requireFlag } from "../engine/flag-grammar";
import { extractBenchmarkFixtures } from "../suites/typescript-edit/extract";
import { type EditTask, loadTasksFromDir } from "../suites/typescript-edit/tasks";
import { verifyExpectedFileSubset } from "../suites/typescript-edit/verify";

export interface TaskOutcome {
	id: string;
	passed: boolean;
	inputTokens: number;
	outputTokens: number;
	durationMs: number;
	error?: string;
}

export interface BenchReport {
	label: string;
	model: string;
	editToolDescriptionTokens: number;
	passed: number;
	total: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	tasks: TaskOutcome[];
}

/** Copy a fixture's input tree into a scratch directory the model may mutate. */
async function prepareWorkdir(task: EditTask): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `edit-prompt-bench-${task.id}-`));
	await fs.cp(task.inputDir, dir, { recursive: true });
	return dir;
}

/**
 * The `edit` tool description as this build actually renders it. Reported so a
 * run's cost is attributable to a specific prompt size rather than to whatever
 * the working tree happened to contain when someone ran it.
 */
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

export interface EditPromptBenchArgs {
	model: string;
	label: string;
	json?: string;
	limit?: number;
}

/** Read the invocation, or reject it by naming the flag it is missing. */
/** Flags the edit-prompt bench accepts. */
export const EDIT_PROMPT_BENCH_FLAGS = {
	valued: { model: true, label: true, json: true, limit: true },
} as const satisfies FlagGrammar;

export function parseBenchArgs(argv: string[]): EditPromptBenchArgs {
	const flags = parseFlags(argv, EDIT_PROMPT_BENCH_FLAGS);
	return {
		model: requireFlag(flags, "model", "e.g. --model cursor/cursor-grok-4.5-medium"),
		label: flags.label === undefined || flags.label === "true" ? "run" : flags.label,
		json: flags.json === undefined || flags.json === "true" ? undefined : flags.json,
		limit: flagCount(flags, "limit"),
	};
}

/**
 * The two numbers the prune is decided on, plus the token totals behind them.
 * Separate from the run loop so a report is summarized the same way whether the
 * outcomes came from a live model or from a recorded run.
 */
export function summarizeBenchOutcomes(
	outcomes: readonly TaskOutcome[],
	identity: { label: string; model: string; editToolDescriptionTokens: number },
): BenchReport {
	return {
		label: identity.label,
		model: identity.model,
		editToolDescriptionTokens: identity.editToolDescriptionTokens,
		passed: outcomes.filter(outcome => outcome.passed).length,
		total: outcomes.length,
		totalInputTokens: outcomes.reduce((sum, outcome) => sum + outcome.inputTokens, 0),
		totalOutputTokens: outcomes.reduce((sum, outcome) => sum + outcome.outputTokens, 0),
		tasks: [...outcomes],
	};
}

const EDIT_PROMPT_USAGE =
	"usage: bun edit-prompt-bench.ts --model <id> [--label <name>] [--limit <n>] [--json <file>]\n";

async function main(): Promise<void> {
	let parsed: EditPromptBenchArgs;
	try {
		parsed = parseBenchArgs(process.argv.slice(2));
	} catch (error) {
		// Nothing was measured, so the command line is the failure rather than the run.
		console.error(errorMessage(error));
		console.error(EDIT_PROMPT_USAGE);
		process.exit(2);
	}
	const { model, label, json, limit } = parsed;
	const fixtures = await extractBenchmarkFixtures();
	try {
		const all = await loadTasksFromDir(fixtures.dir);
		const tasks = limit ? all.slice(0, limit) : all;
		const shared = await discoverSharedInfra();

		console.log(`label=${label} model=${model} tasks=${tasks.length}`);

		// Measured once against a throwaway session so the reported prompt size is
		// this build's, not a stale note in a commit message.
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

		const report = summarizeBenchOutcomes(outcomes, {
			label,
			model,
			editToolDescriptionTokens: descriptionTokens,
		});

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

if (import.meta.main) {
	await main();
}
