import * as fs from "node:fs";
import { countTokens as nativeCountTokens } from "@veyyon/natives";
import { generateDict } from "argot";
import { REFERENCE_RATE_CARD, retainedTokenCost } from "./cost-model";

const countTokens = (text: string): number => nativeCountTokens(text);

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
