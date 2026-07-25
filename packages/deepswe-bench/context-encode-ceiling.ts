/**
 * What would encoding the CONTEXT save, in cost, on a real session?
 *
 * WHY THIS EXISTS. The codec has only ever been pointed at what the model
 * emits, and on a real trace that is the smallest of the three billing lines.
 * Tool results are the largest single block of context, and context is not paid
 * once: every token in it is re-read as a cache token on every later turn, so a
 * token introduced at turn 5 of a 66-turn session is billed roughly sixty more
 * times. That re-reading is where most of the bill actually is.
 *
 * The naive version of this measurement is badly misleading in BOTH directions,
 * which is why this tool exists rather than a one-off script:
 *
 *   - It overstates, by building the dictionary from the very text it then
 *     compresses. Production builds the dictionary from the repository before
 *     the session starts and cannot see the tool output the session will
 *     produce. Pass a separate `dict-source` to measure that honestly.
 *   - It understates the dictionary's price, by charging it once. The
 *     dictionary sits in the system prompt from turn 0, so it is re-read on
 *     every single turn, and a dictionary large enough to compress well can
 *     cost more than it saves. A 16000-token budget on one real trace saved
 *     36.6% of tool-result tokens and came out roughly a wash on cost.
 *
 * Both effects are position-dependent, so this weights every token by how many
 * turns it is actually re-read for, and sweeps the dictionary budget to find
 * where net cost is minimised rather than assuming the configured budget is
 * right.
 *
 * Usage:
 *   bun context-encode-ceiling.ts <corpus.json> [dict-source.json]
 *
 * Both files are JSON arrays of strings, one entry per turn, in turn order.
 * `dict-source` defaults to the corpus itself, which measures the (overfit)
 * upper bound; pass the repository corpus to measure what production could get.
 */

import * as fs from "node:fs";
import { countTokens as nativeCountTokens } from "@veyyon/natives";
import { generateDict } from "argot";
import { REFERENCE_RATE_CARD, retainedTokenCost } from "./cost-model";

const countTokens = (text: string): number => nativeCountTokens(text);

/**
 * Longest-first, non-overlapping greedy encode.
 *
 * Non-overlapping is the whole point. An earlier estimate counted every handle
 * whose expansion appeared anywhere in the text, including matches that overlap
 * and therefore cannot both be emitted, and reported a ceiling about fifty
 * times too high. This consumes each match, so what it reports is achievable.
 */
export function encodeGreedy(text: string, handles: ReadonlyArray<readonly [string, string]>): string {
	const byLength = [...handles].sort((a, b) => b[1].length - a[1].length);
	let out = "";
	let i = 0;
	outer: while (i < text.length) {
		for (const [name, expansion] of byLength) {
			if (expansion.length > 0 && text.startsWith(expansion, i)) {
				out += name;
				i += expansion.length;
				continue outer;
			}
		}
		out += text[i];
		i += 1;
	}
	return out;
}

export interface SweepRow {
	readonly budget: number;
	readonly handles: number;
	readonly dictTokens: number;
	readonly grossSavingPct: number;
	readonly corpusCostBefore: number;
	readonly corpusCostAfter: number;
	readonly dictCost: number;
	readonly netCostSavingPct: number;
}

/**
 * Measure one dictionary budget end to end, in cost.
 *
 * `corpus[i]` is the text that entered the context at turn `i`. The dictionary
 * is charged as if present from turn 0, because it is.
 */
export function measureBudget(corpus: readonly string[], dictSource: readonly string[], budget: number): SweepRow {
	const dict = generateDict([...dictSource], { tokenBudget: budget, countTokens });
	const handles: Array<readonly [string, string]> = dict.handles.map(h => [`§${h.name}`, h.expansion] as const);
	const dictTokens = countTokens(dict.handles.map(h => `§${h.name}=${h.expansion}`).join("\n"));

	const totalTurns = corpus.length;
	let tokensBefore = 0;
	let tokensAfter = 0;
	let corpusCostBefore = 0;
	let corpusCostAfter = 0;
	for (let turn = 0; turn < corpus.length; turn++) {
		const raw = corpus[turn] ?? "";
		const before = countTokens(raw);
		const after = countTokens(encodeGreedy(raw, handles));
		tokensBefore += before;
		tokensAfter += after;
		const unit = retainedTokenCost(turn, totalTurns);
		corpusCostBefore += before * unit;
		corpusCostAfter += after * unit;
	}
	const dictCost = dictTokens * retainedTokenCost(0, totalTurns);
	const netCostSaving = corpusCostBefore - corpusCostAfter - dictCost;
	return {
		budget,
		handles: dict.handles.length,
		dictTokens,
		grossSavingPct: tokensBefore > 0 ? ((tokensBefore - tokensAfter) / tokensBefore) * 100 : 0,
		corpusCostBefore,
		corpusCostAfter,
		dictCost,
		netCostSavingPct: corpusCostBefore > 0 ? (netCostSaving / corpusCostBefore) * 100 : 0,
	};
}

if (import.meta.main) {
	const corpusPath = process.argv[2];
	if (!corpusPath) {
		console.error("usage: bun context-encode-ceiling.ts <corpus.json> [dict-source.json]");
		process.exit(2);
	}
	const corpus: string[] = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
	const dictSourcePath = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : corpusPath;
	const dictSource: string[] = JSON.parse(fs.readFileSync(dictSourcePath, "utf8"));
	const inSample = dictSourcePath === corpusPath;

	// A dictionary built from the text it then compresses reports a ceiling no
	// deployment can reach: production builds from the repository, before the
	// session that produces this output exists. `--holdout` splits the session in
	// half, builds from the first half only, and scores the second, which is the
	// generalization question actually at issue.
	const holdout = process.argv.includes("--holdout");
	if (holdout) {
		const cut = Math.floor(corpus.length / 2);
		const train = corpus.slice(0, cut);
		const test = corpus.slice(cut);
		console.log(
			`corpus       ${corpusPath}: trained on turns 0-${cut - 1}, scored on turns ${cut}-${corpus.length - 1}`,
		);
		console.log(`rates        ${REFERENCE_RATE_CARD.source}`);
		console.log("");
		console.log("| budget | handles | dict tok | gross tok saving | dict cost | net COST saving |");
		console.log("|---|---|---|---|---|---|");
		for (const budget of [250, 500, 1000, 2000, 4000, 8000, 16000]) {
			const r = measureBudget(test, train, budget);
			console.log(
				`| ${r.budget} | ${r.handles} | ${r.dictTokens} | ${r.grossSavingPct.toFixed(2)}% | ` +
					`$${r.dictCost.toFixed(5)} | ${r.netCostSavingPct.toFixed(2)}% |`,
			);
		}
		process.exit(0);
	}

	console.log(`corpus       ${corpusPath} (${corpus.length} turns)`);
	console.log(`dict source  ${dictSourcePath}${inSample ? "  [IN-SAMPLE, overfit upper bound]" : ""}`);
	console.log(`rates        ${REFERENCE_RATE_CARD.source}`);
	console.log("");
	console.log("| budget | handles | dict tok | gross tok saving | dict cost | net COST saving |");
	console.log("|---|---|---|---|---|---|");
	for (const budget of [250, 500, 1000, 2000, 4000, 8000, 16000]) {
		const r = measureBudget(corpus, dictSource, budget);
		console.log(
			`| ${r.budget} | ${r.handles} | ${r.dictTokens} | ${r.grossSavingPct.toFixed(2)}% | ` +
				`$${r.dictCost.toFixed(5)} | ${r.netCostSavingPct.toFixed(2)}% |`,
		);
	}
}
