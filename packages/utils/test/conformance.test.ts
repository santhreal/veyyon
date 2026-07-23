/**
 * The conformance runner (TS-SUITE-2) is the verdict engine for every recorded
 * behavior corpus: if IT is wrong, a diverging port can replay green. These
 * tests pin the three contracts the Rust runner must also honor:
 *   1. Loud corpus failures (Law 10): malformed JSON, structural defects,
 *      empty dirs, unknown functions, and dual/missing expectations are fatal
 *      errors — never skips.
 *   2. Canonical comparison: key order never matters, -0 folds to 0, and
 *      non-finite floats have a stable tagged encoding.
 *   3. Full reporting: every diverging vector is reported in one run, and
 *      error vectors match on message substring.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertConformance,
	canonicalizeConformanceValue,
	parseConformanceFile,
	runConformance,
} from "../src/conformance";

const tempDirs: string[] = [];
function vectorDir(files: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "conformance-test-"));
	tempDirs.push(dir);
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
	}
	return dir;
}
afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function file(fn: string, vectors: unknown[]): unknown {
	return { schemaVersion: 1, module: "test/mod", function: fn, vectors };
}

describe("canonicalizeConformanceValue — the one comparison", () => {
	test("object key order never affects equality", () => {
		expect(canonicalizeConformanceValue({ b: 1, a: { d: 2, c: 3 } })).toBe(
			canonicalizeConformanceValue({ a: { c: 3, d: 2 }, b: 1 }),
		);
	});

	test("negative zero folds to zero (JSON round-trips lose the sign anyway)", () => {
		expect(canonicalizeConformanceValue(-0)).toBe(canonicalizeConformanceValue(0));
	});

	test("non-finite numbers get stable tagged encodings, distinct from each other", () => {
		const nan = canonicalizeConformanceValue(Number.NaN);
		const inf = canonicalizeConformanceValue(Number.POSITIVE_INFINITY);
		const ninf = canonicalizeConformanceValue(Number.NEGATIVE_INFINITY);
		expect(new Set([nan, inf, ninf]).size).toBe(3);
		// NUL-prefixed tag strings so plain JSON (which has no NaN) can hold
		// them without colliding with any real recorded text.
		expect(nan).toBe(JSON.stringify("\u0000conformance:nan"));
	});

	test("arrays keep their order (order IS behavior for line lists)", () => {
		expect(canonicalizeConformanceValue([1, 2])).not.toBe(canonicalizeConformanceValue([2, 1]));
	});
});

describe("corpus loading — loud failure policy (Law 10)", () => {
	test("invalid JSON is fatal, not a skip", () => {
		const dir = vectorDir({ "bad.json": "{not json" });
		expect(() => runConformance({}, dir)).toThrow(/invalid JSON/);
	});

	test("an empty vector directory is fatal (an empty corpus must never pass)", () => {
		const dir = vectorDir({});
		expect(() => runConformance({}, dir)).toThrow(/no \*\.json vector files/);
	});

	test("a missing vector directory is fatal", () => {
		expect(() => runConformance({}, "/nonexistent/conformance/vectors")).toThrow(/cannot read vector dir/);
	});

	test("an unknown schema version is fatal (the runner refuses to guess)", () => {
		expect(() =>
			parseConformanceFile("v.json", JSON.stringify({ ...(file("f", [{}]) as object), schemaVersion: 99 })),
		).toThrow(/schemaVersion 99/);
	});

	test("a vector with both expected and expectedError is fatal", () => {
		const raw = JSON.stringify(file("f", [{ name: "x", input: [], expected: 1, expectedError: "boom" }]));
		expect(() => parseConformanceFile("v.json", raw)).toThrow(/exactly one of expected \/ expectedError/);
	});

	test("a vector with neither expectation is fatal", () => {
		const raw = JSON.stringify(file("f", [{ name: "x", input: [] }]));
		expect(() => parseConformanceFile("v.json", raw)).toThrow(/exactly one of expected \/ expectedError/);
	});

	test("duplicate vector names in one file are fatal (silent shadowing hides coverage)", () => {
		const raw = JSON.stringify(
			file("f", [
				{ name: "same", input: [], expected: 1 },
				{ name: "same", input: [], expected: 2 },
			]),
		);
		expect(() => parseConformanceFile("v.json", raw)).toThrow(/duplicate vector name/);
	});

	test("a vector file naming an unexported function is fatal (corpus/boundary drift)", () => {
		const dir = vectorDir({ "v.json": file("missingFn", [{ name: "x", input: [], expected: 1 }]) });
		expect(() => runConformance({}, dir)).toThrow(/"missingFn" is not exported/);
	});
});

describe("runConformance — replay semantics", () => {
	const double = (n: number) => n * 2;
	const explode = (msg: string) => {
		throw new Error(`kaboom: ${msg}`);
	};

	test("a green corpus reports zero failures with exact counts", () => {
		const dir = vectorDir({
			"double.json": file("double", [
				{ name: "two", input: [2], expected: 4 },
				{ name: "zero", input: [0], expected: 0 },
			]),
		});
		const report = runConformance({ double }, dir);
		expect(report).toEqual({ files: 1, vectors: 2, failures: [] });
	});

	test("every diverging vector is reported in one run, with expected vs got", () => {
		const dir = vectorDir({
			"double.json": file("double", [
				{ name: "wrong-a", input: [2], expected: 5 },
				{ name: "right", input: [3], expected: 6 },
				{ name: "wrong-b", input: [4], expected: 9 },
			]),
		});
		const report = runConformance({ double }, dir);
		expect(report.failures.map(f => f.vector)).toEqual(["wrong-a", "wrong-b"]);
		expect(report.failures[0]?.detail).toContain("expected 5");
		expect(report.failures[0]?.detail).toContain("got 4");
	});

	test("error vectors pass on message substring and fail on the wrong message", () => {
		const dir = vectorDir({
			"explode.json": file("explode", [
				{ name: "matches", input: ["it broke"], expectedError: "kaboom: it broke" },
				{ name: "wrong-message", input: ["other"], expectedError: "not this" },
			]),
		});
		const report = runConformance({ explode }, dir);
		expect(report.failures.map(f => f.vector)).toEqual(["wrong-message"]);
		expect(report.failures[0]?.detail).toContain("does not contain");
	});

	test("an unexpected throw on a value vector is a failure, not a crash", () => {
		const dir = vectorDir({
			"explode.json": file("explode", [{ name: "should-return", input: ["x"], expected: 1 }]),
		});
		const report = runConformance({ explode }, dir);
		expect(report.failures[0]?.detail).toBe("unexpected error: kaboom: x");
	});

	test("a value returned where an error was expected is a failure", () => {
		const dir = vectorDir({
			"double.json": file("double", [{ name: "should-throw", input: [1], expectedError: "kaboom" }]),
		});
		const report = runConformance({ double }, dir);
		expect(report.failures[0]?.detail).toContain("expected an error");
	});

	test("assertConformance throws a message naming every diverging vector", () => {
		const dir = vectorDir({
			"double.json": file("double", [
				{ name: "bad-one", input: [1], expected: 3 },
				{ name: "bad-two", input: [2], expected: 5 },
			]),
		});
		expect(() => assertConformance({ double }, dir)).toThrow(/2\/2 vectors diverged[\s\S]*bad-one[\s\S]*bad-two/);
	});
});
