import * as fs from "node:fs";
import { countTokens as nativeCountTokens } from "@veyyon/natives";
import { REFERENCE_RATE_CARD, retainedTokenCost } from "./cost-model";

const countTokens = (text: string): number => nativeCountTokens(text);

function candidates(chunk: string, minLength: number): string[] {
	const out: string[] = [];
	for (const line of chunk.split("\n")) {
		if (line.length >= minLength) out.push(line);
		const cut = Math.max(line.lastIndexOf("/"), line.lastIndexOf(" "), line.lastIndexOf("\t"));
		if (cut >= minLength) out.push(line.slice(0, cut + 1));
	}
	return out;
}

export interface OnlineResult {
	readonly totalTurns: number;
	readonly tokensBefore: number;
	readonly tokensAfter: number;
	readonly costBefore: number;
	readonly costAfter: number;
	readonly handlesMinted: number;
	readonly savingPct: number;
	readonly costSavingPct: number;
}

export function simulateOnline(chunks: readonly string[], minLength = 24, minRepeats = 2): OnlineResult {
	const totalTurns = chunks.length;
	const seen = new Map<string, number>();
	const handles = new Map<string, string>();
	const minted = new Set<string>();
	let nextId = 0;

	let tokensBefore = 0;
	let tokensAfter = 0;
	let costBefore = 0;
	let costAfter = 0;

	for (let turn = 0; turn < totalTurns; turn++) {
		const chunk = chunks[turn] ?? "";
		const unit = retainedTokenCost(turn, totalTurns);
		tokensBefore += countTokens(chunk);
		costBefore += countTokens(chunk) * unit;

		let encoded = chunk;
		const active = [...handles.entries()].sort((a, b) => b[0].length - a[0].length);
		for (const [expansion, name] of active) {
			if (encoded.includes(expansion)) encoded = encoded.split(expansion).join(name);
		}

		const definitions: string[] = [];
		for (const candidate of candidates(chunk, minLength)) {
			if (handles.has(candidate)) continue;
			const count = (seen.get(candidate) ?? 0) + 1;
			seen.set(candidate, count);
			if (count < minRepeats) continue;
			const name = `§${nextId.toString(36)}`;
			if (countTokens(candidate) - countTokens(name) <= 0) continue;
			nextId++;
			handles.set(candidate, name);
		}
		let bound = encoded;
		for (const [expansion, name] of [...handles.entries()].sort((a, b) => b[0].length - a[0].length)) {
			if (!minted.has(name) && bound.includes(expansion)) {
				bound = bound.replace(expansion, `${expansion}${name}`);
				minted.add(name);
			}
		}
		encoded = bound;
		void definitions;
		tokensAfter += countTokens(encoded);
		costAfter += countTokens(encoded) * unit;
	}

	return {
		totalTurns,
		tokensBefore,
		tokensAfter,
		costBefore,
		costAfter,
		handlesMinted: handles.size,
		savingPct: tokensBefore > 0 ? ((tokensBefore - tokensAfter) / tokensBefore) * 100 : 0,
		costSavingPct: costBefore > 0 ? ((costBefore - costAfter) / costBefore) * 100 : 0,
	};
}

if (import.meta.main) {
	const paths = process.argv.slice(2).filter(a => !a.startsWith("--"));
	if (paths.length === 0) {
		console.error("usage: bun online-codec-ceiling.ts <chunks.json> [more.json ...]");
		process.exit(2);
	}
	const chunks: string[] = [];
	for (const p of paths) {
		const pc = JSON.parse(fs.readFileSync(p, "utf8")) as string[];
		for (let ci = 0; ci < pc.length; ci++) chunks.push(pc[ci]!);
	}
	console.log(`stream: ${chunks.length} turns from ${paths.length} file(s)`);
	console.log(`rates:  ${REFERENCE_RATE_CARD.source}`);
	console.log("");
	console.log("| minLen | minRep | handles | token saving | COST saving |");
	console.log("|---|---|---|---|---|");
	for (const minLength of [16, 24, 40]) {
		for (const minRepeats of [2, 3]) {
			const r = simulateOnline(chunks, minLength, minRepeats);
			console.log(
				`| ${minLength} | ${minRepeats} | ${r.handlesMinted} | ${r.savingPct.toFixed(2)}% | ${r.costSavingPct.toFixed(2)}% |`,
			);
		}
	}
}
