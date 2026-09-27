/**
 * The report a kit suite writes into a finished run: `report.md` for a reader and `summary.json`
 * for a script.
 *
 * Per arm it states pass rate with its 95% interval, partial credit, and what all its trials spent
 * in tokens, turns and time; the pass rate by capability and by difficulty; how many trials passed
 * within each turn, token and time budget; and, for every arm against the first, the trials only
 * one of them passed, with a sign test and the spend over the trials both graded.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SuiteReportContext, TrialUsage } from "../contracts";
import { type ArmTrial, type PairedArms, pairArms, passesWithin } from "../compare/paired";
import { wilsonInterval } from "../compare/stats";
import { readRunJournal } from "../run/journal";
import type { TrialResultRecord } from "../run/record";
import { DIFFICULTIES, type Difficulty } from "./catalog";

/** The budgets the report counts passes within, per measure, in ascending order. */
export interface BudgetLadders {
	readonly turns: readonly number[];
	readonly tokens: readonly number[];
	readonly seconds: readonly number[];
}

/** The ladders of a suite that declares none: short tasks of a few turns each. */
export const DEFAULT_BUDGETS: BudgetLadders = {
	turns: [5, 10, 20, 40],
	tokens: [50_000, 100_000, 250_000, 500_000],
	seconds: [30, 60, 120, 300],
};

interface KitTrialRow extends ArmTrial {
	readonly task: string;
	readonly partial: number | null;
	readonly error: string | null;
	readonly capabilities: readonly string[];
	readonly difficulty: Difficulty | null;
	readonly timedOut: boolean;
}

export interface ArmSummary {
	readonly arm: string;
	readonly trials: number;
	readonly graded: number;
	readonly errors: number;
	readonly passes: number;
	readonly passRate: number | null;
	readonly passRateLow: number | null;
	readonly passRateHigh: number | null;
	readonly meanPartial: number | null;
	readonly timedOut: number;
	readonly tokens: number;
	readonly turns: number;
	readonly wallSec: number;
	readonly byCapability: Readonly<Record<string, { readonly passes: number; readonly graded: number }>>;
	readonly byDifficulty: Readonly<Record<string, { readonly passes: number; readonly graded: number }>>;
	readonly passesWithinTurns: readonly number[];
	readonly passesWithinTokens: readonly number[];
	readonly passesWithinSeconds: readonly number[];
}

export interface KitRunSummary {
	readonly suite: string;
	readonly model: string;
	readonly tasks: number;
	readonly repeats: number;
	readonly budgets: BudgetLadders;
	readonly arms: readonly ArmSummary[];
	readonly paired: readonly PairedArms[];
}

/** Every token the provider processed: input, cache reads and writes, and output. */
export function tokensOf(usage: TrialUsage | null | undefined): number | null {
	if (!usage || usage.inputTokens == null || usage.outputTokens == null) return null;
	return usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

function rowOf(record: TrialResultRecord): KitTrialRow {
	const usage = record.score.usage ?? record.artifacts?.usage ?? null;
	const extra = record.score.extra;
	const turns = usage?.extra?.turns;
	const capabilities = extra.capabilities;
	const difficulty = extra.difficulty;
	return {
		arm: record.cell.variant,
		key: `${record.cell.task}#${record.cell.repeat}`,
		task: record.cell.task,
		passed: record.score.reward === null ? null : record.score.reward >= 1,
		partial: record.score.partial,
		error: record.score.error,
		tokens: tokensOf(usage),
		turns: typeof turns === "number" ? turns : null,
		wallSec: usage?.durationSec ?? null,
		capabilities: Array.isArray(capabilities)
			? capabilities.filter((item: unknown): item is string => typeof item === "string")
			: [],
		difficulty: DIFFICULTIES.find(item => item === difficulty) ?? null,
		timedOut: extra.timedOut === true,
	};
}

function summarizeArm(rows: readonly KitTrialRow[], arm: string, budgets: BudgetLadders): ArmSummary {
	const mine = rows.filter(row => row.arm === arm);
	const graded = mine.filter(row => row.passed !== null);
	const passes = graded.filter(row => row.passed).length;
	const interval = wilsonInterval(passes, graded.length);
	const tally = (key: (row: KitTrialRow) => readonly string[]) => {
		const out: Record<string, { passes: number; graded: number }> = {};
		for (const row of graded) {
			for (const name of key(row)) {
				let entry = out[name];
				if (!entry) {
					entry = { passes: 0, graded: 0 };
					out[name] = entry;
				}
				entry.graded++;
				if (row.passed) entry.passes++;
			}
		}
		return out;
	};
	const partials = graded.map(row => row.partial).filter((value): value is number => value !== null);
	const total = (pick: (row: KitTrialRow) => number | null) => mine.reduce((sum, row) => sum + (pick(row) ?? 0), 0);
	return {
		arm,
		trials: mine.length,
		graded: graded.length,
		errors: mine.length - graded.length,
		passes,
		passRate: graded.length > 0 ? passes / graded.length : null,
		passRateLow: interval.low,
		passRateHigh: interval.high,
		meanPartial: partials.length > 0 ? partials.reduce((a, b) => a + b, 0) / partials.length : null,
		timedOut: mine.filter(row => row.timedOut).length,
		tokens: total(row => row.tokens),
		turns: total(row => row.turns),
		wallSec: total(row => row.wallSec),
		byCapability: tally(row => row.capabilities),
		byDifficulty: tally(row => (row.difficulty ? [row.difficulty] : [])),
		passesWithinTurns: passesWithin(rows, arm, row => row.turns, budgets.turns),
		passesWithinTokens: passesWithin(rows, arm, row => row.tokens, budgets.tokens),
		passesWithinSeconds: passesWithin(rows, arm, row => row.wallSec, budgets.seconds),
	};
}

export function summarizeKitRun(
	records: readonly TrialResultRecord[],
	context: Pick<SuiteReportContext, "model" | "tasks" | "repeats" | "variants">,
	suite: string,
	budgets: BudgetLadders = DEFAULT_BUDGETS,
): KitRunSummary {
	const rows = records.map(rowOf);
	// The plan's order, so the baseline is the arm named first, however the trials finished; an
	// arm the plan did not name (a journal read on its own) follows in the order it appears.
	const seen = new Set(rows.map(row => row.arm));
	const arms = [...context.variants.filter(arm => seen.has(arm)), ...[...seen].filter(arm => !context.variants.includes(arm))];
	const [baseline, ...candidates] = arms;
	return {
		suite,
		model: context.model,
		tasks: context.tasks.length,
		repeats: context.repeats,
		budgets,
		arms: arms.map(arm => summarizeArm(rows, arm, budgets)),
		paired: baseline === undefined ? [] : candidates.map(candidate => pairArms(rows, baseline, candidate)),
	};
}

const percent = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
const count = (value: number) => value.toLocaleString("en-US");
const ratio = (passes: number, graded: number) => (graded === 0 ? "—" : `${passes}/${graded}`);
const change = (from: number, to: number) => (from === 0 ? "—" : `${(((to - from) / from) * 100).toFixed(1)}%`);
const tokenBudget = (n: number) => (n >= 1_000_000 ? `≤ ${n / 1_000_000}M` : `≤ ${n / 1000}k`);

export function renderKitReport(summary: KitRunSummary, capabilities: Readonly<Record<string, string>>): string {
	const lines: string[] = [
		`# ${summary.suite}`,
		"",
		`Model ${summary.model}; ${summary.tasks} tasks × ${summary.repeats} repeats.`,
		"",
		"| arm | passed | pass rate (95% CI) | partial | errors | timed out | tokens | turns | wall (s) |",
		"|---|---|---|---|---|---|---|---|---|",
	];
	for (const arm of summary.arms) {
		lines.push(
			`| ${arm.arm} | ${ratio(arm.passes, arm.graded)} | ${percent(arm.passRate)} (${percent(arm.passRateLow)}–${percent(arm.passRateHigh)}) | ${percent(arm.meanPartial)} | ${arm.errors} | ${arm.timedOut} | ${count(arm.tokens)} | ${count(arm.turns)} | ${arm.wallSec.toFixed(0)} |`,
		);
	}
	const breakdown = (title: string, names: readonly string[], pick: (arm: ArmSummary) => ArmSummary["byCapability"]) => {
		lines.push("", `## ${title}`, "", `| ${title.toLowerCase()} | ${summary.arms.map(arm => arm.arm).join(" | ")} |`);
		lines.push(`|---|${summary.arms.map(() => "---").join("|")}|`);
		// Rows no trial exercised are omitted; the vocabulary orders the rest.
		for (const name of names.filter(entry => summary.arms.some(arm => pick(arm)[entry] !== undefined))) {
			const cells = summary.arms.map(arm => {
				const tally = pick(arm)[name];
				return tally ? ratio(tally.passes, tally.graded) : "—";
			});
			lines.push(`| ${name} | ${cells.join(" | ")} |`);
		}
	};
	breakdown("Capability", Object.keys(capabilities), arm => arm.byCapability);
	breakdown("Difficulty", DIFFICULTIES, arm => arm.byDifficulty);
	const curve = (title: string, budgets: readonly number[], pick: (arm: ArmSummary) => readonly number[], unit: (n: number) => string) => {
		lines.push("", `## Passes within ${title}`, "", `| arm | ${budgets.map(unit).join(" | ")} |`);
		lines.push(`|---|${budgets.map(() => "---").join("|")}|`);
		for (const arm of summary.arms) lines.push(`| ${arm.arm} | ${pick(arm).join(" | ")} |`);
	};
	curve("turns", summary.budgets.turns, arm => arm.passesWithinTurns, n => `≤ ${n}`);
	curve("tokens", summary.budgets.tokens, arm => arm.passesWithinTokens, tokenBudget);
	curve("seconds", summary.budgets.seconds, arm => arm.passesWithinSeconds, n => `≤ ${n} s`);
	if (summary.paired.length > 0) {
		lines.push(
			"",
			"## Paired against the first arm",
			"",
			"Trials of the two arms on one task and repeat met the same seeded data. Only the pairs both arms graded count.",
			"",
			"| candidate | pairs | only candidate passed | only baseline passed | sign test p | tokens | turns | wall |",
			"|---|---|---|---|---|---|---|---|",
		);
		for (const pair of summary.paired) {
			const delta = (sums: PairedArms["tokens"]) => (sums ? change(sums.baseline, sums.candidate) : "—");
			lines.push(
				`| ${pair.candidate} vs ${pair.baseline} | ${pair.pairs} | ${pair.wins} | ${pair.losses} | ${pair.signTestP.toFixed(3)} | ${delta(pair.tokens)} | ${delta(pair.turns)} | ${delta(pair.wallSec)} |`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

export async function writeKitReport(
	context: SuiteReportContext,
	spec: {
		readonly id: string;
		readonly capabilities: Readonly<Record<string, string>>;
		readonly budgets?: BudgetLadders;
	},
): Promise<void> {
	const records = await readRunJournal(path.dirname(context.runDir), path.basename(context.runDir));
	const summary = summarizeKitRun(records, context, spec.id, spec.budgets);
	await fs.writeFile(path.join(context.runDir, "summary.json"), `${JSON.stringify(summary, null, "\t")}\n`);
	await fs.writeFile(path.join(context.runDir, "report.md"), renderKitReport(summary, spec.capabilities));
}
