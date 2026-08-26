import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import type { SearchToolDetails } from "@veyyon/coding-agent/tools/search";
import { SearchTool } from "@veyyon/coding-agent/tools/search";
import { errorMessage } from "@veyyon/utils";
import { internalScratchDir } from "../../paths";

const FILE_COUNT = 20;
const MATCHES_PER_FILE = 8;
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

interface DisclosureCorpus {
	root: string;
	artifactPath: string;
	cleanup: () => Promise<void>;
}

function resultText(result: AgentToolResult<SearchToolDetails>): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

async function createDisclosureCorpus(baseDir?: string): Promise<DisclosureCorpus> {
	const parent = baseDir ?? internalScratchDir();
	await fs.mkdir(parent, { recursive: true });
	const root = await fs.mkdtemp(path.join(parent, "search-disclosure-bench-"));
	const artifactDir = await fs.mkdtemp(path.join(parent, "search-disclosure-artifacts-"));
	const artifactPath = path.join(artifactDir, "search-disclosure-full.txt");
	for (let fileIndex = 0; fileIndex < FILE_COUNT; fileIndex++) {
		const lines = Array.from(
			{ length: MATCHES_PER_FILE },
			(_, lineIndex) =>
				`export const disclosure_${fileIndex}_${lineIndex} = "DISCLOSURE_NEEDLE_${fileIndex}_${lineIndex}_${"x".repeat(56)}";`,
		);
		await fs.writeFile(path.join(root, `disclosure-${fileIndex}.ts`), `${lines.join("\n")}\n`, "utf8");
	}
	return {
		root,
		artifactPath,
		cleanup: async () => {
			await Promise.all([
				fs.rm(root, { recursive: true, force: true }),
				fs.rm(artifactDir, { recursive: true, force: true }),
			]);
		},
	};
}

function createSession(corpus: DisclosureCorpus, recoverable: boolean): ToolSession {
	return {
		cwd: corpus.root,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		...(recoverable ? { getTurnIndex: () => 0 } : {}),
		settings: Settings.isolated({
			"search.contextBefore": 0,
			"search.contextAfter": 0,
			...(!recoverable ? { "tools.artifactSpillThreshold": 1024 * 1024 } : {}),
		}),
		allocateOutputArtifact: recoverable ? async () => ({ id: ARTIFACT_ID, path: corpus.artifactPath }) : undefined,
	};
}

export async function runSearchDisclosureBenchmark(baseDir?: string): Promise<SearchDisclosureBenchmarkReport> {
	const corpus = await createDisclosureCorpus(baseDir);
	try {
		const input = { type: "text" as const, input: "DISCLOSURE_NEEDLE", path: "." };
		const fullResult = await new SearchTool(createSession(corpus, false)).execute("disclosure-full", input);
		const compactResult = await new SearchTool(createSession(corpus, true)).execute("disclosure-compact", input);
		if (fullResult.details?.type !== "text" || compactResult.details?.type !== "text") {
			throw new Error("Text search benchmark returned the wrong details variant");
		}
		const fullText = resultText(fullResult);
		const compactText = resultText(compactResult);
		let artifactText: string;
		try {
			artifactText = await fs.readFile(corpus.artifactPath, "utf8");
		} catch (err) {
			throw new Error(`Failed to read disclosure artifact at ${corpus.artifactPath}: ${errorMessage(err)}`);
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
		await corpus.cleanup();
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

if (import.meta.main) {
	const report = await runSearchDisclosureBenchmark();
	process.stdout.write(`${formatSearchDisclosureBenchmark(report)}\n`);
	if (!report.exactRecovery || report.inlineReductionBytes <= 0) process.exitCode = 1;
}
