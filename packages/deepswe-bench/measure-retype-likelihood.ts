#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateDictFromRepo } from "argot";
import { defaultSessionsDir, readEmissions } from "./transcript-corpus";

export interface RetypeRow {
	name: string;
	expansion: string;
	rank: number;
	predicted: number;
	emitted: number;
	actual: number;
}

export interface RetypeReport {
	repo: string;
	handles: number;
	dictTokens: number;
	transcripts: number;
	transcriptsForRepo: number;
	assistantMessages: number;
	rows: RetypeRow[];
	neverEmitted: number;
	actualSavedTokens: number;
	carriedInputTokens: number;
	rankAgreement: number;
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		count += 1;
		at = haystack.indexOf(needle, at + needle.length);
	}
	return count;
}

export function rankAgreement(rows: { rank: number; emitted: number }[]): number {
	let concordant = 0;
	let discordant = 0;
	for (let i = 0; i < rows.length; i++) {
		for (let j = i + 1; j < rows.length; j++) {
			const a = rows[i] as { rank: number; emitted: number };
			const b = rows[j] as { rank: number; emitted: number };
			if (a.emitted === b.emitted) continue;
			const predictedFirst = a.rank < b.rank;
			const observedFirst = a.emitted > b.emitted;
			if (predictedFirst === observedFirst) concordant += 1;
			else discordant += 1;
		}
	}
	const pairs = concordant + discordant;
	return pairs === 0 ? 0 : (concordant - discordant) / pairs;
}

function repoFiles(repo: string): { path: string; content: string | undefined }[] {
	const listing = execFileSync("git", ["-C", repo, "ls-files"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	return listing
		.split("\n")
		.filter(Boolean)
		.map(rel => {
			try {
				return { path: rel, content: fs.readFileSync(path.join(repo, rel), "utf8") };
			} catch {
				return { path: rel, content: undefined };
			}
		});
}

export function measureRetype(repo: string, sessionsRoot: string): RetypeReport {
	const generated = generateDictFromRepo(repoFiles(repo), {});
	const emitted = new Map<string, number>(generated.handles.map(handle => [handle.expansion, 0]));

	const resolved = fs.realpathSync(repo);
	const corpus = readEmissions(
		sessionsRoot,
		emission => {
			for (const [expansion, count] of emitted) {
				const found = countOccurrences(emission.text, expansion);
				if (found > 0) emitted.set(expansion, count + found);
			}
		},
		{ cwdFilter: cwd => cwd === resolved || cwd.startsWith(`${resolved}${path.sep}`) },
	);

	const rows: RetypeRow[] = generated.handles.map((handle, rank) => {
		const uses = emitted.get(handle.expansion) ?? 0;
		const perUse = handle.frequency === 0 ? 0 : handle.savedTokens / handle.frequency;
		return {
			name: handle.name,
			expansion: handle.expansion,
			rank,
			predicted: handle.savedTokens,
			emitted: uses,
			actual: perUse * uses,
		};
	});

	return {
		repo: resolved,
		handles: generated.handles.length,
		dictTokens: generated.dictTokens,
		transcripts: corpus.files,
		transcriptsForRepo: corpus.filesRead,
		assistantMessages: corpus.counts.assistantMessages,
		rows,
		neverEmitted: rows.filter(row => row.emitted === 0).length,
		actualSavedTokens: rows.reduce((sum, row) => sum + row.actual, 0),
		carriedInputTokens: generated.dictTokens * corpus.counts.assistantMessages,
		rankAgreement: rankAgreement(rows),
	};
}

function main(argv: string[]): void {
	const flag = (name: string): string | undefined => {
		const at = argv.indexOf(name);
		return at === -1 ? undefined : argv[at + 1];
	};
	const repo = flag("--repo") ?? process.cwd();
	const sessionsRoot = flag("--sessions") ?? defaultSessionsDir();
	if (!fs.existsSync(sessionsRoot)) {
		console.error(`measure-retype-likelihood: no transcript tree at ${sessionsRoot}`);
		process.exit(1);
	}

	const report = measureRetype(repo, sessionsRoot);
	if (argv.includes("--json")) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}

	console.log(`repo:          ${report.repo}`);
	console.log(`dictionary:    ${report.handles} handles, ${report.dictTokens} tokens`);
	console.log(
		`transcripts:   ${report.transcriptsForRepo} of ${report.transcripts} attributed to this repo, ${report.assistantMessages} assistant turns`,
	);
	console.log("");
	if (report.transcriptsForRepo === 0) {
		console.log("no recorded sessions ran in this repository, so there is nothing to compare against");
		return;
	}
	console.log("rank  handle          predicted   emitted      actual  expansion");
	for (const row of report.rows) {
		console.log(
			`${String(row.rank).padStart(4)}  ${row.name.padEnd(14)}  ${row.predicted.toFixed(1).padStart(9)}  ` +
				`${String(row.emitted).padStart(8)}  ${row.actual.toFixed(1).padStart(10)}  ${JSON.stringify(row.expansion)}`,
		);
	}
	console.log("");
	console.log(`never emitted:   ${report.neverEmitted} of ${report.handles} handles`);
	console.log(`output saved:    ${Math.round(report.actualSavedTokens)} tokens, over the whole recorded period`);
	console.log(
		`input carried:   ${report.carriedInputTokens} tokens (${report.dictTokens} x ${report.assistantMessages} turns)`,
	);
	console.log(
		`cost ratio:      ${(report.carriedInputTokens / Math.max(1, report.actualSavedTokens)).toFixed(1)} input tokens carried per output token saved`,
	);
	console.log(
		`rank agreement:  ${report.rankAgreement.toFixed(3)} (Kendall tau-a; 1 perfect, 0 chance, negative inverted)`,
	);
}

if (import.meta.main) {
	main(process.argv.slice(2));
}
