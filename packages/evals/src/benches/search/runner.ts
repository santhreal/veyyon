/**
 * Run the offline search bench over every registered corpus, case suite and arm.
 *
 * The bench answers two questions per case, and they are different questions. Whether the
 * arms AGREE is a comparison against a declared reference arm, which catches a facade that
 * drifts from the engine it dispatches to. Whether the arms are RIGHT is the case's declared
 * answer over its corpus, which catches an engine that stops finding things — a regression
 * agreement cannot see, because arms that share an engine move together.
 *
 * Everything the run covers comes out of the registry at call time: corpora, case suites and
 * arms are registrations, so a new engine, a new corpus or a new query set extends the bench
 * without touching this file. Nothing here consumes provider quota.
 */
import * as fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { AgentToolResult } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import type { SearchType } from "@veyyon/coding-agent/tools/search";
import { errorMessage } from "@veyyon/utils";
import type { SearchArm, SearchArmResult, SearchArmRunner } from "./arms";
import type { SearchBenchmarkCase, SearchCaseSuite } from "./cases";
import { materializeCorpus } from "./corpus";
import { formatExpectationFailures, unwrapSearchDetails, verifySearchExpectation } from "./expectations";
import {
	registerBuiltinSearchBench,
	requireSearchArm,
	requireSearchCaseSuite,
	requireSearchCorpus,
	searchArms,
	searchCaseSuites,
	searchCorpora,
} from "./registry";

/** The arm every other arm is compared against unless a run names a different one. */
export const DEFAULT_REFERENCE_ARM_ID = "unified-tool";

export interface SearchArmMeasurement {
	armId: string;
	meanDurationMs: number;
	minDurationMs: number;
	maxDurationMs: number;
	contentBytes: number;
	detailsBytes: number;
	totalBytes: number;
	/** Mean duration minus the reference arm's. Zero for the reference arm itself. */
	overheadVsReferenceMs: number;
	/** This arm's result is byte-identical to the reference arm's. True for the reference. */
	matchesReference: boolean;
	mismatchReason?: string;
}

export interface SearchCaseMeasurement {
	id: string;
	type: SearchType;
	description: string;
	caseSuiteId: string;
	corpusId: string;
	referenceArmId: string;
	/** Every arm agreed with the reference arm. */
	parityPassed: boolean;
	/** The first disagreement, named by arm. Absent when every arm agreed. */
	mismatchReason?: string;
	/** The reference arm produced the answer the corpus has for this query. */
	expectationSatisfied: boolean;
	/** Every violated clause, one phrase each. Absent when satisfied. */
	expectationFailureReason?: string;
	/** The files the reference arm reported, which the answer check was formed from. */
	matchedPaths: readonly string[];
	/** One entry per arm the run measured, reference arm first. */
	arms: readonly SearchArmMeasurement[];
}

export interface SearchArmAverage {
	armId: string;
	avgDurationMs: number;
	totalBytes: number;
}

export interface SearchTypeSummary {
	type: SearchType;
	totalCases: number;
	parityPassedCases: number;
	parityFailedCases: number;
	expectationPassedCases: number;
	expectationFailedCases: number;
	armAverages: readonly SearchArmAverage[];
}

export interface SearchSuiteReport {
	caseSuiteId: string;
	caseSuiteDescription: string;
	corpusId: string;
	referenceArmId: string;
	armIds: readonly string[];
	corpusFileCount: number;
	corpusTotalBytes: number;
	totalCases: number;
	parityPassed: boolean;
	totalMismatches: number;
	expectationsPassed: boolean;
	totalExpectationFailures: number;
	summaryByType: Record<SearchType, SearchTypeSummary>;
	cases: readonly SearchCaseMeasurement[];
}

export interface SearchBenchReport {
	timestamp: string;
	iterationsPerCase: number;
	referenceArmId: string;
	armIds: readonly string[];
	suites: readonly SearchSuiteReport[];
	totalCases: number;
	parityPassed: boolean;
	totalMismatches: number;
	expectationsPassed: boolean;
	totalExpectationFailures: number;
	limitations: readonly string[];
}

export interface SearchBenchOptions {
	iterations?: number;
	filterType?: SearchType | "all";
	/** Case suites to run, by registered id. Omitted -> every registered suite. */
	caseSuiteIds?: readonly string[];
	/** Arms to measure, by registered id. Omitted -> every registered arm. */
	armIds?: readonly string[];
	/** The arm the others are compared against and whose answer is checked. */
	referenceArmId?: string;
	/** Throw on the first arm that disagrees with the reference arm. */
	strictParity?: boolean;
	/** Throw on the first case whose declared answer the reference arm did not produce. */
	strictExpectations?: boolean;
	corpusBaseDir?: string;
}

/** Known limitations of this benchmark artifact. */
export const SEARCH_BENCHMARK_LIMITATIONS: readonly string[] = [
	"Measures local in-process dispatch, result-envelope, and execution overhead on deterministic synthetic corpora; it does not measure provider schema validation, remote filesystems, or SSH targets.",
	"Structural queries rely on local ast-grep native parser support and are exercised on TypeScript/JavaScript source files.",
	"Does not evaluate model-side tool-selection accuracy, token prompt efficiency, or remote provider latency, because the run is fully offline and consumes zero provider quota.",
	"Agreement between arms is a comparison against the declared reference arm, not a correctness claim; correctness is the per-case declared answer over its corpus.",
	"A declared answer is only as good as the corpus it was derived against: an answer that is wrong in the same direction as the engine is invisible here.",
];

/** An isolated tool session bound to one corpus directory. */
export function createSearchBenchmarkSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

/** Canonical text of a tool result, line endings normalized. */
export function canonicalizeResultContent(content: AgentToolResult["content"]): string {
	return content
		.map(item => {
			if (item.type === "text") return item.text.replace(/\r\n/g, "\n");
			return `[${item.type}]`;
		})
		.join("\n");
}

/**
 * Compare one arm's result against the reference arm's.
 *
 * Both the canonical content and the engine payload have to match byte for byte. An arm that
 * declares a result type (the unified tool does) must declare the case's type.
 */
export function compareArmResult(
	queryType: SearchType,
	reference: SearchArmResult,
	candidate: SearchArmResult,
): { matches: boolean; error?: string } {
	const referenceContent = canonicalizeResultContent(reference.content);
	const candidateContent = canonicalizeResultContent(candidate.content);
	if (referenceContent !== candidateContent) {
		return {
			matches: false,
			error: `Content mismatch: reference emitted ${referenceContent.length} chars, this arm emitted ${candidateContent.length} chars`,
		};
	}

	const candidateDetails = candidate.details;
	if (!reference.details) return { matches: false, error: "Reference arm returned undefined details" };
	if (!candidateDetails) return { matches: false, error: "This arm returned undefined details" };

	if ("type" in candidateDetails && candidateDetails.type !== queryType) {
		return {
			matches: false,
			error: `details.type mismatch: expected "${queryType}", got "${candidateDetails.type}"`,
		};
	}

	const referencePayload = JSON.stringify(unwrapSearchDetails(reference.details));
	const candidatePayload = JSON.stringify(unwrapSearchDetails(candidateDetails));
	if (referencePayload !== candidatePayload) {
		return { matches: false, error: "Details payload differs from the reference arm's" };
	}

	return { matches: true };
}

interface PreparedArm {
	arm: SearchArm;
	runner: SearchArmRunner;
}

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

function armResultBytes(result: SearchArmResult): { contentBytes: number; detailsBytes: number } {
	const contentBytes = byteLength(canonicalizeResultContent(result.content));
	const detailsBytes = result.details ? byteLength(JSON.stringify(result.details)) : 0;
	return { contentBytes, detailsBytes };
}

/**
 * Measure one case across every prepared arm.
 *
 * Arm order rotates per iteration so filesystem and native cache warmth does not always
 * favour the same arm, and every arm still observes the same corpus state within a pass.
 */
export async function measureSearchCase(
	benchCase: SearchBenchmarkCase,
	arms: readonly PreparedArm[],
	options: {
		iterations: number;
		caseSuiteId: string;
		corpusId: string;
		referenceArmId: string;
		strictParity: boolean;
		strictExpectations: boolean;
	},
): Promise<SearchCaseMeasurement> {
	if (arms.length === 0) throw new Error("measureSearchCase needs at least one arm");
	const durations = new Map<string, number[]>(arms.map(prepared => [prepared.arm.id, []]));
	const lastResult = new Map<string, SearchArmResult>();

	for (const prepared of arms) {
		await prepared.runner.run(`warmup-${prepared.arm.id}`, benchCase.input);
	}

	for (let iteration = 0; iteration < options.iterations; iteration++) {
		const offset = iteration % arms.length;
		for (let index = 0; index < arms.length; index++) {
			const prepared = arms[(index + offset) % arms.length];
			const start = performance.now();
			const result = await prepared.runner.run(`bench-${prepared.arm.id}-${iteration}`, benchCase.input);
			const elapsed = performance.now() - start;
			durations.get(prepared.arm.id)?.push(elapsed);
			lastResult.set(prepared.arm.id, result);
		}
	}

	const referenceResult = lastResult.get(options.referenceArmId);
	if (!referenceResult) {
		throw new Error(`internal: reference arm "${options.referenceArmId}" produced no result`);
	}
	const referenceDurations = durations.get(options.referenceArmId) ?? [];
	const referenceMean = referenceDurations.reduce((acc, value) => acc + value, 0) / referenceDurations.length;

	let mismatchReason: string | undefined;
	const measurements: SearchArmMeasurement[] = [];
	for (const prepared of arms) {
		const armId = prepared.arm.id;
		const samples = durations.get(armId) ?? [];
		const mean = samples.reduce((acc, value) => acc + value, 0) / samples.length;
		const result = lastResult.get(armId);
		if (!result) throw new Error(`internal: arm "${armId}" produced no result`);
		const { contentBytes, detailsBytes } = armResultBytes(result);

		const comparison =
			armId === options.referenceArmId
				? { matches: true }
				: compareArmResult(benchCase.type, referenceResult, result);
		if (!comparison.matches && !mismatchReason) {
			mismatchReason = `${armId}: ${comparison.error}`;
			if (options.strictParity) {
				throw new Error(`Search arm disagreement on case "${benchCase.id}" (${benchCase.type}): ${mismatchReason}`);
			}
		}

		measurements.push({
			armId,
			meanDurationMs: Number(mean.toFixed(3)),
			minDurationMs: Number(Math.min(...samples).toFixed(3)),
			maxDurationMs: Number(Math.max(...samples).toFixed(3)),
			contentBytes,
			detailsBytes,
			totalBytes: contentBytes + detailsBytes,
			overheadVsReferenceMs: Number((mean - referenceMean).toFixed(3)),
			matchesReference: comparison.matches,
			mismatchReason: comparison.matches ? undefined : comparison.error,
		});
	}

	// The declared answer is checked against the reference arm, which is the surface a caller
	// reaches; the comparison above already pinned every other arm to the same bytes.
	const expectation = verifySearchExpectation(referenceResult.details, benchCase.expect);
	if (options.strictExpectations && !expectation.satisfied) {
		throw new Error(
			`Search expectation failure on case "${benchCase.id}" (${benchCase.type}): ${formatExpectationFailures(expectation.failures)}`,
		);
	}

	const orderedArms = [
		...measurements.filter(measurement => measurement.armId === options.referenceArmId),
		...measurements.filter(measurement => measurement.armId !== options.referenceArmId),
	];

	return {
		id: benchCase.id,
		type: benchCase.type,
		description: benchCase.description,
		caseSuiteId: options.caseSuiteId,
		corpusId: options.corpusId,
		referenceArmId: options.referenceArmId,
		parityPassed: mismatchReason === undefined,
		mismatchReason,
		expectationSatisfied: expectation.satisfied,
		expectationFailureReason: expectation.satisfied ? undefined : formatExpectationFailures(expectation.failures),
		matchedPaths: expectation.matchedPaths,
		arms: orderedArms,
	};
}

const SEARCH_TYPES: readonly SearchType[] = ["files", "text", "structure"];

function summarize(
	measurements: readonly SearchCaseMeasurement[],
	armIds: readonly string[],
): Record<SearchType, SearchTypeSummary> {
	const summaryByType = {} as Record<SearchType, SearchTypeSummary>;
	for (const type of SEARCH_TYPES) {
		const typeCases = measurements.filter(measurement => measurement.type === type);
		const total = typeCases.length;
		const parityPassed = typeCases.filter(measurement => measurement.parityPassed).length;
		const expectationPassed = typeCases.filter(measurement => measurement.expectationSatisfied).length;
		const armAverages = armIds.map(armId => {
			const arms = typeCases.flatMap(measurement => measurement.arms.filter(arm => arm.armId === armId));
			const avg = arms.length > 0 ? arms.reduce((acc, arm) => acc + arm.meanDurationMs, 0) / arms.length : 0;
			return {
				armId,
				avgDurationMs: Number(avg.toFixed(3)),
				totalBytes: arms.reduce((acc, arm) => acc + arm.totalBytes, 0),
			};
		});
		summaryByType[type] = {
			type,
			totalCases: total,
			parityPassedCases: parityPassed,
			parityFailedCases: total - parityPassed,
			expectationPassedCases: expectationPassed,
			expectationFailedCases: total - expectationPassed,
			armAverages,
		};
	}
	return summaryByType;
}

/** Run one case suite over its corpus with the arms already resolved. */
export async function runSearchCaseSuite(
	suite: SearchCaseSuite,
	arms: readonly SearchArm[],
	options: SearchBenchOptions = {},
): Promise<SearchSuiteReport> {
	const iterations = Math.max(1, options.iterations ?? 5);
	const filterType = options.filterType ?? "all";
	const referenceArmId = options.referenceArmId ?? DEFAULT_REFERENCE_ARM_ID;
	const strictParity = options.strictParity ?? true;
	const strictExpectations = options.strictExpectations ?? true;

	if (!arms.some(arm => arm.id === referenceArmId)) {
		throw new Error(
			`Reference arm "${referenceArmId}" is not among the arms this run measures (${arms.map(arm => arm.id).join(", ") || "none"}).`,
		);
	}

	const corpus = await materializeCorpus(requireSearchCorpus(suite.corpusId), options.corpusBaseDir);
	const prepared: PreparedArm[] = [];
	try {
		const session = createSearchBenchmarkSession(corpus.corpusDir);
		for (const arm of arms) {
			prepared.push({ arm, runner: arm.prepare({ session, corpusDir: corpus.corpusDir }) });
		}

		const casesToRun = suite.cases.filter(benchCase => filterType === "all" || benchCase.type === filterType);
		const measurements: SearchCaseMeasurement[] = [];
		for (const benchCase of casesToRun) {
			measurements.push(
				await measureSearchCase(benchCase, prepared, {
					iterations,
					caseSuiteId: suite.id,
					corpusId: suite.corpusId,
					referenceArmId,
					strictParity,
					strictExpectations,
				}),
			);
		}

		const armIds = arms.map(arm => arm.id);
		const totalMismatches = measurements.filter(measurement => !measurement.parityPassed).length;
		const totalExpectationFailures = measurements.filter(measurement => !measurement.expectationSatisfied).length;

		return {
			caseSuiteId: suite.id,
			caseSuiteDescription: suite.description,
			corpusId: suite.corpusId,
			referenceArmId,
			armIds,
			corpusFileCount: corpus.fileCount,
			corpusTotalBytes: corpus.totalBytes,
			totalCases: measurements.length,
			parityPassed: totalMismatches === 0,
			totalMismatches,
			expectationsPassed: totalExpectationFailures === 0,
			totalExpectationFailures,
			summaryByType: summarize(measurements, armIds),
			cases: measurements,
		};
	} finally {
		for (const entry of prepared) await entry.runner.dispose?.();
		await corpus.cleanup();
	}
}

/** Run every selected case suite over every selected arm. */
export async function runSearchBench(options: SearchBenchOptions = {}): Promise<SearchBenchReport> {
	registerBuiltinSearchBench();

	const suites = options.caseSuiteIds ? options.caseSuiteIds.map(requireSearchCaseSuite) : [...searchCaseSuites()];
	const arms = options.armIds ? options.armIds.map(requireSearchArm) : [...searchArms()];
	const referenceArmId = options.referenceArmId ?? DEFAULT_REFERENCE_ARM_ID;

	const suiteReports: SearchSuiteReport[] = [];
	for (const suite of suites) {
		suiteReports.push(await runSearchCaseSuite(suite, arms, { ...options, referenceArmId }));
	}

	const totalMismatches = suiteReports.reduce((acc, report) => acc + report.totalMismatches, 0);
	const totalExpectationFailures = suiteReports.reduce((acc, report) => acc + report.totalExpectationFailures, 0);

	return {
		timestamp: new Date().toISOString(),
		iterationsPerCase: Math.max(1, options.iterations ?? 5),
		referenceArmId,
		armIds: arms.map(arm => arm.id),
		suites: suiteReports,
		totalCases: suiteReports.reduce((acc, report) => acc + report.totalCases, 0),
		parityPassed: totalMismatches === 0,
		totalMismatches,
		expectationsPassed: totalExpectationFailures === 0,
		totalExpectationFailures,
		limitations: SEARCH_BENCHMARK_LIMITATIONS,
	};
}

/** Human-readable report: one block per case suite, one column per arm. */
export function formatSearchBenchReport(report: SearchBenchReport): string {
	const lines: string[] = [];
	const rule = "================================================================================";
	lines.push(rule);
	lines.push("                        OFFLINE UNIFIED SEARCH BENCH                            ");
	lines.push(rule);
	lines.push(`Timestamp:          ${report.timestamp}`);
	lines.push(`Iterations / case:  ${report.iterationsPerCase}`);
	lines.push(`Arms:               ${report.armIds.join(", ")}  (reference: ${report.referenceArmId})`);
	lines.push(`Case suites:        ${report.suites.map(suite => suite.caseSuiteId).join(", ")}`);
	lines.push(`Cases:              ${report.totalCases}`);
	lines.push(`Arm agreement:      ${report.parityPassed ? "PASS" : `FAIL (${report.totalMismatches} case(s))`}`);
	lines.push(
		`Declared answers:   ${report.expectationsPassed ? "PASS" : `FAIL (${report.totalExpectationFailures} case(s))`}`,
	);

	for (const suite of report.suites) {
		lines.push("--------------------------------------------------------------------------------");
		lines.push(
			`SUITE ${suite.caseSuiteId}  (corpus ${suite.corpusId}: ${suite.corpusFileCount} files, ${suite.corpusTotalBytes} bytes)`,
		);
		lines.push(`  ${suite.caseSuiteDescription}`);
		lines.push("");
		const armHeader = suite.armIds.map(id => `${id} (ms)`.padStart(20)).join(" | ");
		lines.push(`Type       | Cases | Agree | Answer | ${armHeader}`);
		for (const summary of Object.values(suite.summaryByType)) {
			if (summary.totalCases === 0) continue;
			const cells = suite.armIds.map(armId => {
				const average = summary.armAverages.find(entry => entry.armId === armId);
				return (average ? average.avgDurationMs.toFixed(3) : "-").padStart(20);
			});
			lines.push(
				`${summary.type.padEnd(10)} | ${String(summary.totalCases).padStart(5)} | ` +
					`${`${summary.parityPassedCases}/${summary.totalCases}`.padStart(5)} | ` +
					`${`${summary.expectationPassedCases}/${summary.totalCases}`.padStart(6)} | ${cells.join(" | ")}`,
			);
		}
		lines.push("");
		lines.push("Case                                | Type      | Agree | Answer | Files | ref (ms) | Δ vs ref");
		for (const measurement of suite.cases) {
			const reference = measurement.arms.find(arm => arm.armId === measurement.referenceArmId);
			const others = measurement.arms.filter(arm => arm.armId !== measurement.referenceArmId);
			const delta = others
				.map(
					arm =>
						`${arm.armId} ${arm.overheadVsReferenceMs >= 0 ? "+" : ""}${arm.overheadVsReferenceMs.toFixed(3)}`,
				)
				.join(", ");
			lines.push(
				`${measurement.id.padEnd(35)} | ${measurement.type.padEnd(9)} | ` +
					`${(measurement.parityPassed ? "PASS" : "FAIL").padEnd(5)} | ` +
					`${(measurement.expectationSatisfied ? "PASS" : "FAIL").padEnd(6)} | ` +
					`${String(measurement.matchedPaths.length).padStart(5)} | ` +
					`${(reference?.meanDurationMs ?? 0).toFixed(3).padStart(8)} | ${delta || "-"}`,
			);
			if (measurement.expectationFailureReason) {
				lines.push(`  -> declared answer not produced: ${measurement.expectationFailureReason}`);
			}
			if (measurement.mismatchReason) {
				lines.push(`  -> arms disagree: ${measurement.mismatchReason}`);
			}
		}
	}

	lines.push(rule);
	lines.push("LIMITATIONS:");
	for (const limitation of report.limitations) lines.push(`- ${limitation}`);
	lines.push(rule);

	return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	let iterations = 5;
	let filterType: SearchType | "all" = "all";
	let caseSuiteIds: string[] | undefined;
	let armIds: string[] | undefined;
	let referenceArmId: string | undefined;
	let jsonOutput: string | null = null;
	let jsonStdout = false;
	let listOnly = false;

	const listValue = (value: string): string[] =>
		value
			.split(",")
			.map(entry => entry.trim())
			.filter(Boolean);

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--iterations" && i + 1 < args.length) {
			iterations = Number.parseInt(args[++i], 10) || 5;
		} else if (arg === "--type" && i + 1 < args.length) {
			const value = args[++i];
			if (value === "files" || value === "text" || value === "structure" || value === "all") filterType = value;
		} else if (arg === "--suite" && i + 1 < args.length) {
			caseSuiteIds = listValue(args[++i]);
		} else if (arg === "--arms" && i + 1 < args.length) {
			armIds = listValue(args[++i]);
		} else if (arg === "--reference" && i + 1 < args.length) {
			referenceArmId = args[++i];
		} else if (arg === "--list") {
			listOnly = true;
		} else if (arg === "--json") {
			if (i + 1 < args.length && !args[i + 1].startsWith("-")) jsonOutput = args[++i];
			else jsonStdout = true;
		}
	}

	registerBuiltinSearchBench();

	if (listOnly) {
		const lines = ["corpora:"];
		for (const corpus of searchCorpora()) {
			lines.push(`  ${corpus.id}  files=${Object.keys(corpus.files).length}  ${corpus.description}`);
		}
		lines.push("case suites:");
		for (const suite of searchCaseSuites()) {
			lines.push(`  ${suite.id}  corpus=${suite.corpusId}  cases=${suite.cases.length}  ${suite.description}`);
		}
		lines.push("arms:");
		for (const arm of searchArms()) lines.push(`  ${arm.id}  ${arm.description}`);
		process.stdout.write(`${lines.join("\n")}\n`);
	} else {
		try {
			const report = await runSearchBench({
				iterations,
				filterType,
				caseSuiteIds,
				armIds,
				referenceArmId,
				// Collect every failure rather than stopping at the first, so one run reports the
				// whole picture; the exit code still refuses.
				strictParity: false,
				strictExpectations: false,
			});

			if (jsonStdout) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
			else process.stdout.write(formatSearchBenchReport(report));

			if (jsonOutput) await fs.writeFile(jsonOutput, JSON.stringify(report, null, 2), "utf8");

			if (!report.parityPassed || !report.expectationsPassed) process.exit(1);
		} catch (err) {
			process.stderr.write(`Search bench error: ${errorMessage(err)}\n`);
			process.exit(1);
		}
	}
}
