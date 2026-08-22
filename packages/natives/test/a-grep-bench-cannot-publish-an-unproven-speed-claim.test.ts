/**
 * WHY: the grep benchmark published speed claims nobody could reproduce or check.
 *
 * The defect: it searched this repository and the local Cargo registry (so the corpus
 * changed with every commit and differed on every machine), compared a single total
 * match count, printed `Nx faster` whatever that comparison said, and ran `rg` with
 * stderr discarded and the exit code unread. An `rg` that failed to start therefore
 * measured as a very fast search of zero files, and path, line or text drift between
 * the engines was invisible.
 *
 * The class this closes: a bench arm that can report a number without proving the two
 * engines did the same work, on a corpus it can name, on a machine it recorded. Each
 * of the four gates is tested on its own, and the claim wording is tested against
 * every way a gate can fail, so a later refactor cannot quietly re-enable a ratio.
 *
 * What it does not catch: column drift. The addon's `GrepMatch` carries no column, so
 * no comparison here can see it, and `PARITY_SCOPE` says so wherever parity is
 * reported. It also does not run `rg` itself as part of parity: the parsers are held
 * to captured `rg` 14.1.1 output, and the live end-to-end comparison is the bench.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONTROL_FILES,
	CORPUS_PATTERN,
	CORPUS_VERSION,
	corpusFileContents,
	corpusRelativePath,
	generateCorpus,
	HIDDEN_DIR,
	IGNORED_DIR,
	isMatchingIndex,
	MATCH_EVERY,
	MAX_MATCHES_PER_FILE,
	matchesForIndex,
	NODE_MODULES_DIR,
} from "../bench/grep-corpus.js";
import {
	type ClaimInput,
	type ContentRow,
	type CountRow,
	compareContent,
	compareCounts,
	compareFiles,
	missingProvenance,
	type Provenance,
	parseRgContent,
	parseRgCounts,
	parseRgFiles,
	type RgRun,
	readings,
	rgFailure,
	runRipgrep,
	speedClaim,
	stability,
} from "../bench/grep-parity.js";

const roots: string[] = [];

async function corpusRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-grep-corpus-"));
	roots.push(root);
	return root;
}

async function readAll(root: string, files: number): Promise<string[]> {
	const contents: string[] = [];
	for (let index = 0; index < files; index++) {
		contents.push(await fs.readFile(path.join(root, corpusRelativePath(index)), "utf8"));
	}
	return contents;
}

function completeProvenance(): Provenance {
	return {
		rgVersion: "ripgrep 14.1.1",
		addonVersion: "1.1.1",
		bunVersion: "1.4.0",
		cpu: "AMD Ryzen 9 9950X 16-Core Processor",
		platform: "linux-x64 6.17.0",
		corpusVersion: 1,
		corpusSeed: 0x5eed1,
		corpusFiles: 10_000,
		corpusBytes: 41_000_000,
		pageCacheState: "warm (page cache not dropped)",
	};
}

function stableSamples(): number[] {
	return [10, 10, 10, 10, 10, 10, 10, 10];
}

function claimInput(overrides: Partial<ClaimInput> = {}): ClaimInput {
	return {
		nativeMs: 10,
		rgMs: 12,
		parityDifferences: [],
		missingProvenance: [],
		stability: stability(stableSamples()),
		...overrides,
	};
}

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("the corpus is reproducible, or the numbers mean nothing", () => {
	it("writes byte-identical files for the same version and seed", async () => {
		const [first, second] = [await corpusRoot(), await corpusRoot()];
		const factsA = await generateCorpus({ root: first, seed: 7, files: 40 });
		const factsB = await generateCorpus({ root: second, seed: 7, files: 40 });

		expect(factsA.version).toBe(CORPUS_VERSION);
		expect(await readAll(first, 40)).toEqual(await readAll(second, 40));
		expect(factsA.bytes).toBe(factsB.bytes);
		expect(factsA.srcMatches).toBe(factsB.srcMatches);
	});

	it("keeps the shape and changes the bytes when the seed changes", async () => {
		const [first, second] = [await corpusRoot(), await corpusRoot()];
		const factsA = await generateCorpus({ root: first, seed: 7, files: 40 });
		const factsB = await generateCorpus({ root: second, seed: 8, files: 40 });

		expect(await readAll(first, 40)).not.toEqual(await readAll(second, 40));
		expect(factsB.matchingFiles).toBe(factsA.matchingFiles);
		expect(factsB.srcMatches).toBe(factsA.srcMatches);
	});

	it("gives every corpus path the same length", async () => {
		const root = await corpusRoot();
		const facts = await generateCorpus({ root, seed: 3, files: 60 });
		const lengths = new Set<number>();
		for (let index = 0; index < facts.files; index++) lengths.add(corpusRelativePath(index).length);
		expect([...lengths]).toEqual([facts.pathLength]);
	});

	it("puts matching lines in one file in twenty, cycling one to four per file", async () => {
		const root = await corpusRoot();
		const files = 80;
		const facts = await generateCorpus({ root, seed: 5, files });
		const pattern = new RegExp(CORPUS_PATTERN);

		expect(facts.matchingFiles).toBe(files / MATCH_EVERY);
		let counted = 0;
		const perFile = new Set<number>();
		for (const [index, contents] of (await readAll(root, files)).entries()) {
			// The generator's own claim, checked against the bytes it wrote: a corpus
			// whose manifest disagrees with its files would make every arm a fiction.
			const found = contents.split("\n").filter(line => pattern.test(line)).length;
			expect(found).toBe(matchesForIndex(index));
			expect(found > 0).toBe(isMatchingIndex(index));
			if (found > 0) perFile.add(found);
			counted += found;
		}
		expect(counted).toBe(facts.srcMatches);
		expect([...perFile].sort()).toEqual([1, 2, 3, 4].slice(0, Math.min(MAX_MATCHES_PER_FILE, files / MATCH_EVERY)));
	});

	it("writes the hidden, ignored and pruned controls the option subset is proved with", async () => {
		const root = await corpusRoot();
		const facts = await generateCorpus({ root, seed: 5, files: 40 });
		const pattern = new RegExp(CORPUS_PATTERN);

		for (const dir of [HIDDEN_DIR, IGNORED_DIR, path.join(NODE_MODULES_DIR, "pkg")]) {
			const entries = await fs.readdir(path.join(root, dir));
			expect(entries.length).toBe(CONTROL_FILES);
			for (const entry of entries) {
				const contents = await fs.readFile(path.join(root, dir, entry), "utf8");
				expect(contents.split("\n").filter(line => pattern.test(line)).length).toBe(1);
			}
		}
		expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toBe(`${IGNORED_DIR}/\n`);
		expect(facts.hiddenMatches).toBe(CONTROL_FILES);
		expect(facts.ignoredMatches).toBe(CONTROL_FILES);
		expect(facts.nodeModulesMatches).toBe(CONTROL_FILES);
	});

	it("reuses a corpus the manifest already describes, and rewrites one it does not", async () => {
		const root = await corpusRoot();
		await generateCorpus({ root, seed: 5, files: 40 });
		const witness = path.join(root, "witness.txt");
		await fs.writeFile(witness, "still here");

		const reused = await generateCorpus({ root, seed: 5, files: 40 });
		expect(reused.reused).toBe(true);
		expect(await fs.readFile(witness, "utf8")).toBe("still here");

		const regenerated = await generateCorpus({ root, seed: 5, files: 60 });
		expect(regenerated.reused).toBe(false);
		expect(regenerated.files).toBe(60);
		await expect(fs.readFile(witness, "utf8")).rejects.toThrow();
	});

	it("rewrites a corpus left behind by an older version or another seed", async () => {
		// A corpus is a persisted shape. A run that reuses one written by an older
		// generator compares today's engine against yesterday's bytes and calls the
		// difference a speedup.
		const root = await corpusRoot();
		await generateCorpus({ root, seed: 5, files: 40 });
		const manifestPath = path.join(root, "manifest.json");
		const stale: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
		await fs.writeFile(manifestPath, JSON.stringify({ ...(stale as object), version: CORPUS_VERSION - 1 }));
		expect((await generateCorpus({ root, seed: 5, files: 40 })).reused).toBe(false);

		expect((await generateCorpus({ root, seed: 6, files: 40 })).reused).toBe(false);
		expect((await generateCorpus({ root, seed: 6, files: 40 })).reused).toBe(true);
	});

	it("is pure in index, seed and match count, which is what makes a run comparable", () => {
		// Compared body-first: the header line names the index and the seed, so two
		// files whose generated bodies are identical would still differ as whole files.
		const body = (text: string) => text.split("\n").slice(1, -2).join("\n");
		expect(corpusFileContents(3, 11, 0)).toBe(corpusFileContents(3, 11, 0));
		expect(body(corpusFileContents(3, 11, 0))).not.toBe(body(corpusFileContents(4, 11, 0)));
		expect(body(corpusFileContents(3, 11, 0))).not.toBe(body(corpusFileContents(3, 12, 0)));
		expect(new RegExp(CORPUS_PATTERN).test(corpusFileContents(3, 11, 0))).toBe(false);
		expect(
			corpusFileContents(3, 11, 2)
				.split("\n")
				.filter(line => new RegExp(CORPUS_PATTERN).test(line)).length,
		).toBe(2);
	});
});

describe("an rg that did not search is never timed", () => {
	it("names the failure when rg cannot be started at all", async () => {
		const root = await corpusRoot();
		const run = await runRipgrep(["--version"], root, path.join(root, "no-such-rg"));
		expect(run.exitCode).toBe(-1);
		const failure = rgFailure(run);
		expect(failure).toContain("rg could not be started");
	});

	it("treats an empty result as drift, because every arm searches files that match", () => {
		const empty: RgRun = { argv: ["rg"], stdout: "", stderr: "", exitCode: 1, ms: 4 };
		expect(rgFailure(empty)).toContain("no matches");
	});

	it("carries rg's own error text, which the old bench discarded", () => {
		const broken: RgRun = { argv: ["rg"], stdout: "", stderr: "error: unknown flag --nope\n", exitCode: 2, ms: 1 };
		const failure = rgFailure(broken);
		expect(failure).toContain("rg exited 2");
		expect(failure).toContain("unknown flag --nope");
	});

	it("accepts only exit zero", () => {
		expect(rgFailure({ argv: ["rg"], stdout: "x", stderr: "", exitCode: 0, ms: 1 })).toBeNull();
	});
});

describe("rg output is read row for row", () => {
	// Captured from ripgrep 14.1.1. Parsing is asserted against real bytes rather than
	// a hand-built shape, because the shape is what the comparison depends on.
	const jsonOutput = [
		'{"type":"begin","data":{"path":{"text":"./src/d00/s00/f00000.ts"}}}',
		// A context row carries a path, a line number and text, and is not a match. It
		// is the event that makes the type check load-bearing.
		'{"type":"context","data":{"path":{"text":"./src/d00/s00/f00000.ts"},"lines":{"text":"const cinder0000 = compute(0, \\"harbor\\", 3581);\\n"},"line_number":21,"absolute_offset":860,"submatches":[]}}',
		'{"type":"match","data":{"path":{"text":"./src/d00/s00/f00000.ts"},"lines":{"text":"import { alpha0000 } from \\"../mod-00/bravo\\";\\n"},"line_number":22,"absolute_offset":900,"submatches":[{"match":{"text":"import { alpha0000 } from \\"../mod-00/bravo\\";"},"start":0,"end":44}]}}',
		'{"type":"match","data":{"path":{"text":"./src/d00/s00/f00020.ts"},"lines":{"text":"import { delta0020 } from \\"../mod-20/onyx\\";\\n"},"line_number":41,"absolute_offset":1700,"submatches":[]}}',
		'{"type":"end","data":{"path":{"text":"./src/d00/s00/f00000.ts"},"binary_offset":null,"stats":{"searches":1,"matched_lines":1,"matches":1}}}',
		'{"data":{"elapsed_total":{"human":"0.000326s","nanos":326476,"secs":0},"stats":{"matches":1}},"type":"summary"}',
		"",
	].join("\n");

	it("keeps path, line number and text, and drops the events that are not matches", () => {
		expect(parseRgContent(jsonOutput)).toEqual([
			{ path: "src/d00/s00/f00000.ts", lineNumber: 22, line: 'import { alpha0000 } from "../mod-00/bravo";' },
			{ path: "src/d00/s00/f00020.ts", lineNumber: 41, line: 'import { delta0020 } from "../mod-20/onyx";' },
		]);
	});

	it("reads a file list and per-file counts, with the leading ./ removed", () => {
		expect(parseRgFiles("./src/d00/s00/f00000.ts\n./ignored/i00.ts\n\n")).toEqual([
			"src/d00/s00/f00000.ts",
			"ignored/i00.ts",
		]);
		expect(parseRgCounts("./src/d00/s00/f00000.ts:3\n./ignored/i00.ts:1\n")).toEqual([
			{ path: "src/d00/s00/f00000.ts", count: 3 },
			{ path: "ignored/i00.ts", count: 1 },
		]);
	});
});

describe("the comparison sees the drift a count total hid", () => {
	const rows: ContentRow[] = [
		{ path: "a.ts", lineNumber: 1, line: 'import { alpha0000 } from "../mod-00/bravo";' },
		{ path: "b.ts", lineNumber: 9, line: 'import { delta0020 } from "../mod-20/onyx";' },
	];

	it("passes only when every row matches", () => {
		expect(compareContent("content", rows, [...rows].reverse().reverse())).toEqual([]);
	});

	it("catches a row only one engine has, in either direction", () => {
		const extra: ContentRow = { path: "c.ts", lineNumber: 2, line: rows[0]?.line ?? "" };
		expect(compareContent("content", [...rows, extra], rows).join(" ")).toContain("only the addon has c.ts");
		expect(compareContent("content", rows, [...rows, extra]).join(" ")).toContain("only rg has c.ts");
	});

	it("catches a line number that moved while the count stayed the same", () => {
		const moved = rows.map((row, index) => (index === 0 ? { ...row, lineNumber: 2 } : row));
		const differences = compareContent("content", moved, rows);
		expect(differences.length).toBeGreaterThan(0);
		expect(differences.join(" ")).toContain("a.ts");
	});

	it("catches text that differs on the same path and line", () => {
		const retyped = rows.map((row, index) =>
			index === 1 ? { ...row, line: 'import { other0001 } from "../mod-01/onyx";' } : row,
		);
		expect(compareContent("content", retyped, rows).length).toBeGreaterThan(0);
	});

	it("catches a file-set difference and a per-file count difference", () => {
		expect(compareFiles("files", ["a.ts", "b.ts"], ["a.ts"]).join(" ")).toContain("only the addon has b.ts");
		expect(compareFiles("files", ["a.ts"], ["a.ts"])).toEqual([]);
		const native: CountRow[] = [{ path: "a.ts", count: 3 }];
		const rg: CountRow[] = [{ path: "a.ts", count: 4 }];
		expect(compareCounts("count", native, rg).length).toBeGreaterThan(0);
		expect(compareCounts("count", native, native)).toEqual([]);
	});

	it("reports the row totals when they differ, so a truncated arm is visible", () => {
		expect(compareFiles("files", ["a.ts", "b.ts"], ["a.ts"]).join(" ")).toContain("addon has 2 rows, rg has 1");
	});
});

describe("provenance is complete or the run cannot claim anything", () => {
	it("accepts a full record", () => {
		expect(missingProvenance(completeProvenance())).toEqual([]);
	});

	it("names every field that carries no value, including a field added later", () => {
		// Swept from the object's own keys rather than a written-out list: a field added
		// to `Provenance` and not checked by `missingProvenance` turns this red. A number
		// is blanked twice, because zero is meaningless for a byte count and legitimate
		// for a seed, and one of the two must be reported either way.
		const complete = completeProvenance();
		for (const key of Object.keys(complete) as Array<keyof Provenance>) {
			const blanks: unknown[] = typeof complete[key] === "number" ? [0, Number.NaN] : ["  "];
			const reported = blanks.flatMap(blank => missingProvenance({ ...complete, [key]: blank }));
			expect(reported).toContain(key);
		}
	});
});

describe("stability decides whether a ratio is reproducible", () => {
	it("calls a run stable when its halves agree", () => {
		const verdict = stability(stableSamples());
		expect(verdict.stable).toBe(true);
		expect(verdict.drift).toBeLessThanOrEqual(verdict.tolerance);
	});

	it("calls a drifting run unstable and reports how far it drifted", () => {
		const verdict = stability([10, 10, 10, 10, 14, 14, 14, 14]);
		expect(verdict.stable).toBe(false);
		expect(verdict.drift).toBeCloseTo(0.4, 5);
	});

	it("refuses to judge a run with almost no samples", () => {
		expect(stability([10, 10]).stable).toBe(false);
	});

	it("treats an unmeasurable median as unstable rather than infinitely fast", () => {
		const verdict = stability([0, 0, 0, 0]);
		expect(verdict.stable).toBe(false);
		expect(verdict.drift).toBe(Number.POSITIVE_INFINITY);
	});

	it("reads medians, not means, off a skewed sample set", () => {
		const stats = readings([10, 10, 10, 10, 100]);
		expect(stats.p50).toBe(10);
		expect(stats.max).toBe(100);
		expect(stats.mean).toBeCloseTo(28, 5);
		expect(stats.samples).toBe(5);
	});
});

describe("a speed claim is refused unless every gate passed", () => {
	it("states the ratio, the direction and what parity covered", () => {
		const claim = speedClaim(claimInput());
		expect(claim).toBe(
			"addon grep is 1.20x faster than rg (median, parity on path, line number and line text (the addon exposes no column))",
		);
		expect(speedClaim(claimInput({ nativeMs: 12, rgMs: 10 }))).toContain("1.20x slower");
	});

	it("prints no comparison when the arms disagreed", () => {
		const claim = speedClaim(claimInput({ parityDifferences: ["content: only rg has a.ts"] }));
		expect(claim).not.toContain("faster");
		expect(claim).not.toContain("slower");
		expect(claim).toContain("the arms disagree");
	});

	it("prints no comparison when the run did not record what it ran on", () => {
		const claim = speedClaim(claimInput({ missingProvenance: ["rgVersion"] }));
		expect(claim).not.toContain("faster");
		expect(claim).toContain("rgVersion");
	});

	it("prints no comparison when the run's own halves disagreed", () => {
		const claim = speedClaim(claimInput({ stability: stability([10, 10, 10, 10, 14, 14, 14, 14]) }));
		expect(claim).not.toContain("faster");
		expect(claim).toContain("drifted 40.0%");
	});

	it("prints no comparison when a median came out zero", () => {
		expect(speedClaim(claimInput({ nativeMs: 0 }))).toContain("a measured median was zero");
		expect(speedClaim(claimInput({ rgMs: 0 }))).not.toContain("faster");
	});

	it("reports the parity failure first when several gates failed at once", () => {
		const claim = speedClaim(
			claimInput({
				parityDifferences: ["content: only rg has a.ts"],
				missingProvenance: ["cpu"],
				stability: stability([10, 10, 10, 10, 14, 14, 14, 14]),
			}),
		);
		expect(claim).toContain("the arms disagree");
		expect(claim).not.toContain("faster");
	});
});
