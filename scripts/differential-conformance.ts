#!/usr/bin/env bun
/**
 * Cross-language differential gate (TS-SUITE-7). Replays a module's
 * conformance corpus through a candidate PORT (any external command) and
 * fails on the first divergence from the recorded oracle expectations,
 * compared value-exactly via the same canonicalization the TS runner uses.
 *
 * Usage:
 *   bun scripts/differential-conformance.ts <module> -- <command> [args...]
 *
 * Protocol (defined in docs/migration/conformance-format.md): the command is
 * spawned once with the vector DIRECTORY as its last argument. For every
 * vector in every file it must print one NDJSON line to stdout:
 *   {"file":"<basename>","name":"<vector name>","output":<value>}
 *   {"file":"<basename>","name":"<vector name>","error":"<message>"}
 * Order does not matter; missing or extra results are failures. `output` is
 * compared canonically (sorted keys, -0 -> 0, non-finite via the NUL-prefixed
 * tag strings); `error` must contain the vector's `expectedError` substring.
 *
 * Exit codes: 0 all vectors match; 1 divergence/missing/extra; 2 usage or
 * spawn failure. While no port exists this script simply is not invoked; the
 * moment one lands, wiring it into CI is part of the port checklist.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeConformanceValue } from "../packages/utils/src/conformance";
import { vectorDirFor } from "./record-conformance";

interface Vector {
	name: string;
	input: unknown[];
	expected?: unknown;
	expectedError?: string;
}

interface PortResult {
	file: string;
	name: string;
	output?: unknown;
	error?: string;
}

function usage(): never {
	console.error("Usage: bun scripts/differential-conformance.ts <module> -- <command> [args...]");
	process.exit(2);
}

const argv = process.argv.slice(2);
const moduleName = argv[0];
const sep = argv.indexOf("--");
if (!moduleName || sep === -1 || sep + 1 >= argv.length) usage();
const command = argv.slice(sep + 1);

const dir = vectorDirFor(moduleName);
const expectations = new Map<string, Vector>();
for (const fileName of readdirSync(dir)
	.filter(f => f.endsWith(".json"))
	.sort()) {
	const parsed = JSON.parse(readFileSync(join(dir, fileName), "utf8")) as { vectors: Vector[] };
	for (const vector of parsed.vectors) expectations.set(`${fileName} :: ${vector.name}`, vector);
}
if (expectations.size === 0) {
	console.error(`No vectors found for module ${moduleName} in ${dir}`);
	process.exit(2);
}

const proc = Bun.spawnSync([...command, dir], { stdout: "pipe", stderr: "inherit" });
if (proc.exitCode !== 0) {
	console.error(`Port command exited ${proc.exitCode} before results could be compared.`);
	process.exit(2);
}

const failures: string[] = [];
const seen = new Set<string>();
for (const line of proc.stdout.toString("utf8").split("\n")) {
	if (!line.trim()) continue;
	let result: PortResult;
	try {
		result = JSON.parse(line) as PortResult;
	} catch {
		failures.push(`unparseable result line: ${line.slice(0, 200)}`);
		continue;
	}
	const key = `${result.file} :: ${result.name}`;
	if (seen.has(key)) {
		failures.push(`${key}: duplicate result`);
		continue;
	}
	seen.add(key);
	const vector = expectations.get(key);
	if (!vector) {
		failures.push(`${key}: result for a vector the corpus does not contain`);
		continue;
	}
	if (vector.expectedError !== undefined) {
		if (result.error === undefined) {
			failures.push(`${key}: expected an error containing ${JSON.stringify(vector.expectedError)}, got a value`);
		} else if (!result.error.includes(vector.expectedError)) {
			failures.push(
				`${key}: error ${JSON.stringify(result.error)} does not contain ${JSON.stringify(vector.expectedError)}`,
			);
		}
		continue;
	}
	if (result.error !== undefined) {
		failures.push(`${key}: expected a value, port errored: ${result.error}`);
		continue;
	}
	const want = canonicalizeConformanceValue(vector.expected);
	const got = canonicalizeConformanceValue(result.output);
	if (want !== got) {
		failures.push(`${key}: divergence\n  oracle: ${want}\n  port:   ${got}`);
	}
}
for (const key of expectations.keys()) {
	if (!seen.has(key)) failures.push(`${key}: no result from the port (missing coverage is a failure)`);
}

if (failures.length > 0) {
	console.error(`${failures.length} differential failure(s) for ${moduleName}:\n\n${failures.join("\n")}`);
	process.exit(1);
}
console.log(`${moduleName}: port matches the oracle on all ${expectations.size} vectors.`);
