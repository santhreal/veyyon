#!/usr/bin/env bun
/**
 * Reference implementation of the differential-conformance PORT protocol
 * (TS-SUITE-7): replays a vector directory through the current TS boundary
 * and prints one NDJSON result line per vector, exactly as a Rust port's
 * runner must. Two jobs: (1) executable documentation of the protocol a real
 * port implements; (2) the identity fixture differential-conformance.test.ts
 * uses to prove the gate passes on a faithful port and fails on divergence.
 *
 * Usage: bun scripts/conformance-port-oracle.ts [--sabotage] <vector-dir>
 * `--sabotage` corrupts one result on purpose so the test can assert the
 * differential gate actually fails on divergence.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
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

const BOUNDARY: Record<string, (...args: never[]) => unknown> = {
	splitHashlineLines,
	parseLid,
	detectLineEnding,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
	cosineSimilarity: cosineSimilarity as (...args: never[]) => unknown,
	encodeEmbeddingJson: encodeEmbeddingJson as (...args: never[]) => unknown,
	decodeEmbeddingJson: decodeEmbeddingJson as (...args: never[]) => unknown,
	quantizeInt8AsArray: quantizeInt8AsArray as (...args: never[]) => unknown,
	binarizeAsArray: binarizeAsArray as (...args: never[]) => unknown,
	hammingDistanceFromArrays: hammingDistanceFromArrays as (...args: never[]) => unknown,
	informationScore: informationScore as (...args: never[]) => unknown,
	weibullDecayFactor12: weibullDecayFactor12 as (...args: never[]) => unknown,
	jaccardWordSimilarity: jaccardWordSimilarity as (...args: never[]) => unknown,
	wordSetSorted: wordSetSorted as (...args: never[]) => unknown,
	mmrRerankRecords: mmrRerankRecords as (...args: never[]) => unknown,
};

const args = process.argv.slice(2);
const sabotage = args[0] === "--sabotage";
const dir = sabotage ? args[1] : args[0];
if (!dir) {
	console.error("Usage: bun scripts/conformance-port-oracle.ts [--sabotage] <vector-dir>");
	process.exit(2);
}

let sabotaged = false;
for (const fileName of readdirSync(dir)
	.filter(f => f.endsWith(".json"))
	.sort()) {
	const parsed = JSON.parse(readFileSync(join(dir, fileName), "utf8")) as {
		function: string;
		vectors: Array<{ name: string; input: unknown[] }>;
	};
	const fn = BOUNDARY[parsed.function];
	if (!fn) {
		console.error(`No boundary function ${parsed.function}`);
		process.exit(2);
	}
	for (const vector of parsed.vectors) {
		const file = basename(fileName);
		try {
			// Non-finite numbers have no JSON form: the protocol requires the
			// canonical NUL-tag encoding, or JSON.stringify silently emits null.
			let output = encodeConformanceValue((fn as (...a: unknown[]) => unknown)(...vector.input));
			if (sabotage && !sabotaged && typeof output === "string") {
				output = `${output}!DIVERGED`;
				sabotaged = true;
			}
			console.log(JSON.stringify({ file, name: vector.name, output }));
		} catch (error) {
			console.log(
				JSON.stringify({ file, name: vector.name, error: error instanceof Error ? error.message : String(error) }),
			);
		}
	}
}
