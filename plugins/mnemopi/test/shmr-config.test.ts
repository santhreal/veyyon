import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

const PACKAGE_DIR = path.join(import.meta.dir, "..");
const SRC_DIR = path.join(PACKAGE_DIR, "src");
// Repo root: test → mnemopi → packages → root.
const REPO_ROOT = path.join(PACKAGE_DIR, "..", "..");
const ENV_OWNER = path.join("util", "env.ts");

/**
 * Read one exported numeric constant from `@veyyon/mnemopi/core/shmr` in a fresh
 * subprocess with the given env applied. The SHMR tunables are import-time
 * constants, so a fresh process is the only way to observe how a specific
 * override parses.
 */
async function shmrConstantUnderEnv(name: string, env: Record<string, string>): Promise<number> {
	const proc = Bun.spawn(
		[
			"bun",
			"-e",
			`import("@veyyon/mnemopi/core/shmr").then(m => { process.stdout.write(String(m[${JSON.stringify(name)}])); });`,
		],
		{ cwd: REPO_ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" },
	);
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`shmr import failed (code ${code}): ${err}`);
	return Number(out);
}

async function sourceFiles(dir: string, out: string[] = []): Promise<string[]> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			await sourceFiles(full, out);
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out;
}

/**
 * SHMR's tunables (batch size, iteration cap, similarity/harmony thresholds,
 * min cluster size) and the scratchpad cap used to be parsed inline with
 * `Number.parseInt(process.env.X ?? "d", 10)` / `Number.parseFloat(...)`. That
 * bypassed the shared envInt/envFloat owner, which has no NaN guard: a
 * non-numeric or empty override seeded NaN. A NaN threshold makes every
 * `cosineSimilarity(...) >= threshold` comparison false, so clustering and the
 * whole harmonize() pass silently produced zero beliefs with no error; a NaN
 * batch/limit corrupted the SQLite `LIMIT ?` bind. These tests pin that every
 * such override now falls back to its default value, never NaN, and lock the
 * class of inline `parse*(process.env...)` bypass out of the package for good.
 */
describe("SHMR config parses through the shared env owner", () => {
	it("falls back to the default similarity threshold on a non-numeric override, never NaN", async () => {
		const value = await shmrConstantUnderEnv("SHMR_SIMILARITY_THRESHOLD", {
			MNEMOPI_SHMR_SIMILARITY_THRESHOLD: "high",
		});
		expect(Number.isNaN(value)).toBe(false);
		expect(value).toBe(0.7);
	});

	it("falls back to the default harmony threshold on an empty override, never NaN", async () => {
		const value = await shmrConstantUnderEnv("SHMR_HARMONY_THRESHOLD", { MNEMOPI_SHMR_HARMONY_THRESHOLD: "" });
		expect(Number.isNaN(value)).toBe(false);
		expect(value).toBe(0.6);
	});

	it("falls back to the default batch size on garbage, never NaN", async () => {
		const value = await shmrConstantUnderEnv("SHMR_BATCH_SIZE", { MNEMOPI_SHMR_BATCH_SIZE: "abc" });
		expect(Number.isNaN(value)).toBe(false);
		expect(value).toBe(50);
	});

	it("falls back to the default min cluster size on garbage, never NaN", async () => {
		const value = await shmrConstantUnderEnv("SHMR_MIN_CLUSTER_SIZE", { MNEMOPI_SHMR_MIN_CLUSTER_SIZE: "two" });
		expect(Number.isNaN(value)).toBe(false);
		expect(value).toBe(2);
	});

	it("still honors a valid numeric override", async () => {
		const value = await shmrConstantUnderEnv("SHMR_SIMILARITY_THRESHOLD", {
			MNEMOPI_SHMR_SIMILARITY_THRESHOLD: "0.42",
		});
		expect(value).toBe(0.42);
	});
});

describe("no inline process.env numeric parse bypasses envInt/envFloat", () => {
	// Matches `parseInt(process.env...` and `parseFloat(process.env...` with or
	// without the `Number.` prefix and interior whitespace. The env parsers in
	// util/env.ts read process.env internally; a call site must import envInt /
	// envFloat, never re-derive the parse (which drops the NaN fallback).
	const INLINE_ENV_PARSE = /parse(?:Int|Float)\s*\(\s*(?:Number\.)?process\.env/;

	it("matches the offending shape but not a routed call", () => {
		expect(INLINE_ENV_PARSE.test('Number.parseInt(process.env.X ?? "1", 10)')).toBe(true);
		expect(INLINE_ENV_PARSE.test("parseFloat(process.env.Y)")).toBe(true);
		expect(INLINE_ENV_PARSE.test('envInt("X", 1)')).toBe(false);
		expect(INLINE_ENV_PARSE.test("Number.parseInt(raw, 10)")).toBe(false);
	});

	it("no production source parses process.env inline instead of importing envInt/envFloat", async () => {
		const offenders: string[] = [];
		for (const file of await sourceFiles(SRC_DIR)) {
			if (file.endsWith(ENV_OWNER)) continue;
			if (INLINE_ENV_PARSE.test(await readFile(file, "utf8"))) {
				offenders.push(path.relative(SRC_DIR, file).replaceAll(path.sep, "/"));
			}
		}
		expect(offenders, "parse process.env through envInt/envFloat, not inline").toEqual([]);
	});
});
