#!/usr/bin/env bun
/**
 * Measures whether the strings argot ranks highest are the strings an agent
 * actually retypes.
 *
 * WHY THIS INSTRUMENT EXISTS (backlog row ARGOT-RETYPE-LIKELIHOOD). A handle only
 * pays when the model emits it, so a dictionary's value is `saving per use` times
 * `uses`. The generator knows the first number exactly and GUESSES the second: it
 * ranks candidates by document frequency, meaning how many files of the repository
 * a string appears in. That is a claim about the corpus, not about the agent, and
 * the two come apart in the direction that costs the most. An import path sits in
 * every file and is typed by an agent almost never. Line structure sits in every
 * file too and is typed constantly.
 *
 * The guess had never been checked, because checking it needs a record of what the
 * agent really wrote. That record exists: recorded transcripts. This reads them,
 * restricted to sessions whose working directory is the repository in question,
 * and counts how many times each generated handle's expansion was actually emitted.
 *
 * Reading the output. `predicted` is the generator's own `savedTokens`, its
 * estimate of the tokens a handle removes across a pass over the corpus.
 * `emitted` is how many times the expansion really appeared in what the agent
 * wrote. `actual` prices those real emissions at the same per-use rate the
 * generator used, so the two columns are directly comparable. A handle with a high
 * `predicted` and an `emitted` of zero is budget spent on a string the model does
 * not write, and it is carried in the system prompt on every turn.
 *
 * Two honest limits, stated because they bound what the numbers can settle:
 *
 *   - The count is of the expansion appearing in emitted text, which is the best
 *     available proxy for "the model would have typed this". It cannot distinguish
 *     text the model composed from text it copied out of a tool result it had just
 *     read. That inflates every row rather than one, so it does not disturb the
 *     comparison BETWEEN rows, which is what the ranking question is about.
 *   - Sessions are attributed by their recorded working directory. A session that
 *     ranged across several repositories is counted for the one it started in.
 *
 * Usage:
 *   bun measure-retype-likelihood.ts --repo <dir>      # defaults to this repo
 *   bun measure-retype-likelihood.ts --sessions <dir>  # a specific transcript tree
 *   bun measure-retype-likelihood.ts --json
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateDictFromRepo } from "argot";
import { defaultSessionsDir, readEmissions } from "./transcript-corpus";

/** One handle, with what the generator predicted and what the agent really did. */
export interface RetypeRow {
	name: string;
	expansion: string;
	/** The generator's rank, 0 being the top of the table. */
	rank: number;
	/** Tokens the generator expects this handle to remove across a corpus pass. */
	predicted: number;
	/** Times the expansion appeared in what the agent actually emitted. */
	emitted: number;
	/** Those real emissions priced at the generator's own per-use saving. */
	actual: number;
}

/** What the measurement found, and enough context to know whether to believe it. */
export interface RetypeReport {
	repo: string;
	handles: number;
	dictTokens: number;
	/** Transcripts under the root, and how many were attributed to this repository. */
	transcripts: number;
	transcriptsForRepo: number;
	assistantMessages: number;
	rows: RetypeRow[];
	/** Handles the agent never emitted once. The budget spent on nothing. */
	neverEmitted: number;
	/** Output tokens the dictionary really removed, summed over every row. */
	actualSavedTokens: number;
	/**
	 * Input tokens the dictionary cost to carry: its size times the number of
	 * assistant turns it rode along on.
	 *
	 * This is the other half of the ledger and the generator never sees it. A
	 * dictionary is INPUT carried on every turn while its savings are OUTPUT
	 * produced once per emission, so the two have to be compared over the same
	 * period of real work, which is what the transcripts provide.
	 */
	carriedInputTokens: number;
	/**
	 * Whether the generator's ranking agrees with the observed one, as Kendall's
	 * tau-a over every pair of handles: 1 is perfect agreement, 0 is no better than
	 * chance, and a negative value means the ranking is actively inverted.
	 */
	rankAgreement: number;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
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

/**
 * Kendall's tau-a between the generator's ranking and the observed emission counts.
 *
 * Chosen over a correlation on the values because the question is about ORDER: the
 * generator's job is to put the handle an agent writes most at the top of a table
 * that gets truncated by a budget. Ties in the observed counts are common (many
 * handles are emitted zero times) and tau-a counts a tied pair as neither
 * concordant nor discordant, which is the honest treatment: two handles the agent
 * never wrote carry no evidence about which should rank higher.
 */
export function rankAgreement(rows: { rank: number; emitted: number }[]): number {
	let concordant = 0;
	let discordant = 0;
	for (let i = 0; i < rows.length; i++) {
		for (let j = i + 1; j < rows.length; j++) {
			const a = rows[i] as { rank: number; emitted: number };
			const b = rows[j] as { rank: number; emitted: number };
			if (a.emitted === b.emitted) continue;
			// The generator ranks better with a LOWER rank number, so agreement means
			// the earlier-ranked handle was emitted more often.
			const predictedFirst = a.rank < b.rank;
			const observedFirst = a.emitted > b.emitted;
			if (predictedFirst === observedFirst) concordant += 1;
			else discordant += 1;
		}
	}
	const pairs = concordant + discordant;
	return pairs === 0 ? 0 : (concordant - discordant) / pairs;
}

/** The repository's git-tracked files, the same corpus the agent's dictionary is built from. */
function repoFiles(repo: string): { path: string; content: string | undefined }[] {
	const listing = execFileSync("git", ["-C", repo, "ls-files"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	return listing
		.split("\n")
		.filter(Boolean)
		.map(rel => {
			try {
				return { path: rel, content: fs.readFileSync(path.join(repo, rel), "utf8") };
			} catch {
				// A path git tracks but the working tree cannot read (a submodule, a
				// deleted file, a binary that is not valid UTF-8) still counts as a
				// candidate path, which is why it is kept with no content rather than
				// dropped.
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
		// The generator's per-use saving, recovered from the numbers it reported so
		// the two columns are priced identically. `frequency` is what it assumed the
		// use count was.
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
		// Said plainly rather than printed as a table of zeros, which would read as
		// "the agent never types any of these" instead of "nothing was measured".
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
	// Printed as a ratio because the two sides are different goods: output tokens
	// cost several times more than input tokens, so a reader needs the raw ratio to
	// apply whatever price multiple their provider charges. Anything above about 5
	// is a net loss on any real price sheet.
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
