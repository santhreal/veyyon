import { Glob } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Scan every shipped (`packages/<pkg>/src/**`) TypeScript source line for a
 * pattern and return one `path:line:text` record per match — the exact shape
 * `rg --line-number <pattern> .` produced, so callers keep their existing
 * allow-list filters unchanged.
 *
 * This replaces a `Bun.spawnSync({ cmd: ["rg", ...] })` call that the two
 * single-owner guard suites used. When ripgrep is not on PATH, spawnSync does
 * not return an exit code — it throws `Executable not found in $PATH: "rg"`
 * before the `scan.exitCode < 2` guard can run. GitHub-hosted ubuntu runners do
 * not ship ripgrep, so both guards hard-failed there, which turned the whole
 * test gate red and blocked every release from cutting (release_binary needs a
 * green test gate). A self-contained walk has no external dependency and cannot
 * regress when a runner image changes.
 *
 * @param repoRoot absolute path the glob is anchored at (the caller's repo root)
 * @param pattern per-line matcher; the global flag is stripped so it matches
 *        each line independently
 */
export function scanShippedSourceLines(repoRoot: string, pattern: RegExp): string[] {
	const glob = new Glob("packages/**/src/**/*.ts");
	const perLine = new RegExp(pattern.source, pattern.flags.replace("g", ""));
	const hits: string[] = [];
	for (const rel of glob.scanSync({ cwd: repoRoot, onlyFiles: true })) {
		const lines = fs.readFileSync(path.join(repoRoot, rel), "utf8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (perLine.test(lines[i])) hits.push(`${rel}:${i + 1}:${lines[i]}`);
		}
	}
	return hits;
}
