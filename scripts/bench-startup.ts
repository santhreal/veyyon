/**
 * Startup benchmark: how long veyyon takes to put something on the screen.
 *
 * Four arms, cheapest first, so a regression can be attributed to a layer:
 *
 *   version      `--version`, which returns before the command registry loads. Runtime init plus
 *                the entry module's own graph, and nothing else.
 *   help         `--help`, which loads the command registry. version + registry.
 *   ready        an interactive launch with `VEYYON_TIMING=x`, which prints the startup timing tree
 *                and exits at the point the TUI would take the terminal. Everything the boot path
 *                does before the first frame, minus the frame itself.
 *   first-frame  an interactive launch under a pty, timed from spawn to the first byte the process
 *                writes. This is what a person waits for.
 *
 * Each arm runs against an isolated agent home so the numbers do not depend on the machine's
 * accumulated caches, sessions, or vault, and so a run cannot touch them. `--cold` throws that home
 * away between repetitions, which is the install-day number; the default keeps it, which is the
 * number a returning user sees. The two differ by more than a factor of three on the machine this
 * was written on, so a report that does not say which one it measured says nothing.
 *
 * Usage:
 *   bun scripts/bench-startup.ts [--runs 5] [--cold] [--bin <veyyon>] [--json out.json]
 *
 * `--bin` measures a built binary instead of `bun <source>`; the source arm carries Bun's own
 * transpile cost and is the pessimistic reading.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_SOURCE = path.join(REPO_ROOT, "packages", "coding-agent", "src", "cli.ts");
/** Onboarding generation the seeded home claims to have finished, so no run measures the wizard. */
const ONBOARDED_CONFIG = "onboardingVersion: 1\n";

interface Options {
	runs: number;
	cold: boolean;
	bin?: string;
	json?: string;
	timeoutMs: number;
}

interface Sample {
	arm: string;
	ms: number;
}

function parseArgs(argv: string[]): Options {
	const options: Options = { runs: 5, cold: false, timeoutMs: 60_000 };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--runs") options.runs = Number(argv[++i]);
		else if (arg === "--cold") options.cold = true;
		else if (arg === "--bin") options.bin = argv[++i];
		else if (arg === "--json") options.json = argv[++i];
		else if (arg === "--timeout") options.timeoutMs = Number(argv[++i]) * 1000;
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (!Number.isFinite(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer");
	return options;
}

/** The command that launches veyyon: a built binary when given one, else the source entry under Bun. */
function launcher(options: Options): { command: string; prefix: string[] } {
	return options.bin ? { command: options.bin, prefix: [] } : { command: "bun", prefix: [CLI_SOURCE] };
}

/**
 * A pty wrapper, because the interactive arms refuse to run without a terminal and neither Node nor
 * Bun can allocate one. `script` ships with util-linux and with macOS, and its argument order
 * differs between them.
 */
function ptyWrapper(command: string, args: string[]): { command: string; args: string[] } {
	const quoted = [command, ...args].map(part => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
	return os.platform() === "darwin"
		? { command: "script", args: ["-q", "/dev/null", "/bin/sh", "-c", quoted] }
		: { command: "script", args: ["-qec", quoted, "/dev/null"] };
}

interface RunOutcome {
	ms: number;
	stdout: string;
}

/**
 * Spawn one process and stop timing at `until`: the first byte for the pty arms, process exit for
 * the rest. The child is killed the moment the number is captured — an interactive launch never
 * ends on its own, and nothing after the first byte is being measured.
 */
async function timeRun(
	command: string,
	args: string[],
	env: Record<string, string>,
	until: "first-byte" | "exit",
	timeoutMs: number,
): Promise<RunOutcome> {
	const { promise, resolve, reject } = Promise.withResolvers<RunOutcome>();
	const started = performance.now();
	let ms: number | undefined;
	let stdout = "";
	let settled = false;

	const child = spawn(command, args, {
		cwd: REPO_ROOT,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...env },
	});

	const finish = (): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (ms === undefined) reject(new Error(`no output before exit: ${stdout.slice(-300)}`));
		else resolve({ ms, stdout });
	};

	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		if (!settled) {
			settled = true;
			reject(new Error(`timed out after ${timeoutMs}ms`));
		}
	}, timeoutMs);

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
		if (until !== "first-byte" || ms !== undefined) return;
		ms = performance.now() - started;
		child.kill("SIGKILL");
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.on("error", err => {
		clearTimeout(timer);
		if (!settled) {
			settled = true;
			reject(err);
		}
	});
	child.on("close", () => {
		if (until === "exit") ms = performance.now() - started;
		finish();
	});

	return promise;
}

/** A seeded agent home: onboarded, empty of everything else. */
async function seedHome(root: string): Promise<string> {
	const home = path.join(root, "home");
	await fs.mkdir(path.join(home, ".veyyon"), { recursive: true });
	await fs.writeFile(path.join(home, ".veyyon", "config.yml"), ONBOARDED_CONFIG);
	return home;
}

/** `Total: 394.3ms` from the timing tree the `ready` arm prints. */
function parseInstrumentedTotal(stdout: string): number | undefined {
	const match = /Total:\s+([0-9.]+)ms/.exec(stdout);
	return match ? Number(match[1]) : undefined;
}

/** `(before instrumentation): 511ms` — runtime init plus module load, before the first marker. */
function parseBeforeInstrumentation(stdout: string): number | undefined {
	const match = /\(before instrumentation\):\s+([0-9.]+)ms/.exec(stdout);
	return match ? Number(match[1]) : undefined;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function report(arm: string, samples: number[]): string {
	if (samples.length === 0) return `${arm}: no samples`;
	return (
		`${arm.padEnd(12)} median ${median(samples).toFixed(0)}ms ` +
		`(min ${Math.min(...samples).toFixed(0)}, max ${Math.max(...samples).toFixed(0)}, n=${samples.length})`
	);
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const { command, prefix } = launcher(options);
	const scratch = path.join(REPO_ROOT, ".captures", "bench-startup");
	await fs.rm(scratch, { recursive: true, force: true });
	await fs.mkdir(scratch, { recursive: true });

	const samples: Sample[] = [];
	const push = (arm: string, ms: number): void => {
		samples.push({ arm, ms });
	};

	/**
	 * `--cold` means every arm pays install-day cost, so the home is thrown away before each arm
	 * rather than each run: the GPU probe, the model catalog and the session store are all caches one
	 * arm would otherwise warm for the next, which turned a cold first-frame number into a warm one.
	 */
	async function envFor(): Promise<Record<string, string>> {
		if (options.cold) await fs.rm(path.join(scratch, "home"), { recursive: true, force: true });
		const home = await seedHome(scratch);
		return { HOME: home, TERM: "xterm-256color", VEYYON_PROFILE: "" };
	}

	for (let run = 0; run < options.runs; run++) {
		let env = await envFor();

		push("version", (await timeRun(command, [...prefix, "--version"], env, "exit", options.timeoutMs)).ms);

		env = await envFor();
		push("help", (await timeRun(command, [...prefix, "--help"], env, "exit", options.timeoutMs)).ms);

		env = await envFor();
		const readyPty = ptyWrapper(command, prefix);
		const ready = await timeRun(
			readyPty.command,
			readyPty.args,
			{ ...env, VEYYON_TIMING: "x" },
			"exit",
			options.timeoutMs,
		);
		push("ready", ready.ms);
		const total = parseInstrumentedTotal(ready.stdout);
		const before = parseBeforeInstrumentation(ready.stdout);
		if (total !== undefined) push("ready:boot", total);
		if (before !== undefined) push("ready:load", before);

		env = await envFor();
		const framePty = ptyWrapper(command, prefix);
		push("first-frame", (await timeRun(framePty.command, framePty.args, env, "first-byte", options.timeoutMs)).ms);
	}

	const arms = ["version", "help", "ready:load", "ready:boot", "ready", "first-frame"];
	const lines = [
		`veyyon startup — ${options.bin ? `binary ${options.bin}` : "bun source"}, ${options.cold ? "cold" : "warm"} home, ${options.runs} run(s)`,
		...arms.map(arm =>
			report(
				arm,
				samples.filter(sample => sample.arm === arm).map(sample => sample.ms),
			),
		),
	];
	process.stdout.write(`${lines.join("\n")}\n`);

	if (options.json) {
		await fs.writeFile(
			options.json,
			`${JSON.stringify(
				{
					target: options.bin ?? "bun source",
					home: options.cold ? "cold" : "warm",
					runs: options.runs,
					platform: `${os.platform()}-${os.arch()}`,
					samples,
				},
				null,
				2,
			)}\n`,
		);
	}
}

await main();
