#!/usr/bin/env bun
/**
 * Boundary coverage floor (TS-SUITE-9). Runs ONLY the black-box suites
 * (conformance corpus + generative properties) with coverage and enforces
 * per-file floors on the port-candidate sources. This measures what a port
 * must satisfy — how much of the module the language-neutral vectors drive
 * through its PUBLIC boundary — not how many internal branches white-box
 * unit tests can reach; the internal coverage loop continues separately.
 *
 * Floors (raise deliberately as the corpus grows, never lower):
 * - normalize.ts: 100/100 — the corpus fully drives all four functions.
 * - tokenizer.ts: 23 funcs / 25 lines — only splitHashlineLines + parseLid
 *   are contracted so far; the rest of the tokenizer joins the manifest,
 *   corpus, and this floor together when its contract is written.
 *
 * Usage: bun scripts/coverage-floor.ts   (exit 1 below floor)
 */
const FLOORS: Record<string, { funcs: number; lines: number }> = {
	"src/normalize.ts": { funcs: 100, lines: 100 },
	"src/tokenizer.ts": { funcs: 23, lines: 25 },
};

const proc = Bun.spawnSync(["bun", "test", "test/conformance", "test/property", "--coverage"], {
	cwd: new URL("..", import.meta.url).pathname,
	stdout: "pipe",
	stderr: "pipe",
});
const output = proc.stdout.toString() + proc.stderr.toString();
if (proc.exitCode !== 0) {
	console.error(output);
	console.error("Boundary suites failed; coverage floor not evaluated.");
	process.exit(proc.exitCode ?? 1);
}

let failed = false;
for (const [file, floor] of Object.entries(FLOORS)) {
	const row = output.split("\n").find(line => line.includes(file));
	if (!row) {
		console.error(`${file}: missing from the coverage table — floor cannot be verified`);
		failed = true;
		continue;
	}
	const cells = row.split("|").map(cell => cell.trim());
	const funcs = Number.parseFloat(cells[1] ?? "");
	const lines = Number.parseFloat(cells[2] ?? "");
	if (!Number.isFinite(funcs) || !Number.isFinite(lines)) {
		console.error(`${file}: unparseable coverage row: ${row}`);
		failed = true;
		continue;
	}
	const ok = funcs >= floor.funcs && lines >= floor.lines;
	console.log(
		`${file}: ${funcs}% funcs / ${lines}% lines (floor ${floor.funcs}/${floor.lines}) ${ok ? "ok" : "BELOW FLOOR"}`,
	);
	if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
