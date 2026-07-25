/**
 * Argot release bench: deterministic, offline (no API) token accounting.
 *
 * This measures the codec's real effect on a real repository, with numbers
 * anyone can reproduce and nothing cherry-picked:
 *
 *   - dictionary cost: how many tokens the generated handle table spends,
 *   - teach cost: the per-turn `promptFragment` the harness injects to encode,
 *   - output savings: full corpus text vs the same text written with handles,
 *   - per-file reality: which real files benefit, and by how much,
 *   - three-arm accounting: off vs expand-only vs encode+expand, per turn,
 *   - expansion: per-call latency, and a byte-lossless round-trip assertion.
 *
 * It is offline because the codec side is fully deterministic: given a corpus
 * and a budget, the dictionary and every token count are fixed. The real-model
 * arm (does the model actually adopt handles, and what does the provider bill?)
 * is a separate dogfood run through `bench-profile`; see BACKLOG BENCH-3.
 *
 * The three arms map to existing argot settings, no bench-only settings:
 *
 *   - OFF          argot.enabled = false           no teach, no expansion
 *   - EXPAND-ONLY  argot.enabled = true, models=[]  no teach, expansion armed
 *   - ENCODE+EXPAND argot.enabled = true, models=[m] teach every turn, expansion armed
 *
 * Run:
 *   bun bench/argot-bench.ts [corpus-root]
 *
 * `corpus-root` defaults to this repository. Pass another repo (e.g. veyyon) to
 * bench against a larger, more representative codebase. Budget matches the
 * shipped default (1000 tokens), so the numbers are what a user would see.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ArgotSession } from "../src/session.js";
import { DEFAULT_SIGIL } from "../src/constants.js";
import { estimateTokens, generateDictFromRepo, type GeneratedHandle, type RepoFile } from "../src/generate.js";

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 256 * 1024;
const EXPANSION_LATENCY_ITERS = 5000;
const DICT_TOKEN_BUDGET = 1000; // matches the shipped default in generateDict

function repoRoot(): string {
	const arg = process.argv[2];
	if (arg) return path.resolve(arg);
	return path.resolve(import.meta.dir, "..");
}

/** Tracked files via `git ls-files`, with content read where it is text and not huge. */
function loadCorpus(root: string): RepoFile[] {
	const listed = spawnSync("git", ["-C", root, "ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (listed.status !== 0) {
		throw new Error(`git ls-files failed in ${root}: ${listed.stderr}`);
	}
	const paths = listed.stdout.split("\n").filter(Boolean).slice(0, MAX_FILES);
	const files: RepoFile[] = [];
	for (const rel of paths) {
		const abs = path.join(root, rel);
		let content: string | undefined;
		try {
			const stat = fs.statSync(abs);
			if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
				const buf = fs.readFileSync(abs);
				if (!buf.subarray(0, 4096).includes(0)) content = buf.toString("utf8");
			}
		} catch {
			// Unreadable path still enters as a listing-only candidate.
		}
		files.push(content === undefined ? { path: rel } : { path: rel, content });
	}
	return files;
}

/**
 * Encode text the way a model that adopted every handle would: replace each
 * expansion with its `sigil+name`, longest expansion first so a shorter
 * expansion nested in a longer one never corrupts the replacement. This is the
 * upper bound on what encoding can save for the given text; the model's real
 * adoption is measured separately (BENCH-3). The round-trip assertion below is
 * the guard that this encoding is faithful.
 */
function encodeWithHandles(text: string, handles: readonly GeneratedHandle[], sigil: string): string {
	let out = text;
	const byLongest = [...handles].sort((a, b) => b.expansion.length - a.expansion.length);
	for (const h of byLongest) {
		out = out.split(h.expansion).join(`${sigil}${h.name}`);
	}
	return out;
}

/** True when at least one handle expansion appears in the text. */
function containsHandle(text: string, handles: readonly GeneratedHandle[]): boolean {
	return handles.some(h => text.includes(h.expansion));
}

function pct(saved: number, base: number): string {
	if (base === 0) return "0.0%";
	return `${((saved / base) * 100).toFixed(1)}%`;
}

function preview(s: string, n = 56): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

function main(): void {
	const root = repoRoot();
	const files = loadCorpus(root);
	const withContent = files.filter((f): f is RepoFile & { content: string } => f.content !== undefined);

	const dict = generateDictFromRepo(files, { tokenBudget: DICT_TOKEN_BUDGET });
	if (dict.handles.length === 0) {
		console.log(`No handles selected for ${root}. Nothing to bench.`);
		return;
	}

	const argot = new ArgotSession();
	argot.loadVocab(dict.vocab);
	const teachTokens = estimateTokens(argot.promptFragment());

	// Aggregate: the whole corpus written with handles vs written in full. This
	// is the honest ceiling on output savings, over every tracked byte of the
	// real repo, not a hand-picked snippet.
	const allContent = withContent.map(f => f.content).join("\n");
	const allEncoded = encodeWithHandles(allContent, dict.handles, DEFAULT_SIGIL);
	const allFullTokens = estimateTokens(allContent);
	const allEncodedTokens = estimateTokens(allEncoded);
	const aggSaved = allFullTokens - allEncodedTokens;
	const lossless = argot.expand(allEncoded) === allContent;

	// Per-file reality: how many real files contain any handle at all, and the
	// single file that benefits most (a real file a model might reproduce).
	let benefiting = 0;
	let best: { path: string; full: number; enc: number } | null = null;
	for (const f of withContent) {
		if (!containsHandle(f.content, dict.handles)) continue;
		benefiting++;
		const full = estimateTokens(f.content);
		const enc = estimateTokens(encodeWithHandles(f.content, dict.handles, DEFAULT_SIGIL));
		if (best === null || full - enc > best.full - best.enc) best = { path: f.path, full, enc };
	}

	// Expansion latency, on a real handle-bearing payload.
	const latencyPayload = best ? encodeWithHandles(withContent.find(f => f.path === best?.path)?.content ?? "", dict.handles, DEFAULT_SIGIL) : allEncoded;
	const t0 = performance.now();
	for (let i = 0; i < EXPANSION_LATENCY_ITERS; i++) argot.expand(latencyPayload);
	const perExpandUs = ((performance.now() - t0) * 1000) / EXPANSION_LATENCY_ITERS;

	const rows: Array<[string, string]> = [
		["corpus root", root],
		["files (listed / with content)", `${files.length} / ${withContent.length}`],
		["corpus tokens (content)", allFullTokens.toLocaleString()],
		["candidates considered", dict.candidatesConsidered.toLocaleString()],
		["handles chosen", `${dict.handles.length} (budget ${dict.tokenBudget} tokens)`],
		["dict token cost", `${dict.dictTokens}`],
		["teach cost (encode arm)", `${teachTokens} tokens / turn`],
		["", ""],
		["aggregate full tokens", allFullTokens.toLocaleString()],
		["aggregate encoded tokens", allEncodedTokens.toLocaleString()],
		["aggregate output saved", `${aggSaved.toLocaleString()} (${pct(aggSaved, allFullTokens)}) losslessly`],
		["round-trip lossless", lossless ? "yes" : "NO — FAIL"],
		["", ""],
		["files containing a handle", `${benefiting} / ${withContent.length} (${pct(benefiting, withContent.length)})`],
	];
	if (best) {
		rows.push(
			["best real file", best.path],
			["  full / encoded tokens", `${best.full.toLocaleString()} / ${best.enc.toLocaleString()}`],
			["  saved on that file", `${(best.full - best.enc).toLocaleString()} (${pct(best.full - best.enc, best.full)})`],
			["  break-even (encode arm)", best.full - best.enc > 0 ? `emit it ${(teachTokens / (best.full - best.enc)).toFixed(2)}× to repay the teach cost` : "never (no savings)"],
		);
	}
	rows.push(["", ""], ["expansion latency", `${perExpandUs.toFixed(2)} µs/call (${EXPANSION_LATENCY_ITERS} iters)`]);

	const width = Math.max(...rows.map(([k]) => k.length));
	console.log(`\nArgot release bench\n${"=".repeat(width + 40)}`);
	for (const [k, v] of rows) {
		if (k === "" && v === "") {
			console.log("");
			continue;
		}
		console.log(`${k.padEnd(width)}   ${v}`);
	}

	// Top handles, so the reader sees what the generator actually picked on this
	// corpus (on veyyon: fontawesome SVG blocks, license headers, lockfile lines).
	console.log("\ntop handles (name  freq  saved  expansion)");
	for (const h of dict.handles.slice(0, 8)) {
		console.log(`  ${(DEFAULT_SIGIL + h.name).padEnd(10)} ${String(h.frequency).padStart(5)}  ${String(h.savedTokens).padStart(7)}  "${preview(h.expansion)}"`);
	}

	// Three-arm per-turn accounting, all from the real numbers above, for a turn
	// whose output is the best real handle-bearing file (the friendliest honest
	// case for encoding). "delta" is tokens vs the OFF arm; negative is a saving.
	if (best) {
		const off = best.full;
		const expandOnly = best.full; // untaught model writes full text; expansion has nothing fresh to shorten
		const encode = best.enc + teachTokens; // teach paid once this turn, output encoded
		console.log("\nthree-arm accounting for a turn that reproduces the best real file:");
		console.log(`  OFF            output ${off.toLocaleString()}  teach 0     total ${off.toLocaleString()}`);
		console.log(`  EXPAND-ONLY    output ${expandOnly.toLocaleString()}  teach 0     total ${expandOnly.toLocaleString()}  (Δ ${(expandOnly - off).toLocaleString()}; helps only when handles already sit in history)`);
		console.log(`  ENCODE+EXPAND  output ${best.enc.toLocaleString()}  teach ${teachTokens}  total ${encode.toLocaleString()}  (Δ ${(encode - off).toLocaleString()})`);
	}
	console.log("");

	if (!lossless) {
		console.error("FAIL: expansion round-trip is not byte-lossless.");
		process.exit(1);
	}
}

main();
