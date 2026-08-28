import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, isRecord } from "./type-guards";

export const CONFORMANCE_SCHEMA_VERSION = 1;

export interface ConformanceVector {
	name: string;
	input: unknown[];
	expected?: unknown;
	expectedError?: string;
	meta?: Record<string, unknown>;
}

export interface ConformanceFile {
	schemaVersion: number;
	module: string;
	function: string;
	vectors: ConformanceVector[];
}

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

export function canonicalizeConformanceValue(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

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
