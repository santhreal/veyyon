/**
 * Language-neutral conformance harness (TS-SUITE-2).
 *
 * Behavior is recorded once as JSON vector files and replayed against any
 * implementation of the same module: today the TS oracle, later the Rust
 * port, both consuming the identical files. The format and the canonical
 * serialization are specified in `docs/migration/conformance-format.md`; the
 * Rust runner must implement that document, not this file.
 *
 * Failure policy (Law 10): a malformed vector file, an unknown function, an
 * empty directory, or a missing expectation is a LOUD error, never a skip. A
 * corpus that silently shrinks is indistinguishable from a passing one.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, isRecord } from "./type-guards";

/** Version stamp of the vector file format. Bump only with a documented
 * migration in conformance-format.md; the Rust runner refuses unknown versions. */
export const CONFORMANCE_SCHEMA_VERSION = 1;

/** One recorded call: `function(...input)` must produce `expected`, or throw
 * an error whose message contains `expectedError`. Exactly one of the two. */
export interface ConformanceVector {
	/** Unique within its file; names the behavior, not the input bytes. */
	name: string;
	/** Positional arguments, JSON-encodable. */
	input: unknown[];
	/** The exact return value (canonical-compared). Absent for error vectors. */
	expected?: unknown;
	/** Substring the thrown error's message must contain. Absent for value vectors. */
	expectedError?: string;
	/** Free-form provenance/notes; never affects the verdict. */
	meta?: Record<string, unknown>;
}

/** One vector file: all calls target a single exported function of the module. */
export interface ConformanceFile {
	schemaVersion: number;
	/** The module under test, e.g. "hashline/tokenizer". Documentation only. */
	module: string;
	/** The exported function every vector in this file calls. */
	function: string;
	vectors: ConformanceVector[];
}

/** A single vector's failure, with enough context to reproduce by hand. */
export interface ConformanceFailure {
	file: string;
	vector: string;
	detail: string;
}

export interface ConformanceReport {
	files: number;
	vectors: number;
	failures: ConformanceFailure[];
}

/**
 * Canonicalize a JSON-encodable value to a deterministic string: object keys
 * sorted, arrays in order, `-0` folded to `0`, non-finite numbers encoded as
 * NUL-prefixed tagged strings (JSON has no NaN/Infinity; the NUL prefix
 * cannot collide with real recorded text). Two values are conformance-equal
 * exactly when their canonical strings are byte-equal — this is the ONE
 * comparison the Rust runner must reproduce.
 */
export function canonicalizeConformanceValue(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

/**
 * Encode a value for STORAGE in a vector file: same mapping the comparison
 * uses (sorted keys, -0 folded, non-finite numbers and undefined as the
 * NUL-tagged strings), returned as a JSON-encodable value instead of a
 * string. Recorders must pass oracle results through this before
 * JSON.stringify, because a raw NaN/Infinity would otherwise serialize as
 * null and silently corrupt the recorded expectation.
 */
export function encodeConformanceValue(value: unknown): unknown {
	return sortValue(value);
}

function sortValue(value: unknown): unknown {
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "\u0000conformance:nan";
		if (value === Number.POSITIVE_INFINITY) return "\u0000conformance:+inf";
		if (value === Number.NEGATIVE_INFINITY) return "\u0000conformance:-inf";
		if (Object.is(value, -0)) return 0;
		return value;
	}
	if (Array.isArray(value)) return value.map(sortValue);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			out[key] = sortValue((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	if (value === undefined) return "\u0000conformance:undefined";
	return value;
}

function fail(file: string, message: string): never {
	throw new Error(`Conformance corpus error in ${file}: ${message}`);
}

/** Parse and validate one vector file. Every structural defect is fatal. */
export function parseConformanceFile(path: string, raw: string): ConformanceFile {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch (error) {
		fail(path, `invalid JSON (${String(error)})`);
	}
	if (!isRecord(data)) {
		fail(path, "top level must be an object {schemaVersion, module, function, vectors}");
	}
	const file = data as Partial<ConformanceFile>;
	if (file.schemaVersion !== CONFORMANCE_SCHEMA_VERSION) {
		fail(path, `schemaVersion ${String(file.schemaVersion)} (this runner implements ${CONFORMANCE_SCHEMA_VERSION})`);
	}
	if (typeof file.module !== "string" || file.module.length === 0) fail(path, "missing module name");
	if (typeof file.function !== "string" || file.function.length === 0) fail(path, "missing function name");
	if (!Array.isArray(file.vectors) || file.vectors.length === 0) fail(path, "vectors must be a non-empty array");
	const seen = new Set<string>();
	for (const [i, v] of file.vectors.entries()) {
		if (!isRecord(v)) fail(path, `vector #${i} is not an object`);
		if (typeof v.name !== "string" || v.name.length === 0) fail(path, `vector #${i} has no name`);
		if (seen.has(v.name)) fail(path, `duplicate vector name "${v.name}"`);
		seen.add(v.name);
		if (!Array.isArray(v.input)) fail(path, `vector "${v.name}": input must be an argument array`);
		const hasExpected = Object.hasOwn(v, "expected");
		const hasError = Object.hasOwn(v, "expectedError");
		if (hasExpected === hasError) {
			fail(path, `vector "${v.name}": exactly one of expected / expectedError is required`);
		}
		if (hasError && (typeof v.expectedError !== "string" || v.expectedError.length === 0)) {
			fail(path, `vector "${v.name}": expectedError must be a non-empty string`);
		}
	}
	return file as ConformanceFile;
}

/** Load every `*.json` vector file in `vectorDir`. An unreadable directory or
 * a directory with no vector files is fatal — an empty corpus must never pass. */
export function loadConformanceDir(vectorDir: string): Array<{ path: string; file: ConformanceFile }> {
	let names: string[];
	try {
		names = readdirSync(vectorDir);
	} catch (error) {
		throw new Error(`Conformance corpus error: cannot read vector dir ${vectorDir} (${String(error)})`);
	}
	const jsonNames = names.filter(n => n.endsWith(".json")).sort();
	if (jsonNames.length === 0) {
		throw new Error(`Conformance corpus error: ${vectorDir} contains no *.json vector files`);
	}
	return jsonNames.map(name => {
		const path = join(vectorDir, name);
		return { path, file: parseConformanceFile(path, readFileSync(path, "utf8")) };
	});
}

/**
 * Replay every vector in `vectorDir` against `module` (the implementation's
 * public boundary: exported name -> function) and return a full report. Every
 * mismatch is collected — one run surfaces all of what diverges. A vector file
 * naming a function the module does not export is fatal (the corpus and the
 * boundary drifted; that is a contract break, not a test to skip).
 */
export function runConformance(
	module: Record<string, (...args: never[]) => unknown>,
	vectorDir: string,
): ConformanceReport {
	const files = loadConformanceDir(vectorDir);
	const failures: ConformanceFailure[] = [];
	let vectors = 0;
	for (const { path, file } of files) {
		const fn = module[file.function];
		if (typeof fn !== "function") {
			fail(path, `function "${file.function}" is not exported by the module under test`);
		}
		for (const vector of file.vectors) {
			vectors++;
			let actual: unknown;
			let threw: Error | undefined;
			try {
				actual = fn(...(vector.input as never[]));
			} catch (error) {
				threw = new Error(errorMessage(error));
			}
			if (vector.expectedError !== undefined) {
				if (!threw) {
					failures.push({
						file: path,
						vector: vector.name,
						detail: `expected an error containing ${JSON.stringify(vector.expectedError)}, got value ${canonicalizeConformanceValue(actual)}`,
					});
				} else if (!threw.message.includes(vector.expectedError)) {
					failures.push({
						file: path,
						vector: vector.name,
						detail: `error message ${JSON.stringify(threw.message)} does not contain ${JSON.stringify(vector.expectedError)}`,
					});
				}
				continue;
			}
			if (threw) {
				failures.push({ file: path, vector: vector.name, detail: `unexpected error: ${threw.message}` });
				continue;
			}
			const want = canonicalizeConformanceValue(vector.expected);
			const got = canonicalizeConformanceValue(actual);
			if (want !== got) {
				failures.push({ file: path, vector: vector.name, detail: `expected ${want}\n       got ${got}` });
			}
		}
	}
	return { files: files.length, vectors, failures };
}

/** Run and throw a precise multi-line error unless every vector passes. This
 * is what a test suite calls to turn the corpus into a hard verdict. */
export function assertConformance(
	module: Record<string, (...args: never[]) => unknown>,
	vectorDir: string,
): ConformanceReport {
	const report = runConformance(module, vectorDir);
	if (report.failures.length > 0) {
		const lines = report.failures.map(f => `  - ${f.file} :: ${f.vector}\n    ${f.detail}`);
		throw new Error(
			`Conformance FAILED: ${report.failures.length}/${report.vectors} vectors diverged\n${lines.join("\n")}`,
		);
	}
	return report;
}
