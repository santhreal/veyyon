/**
 * Conformance-corpus recorder (TS-SUITE-3). Runs the CURRENT TypeScript
 * implementation as the oracle over a deterministic, named input enumeration
 * and regenerates the checked-in vector files under
 * `packages/<module>/test/conformance/vectors/`. The corpus is the
 * language-neutral record a Rust port must replay (see
 * docs/migration/conformance-format.md); regenerating and reviewing the diff
 * is how oracle drift becomes visible in review instead of silently moving
 * the goalposts.
 *
 * Usage:
 *   bun scripts/record-conformance.ts <module>          # rewrite vector files
 *   bun scripts/record-conformance.ts <module> --check  # fail if disk differs
 *
 * Inputs are enumerated in code (curated cases + generated families), never
 * random and never time-dependent, so back-to-back runs are byte-identical.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../packages/hashline/src/normalize";
import { parseLid, splitHashlineLines } from "../packages/hashline/src/tokenizer";
import {
	binarizeAsArray,
	cosineSimilarity,
	decodeEmbeddingJson,
	encodeEmbeddingJson,
	hammingDistanceFromArrays,
	informationScore,
	jaccardWordSimilarity,
	mmrRerankRecords,
	quantizeInt8AsArray,
	weibullDecayFactor12,
	wordSetSorted,
} from "../packages/mnemopi/src/core/conformance-boundary";
import { encodeConformanceValue } from "../packages/utils/src/conformance";

interface RecordedCase {
	name: string;
	input: unknown[];
}

interface FunctionCorpus {
	/** Vector file basename (without .json). */
	file: string;
	module: string;
	fn: string;
	oracle: (...args: never[]) => unknown;
	cases: RecordedCase[];
}

interface ModuleRecorder {
	vectorDir: string;
	corpora: () => FunctionCorpus[];
}

function cases(prefix: string, inputs: Array<[string, unknown[]]>): RecordedCase[] {
	return inputs.map(([name, input]) => ({ name: prefix ? `${prefix}: ${name}` : name, input }));
}

/** Show a content string as a readable case name: escape the invisibles. */
function show(text: string): string {
	return JSON.stringify(text);
}

// ---------------------------------------------------------------------------
// hashline
// ---------------------------------------------------------------------------

function splitCases(): RecordedCase[] {
	const curated = cases("", [
		["empty input is one empty line", [""]],
		["single line without terminator", ["a"]],
		["two LF lines", ["a\nb"]],
		["trailing LF adds no phantom line", ["a\n"]],
		["CRLF separates and the CR is trimmed", ["a\r\nb"]],
		["lone CR is not a separator", ["a\rb"]],
		["one bare LF is one empty line", ["\n"]],
		["blank line between content survives", ["a\n\nb"]],
		["trailing CRLF adds no phantom line", ["a\r\n"]],
		["trailing lone CR is trimmed from the final line", ["a\r"]],
		["CRLF-only input is one empty line", ["\r\n"]],
		["non-ASCII content passes through untouched", ["héllo\n😀"]],
		["mixed CRLF and LF in one input", ["a\r\nb\nc"]],
	]);

	// Every combination of separator styles between three segments, with every
	// terminator variant: the full ending matrix a real mixed-history file can
	// present.
	const matrix: RecordedCase[] = [];
	const seps: Array<["lf" | "crlf", string]> = [
		["lf", "\n"],
		["crlf", "\r\n"],
	];
	const tails: Array<[string, string]> = [
		["none", ""],
		["lf", "\n"],
		["crlf", "\r\n"],
		["bare-cr", "\r"],
	];
	for (const [sep1Name, sep1] of seps) {
		for (const [sep2Name, sep2] of seps) {
			for (const [tailName, tail] of tails) {
				matrix.push({
					name: `ending matrix: ${sep1Name}+${sep2Name}, tail ${tailName}`,
					input: [`x${sep1}y${sep2}z${tail}`],
				});
			}
		}
	}

	const crEdges = cases("cr edge", [
		["bare CR alone", ["\r"]],
		["two bare CRs", ["\r\r"]],
		["CR then content", ["\ra"]],
		["CR before CRLF", ["a\r\r\nb"]],
		["CRLF then bare CR", ["a\r\n\r"]],
		["CR run before LF", ["a\r\r\r\nb"]],
		["LF then CR then LF", ["a\n\r\nb"]],
	]);

	const unicode = cases("unicode", [
		["U+2028 line separator is content, not a split", ["a b"]],
		["U+0085 NEL is content, not a split", ["ab"]],
		["leading BOM stays on the first line", ["﻿a\nb"]],
		["surrogate pair across CRLF", ["𝄞\r\n𝄞"]],
		["fullwidth text", ["ｗｉｄｅ\nｌｉｎｅ"]],
		["combining marks survive", ["é\né"]],
	]);

	const scale = cases("scale", [
		["200 LF lines", [Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n")]],
		["200 CRLF lines", [Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\r\n")]],
		["5000-char single line then a short one", [`${"a".repeat(5000)}\nb`]],
	]);

	return [...curated, ...matrix, ...crEdges, ...unicode, ...scale];
}

function parseLidCases(): RecordedCase[] {
	const curated = cases("", [
		["plain number", ["5", 1]],
		["surrounding whitespace is tolerated", ["  12  ", 3]],
		["large line number", ["1234567890", 1]],
		["zero is rejected (anchors are 1-based)", ["0", 2]],
		["empty anchor is rejected", ["", 4]],
		["trailing garbage is rejected", ["5x", 1]],
		["two numbers are rejected", ["12 7", 1]],
		["leading zero is rejected", ["05", 1]],
	]);

	const accepted: RecordedCase[] = [];
	for (const value of [1, 2, 9, 10, 42, 99, 100, 999, 1000, 65535, 100000, 2147483647, 4294967296, 9007199254740991]) {
		accepted.push({ name: `accepts ${value}`, input: [String(value), 1] });
	}
	const paddings: Array<[string, string]> = [
		["leading tab", "\t7"],
		["trailing tab", "7\t"],
		["leading spaces", "   7"],
		["trailing spaces", "7   "],
		["tab both sides", "\t7\t"],
	];
	for (const [name, raw] of paddings) {
		accepted.push({ name: `padding: ${name}`, input: [raw, 1] });
	}

	const rejected: RecordedCase[] = [];
	const badRaws = [
		"-1",
		"+1",
		"1.5",
		"1e3",
		"0x10",
		"1,000",
		" ",
		"\t",
		"00",
		"010",
		"5 6",
		"x5",
		"５", // fullwidth digit five
		"٥", // Arabic-Indic digit five
		"5 ", // trailing NBSP is not tokenizer whitespace
		"5-6",
	];
	for (const raw of badRaws) {
		rejected.push({ name: `rejects ${show(raw)}`, input: [raw, 1] });
	}
	// The error message embeds the hashline line number; pin that coupling.
	rejected.push({ name: "error message carries the input line number", input: ["nope", 42] });

	return [...curated, ...accepted, ...rejected];
}

function detectCases(): RecordedCase[] {
	const curated = cases("", [
		["empty defaults to LF", [""]],
		["no line endings defaults to LF", ["abc"]],
		["pure LF", ["a\nb"]],
		["pure CRLF", ["a\r\nb"]],
		["first ending wins - LF before CRLF", ["a\nb\r\nc"]],
		["first ending wins - CRLF before LF", ["a\r\nb\nc"]],
		["lone CR is not an ending", ["a\rb"]],
	]);

	// prefix x first-ending x rest: the full first-encounter decision table.
	const matrix: RecordedCase[] = [];
	const prefixes: Array<[string, string]> = [
		["at start", ""],
		["after content", "x"],
	];
	const firsts: Array<[string, string]> = [
		["lf", "\n"],
		["crlf", "\r\n"],
		["bare-cr", "\r"],
	];
	const rests: Array<[string, string]> = [
		["nothing", ""],
		["then lf", "y\n"],
		["then crlf", "y\r\n"],
	];
	for (const [pName, prefix] of prefixes) {
		for (const [fName, first] of firsts) {
			for (const [rName, rest] of rests) {
				matrix.push({
					name: `decision: ${fName} ${pName}, ${rName}`,
					input: [`${prefix}${first}${rest}`],
				});
			}
		}
	}
	return [...curated, ...matrix];
}

function toLfCases(): RecordedCase[] {
	const curated = cases("", [
		["CRLF and lone CR both become LF", ["a\r\nb\rc\nd"]],
		["empty stays empty", [""]],
		["lone CR becomes LF", ["\r"]],
		["consecutive CRLFs become consecutive LFs", ["\r\n\r\n"]],
		["pure LF is unchanged", ["a\nb\n"]],
	]);
	const extra = cases("edge", [
		["CR then CRLF", ["\r\r\n"]],
		["CRLF then CR", ["\r\n\r"]],
		["CR run", ["\r\r\r"]],
		["trailing CRs after content", ["a\rb\r"]],
		["mixed sample", ["x\r\ny\rz\n"]],
		["BOM survives normalization", ["﻿a\r\nb"]],
		["five CRLFs", ["\r\n".repeat(5)]],
		// Frozen fast-check shrink (TS-SUITE-4): a bare-CR boundary directly
		// followed by an empty line and an LF boundary forms the byte pair
		// CR LF, which normalizes as ONE CRLF ending, not two boundaries.
		["property shrink: CR + LF across an empty boundary is one CRLF", ["\n\r\n\n"]],
		["five bare CRs", ["\r".repeat(5)]],
	]);
	return [...curated, ...extra];
}

function restoreCases(): RecordedCase[] {
	const curated = cases("", [
		["LF re-encodes to CRLF", ["a\nb", "\r\n"]],
		["LF target is identity", ["a\nb", "\n"]],
		["empty stays empty for CRLF", ["", "\r\n"]],
		["every LF is re-encoded, including trailing", ["a\n\n", "\r\n"]],
	]);
	const matrix: RecordedCase[] = [];
	const texts: Array<[string, string]> = [
		["no newline", "a"],
		["single trailing LF", "a\n"],
		["interior blanks", "a\n\nb\n"],
		["pre-existing bare CR", "a\rb\n"],
		["pre-existing CRLF is doubled by design", "a\r\nb"],
		["only newlines", "\n\n"],
	];
	for (const [tName, text] of texts) {
		for (const ending of ["\n", "\r\n"] as const) {
			matrix.push({
				name: `matrix: ${tName} -> ${ending === "\n" ? "lf" : "crlf"}`,
				input: [text, ending],
			});
		}
	}
	return [...curated, ...matrix];
}

function stripBomCases(): RecordedCase[] {
	const curated = cases("", [
		["UTF-8 BOM is split off", ["﻿abc"]],
		["no BOM passes through", ["abc"]],
		["empty input has no BOM", [""]],
		["BOM-only input keeps empty text", ["﻿"]],
		["interior BOM is content, not a BOM", ["a﻿b"]],
	]);
	const extra = cases("edge", [
		["double BOM strips only the first", ["﻿﻿a"]],
		["BOM before CRLF content", ["﻿a\r\nb"]],
		["space before BOM keeps it as content", [" ﻿a"]],
		["BOM before empty line", ["﻿\n"]],
	]);
	return [...curated, ...extra];
}

// ---------------------------------------------------------------------------
// mnemopi (first-wave pure math; JSON boundary in src/core/conformance-boundary.ts)
// ---------------------------------------------------------------------------
// Inputs are JSON-clean by rule: non-finite numbers cannot ride in a vector
// file's input array (JSON.stringify would silently turn them into null), so
// non-finite HANDLING is locked by the contract's unit/property tests, and the
// corpus covers it only where non-finites arrive as strings (decode).

/** Deterministic pseudo-vector: small integers derived from the index. */
function pseudoVector(dim: number, mulA: number, addA: number, mod: number, shift: number): number[] {
	return Array.from({ length: dim }, (_, i) => ((i * mulA + addA) % mod) - shift);
}

function cosineCases(): RecordedCase[] {
	const curated = cases("", [
		[
			"identical vectors score 1",
			[
				[1, 2, 3],
				[1, 2, 3],
			],
		],
		[
			"orthogonal vectors score 0",
			[
				[1, 0],
				[0, 1],
			],
		],
		[
			"opposite vectors score -1",
			[
				[1, 2],
				[-1, -2],
			],
		],
		["both empty score 0", [[], []]],
		[
			"zero vector scores 0",
			[
				[0, 0, 0],
				[1, 2, 3],
			],
		],
		["single elements", [[2], [3]]],
		[
			"negative mix",
			[
				[1, -2, 3],
				[-4, 5, -6],
			],
		],
		[
			"scaled copies still score 1",
			[
				[1, 2, 3],
				[10, 20, 30],
			],
		],
	]);
	const mismatch = cases("length mismatch reads missing as 0", [
		[
			"longer a",
			[
				[1, 2, 3],
				[1, 2],
			],
		],
		["longer b", [[1], [1, 0, 0]]],
		["empty vs non-empty", [[], [5, 5]]],
		[
			"padding zeros are equivalent to absence",
			[
				[1, 2, 0],
				[1, 2],
			],
		],
	]);
	const extremes = cases("magnitude extremes", [
		[
			"1e150 entries stay finite",
			[
				[1e150, 1e150],
				[1e150, -1e150],
			],
		],
		[
			"1e200 squares overflow to Infinity in the norm",
			[
				[1e200, 0],
				[1e200, 0],
			],
		],
		["1e-170 squares underflow the norm to 0", [[1e-170], [1e-170]]],
		[
			"subnormal entries",
			[
				[5e-324, 5e-324],
				[5e-324, 0],
			],
		],
	]);
	const generated: RecordedCase[] = [];
	for (const dim of [2, 3, 4, 8, 16, 32]) {
		generated.push({
			name: `generated: pseudo pair dim ${dim}`,
			input: [pseudoVector(dim, 7, 3, 11, 5), pseudoVector(dim, 5, 1, 13, 6)],
		});
		generated.push({
			name: `generated: pseudo self dim ${dim}`,
			input: [pseudoVector(dim, 7, 3, 11, 5), pseudoVector(dim, 7, 3, 11, 5)],
		});
	}
	return [...curated, ...mismatch, ...extremes, ...generated];
}

function encodeEmbeddingCases(): RecordedCase[] {
	return cases("", [
		["plain integers", [[1, 2, 3]]],
		["empty array encodes to []", [[]]],
		["fractions keep full precision", [[0.5, -0.25, 0.1]]],
		["scientific-notation magnitudes", [[1e-7, 1.5e300]]],
		["negative zero", [[-0]]],
		["single value", [[42]]],
	]);
}

function decodeEmbeddingCases(): RecordedCase[] {
	const accepts = cases("accepts", [
		["plain integers", ["[1,2,3]"]],
		["fractions", ["[0.5,-0.25]"]],
		["surrounding whitespace", [" [1,2] "]],
		["subnormal is finite", ["[1e-320]"]],
		["negative zero", ["[-0]"]],
		["single element", ["[7]"]],
	]);
	const rejects = cases("rejects", [
		["non-string input", [42]],
		["empty string", [""]],
		["empty array", ["[]"]],
		["malformed json", ["not json"]],
		["numeric string element", ['[1,"2"]']],
		["null element", ["[null]"]],
		["nested array element", ["[[1]]"]],
		["object", ['{"a":1}']],
		["overflow to Infinity", ["[1e999]"]],
		["bare NaN is invalid json", ["[NaN]"]],
		["json string of an array", ['"[1,2]"']],
		["trailing comma", ["[1,2,]"]],
		["boolean element", ["[true]"]],
	]);
	return [...accepts, ...rejects];
}

function quantizeCases(): RecordedCase[] {
	return cases("", [
		["unit range maps to +-127", [[0, 1, -1, 0.5, -0.5, 0.25]]],
		["values beyond +-1 clamp", [[2, -2, 100, -100]]],
		["symmetric rounding at the half step", [[0.5, -0.5]]],
		["126.5 boundary rounds half up, negated mirrors", [[0.996063, -0.996063]]],
		["tiny values round to 0", [[1e-10, -1e-10, 0.003]]],
		["first step boundary", [[0.003937007874015748, 0.004]]],
		["empty embedding", [[]]],
		["exact integer steps", [[1 / 127, 2 / 127, -1 / 127]]],
	]);
}

function binarizeCases(): RecordedCase[] {
	return cases("", [
		["sign pattern packs MSB-first", [[1, -1, 0, 2, -3]]],
		["eight positives fill one byte", [[1, 1, 1, 1, 1, 1, 1, 1]]],
		["ninth bit starts a second byte", [[1, 1, 1, 1, 1, 1, 1, 1, 1]]],
		["seven positives leave the low bit clear", [[1, 1, 1, 1, 1, 1, 1]]],
		["zeros produce cleared bits (strictly positive test)", [[0, 0, 0, 0]]],
		["all negatives clear every bit", [[-1, -2, -3]]],
		["empty embedding has no bytes", [[]]],
		["alternating signs", [[1, -1, 1, -1, 1, -1, 1, -1]]],
		["single positive is the high bit", [[3]]],
	]);
}

function hammingCases(): RecordedCase[] {
	return cases("", [
		[
			"equal arrays are distance 0",
			[
				[255, 0, 7],
				[255, 0, 7],
			],
		],
		["full byte flip is 8", [[255], [0]]],
		["alternating patterns differ fully", [[170], [85]]],
		["length mismatch counts the tail's set bits", [[255, 255], [255]]],
		["empty vs bytes counts all set bits", [[], [7]]],
		["both empty are distance 0", [[], []]],
		["single-bit difference", [[128], [129]]],
		[
			"multi-byte mixed",
			[
				[1, 2, 3],
				[3, 2, 1],
			],
		],
	]);
}

function informationScoreCases(): RecordedCase[] {
	return cases("", [
		["zero distance is a perfect 1", [0, 384]],
		["half distance is 0.5", [192, 384]],
		["full distance is 0", [384, 384]],
		["distance past dim goes negative", [400, 384]],
		["zero dim yields 0", [10, 0]],
		["negative dim yields 0", [3, -5]],
		["small dims divide exactly", [3, 8]],
		["fractional result", [1, 3]],
	]);
}

function weibullCases(): RecordedCase[] {
	const types = ["general", "fact", "request", "profile", "decision", "event", "context", "not-a-type"];
	const ages = [0, -5, 1, 24, 168, 720, 8760];
	const generated: RecordedCase[] = [];
	for (const type of types) {
		for (const age of ages) {
			generated.push({ name: `decay: ${type} at ${age}h`, input: [age, type] });
		}
	}
	return generated;
}

function jaccardWordCases(): RecordedCase[] {
	return cases("", [
		["identical texts score 1", ["alpha beta", "alpha beta"]],
		["disjoint texts score 0", ["alpha beta", "gamma delta"]],
		["comparison is case-insensitive", ["Alpha BETA", "alpha beta"]],
		["whitespace runs and tabs split identically", ["a\tb  c", "a b c"]],
		["empty vs text scores 0", ["", "alpha"]],
		["both empty score 0", ["", ""]],
		["duplicate words collapse to one set entry", ["a a a b", "a b"]],
		["one-of-three overlap", ["a b c", "c d e"]],
		["unicode words compare whole", ["héllo wörld", "héllo there"]],
		["newlines are separators", ["a\nb", "a b"]],
	]);
}

function wordSetCases(): RecordedCase[] {
	return cases("", [
		["lowercases and sorts", ["Beta ALPHA gamma"]],
		["duplicates collapse", ["a b a b a"]],
		["punctuation stays attached to its word", ["a, b. c!"]],
		["tabs and newlines split", ["a\tb\nc"]],
		["empty text is an empty set", [""]],
		["whitespace-only text is an empty set", ["  \t  "]],
		["unicode words survive", ["Héllo WÖRLD"]],
	]);
}

function mmrCases(): RecordedCase[] {
	const docs = [
		{ content: "the quick brown fox", score: 0.9 },
		{ content: "the quick brown wolf", score: 0.85 },
		{ content: "entirely different topic", score: 0.8 },
		{ content: "the quick brown fox jumps", score: 0.75 },
	];
	return cases("", [
		["empty results stay empty", [[], 0.7, 10]],
		["topK 0 selects nothing", [docs, 0.7, 0]],
		["lambda 1 is pure relevance order", [docs, 1, 4]],
		["lambda 0.7 demotes near-duplicates", [docs, 0.7, 3]],
		["lambda 0 is pure diversity after the seed", [docs, 0, 3]],
		["topK beyond length returns all", [docs.slice(0, 2), 0.7, 10]],
		[
			"score ties keep sort order",
			[
				[
					{ content: "a", score: 0.5 },
					{ content: "b", score: 0.5 },
					{ content: "c", score: 0.5 },
				],
				0.7,
				3,
			],
		],
		[
			"missing score and content fields default",
			[[{ content: "with score", score: 0.4 }, { content: "no score" }, { score: 0.3 }], 0.7, 3],
		],
		["single result short-circuits", [[{ content: "only", score: 0.1 }], 0.7, 5]],
	]);
}

const RECORDERS: Record<string, ModuleRecorder> = {
	hashline: {
		vectorDir: join(import.meta.dir, "../packages/hashline/test/conformance/vectors"),
		corpora: () => [
			{
				file: "tokenizer-split-hashline-lines",
				module: "hashline/tokenizer",
				fn: "splitHashlineLines",
				oracle: splitHashlineLines,
				cases: splitCases(),
			},
			{
				file: "tokenizer-parse-lid",
				module: "hashline/tokenizer",
				fn: "parseLid",
				oracle: parseLid as (...args: never[]) => unknown,
				cases: parseLidCases(),
			},
			{
				file: "normalize-detect-line-ending",
				module: "hashline/normalize",
				fn: "detectLineEnding",
				oracle: detectLineEnding,
				cases: detectCases(),
			},
			{
				file: "normalize-to-lf",
				module: "hashline/normalize",
				fn: "normalizeToLF",
				oracle: normalizeToLF,
				cases: toLfCases(),
			},
			{
				file: "normalize-restore-line-endings",
				module: "hashline/normalize",
				fn: "restoreLineEndings",
				oracle: restoreLineEndings as (...args: never[]) => unknown,
				cases: restoreCases(),
			},
			{
				file: "normalize-strip-bom",
				module: "hashline/normalize",
				fn: "stripBom",
				oracle: stripBom,
				cases: stripBomCases(),
			},
		],
	},
	mnemopi: {
		vectorDir: join(import.meta.dir, "../packages/mnemopi/test/conformance/vectors"),
		corpora: () => [
			{
				file: "vector-math-cosine-similarity",
				module: "mnemopi/vector-math",
				fn: "cosineSimilarity",
				oracle: cosineSimilarity as (...args: never[]) => unknown,
				cases: cosineCases(),
			},
			{
				file: "vector-math-encode-embedding-json",
				module: "mnemopi/vector-math",
				fn: "encodeEmbeddingJson",
				oracle: encodeEmbeddingJson as (...args: never[]) => unknown,
				cases: encodeEmbeddingCases(),
			},
			{
				file: "vector-math-decode-embedding-json",
				module: "mnemopi/vector-math",
				fn: "decodeEmbeddingJson",
				oracle: decodeEmbeddingJson as (...args: never[]) => unknown,
				cases: decodeEmbeddingCases(),
			},
			{
				file: "binary-vectors-quantize-int8",
				module: "mnemopi/binary-vectors",
				fn: "quantizeInt8AsArray",
				oracle: quantizeInt8AsArray as (...args: never[]) => unknown,
				cases: quantizeCases(),
			},
			{
				file: "binary-vectors-binarize",
				module: "mnemopi/binary-vectors",
				fn: "binarizeAsArray",
				oracle: binarizeAsArray as (...args: never[]) => unknown,
				cases: binarizeCases(),
			},
			{
				file: "binary-vectors-hamming-distance",
				module: "mnemopi/binary-vectors",
				fn: "hammingDistanceFromArrays",
				oracle: hammingDistanceFromArrays as (...args: never[]) => unknown,
				cases: hammingCases(),
			},
			{
				file: "binary-vectors-information-score",
				module: "mnemopi/binary-vectors",
				fn: "informationScore",
				oracle: informationScore as (...args: never[]) => unknown,
				cases: informationScoreCases(),
			},
			{
				file: "decay-weibull-decay-factor",
				module: "mnemopi/decay",
				fn: "weibullDecayFactor12",
				oracle: weibullDecayFactor12 as (...args: never[]) => unknown,
				cases: weibullCases(),
			},
			{
				file: "text-similarity-jaccard-word",
				module: "mnemopi/text-similarity",
				fn: "jaccardWordSimilarity",
				oracle: jaccardWordSimilarity as (...args: never[]) => unknown,
				cases: jaccardWordCases(),
			},
			{
				file: "text-similarity-word-set",
				module: "mnemopi/text-similarity",
				fn: "wordSetSorted",
				oracle: wordSetSorted as (...args: never[]) => unknown,
				cases: wordSetCases(),
			},
			{
				file: "mmr-rerank-records",
				module: "mnemopi/mmr",
				fn: "mmrRerankRecords",
				oracle: mmrRerankRecords as (...args: never[]) => unknown,
				cases: mmrCases(),
			},
		],
	},
};

/** Run the oracle over every case and serialize the vector file content. */
export function renderModuleVectors(moduleName: string): Map<string, string> {
	const recorder = RECORDERS[moduleName];
	if (!recorder) {
		throw new Error(`Unknown conformance module "${moduleName}". Known: ${Object.keys(RECORDERS).join(", ")}`);
	}
	const out = new Map<string, string>();
	for (const corpus of recorder.corpora()) {
		const seen = new Set<string>();
		const vectors = corpus.cases.map(recorded => {
			if (seen.has(recorded.name)) {
				throw new Error(`Duplicate case name in ${corpus.file}: ${recorded.name}`);
			}
			seen.add(recorded.name);
			try {
				const expected = encodeConformanceValue(
					(corpus.oracle as (...args: unknown[]) => unknown)(...recorded.input),
				);
				return { name: recorded.name, input: recorded.input, expected };
			} catch (error) {
				// Record the FULL message: the strictest substring a replayer can
				// match, and any wording change shows up as a reviewed corpus diff.
				const message = error instanceof Error ? error.message : String(error);
				return { name: recorded.name, input: recorded.input, expectedError: message };
			}
		});
		const file = {
			schemaVersion: 1,
			module: corpus.module,
			function: corpus.fn,
			vectors,
		};
		out.set(`${corpus.file}.json`, `${JSON.stringify(file, null, 1)}\n`);
	}
	return out;
}

export function vectorDirFor(moduleName: string): string {
	const recorder = RECORDERS[moduleName];
	if (!recorder) {
		throw new Error(`Unknown conformance module "${moduleName}". Known: ${Object.keys(RECORDERS).join(", ")}`);
	}
	return recorder.vectorDir;
}

function main(): void {
	const [moduleName, flag] = process.argv.slice(2);
	if (!moduleName) {
		console.error(`Usage: bun scripts/record-conformance.ts <module> [--check]`);
		console.error(`Known modules: ${Object.keys(RECORDERS).join(", ")}`);
		process.exit(2);
	}
	const rendered = renderModuleVectors(moduleName);
	const dir = vectorDirFor(moduleName);

	if (flag === "--check") {
		const problems: string[] = [];
		for (const [name, content] of rendered) {
			let onDisk: string;
			try {
				onDisk = readFileSync(join(dir, name), "utf8");
			} catch {
				problems.push(`${name}: missing on disk`);
				continue;
			}
			if (onDisk !== content) problems.push(`${name}: differs from the recorded oracle output`);
		}
		for (const name of readdirSync(dir)) {
			if (name.endsWith(".json") && !rendered.has(name)) problems.push(`${name}: on disk but not recorded`);
		}
		if (problems.length > 0) {
			console.error(`Conformance corpus out of sync with the oracle:\n  ${problems.join("\n  ")}`);
			console.error(`Regenerate with: bun scripts/record-conformance.ts ${moduleName}`);
			process.exit(1);
		}
		console.log(`${moduleName}: ${rendered.size} vector files in sync.`);
		return;
	}

	for (const [name, content] of rendered) {
		writeFileSync(join(dir, name), content);
		console.log(`wrote ${join(dir, name)}`);
	}
}

if (import.meta.main) main();
