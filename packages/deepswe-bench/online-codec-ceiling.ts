/**
 * What an ONLINE, append-only, self-describing codec could save.
 *
 * WHY A DIFFERENT CODEC. The shipped codec fails for two structural reasons,
 * both measured rather than argued:
 *
 *   1. Its dictionary lives in the system prompt, so it is re-read on every
 *      turn. At a 16000-token budget that is ~8.5k tokens x 65 re-reads, and it
 *      costs more than the compression returns. Priced paired per task, the
 *      encode arm came out +$0.30/task dearer, 7 of 8 tasks.
 *   2. It is built from the repository BEFORE the session, so it has to guess
 *      which strings will appear. Held out, it compresses 0.47% of
 *      model-emitted tokens and 1.56% of tool-result tokens. Nearly nothing.
 *
 * An online codec removes both by construction:
 *
 *   - NO PREFIX COST. Nothing goes in the system prompt. A handle is defined
 *     inline, in the message where its expansion appears, and is therefore paid
 *     for exactly like the text around it.
 *   - NO GUESSING. A handle is only minted once its expansion has ALREADY
 *     appeared, so it never spends bytes on a string that turns out unused.
 *     The held-out problem does not exist: there is nothing to hold out.
 *   - NO CACHE INVALIDATION. It is append-only. Earlier context is never
 *     rewritten, so the provider's prefix cache survives, which is what makes
 *     the saving actually bankable rather than paid back at the uncached rate.
 *
 * The economics are per-handle and local. Minting costs the definition once;
 * every later use saves `len(expansion) - len(name)`, and that saving is then
 * multiplied by how many turns remain, because context is re-read. A string
 * that recurs twice near the end of a session is not worth a handle; one that
 * recurs ten times from turn 5 is worth a great deal. This tool prices exactly
 * that, so the answer is a number rather than an intuition.
 */

import * as fs from "node:fs";
import { countTokens as nativeCountTokens } from "@veyyon/natives";
import { REFERENCE_RATE_CARD } from "./cost-model";

const countTokens = (text: string): number => nativeCountTokens(text);

/** Cost of one token that enters context at `turn` and is re-read for the rest of the session. */
function retainedTokenCost(turn: number, totalTurns: number): number {
	const rereads = Math.max(0, totalTurns - turn - 1);
	return (REFERENCE_RATE_CARD.input + REFERENCE_RATE_CARD.cacheRead * rereads) / 1_000_000;
}

/**
 * Candidate strings from one chunk: whole lines, and the long shared prefixes
 * that dominate machine output.
 *
 * Lines are the right unit for the corpus that actually costs money here. The
 * expensive results in the measured trace were test-runner output, build logs
 * and file listings, where the same long path or the same prefix recurs on
 * hundreds of lines. Short strings are excluded because a handle cannot pay for
 * itself against them.
 */
function candidates(chunk: string, minLength: number): string[] {
	const out: string[] = [];
	for (const line of chunk.split("\n")) {
		if (line.length >= minLength) out.push(line);
		// Leading run of a line, which is what repeats when only a suffix varies
		// (`=== RUN   TestThing/case_1`, `.../case_2`, ...).
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

/**
 * Simulate the codec over a session's context stream, causally.
 *
 * `chunks[i]` is what entered the context at turn `i`. The simulation only ever
 * looks at chunks `<= i`, so nothing here depends on knowing the future, which
 * is the property that makes the result deployable rather than an upper bound.
 */
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

		// Encode with handles minted on earlier turns, longest first so a longer
		// binding is never shadowed by a shorter one it contains.
		let encoded = chunk;
		const active = [...handles.entries()].sort((a, b) => b[0].length - a[0].length);
		for (const [expansion, name] of active) {
			if (encoded.includes(expansion)) encoded = encoded.split(expansion).join(name);
		}

		// Mint at FIRST occurrence, in place, so the definition costs only the
		// marker rather than a second copy of the text.
		//
		// The first version minted on the SECOND occurrence and emitted
		// `name=expansion` as a fresh definition line. That restates bytes the
		// context already holds, and it measured -30% cost: the definitions cost
		// far more than the reuses returned. The expansion is already there; all a
		// handle needs is to name it as it goes past.
		//
		// Minting is therefore speculative, and cheap enough to be. A mint adds
		// about 2 tokens; one reuse of a 15-token line saves 14. Speculation pays
		// as long as a modest fraction of minted handles are ever reused, which is
		// why no future knowledge is needed.
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
		// Bind in place: the first appearance carries `text§name`, marking the text
		// with the name it will be referred to by afterwards.
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
	for (const p of paths) chunks.push(...(JSON.parse(fs.readFileSync(p, "utf8")) as string[]));
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
