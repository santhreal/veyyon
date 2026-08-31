#!/usr/bin/env bun
/**
 * Boot-time regression guard.
 *
 * Re-runs the `VEYYON_TIMING=x` cold-boot benchmark under hyperfine and fails
 * when the median regresses past the budget in `bench-guard-decision.ts`.
 * `VEYYON_TIMING=x` runs the full pre-paint chain in `runRootCommand` and then
 * exits, so the never-exiting interactive launch becomes a terminating,
 * benchmarkable boot.
 *
 * Boot wall-clock is MACHINE-RELATIVE: a baseline captured on one machine says
 * nothing on another. This is a LOCAL guard, deliberately not wired into CI,
 * and every fact the comparison rests on — platform, arch, CPU, host, Bun
 * version, command, whether HOME was isolated, how many runs — travels with the
 * baseline and is checked before the medians are compared. A mismatch is a
 * refusal (exit 2), not a number.
 *
 * Each launch runs against a HOME created for the run, so a populated profile,
 * a session history or an MCP config on the measuring machine cannot move the
 * median, and stdin is closed so a launch cannot block on a terminal that is
 * not there.
 *
 *   bun scripts/bench-guard.ts --update   # capture the baseline for this host
 *   bun scripts/bench-guard.ts            # measure + compare; exit 1 on regression
 *
 * Requires `hyperfine` on PATH.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
	BASELINE_VERSION,
	type BaselineFile,
	type BenchFingerprint,
	decide,
	MIN_RUNS,
	medianOf,
	THRESHOLD,
} from "./bench-guard-decision";

const execFileAsync = promisify(execFile);

const BASELINE_PATH = path.join(import.meta.dirname, "..", "bench", "boot-baseline.json");
const LAUNCH = "VEYYON_TIMING=x VEYYON_STRICT_EDIT_MODE=1 bun src/cli.ts";
// The interactive launch refuses a stdin that is not a terminal, and it refuses
// before it reaches the pre-paint timing exit — so measuring it without a pty
// measures the refusal (exit 2, which hyperfine reports as a failed command).
// `script` supplies the pty; util-linux takes the command through a shell with
// `-c`, BSD takes it as argv, which needs an explicit `sh -c`.
const BENCH_COMMAND =
	process.platform === "darwin" ? `script -q /dev/null sh -c '${LAUNCH}'` : `script -qec '${LAUNCH}' /dev/null`;
const cwd = path.join(import.meta.dirname, "..");

async function gitFacts(): Promise<{ revision: string | null; dirty: boolean }> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
		const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
		return { revision: stdout.trim(), dirty: status.trim().length > 0 };
	} catch {
		return { revision: null, dirty: false };
	}
}

async function measure(): Promise<{ median: number; runs: number; raw: string }> {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-bench-home-"));
	const exportPath = path.join(home, "hyperfine.json");
	const proc = Bun.spawn(
		["hyperfine", "--warmup", "3", "--min-runs", String(MIN_RUNS), "--export-json", exportPath, BENCH_COMMAND],
		{
			cwd,
			// The measured launch inherits this environment. An isolated HOME and
			// XDG root keep a populated profile, a session history or an MCP
			// config on the measuring machine out of the median.
			env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), CI: "1" },
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	const code = await proc.exited;
	if (code !== 0) {
		await fs.rm(home, { recursive: true, force: true });
		throw new Error(`hyperfine exited ${code}. Run the measured launch by hand to see why:\n  ${BENCH_COMMAND}`);
	}
	const raw = await fs.readFile(exportPath, "utf8");
	const { median, runs } = medianOf(raw);
	await fs.rm(home, { recursive: true, force: true });
	return { median, runs, raw };
}

function fingerprint(runs: number): BenchFingerprint {
	return {
		platform: process.platform,
		arch: process.arch,
		cpu: os.cpus()[0]?.model ?? "unknown",
		host: os.hostname(),
		runtime: `bun ${Bun.version}`,
		command: BENCH_COMMAND,
		isolatedHome: true,
		runs,
	};
}

async function readBaseline(): Promise<BaselineFile | null> {
	try {
		return JSON.parse(await fs.readFile(BASELINE_PATH, "utf8")) as BaselineFile;
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return null;
		throw error;
	}
}

const update = process.argv.includes("--update");
const { median, runs, raw } = await measure();
const candidate = fingerprint(runs);

if (update) {
	const { revision, dirty } = await gitFacts();
	const file: BaselineFile = {
		version: BASELINE_VERSION,
		median,
		fingerprint: candidate,
		revision,
		dirty,
		capturedAt: new Date().toISOString(),
		hyperfine: JSON.parse(raw),
	};
	await fs.mkdir(path.dirname(BASELINE_PATH), { recursive: true });
	await fs.writeFile(BASELINE_PATH, `${JSON.stringify(file, null, 2)}\n`);
	console.log(
		`Baseline: ${(median * 1000).toFixed(0)}ms median over ${runs} runs on ${candidate.host} ` +
			`(${candidate.cpu}, ${candidate.runtime})${dirty ? ", dirty tree" : ""} -> ${BASELINE_PATH}`,
	);
	process.exit(0);
}

const baseline = await readBaseline();
const decision = decide(baseline, candidate, median);

if (decision.kind === "refused") {
	console.error("Refusing to compare this run against the stored baseline:");
	for (const reason of decision.reasons) console.error(`  - ${reason}`);
	console.error("Recapture on this machine with: bun scripts/bench-guard.ts --update");
	process.exit(2);
}

const baselineMedian = baseline?.median ?? 0;
console.log(
	`boot median: ${(median * 1000).toFixed(0)}ms over ${runs} runs vs baseline ` +
		`${(baselineMedian * 1000).toFixed(0)}ms (${((decision.ratio - 1) * 100).toFixed(1)}%, ` +
		`budget ${((THRESHOLD - 1) * 100).toFixed(0)}%) -> ${decision.kind === "regression" ? "REGRESSION" : "ok"}`,
);
process.exit(decision.kind === "regression" ? 1 : 0);
