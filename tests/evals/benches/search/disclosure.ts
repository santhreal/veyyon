import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import type { SearchToolDetails } from "@veyyon/coding-agent/tools/search/search";
import { SearchTool } from "@veyyon/coding-agent/tools/search/search";
import { errorMessage } from "@veyyon/utils";
import { type FlagGrammar, parseFlags } from "../../engine/flag-grammar";
import { internalScratchDir } from "../../engine/package-paths";
import { materializeCorpus } from "./corpus";
import { registerBuiltinSearchBench, requireSearchCorpus } from "./registry";
import { createSearchBenchmarkSession } from "./main";

const ASSUMED_LATER_TURNS = 60;
const ARTIFACT_ID = "search-disclosure-full";
export interface SearchDisclosureBenchmarkReport {
	fileCount: number;
	matchCount: number;
	fullInlineBytes: number;
	compactInlineBytes: number;
	artifactBytes: number;
	exactRecovery: boolean;
	inlineReductionBytes: number;
	inlineReductionPercent: number;
	assumedLaterTurns: number;
	estimatedByteTurnsAvoided: number;
	estimatedTokensAvoided: number;
}

function resultText(result: AgentToolResult<SearchToolDetails>): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}
export async function runSearchDisclosureBenchmark(baseDir?: string): Promise<SearchDisclosureBenchmarkReport> {
	registerBuiltinSearchBench();
	const spec = requireSearchCorpus("disclosure");
	const corpus = await materializeCorpus(spec, baseDir);
	const parent = baseDir ?? internalScratchDir();
	await fs.mkdir(parent, { recursive: true });
	const artifactDir = await fs.mkdtemp(path.join(parent, "search-disclosure-artifacts-"));
	const artifactPath = path.join(artifactDir, "search-disclosure-full.txt");
	try {
		const input = { type: "text" as const, input: "DISCLOSURE_NEEDLE", path: "." };
		const fullSession = createSearchBenchmarkSession(corpus.corpusDir, {
			settings: {
				"search.contextBefore": 0,
				"search.contextAfter": 0,
				"tools.artifactSpillThreshold": 1024 * 1024,
			},
		});
		const compactSession = createSearchBenchmarkSession(corpus.corpusDir, {
			getTurnIndex: () => 0,
			settings: {
				"search.contextBefore": 0,
				"search.contextAfter": 0,
			},
			allocateOutputArtifact: async () => ({ id: ARTIFACT_ID, path: artifactPath }),
		});
		const fullResult = await new SearchTool(fullSession).execute("disclosure-full", input);
		const compactResult = await new SearchTool(compactSession).execute("disclosure-compact", input);
		if (fullResult.details?.type !== "text" || compactResult.details?.type !== "text") {
			throw new Error("Text search benchmark returned the wrong details variant");
		}
		const fullText = resultText(fullResult);
		const compactText = resultText(compactResult);
		let artifactText: string;
		try {
			artifactText = await fs.readFile(artifactPath, "utf8");
		} catch (err) {
			throw new Error(`Failed to read disclosure artifact at ${artifactPath}: ${errorMessage(err)}`);
		}
		return buildSearchDisclosureReport(
			{
				fileCount: compactResult.details.result.fileCount ?? null,
				matchCount: compactResult.details.result.matchCount ?? null,
				fullInlineBytes: Buffer.byteLength(fullText, "utf8"),
				compactInlineBytes: Buffer.byteLength(compactText, "utf8"),
				artifactBytes: Buffer.byteLength(artifactText, "utf8"),
				exactRecovery: artifactText === fullText,
			},
			corpus.corpusDir,
		);
	} finally {
		await Promise.all([corpus.cleanup(), fs.rm(artifactDir, { recursive: true, force: true })]);
	}
}

/** What one disclosure run measured, before any ratio or projection is derived from it. */
export interface SearchDisclosureMeasurement {
	/** Files the search reported, or null when it reported no count. */
	fileCount: number | null;
	/** Matches the search reported, or null when it reported no count. */
	matchCount: number | null;
	fullInlineBytes: number;
	compactInlineBytes: number;
	artifactBytes: number;
	exactRecovery: boolean;
}

/**
 * Derive the report from one measurement, or refuse it.
 *
 * Every derived number is a saving over what the full search inlined, so a measurement that read
 * nothing cannot produce one: a reduction over zero bytes is NaN rather than a percentage, and a
 * count the search never reported is not "0 matches across 0 files". A bench that measured nothing
 * refuses instead of printing a number nothing backs.
 */
export function buildSearchDisclosureReport(
	measured: SearchDisclosureMeasurement,
	corpusLabel: string,
): SearchDisclosureBenchmarkReport {
	const { fileCount, matchCount, fullInlineBytes, compactInlineBytes } = measured;
	if (fileCount === null || matchCount === null) {
		throw new Error("Search disclosure bench: the search tool reported no file or match count");
	}
	if (matchCount === 0) {
		throw new Error(`Search disclosure bench: the corpus at ${corpusLabel} produced no matches`);
	}
	if (fullInlineBytes <= 0) {
		throw new Error("Search disclosure bench: the full-context search inlined no bytes, so there is no reduction");
	}
	const inlineReductionBytes = fullInlineBytes - compactInlineBytes;
	const estimatedByteTurnsAvoided = inlineReductionBytes * ASSUMED_LATER_TURNS;
	return {
		fileCount,
		matchCount,
		fullInlineBytes,
		compactInlineBytes,
		artifactBytes: measured.artifactBytes,
		exactRecovery: measured.exactRecovery,
		inlineReductionBytes,
		inlineReductionPercent: Number(((inlineReductionBytes / fullInlineBytes) * 100).toFixed(2)),
		assumedLaterTurns: ASSUMED_LATER_TURNS,
		estimatedByteTurnsAvoided,
		estimatedTokensAvoided: Math.round(estimatedByteTurnsAvoided / 4),
	};
}

export function formatSearchDisclosureBenchmark(report: SearchDisclosureBenchmarkReport): string {
	return [
		"UNIFIED SEARCH PROGRESSIVE DISCLOSURE BENCHMARK",
		`Corpus:                 ${report.matchCount} matches across ${report.fileCount} files`,
		`Full inline:            ${report.fullInlineBytes} bytes`,
		`Compact inline:         ${report.compactInlineBytes} bytes`,
		`Inline reduction:       ${report.inlineReductionBytes} bytes (${report.inlineReductionPercent.toFixed(2)}%)`,
		`Recovered artifact:     ${report.artifactBytes} bytes (${report.exactRecovery ? "exact" : "MISMATCH"})`,
		`Est. byte-turns avoided: ${report.estimatedByteTurnsAvoided} (assuming ${report.assumedLaterTurns} later turns)`,
		`Est. tokens avoided:    ${report.estimatedTokensAvoided} (~4 bytes/token approximation)`,
	].join("\n");
}

/** The disclosure bench takes no inputs, so any flag but `--help` is a mistake. */
export const DISCLOSURE_BENCH_FLAGS = { valued: {}, valueless: { help: true } } as const satisfies FlagGrammar;

/** Usage text, printed for `--help` and after a refusal. */
export const DISCLOSURE_BENCH_USAGE = `search disclosure bench — measure inline bytes saved by artifact disclosure

Usage:
  bench:search:disclosure          run the bench over its fixed corpus
  bench:search:disclosure --help   this text
`;

if (import.meta.main) {
	let flags: Record<string, string>;
	try {
		flags = parseFlags(process.argv.slice(2), DISCLOSURE_BENCH_FLAGS);
	} catch (err) {
		process.stderr.write(`${errorMessage(err)}\n\n${DISCLOSURE_BENCH_USAGE}`);
		// Nothing ran, so this is the usage code, not the code a failed measurement returns.
		process.exit(2);
	}
	if (flags.help !== undefined) {
		process.stdout.write(DISCLOSURE_BENCH_USAGE);
		process.exit(0);
	}
	const report = await runSearchDisclosureBenchmark();
	process.stdout.write(`${formatSearchDisclosureBenchmark(report)}\n`);
	if (!report.exactRecovery || report.inlineReductionBytes <= 0) process.exitCode = 1;
}
