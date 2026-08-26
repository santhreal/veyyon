import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import type { SearchToolDetails } from "@veyyon/coding-agent/tools/search";
import { SearchTool } from "@veyyon/coding-agent/tools/search";
import { errorMessage } from "@veyyon/utils";
import { type FlagGrammar, parseFlags } from "../../core/flags";
import { internalScratchDir } from "../../paths";
import { materializeCorpus } from "./corpus";
import { registerBuiltinSearchBench, requireSearchCorpus } from "./registry";
import { createSearchBenchmarkSession } from "./runner";

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
		const fullInlineBytes = Buffer.byteLength(fullText, "utf8");
		const compactInlineBytes = Buffer.byteLength(compactText, "utf8");
		const artifactBytes = Buffer.byteLength(artifactText, "utf8");
		const inlineReductionBytes = fullInlineBytes - compactInlineBytes;
		const estimatedByteTurnsAvoided = inlineReductionBytes * ASSUMED_LATER_TURNS;
		return {
			fileCount: compactResult.details.result.fileCount ?? 0,
			matchCount: compactResult.details.result.matchCount ?? 0,
			fullInlineBytes,
			compactInlineBytes,
			artifactBytes,
			exactRecovery: artifactText === fullText,
			inlineReductionBytes,
			inlineReductionPercent: Number(((inlineReductionBytes / fullInlineBytes) * 100).toFixed(2)),
			assumedLaterTurns: ASSUMED_LATER_TURNS,
			estimatedByteTurnsAvoided,
			estimatedTokensAvoided: Math.round(estimatedByteTurnsAvoided / 4),
		};
	} finally {
		await Promise.all([corpus.cleanup(), fs.rm(artifactDir, { recursive: true, force: true })]);
	}
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
		process.exit(1);
	}
	if (flags.help !== undefined) {
		process.stdout.write(DISCLOSURE_BENCH_USAGE);
		process.exit(0);
	}
	const report = await runSearchDisclosureBenchmark();
	process.stdout.write(`${formatSearchDisclosureBenchmark(report)}\n`);
	if (!report.exactRecovery || report.inlineReductionBytes <= 0) process.exitCode = 1;
}
