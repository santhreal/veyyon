/**
 * `veyyon grep` standalone command: content/count/files modes, glob filtering,
 * limit, and error exit codes over a real fixture tree, plus a characterization
 * lock on the engine's literal fallback for unparseable regexes (tracked in
 * BACKLOG GREP-LITERAL-FALLBACK-INVISIBLE — the fallback is deliberate but
 * currently invisible; this suite pins today's behavior so a future fix that
 * surfaces the demotion shows up as an intentional test change).
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

function makeFixtureTree(): string {
	const root = mkdtempSync(path.join(tmpdir(), "veyyon-grep-fixture-"));
	writeFileSync(path.join(root, "alpha.txt"), "needle one\nplain line\nneedle two\n");
	writeFileSync(path.join(root, "beta.md"), "no match here\nneedle three\n");
	mkdirSync(path.join(root, "sub"));
	writeFileSync(path.join(root, "sub", "gamma.txt"), "fetchProvider(\n");
	return root;
}

async function runGrep(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const home = mkdtempSync(path.join(tmpdir(), "veyyon-grep-home-"));
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: "1" };
	for (const key of ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR", "VEYYON_PROFILE"]) {
		delete env[key];
	}

	const proc = Bun.spawn(["bun", cliPath, "grep", ...args], {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

describe("veyyon grep", () => {
	it("content mode reports exact totals and file:line matches", async () => {
		const root = makeFixtureTree();
		const { exitCode, stdout } = await runGrep(["needle", root]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Total matches: 3");
		expect(stdout).toContain("Files with matches: 2");
		expect(stdout).toContain("alpha.txt:1: needle one");
		expect(stdout).toContain("alpha.txt:3: needle two");
		expect(stdout).toContain("beta.md:2: needle three");
	}, 30_000);

	it("count mode (-c) prints per-file match counts", async () => {
		const root = makeFixtureTree();
		const { exitCode, stdout } = await runGrep(["-c", "needle", root]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("alpha.txt: 2 matches");
		expect(stdout).toContain("beta.md: 1 matches");
	}, 30_000);

	it("files mode (-f) prints matching paths only, no line content", async () => {
		const root = makeFixtureTree();
		const { exitCode, stdout } = await runGrep(["-f", "needle", root]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("alpha.txt");
		expect(stdout).toContain("beta.md");
		expect(stdout).not.toContain("needle one");
	}, 30_000);

	it("--glob restricts the searched files", async () => {
		const root = makeFixtureTree();
		const { exitCode, stdout } = await runGrep(["-g", "*.md", "needle", root]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Total matches: 1");
		expect(stdout).toContain("beta.md:2: needle three");
		expect(stdout).not.toContain("alpha.txt");
	}, 30_000);

	it("--limit caps matches and reports the truncation", async () => {
		const root = makeFixtureTree();
		const { exitCode, stdout } = await runGrep(["-l", "1", "needle", root]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Limit reached: true");
	}, 30_000);

	it("exits 1 with the OS error when the search path does not exist", async () => {
		const { exitCode, stderr } = await runGrep(["needle", "/nonexistent-grep-path-xyz"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Path not found");
	}, 30_000);

	it("exits 1 with usage when the pattern is missing", async () => {
		const { exitCode, stderr } = await runGrep([]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Pattern is required");
	}, 30_000);

	it("a code-snippet pattern with a stray paren still matches (paren-escape retry)", async () => {
		const root = makeFixtureTree();
		const { exitCode, stdout } = await runGrep(["fetchProvider(", root]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("Total matches: 1");
		expect(stdout).toContain("sub/gamma.txt:1: fetchProvider(");
	}, 30_000);

	// Characterization: an unparseable regex is demoted to a literal search and
	// reports 0 matches with exit 0 — no notice that the pattern was not used as
	// a regex. See BACKLOG GREP-LITERAL-FALLBACK-INVISIBLE for the planned fix.
	it("an unparseable regex currently falls back to a silent literal search", async () => {
		const root = makeFixtureTree();
		const literal = makeFixtureTree();
		writeFileSync(path.join(literal, "delta.txt"), "prefix [unclosed suffix\n");

		const miss = await runGrep(["[unclosed", root]);
		expect(miss.exitCode).toBe(0);
		expect(miss.stdout).toContain("Total matches: 0");

		const hit = await runGrep(["[unclosed", literal]);
		expect(hit.exitCode).toBe(0);
		expect(hit.stdout).toContain("Total matches: 1");
		expect(hit.stdout).toContain("delta.txt:1: prefix [unclosed suffix");
	}, 30_000);
});
