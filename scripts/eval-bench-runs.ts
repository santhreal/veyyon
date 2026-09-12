#!/usr/bin/env bun

/**
 * Aggregate and report benchmark evaluation run summaries.
 *
 * Parses evaluation run summary files across specified directories, extracting task success
 * percentages, verification rates, edit tool usage, patch failure metrics, token totals, and
 * execution durations. Prints formatted comparison reports as text tables, markdown, CSV, or
 * JSON sorted by selected metrics.
 *
 * Usage:
 *   bun scripts/eval-bench-runs.ts <runs-dir>... [--aggregate] [--format table|md|csv|json] [--sort sep|model|task|edit|tokens]
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface ReportRow {
	file: string;
	sepSlug: string;
	model: string;
	totalTasks: number;
	totalRuns: number;
	successfulRuns: number;
	taskSuccessPct: number;
	verifiedPct: number;
	editToolUsagePct: number;
	editSuccessPct: number;
	patchFailurePct: number;
	patchFailures: number;
	patchAttempts: number;
	mutationIntentPct: number;
	autocorrectFreePct: number;
	tasksAllPassing: number;
	tasksFlakyFailing: number;
	timeoutRuns: number;
	inputTokensTotal: number;
	outputTokensTotal: number;
	totalTokens: number;
	inputTokensAvg: number;
	outputTokensAvg: number;
	totalTokensAvg: number;
	durationTotal: string;
	durationAvg: string;
	avgIndentScore: number | null;
	readTotal: number;
	editTotal: number;
	writeTotal: number;
}

const SEPARATOR_DISPLAY: Record<string, string> = {
	gt: ">",
	plus: "+",
	div: "÷",
	pipe: "|",
	bslash: "\\",
	tilde: "~",
	pct: "%",
	colon: ":",
};

const args = process.argv.slice(2);
const dirs: string[] = [];
type ReportFormat = "table" | "md" | "csv" | "json";
type ReportSort = "sep" | "model" | "task" | "edit" | "tokens";
let format: ReportFormat = "table";
let sortBy: ReportSort = "sep";
let aggregate = false;

for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--format") format = args[++i] as ReportFormat;
	else if (a === "--sort") sortBy = args[++i] as ReportSort;
	else if (a === "--aggregate") aggregate = true;
	else if (!a.startsWith("--")) dirs.push(a);
}

if (dirs.length === 0) {
	console.error(
		"usage: bun scripts/eval-bench-runs.ts <runs-dir> [<runs-dir>...] [--aggregate] [--format table|md|csv|json] [--sort sep|model|task|edit|tokens]",
	);
	process.exit(2);
}

const parseNum = (s: string) => Number.parseFloat(s.replace(/,/g, ""));
const getCell = (text: string, label: string) =>
	text
		.match(
			new RegExp(
				`^\\|\\s*\\*?\\*?${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*?\\*?\\s*\\|\\s*\\*?\\*?(.+?)\\*?\\*?\\s*\\|\\s*$`,
				"m",
			),
		)?.[1]
		.trim() ?? null;
const getRow = (text: string, label: string) =>
	text
		.match(
			new RegExp(`^\\|\\s*\\*?\\*?${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*?\\*?\\s*\\|(.+)\\|\\s*$`, "m"),
		)?.[1]
		.split("|")
		.map(s => s.trim().replace(/^\*\*|\*\*$/g, "")) ?? null;
const parsePercent = (val: string | null) => (val?.match(/([0-9.]+)\s*%/) ? Number.parseFloat(RegExp.$1) : Number.NaN);

function parseRatePair(val: string | null) {
	const m = val?.match(/([0-9.]+)\s*%\s*\(\s*([0-9,]+)\s*\/\s*([0-9,]+)\s*\)/);
	return m
		? { pct: Number.parseFloat(m[1]), numerator: parseNum(m[2]), denominator: parseNum(m[3]) }
		: { numerator: 0, denominator: 0, pct: parsePercent(val) };
}

async function parseReport(file: string): Promise<ReportRow> {
	const text = await Bun.file(file).text();
	const [sepSlug, ...modelParts] = path.basename(file, ".md").split("__");
	const model = modelParts.join("__").replace(/_/g, "/");
	const editTool = parseRatePair(getCell(text, "Edit Tool Usage Rate"));
	const patchFailure = parseRatePair(getCell(text, "Patch Failure Rate"));
	const inRow = getRow(text, "Input Tokens") ?? ["0", "0"];
	const outRow = getRow(text, "Output Tokens") ?? ["0", "0"];
	const totalRow = getRow(text, "Total Tokens") ?? ["0", "0"];
	const durationRow = getRow(text, "Duration") ?? ["", ""];
	const indentRow = getRow(text, "Avg Indent Score") ?? ["—", "—"];
	const readRow = getRow(text, "Read") ?? ["0", "0"];
	const editRow = getRow(text, "Edit") ?? ["0", "0"];
	const writeRow = getRow(text, "Write") ?? ["0", "0"];
	const indentValue = indentRow[1]?.replace(/[*\s—-]/g, "");

	return {
		file,
		sepSlug,
		model,
		totalTasks: Number.parseInt(getCell(text, "Total Tasks") ?? "0", 10),
		totalRuns: Number.parseInt(getCell(text, "Total Runs") ?? "0", 10),
		successfulRuns: Number.parseInt(getCell(text, "Successful Runs") ?? "0", 10),
		taskSuccessPct: parsePercent(getCell(text, "Task Success Rate")),
		verifiedPct: parsePercent(getCell(text, "Verified Rate")),
		editToolUsagePct: editTool.pct,
		editSuccessPct: parsePercent(getCell(text, "Edit Success Rate")),
		patchFailurePct: patchFailure.pct,
		patchFailures: patchFailure.numerator,
		patchAttempts: patchFailure.denominator,
		mutationIntentPct: parsePercent(getCell(text, "Mutation Intent Match Rate")),
		autocorrectFreePct: parsePercent(getCell(text, "Autocorrect-Free Success Rate")),
		tasksAllPassing: Number.parseInt(getCell(text, "Tasks All Passing") ?? "0", 10),
		tasksFlakyFailing: Number.parseInt(getCell(text, "Tasks Flaky/Failing") ?? "0", 10),
		timeoutRuns: Number.parseInt(getCell(text, "Timeout Runs") ?? "0", 10),
		inputTokensTotal: parseNum(inRow[0]),
		outputTokensTotal: parseNum(outRow[0]),
		totalTokens: parseNum(totalRow[0]),
		inputTokensAvg: parseNum(inRow[1]),
		outputTokensAvg: parseNum(outRow[1]),
		totalTokensAvg: parseNum(totalRow[1]),
		durationTotal: durationRow[0] ?? "",
		durationAvg: durationRow[1] ?? "",
		avgIndentScore: indentValue ? Number.parseFloat(indentValue) : null,
		readTotal: parseNum(readRow[0]),
		editTotal: parseNum(editRow[0]),
		writeTotal: parseNum(writeRow[0]),
	};
}

const fmtPct = (v: number) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : "—");
const fmtNum = (v: number) => (Number.isFinite(v) ? v.toLocaleString() : "—");
const shortModel = (m: string) =>
	m
		.split("/")
		.pop()!
		.replace(/:nitro/, "");
const sumField = (list: ReportRow[], pick: (r: ReportRow) => number) =>
	list.reduce((a, r) => a + (Number.isFinite(pick(r)) ? pick(r) : 0), 0);
const avg = (list: ReportRow[], pick: (r: ReportRow) => number) => {
	const vals = list.map(pick).filter(Number.isFinite);
	return vals.length === 0 ? Number.NaN : vals.reduce((a, b) => a + b, 0) / vals.length;
};

function mergeRows(input: ReportRow[]): ReportRow[] {
	const groups = new Map<string, ReportRow[]>();
	for (const r of input) {
		const key = `${r.sepSlug}::${r.model}`;
		const list = groups.get(key) ?? [];
		list.push(r);
		groups.set(key, list);
	}
	return [...groups.values()].map(list => {
		if (list.length === 1) return list[0];
		const totalRuns = sumField(list, r => r.totalRuns);
		const successfulRuns = sumField(list, r => r.successfulRuns);
		const patchFailures = sumField(list, r => r.patchFailures);
		const patchAttempts = sumField(list, r => r.patchAttempts);
		const inputTokensTotal = sumField(list, r => r.inputTokensTotal);
		const outputTokensTotal = sumField(list, r => r.outputTokensTotal);
		const totalTokens = sumField(list, r => r.totalTokens);
		const ratio = (n: number, d: number) => (d === 0 ? Number.NaN : (n / d) * 100);
		const indents = list.map(r => r.avgIndentScore).filter((v): v is number => v !== null);
		return {
			file: list.map(r => r.file).join(","),
			sepSlug: list[0].sepSlug,
			model: list[0].model,
			totalTasks: sumField(list, r => r.totalTasks),
			totalRuns,
			successfulRuns,
			taskSuccessPct: ratio(successfulRuns, totalRuns),
			verifiedPct: ratio(successfulRuns, totalRuns),
			editToolUsagePct: ratio(
				sumField(list, r => Math.round((r.editToolUsagePct / 100) * r.totalRuns)),
				totalRuns,
			),
			editSuccessPct: ratio(patchAttempts - patchFailures, patchAttempts),
			patchFailurePct: ratio(patchFailures, patchAttempts),
			patchFailures,
			patchAttempts,
			mutationIntentPct: avg(list, r => r.mutationIntentPct),
			autocorrectFreePct: avg(list, r => r.autocorrectFreePct),
			tasksAllPassing: sumField(list, r => r.tasksAllPassing),
			tasksFlakyFailing: sumField(list, r => r.tasksFlakyFailing),
			timeoutRuns: sumField(list, r => r.timeoutRuns),
			inputTokensTotal,
			outputTokensTotal,
			totalTokens,
			inputTokensAvg: totalRuns ? Math.round(inputTokensTotal / totalRuns) : 0,
			outputTokensAvg: totalRuns ? Math.round(outputTokensTotal / totalRuns) : 0,
			totalTokensAvg: totalRuns ? Math.round(totalTokens / totalRuns) : 0,
			durationTotal: list.map(r => r.durationTotal).join(" + "),
			durationAvg: list.map(r => r.durationAvg).join(" / "),
			avgIndentScore: indents.length ? indents.reduce((a, b) => a + b, 0) / indents.length : null,
			readTotal: sumField(list, r => r.readTotal),
			editTotal: sumField(list, r => r.editTotal),
			writeTotal: sumField(list, r => r.writeTotal),
		};
	});
}

function sortRows(rows: ReportRow[], by: typeof sortBy): ReportRow[] {
	const sepOrder = ["gt", "plus", "div", "pipe", "bslash", "tilde", "pct", "colon"];
	const modelOrder = (m: string) => (m.includes("glm") ? 0 : m.includes("gpt") ? 1 : m.includes("claude") ? 2 : 3);
	const cmp: Record<typeof sortBy, (a: ReportRow, b: ReportRow) => number> = {
		sep: (a, b) =>
			sepOrder.indexOf(a.sepSlug) - sepOrder.indexOf(b.sepSlug) || modelOrder(a.model) - modelOrder(b.model),
		model: (a, b) =>
			modelOrder(a.model) - modelOrder(b.model) || sepOrder.indexOf(a.sepSlug) - sepOrder.indexOf(b.sepSlug),
		task: (a, b) => b.taskSuccessPct - a.taskSuccessPct,
		edit: (a, b) => b.editSuccessPct - a.editSuccessPct,
		tokens: (a, b) => a.totalTokensAvg - b.totalTokensAvg,
	};
	return [...rows].sort(cmp[by]);
}

const entries = (
	await Promise.all(
		dirs.map(async d =>
			(
				await fs.readdir(path.resolve(d), { withFileTypes: true })
			)
				.filter(e => e.isFile() && e.name.endsWith(".md"))
				.map(e => path.join(path.resolve(d), e.name)),
		),
	)
).flat();

const sorted = sortRows(
	aggregate ? mergeRows(await Promise.all(entries.map(parseReport))) : await Promise.all(entries.map(parseReport)),
	sortBy,
);

if (format === "json") {
	console.log(JSON.stringify(sorted, null, 2));
	process.exit(0);
}

if (format === "csv") {
	const cols: Array<keyof ReportRow> = [
		"sepSlug",
		"model",
		"totalRuns",
		"successfulRuns",
		"taskSuccessPct",
		"editToolUsagePct",
		"editSuccessPct",
		"patchFailurePct",
		"patchFailures",
		"patchAttempts",
		"mutationIntentPct",
		"avgIndentScore",
		"inputTokensTotal",
		"outputTokensTotal",
		"totalTokens",
		"totalTokensAvg",
		"durationTotal",
		"durationAvg",
		"editTotal",
		"readTotal",
	];
	console.log(cols.join(","));
	for (const r of sorted) console.log(cols.map(c => JSON.stringify(r[c] ?? "")).join(","));
	process.exit(0);
}

const headers = [
	"sep",
	"model",
	"task ✓",
	"edit ✓",
	"patch fail",
	"intent",
	"in tok/run",
	"out tok/run",
	"tok/run",
	"avg time",
	"indent",
];
const data = sorted.map(r => [
	SEPARATOR_DISPLAY[r.sepSlug] ?? r.sepSlug,
	shortModel(r.model),
	`${fmtPct(r.taskSuccessPct)} (${r.successfulRuns}/${r.totalRuns})`,
	fmtPct(r.editSuccessPct),
	`${fmtPct(r.patchFailurePct)} (${r.patchFailures}/${r.patchAttempts})`,
	fmtPct(r.mutationIntentPct),
	fmtNum(r.inputTokensAvg),
	fmtNum(r.outputTokensAvg),
	fmtNum(r.totalTokensAvg),
	r.durationAvg,
	r.avgIndentScore !== null ? r.avgIndentScore.toFixed(2) : "—",
]);

function printMd(hdrs: string[], rows: string[][]) {
	console.log(`| ${hdrs.join(" | ")} |\n|${hdrs.map(() => "---").join("|")}|`);
	for (const r of rows) console.log(`| ${r.join(" | ")} |`);
}

function printTable(hdrs: string[], rows: string[][]) {
	const widths = hdrs.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
	const row = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
	console.log(`${row(hdrs)}\n${widths.map(w => "-".repeat(w)).join("  ")}`);
	for (const r of rows) console.log(row(r));
}

function groupAggregates(rows: ReportRow[], fmt: "md" | "table") {
	const bySep = new Map<string, ReportRow[]>();
	const byModel = new Map<string, ReportRow[]>();
	for (const r of rows) {
		(bySep.get(r.sepSlug) ?? bySep.set(r.sepSlug, []).get(r.sepSlug)!).push(r);
		(byModel.get(r.model) ?? byModel.set(r.model, []).get(r.model)!).push(r);
	}
	const sepData = [...bySep.entries()].map(([slug, list]) => [
		SEPARATOR_DISPLAY[slug] ?? slug,
		fmtPct(avg(list, r => r.taskSuccessPct)),
		fmtPct(avg(list, r => r.editSuccessPct)),
		`${sumField(list, r => r.patchFailures)}/${sumField(list, r => r.patchAttempts)}`,
		fmtNum(Math.round(avg(list, r => r.totalTokensAvg))),
	]);
	const modelData = [...byModel.entries()].map(([model, list]) => [
		shortModel(model),
		fmtPct(avg(list, r => r.taskSuccessPct)),
		fmtPct(avg(list, r => r.editSuccessPct)),
		`${sumField(list, r => r.patchFailures)}/${sumField(list, r => r.patchAttempts)}`,
		fmtNum(Math.round(avg(list, r => r.totalTokensAvg))),
	]);
	const aggHeaders = ["model", "task ✓ (avg)", "edit ✓ (avg)", "patch fail (sum)", "tok/run (avg)"];
	const aggSepHeaders = ["sep", "task ✓ (avg)", "edit ✓ (avg)", "patch fail (sum)", "tok/run (avg)"];
	if (fmt === "md") {
		console.log("### Per separator (avg across models)\n");
		printMd(aggSepHeaders, sepData);
		console.log("\n### Per model (avg across separators)\n");
		printMd(aggHeaders, modelData);
	} else {
		console.log("\nPer separator (avg across models):");
		printTable(aggSepHeaders, sepData);
		console.log("\nPer model (avg across separators):");
		printTable(aggHeaders, modelData);
	}
}

if (format === "md") {
	printMd(headers, data);
	console.log();
	groupAggregates(sorted, "md");
} else {
	printTable(headers, data);
	groupAggregates(sorted, "table");
}
