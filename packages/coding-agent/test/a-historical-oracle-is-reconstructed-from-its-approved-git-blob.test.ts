/**
 * WHY: A pre-populated cache or embedded source can conceal broken historical reconstruction.
 * Every frozen renderer must load from an empty cache and retain its approved Git bytes.
 * The suite rejects stale bytes for every renderer and fails when the wrapper set changes.
 * Renderer output equivalence is exercised by the existing differential suites.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, readGitTree } from "../../../scripts/git-baseline";
import {
	loadHistoricalOracle,
	ORACLE_EXPORTS,
	ORACLE_SNAPSHOT_COMMIT,
	ORACLE_SOURCE_DIRECTORY,
} from "./oracles/historical-loader";

const parent = path.join(import.meta.dirname, "oracles", ".cache");
fs.mkdirSync(parent, { recursive: true });
const cache = fs.mkdtempSync(path.join(parent, "cold-reconstruction-"));
afterAll(() => fs.rmSync(cache, { recursive: true, force: true }));
const names = Object.keys(ORACLE_EXPORTS).sort();

describe("historical oracle reconstruction", () => {
	it("covers every historical renderer and every current wrapper", () => {
		const suffix = "-main-renderer.ts";
		const wrappers = fs
			.readdirSync(path.join(import.meta.dirname, "oracles"))
			.filter(file => file.endsWith(suffix))
			.map(file => file.slice(0, -3))
			.sort();
		const historical = [...readGitTree(ORACLE_SNAPSHOT_COMMIT).keys()]
			.filter(file => file.startsWith(`${ORACLE_SOURCE_DIRECTORY}/`) && file.endsWith(suffix))
			.map(file => path.basename(file, ".ts"))
			.sort();
		expect(names).toEqual(historical);
		expect(wrappers).toEqual(historical);
	});

	for (const name of names) {
		it(`${name} loads approved bytes from an empty cache and rejects stale bytes`, () => {
			const cacheFile = path.join(cache, `${name}.ts`);
			expect(fs.existsSync(cacheFile)).toBe(false);
			const module = loadHistoricalOracle(name, cache);
			const approved = execFileSync(
				"git",
				["show", `${ORACLE_SNAPSHOT_COMMIT}:${ORACLE_SOURCE_DIRECTORY}/${name}.ts`],
				{
					cwd: REPO_ROOT,
					maxBuffer: 16 * 1024 * 1024,
				},
			);
			expect(fs.readFileSync(cacheFile).equals(approved)).toBe(true);
			for (const exported of ORACLE_EXPORTS[name]) {
				expect(Object.hasOwn(module, exported)).toBe(true);
				expect(module[exported]).not.toBeUndefined();
			}
			fs.appendFileSync(cacheFile, "\n// stale cached source\n");
			try {
				expect(() => loadHistoricalOracle(name, cache)).toThrow(/cache differs from the pinned Git blob/);
			} finally {
				fs.writeFileSync(cacheFile, approved);
			}
		});
	}

	it.each(["unknown-main-renderer", "../task-main-renderer", "toString"])("rejects unapproved name %s", name => {
		expect(() => loadHistoricalOracle(name, cache)).toThrow(/Unknown historical oracle/);
	});
});
